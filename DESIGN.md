# flowmap — design notes

Context for anyone (human or agent) implementing or extending this. The README covers
*what* the tool does. This covers *why* it is shaped this way, and which alternatives were
considered and rejected. If a change here contradicts a decision below, that's fine — but
read the rationale first, because most of these were chosen against an obvious-looking
alternative that fails at scale.

## The problem

~50+ repositories. When implementing a feature that crosses service boundaries, two costs
recur:

1. A coding agent sweeps the codebase to reconstruct the architecture on every task. Slow,
   expensive in tokens, and it still misses async consumers because there is no textual
   call site to grep for.
2. Developers have no shared picture of how data actually moves end to end, so changes
   ship missing a downstream hop. The "I forgot to update repo D" bug.

Both are the same missing artifact: an ordered, anchored description of how data flows
across repos.

## What this is not

Not a dependency graph. "Repo A depends on repo B" does not tell you where to put code.
The unit here is a **contract** (an endpoint, an event topic, a table) with a **file
anchor on both sides**, which is what converts "these are related" into "open this line."

Not a documentation site. Prose about architecture rots and nobody reads it. Everything
here is either verified against the repos or is a short structured record with an owner.

Not a RAG corpus. Retrieval ranks by relevance and will happily return a perfectly
on-topic chunk that stopped being true six months ago. Standards and flows are normative
and stable — they want reliable lookup by name, not semantic search.

**Not a gate.** flowmap never fails a build, blocks a merge, or votes on a PR. It is a
context reference for cross-repo behavior, and nothing else. See "Advisory only" below —
this is the constraint that most shapes the rest of the tool.

## Core model

Three objects, defined in `schema.json`:

- **Contract** — an edge. `id`, `kind` (http/grpc/event/queue/table/file), the path to its
  authoritative schema, and the `fields` it carries. Fields are what make
  `flowmap impact <field>` possible.
- **Repo** — a node. Declares `produces` and `consumes`, each entry pairing a contract id
  with an **anchor** (`path/to/file.ts::symbolName`) and an optional short note.
- **Journey** — a named, ordered list of hops. Drafted by an agent, authored by a human.
  This is the part that answers "where do I put my code."

Plus two supporting blocks:

- **`repos`** — id to clone URL and default branch. Needed by anything that syncs, which is
  `verify` and `draft`. This is the only registry in the system; keep it flat and boring.
- **`verified`** — per repo, the default-branch SHA the anchors last resolved against, when
  that happened, and how many resolved. Written by `flowmap verify`, never by hand.

```json
"verified": {
  "orders-api": { "branch": "main", "sha": "a1b2c3d", "at": "2026-08-24", "anchors": "7/7" },
  "fulfilment":  { "branch": "main", "sha": "9f8e7d6", "at": "2026-08-24", "anchors": "3/4" }
}
```

The anchor is the load-bearing detail, and it does double duty. For a reader it converts
"these are related" into "open this line." For the tool it is the **verification probe** —
resolving `path/file.ts::symbol` against a repo's default branch is how we check the map
still describes reality. A map without anchors is a picture; a map with anchors is a work
surface that can check itself.

## Decisions and rationale

**Advisory only. Never a gate.** flowmap reports; it does not enforce. No exit code that
breaks CI, no required check, no blocked merge. Two reasons. First, the inputs move
independently of any given diff — a check against other repos' default branches goes red
because someone else merged, and a check that fails for reasons the author did not cause
gets routed around within a month. Once it is routed around, the map loses the trust that
was the entire point. Second, and more fundamentally, enforcement belongs to mechanisms
that own their own ground truth: linters, type checks, and contract tests in the repos that
publish those contracts. flowmap's value is in being *read* — by an agent about to make a
cross-repo change, and by a human reviewing one. Do not add a `--strict` mode. If someone
asks for one, the thing they actually want is a contract test.

**Verify by sync, not by push.** A single `flowmap.json` in this repo is the whole record.
To check it, `flowmap verify` syncs the repos named in its journeys to their default branch
and resolves the anchors against real source.

This reverses an earlier decision — each repo emitting its own `flowmap-card.json` in CI,
with a central `flowmap scan` that only aggregates. That was chosen because a crawler over
50 repos does not scale and becomes one team's maintenance burden. The objection is real
but it was scoped wrong: we never walk 50 repos, only the 5–8 named in a journey, and only
the files the anchors point at. What the push model cost was adoption — every repo had to
add CI before the map could describe it, which put the project's own kill gate (step 2
below) behind other teams' backlogs. Pulling instead means flowmap can describe a repo that
has never heard of flowmap.

The sync must stay cheap or this decision fails on wall-clock:

```
git clone --depth 1 --filter=blob:none --sparse <repo>
git sparse-checkout set <anchored paths + schema paths>
```

Blobless and sparse fetches the handful of files the anchors name, not the repo. Cache
checkouts keyed by repo, and re-fetch only when the default branch SHA has moved.

**The verified SHA is the freshness check.** Same principle as before, relocated: freshness
is a commit comparison, never a human-maintained "last reviewed" date that someone has to
remember to bump. Because the `verified` block records the SHA the anchors last resolved
at, a re-run answers a more useful question than pass/fail — it distinguishes "this anchor
moved since we last looked, here is the commit range to inspect" from "this anchor has
never resolved, the map is wrong." Entries verified more than 90 days ago are flagged stale.

**Stale entries stay visible.** Never hide or drop a stale hop. A confidently-served
outdated fact is worse than a missing one, because the agent will not go verify it. The
staleness flag is what tells it to check the source. This is a deliberate inversion of how
most retrieval systems behave, and it matters more now than it did under the push model:
since nothing blocks, the flag is the *only* defense against a reader trusting a hop that
has drifted.

**Split checks by who can act on them.** Two invocations, different scopes:

- *PR-time* — resolve only the anchors belonging to **this** repo, and name which journeys
  the diff touches. No network, fast, and everything it reports is something the author
  actually caused. Surfaces as a comment.
- *Scheduled* — sync every involved repo, resolve everything, update the `verified` block.
  Drift from elsewhere becomes its own report for a human to triage, rather than noise on
  an unrelated PR.

Both are advisory. The split exists so the PR-time signal stays high enough that people
read it.

**Two anchors per hop, not one.** `reads` (where data arrives) and `writes` (where it
leaves) are usually different files. Giving the agent one anchor means it edits half the
hop. This was found by testing — the first implementation had a single anchor and produced
wrong results on hop 4 of the example.

**Branch consumers must not break the chain.** Fan-out is the normal case: two services
subscribe to the same event. A hop with no outbound contract is a branch consumer, so
inbound-contract resolution walks *back* to the last hop that actually emitted something,
rather than looking only at the immediately previous hop. See `journey()` in `lib/graph.js`.

**Journeys are agent-drafted and human-authored.** These are different jobs and the
distinction is the whole decision. *Drafting* is legwork — following a contract into the
next repo, locating the handler, producing a candidate anchor. An agent is better at it
than a person and it is most of the effort. *Authoring* is judgment — which 5 of 50 repos
constitute "checkout", where the story starts and stops, what to leave out. That is the
highest-value content in the file and it does not survive being generated. So: `flowmap
draft` proposes, a human decides, and a draft is never a journey until someone moves it in.
See "Drafting journeys" below.

Corollary: never flag a journey for diverging from the derived graph. A journey that omits
repos is edited, not wrong. Only anchors and contract fields get verified, because only
those have a source of truth to check against.

**A default branch name is data, never a convention.** `main`, `master`, `develop` and
`trunk` all occur, frequently inside one org, and a repo can rename its default at any time.
So flowmap resolves the branch per repo, records it, and refuses to invent one when it
cannot find out — an unregistered guess surfaces later as a confusing clone failure in CI.

The trap is that the method has to differ by source type while looking like it doesn't. For
a remote URL, `ls-remote --symref <url> HEAD` is the upstream default. For a **local path**
the same query returns whatever the developer currently has checked out, so registering a
repo while sitting on a feature branch would record that feature branch permanently; the
upstream answer lives in `refs/remotes/origin/HEAD` instead. Detection therefore prefers the
origin URL, falls back to the cached `origin/HEAD` when offline, and only uses the working
checkout for a repo with no origin at all — where it says so rather than presenting the
guess as fact. See `lib/branch.js`, and the regression test that uses `trunk` precisely
because nothing should be pattern-matching on the two common names.

**Simulation replays recorded behaviour, it does not model it.** `flowmap visualize` takes a
payload and walks it through the `transform` ops each hop declares — `add`, `rename`, `drop`,
`pass`, `derive` — recorded by whoever drafted the journey while reading the code, and
anchored to the file that performs them. Nothing is sent anywhere and nothing needs to be
running, which is what keeps the tool offline and advisory.

The failure mode to design against is a simulation that looks complete while describing
nothing, so three things are surfaced rather than smoothed over: a field the outbound
contract promises but that never arrived (where a consumer breaks), a field flowing through
that no contract declares, and a hop with no recorded transforms — marked *untraced*, never
rendered as an unchanged passthrough. Same instinct as stale entries staying visible: an
honest gap beats a confident blank.

Corollary for anyone drafting: omitting a hop's transforms is fine, inventing them is not.
An invented op produces a confidently wrong trace, which is the worst output this tool can
emit.

**Types are recorded, not parsed.** Contract fields accept `{ name, type, note }` as well as
a bare string. The type comes from the agent that was already reading the source at draft
time, so flowmap needs no per-language schema parser — the investment DESIGN.md lists as a
known gap stays unspent, and the anchor is what lets a reviewer check the claim.

**Discover by local grep; pay to clone only what matched.** `draft journey` run inside a repo
needs no registry: that repo starts the journey, its siblings in the same parent directory
are the candidates, and a grep decides which of them the feature touches.

This looks like the crawl this design rejects, and is not, because of where the cost falls.
Neighbouring repos are already checked out, and `git grep <term> <ref>` searches a branch
without checking it out — so the wide pass is a local grep over fifty repos in about two
seconds, and only the handful that matched are ever cloned. The rejected crawl was expensive
per repo; this one is expensive per *hit*. Keep that property: any future widening must stay
on the cheap side of it.

Two consequences worth preserving. The scan must be **offline** — resolving each repo's
default branch over the network turned a two-second scan into a two-minute one in testing, so
discovery uses the cached `origin/HEAD` and only registration pays for the authoritative
answer. And a repo whose match exists **only on an unmerged branch** must be reported rather
than scored zero: flowmap maps merged code, so the honest output is "found it, but not on the
default branch", never silence.

**No absolute path is ever written to a file.** The point of committing `flowmap.json` is
that the next engineer reuses the journey without redoing the work, and an absolute path
silently breaks that: it resolves on exactly one machine, and the failure looks like a broken
map rather than a portability bug. So everything stored — repo sources, checkout locations in
a draft — is relative to the directory holding `flowmap.json`, and resolved back at runtime
(`lib/paths.js`). A repo with an origin is recorded by URL, which is better still; a relative
path is the fallback for repos that have none.

The same applies to what is printed: paths under the map root are shown relative, because a
reader learns nothing from another developer's home directory.

**The map lives where the command was run, not where the journey starts.** `draft journey`
writes into the repo you invoked it from, whatever repo the first hop happens to be in. The
alternative — putting it wherever hop one lands — moves the file based on a judgement the
tool makes about someone else's code, and would relocate it whenever the journey is re-scoped.
Which repo owns a journey is a team decision, and running the command in that repo is how it
gets expressed.

**Symbol resolution is two-tier, not parsed.** Resolving `::symbolName` properly needs a
parser per language, which is a large per-language investment. Instead: does the file exist
(catches moves and deletes — most real drift), then does the symbol appear as a declaration
in it (grep-level, catches renames). Escalate to tree-sitter only if the grep tier proves
noisy in practice. Do not start with the parser.

**One committed JSON file, no service.** `flowmap.json` lives in the context repo and is
reviewed in PRs. No database, no deploy, no auth. The CLI and the UI read the same file,
so they cannot disagree.

**Zero dependencies, Node 18+.** This gets installed on 50 developers' machines and run in
CI. Every dependency is a reason for someone not to install it.

**flowmap never calls a model.** No API key, no SDK, no network beyond `git`. The tool does
the deterministic half — sync, grep, resolve anchors, validate shape — and emits a brief for
whatever agent the developer is already running to do the inferential half. An LLM call
inside the CLI would break zero-dependency, no-auth, and offline-capable in one move, and
would put a per-run cost on a command people should feel free to run constantly.

## Rejected alternatives

- **Per-repo `flowmap-card.json` pushed from each repo's CI.** The original design; see
  "Verify by sync" above for why it was reversed. Kept here because the objection behind it
  is still sound — if journeys ever routinely span 20+ repos, revisit.
- **Blocking CI checks / a `--strict` mode.** See "Advisory only." The request behind it is
  legitimate and the correct answer to it is a contract test in the producing repo, which
  owns its own ground truth and fails for reasons its author caused.
- **Vector DB over all repos.** Structure first, embeddings last. Semantic search over an
  unstructured dump answers "what is related to X" but never "where do I edit."
- **A "knowledge linter"** that anchors free-text notes to symbols and flags them when the
  symbol moves. Genuinely interesting, but it solves a documentation-rot problem this team
  does not currently have. Notes here are deliberately limited to one short line attached
  to an anchor.
- **Publishing standards (code/workflow/implementation) as one agent skill.** Split by
  invocation instead: enforceable code rules belong in linters and CI, workflow and
  implementation procedures belong in separate task-triggered skills. A monolithic
  "standards" skill triggers on everything vaguely and nothing reliably. Out of scope for
  this tool, noted so it does not get bolted on.
- **Force-directed graph as the primary UI.** Looks impressive, answers nothing. A journey
  is inherently ordered; the ordered list is what maps onto "where does my code go." A
  node graph is a reasonable *second* view for exploration.

## Agent consumption

`--format=agent` emits tab-separated, uncolored, deterministic lines. This is the contract
with the agent and should stay stable; changing the column order is a breaking change.

The token argument is the entire justification for the project:

- Agent greps 50 repos for where an order field flows: tens of thousands of tokens,
  minutes of wall time, and it still misses the async consumer.
- Agent runs `flowmap impact order.total --format=agent`: ~300 tokens, instant, complete.
  It then opens only the 4–5 anchored files it actually needs to edit.

Anything flagged stale must be marked as such in agent output. The agent's correct response
to a stale hop is to go read the source; it cannot make that call if the line looks
identical to a verified one.

The agent-file block that wires this up is in the README. Keep it short — around 15 lines.
Long always-loaded instructions defeat the purpose.

## Drafting journeys

`flowmap draft <name> --from <anchor>` produces a candidate journey for review. Four stages,
and the split between them is what makes agent output trustworthy here:

1. **Sync.** Clone the candidate repos shallow. Unlike `verify`, drafting cannot use a
   sparse checkout — it does not yet know which files matter, which is the whole question.
   Scope defaults to the whole registry, which is not the rejected crawl: the registry holds
   only repos someone deliberately added, typically a handful. The guard therefore trips on
   registry *size* rather than on a missing flag — above a dozen repos it demands `--repos`
   or an explicit `--all`. Putting the friction at the point where breadth actually costs
   something keeps the common case a single command.
2. **Search.** `flowmap search <string>` greps the sync cache for a contract identifier — a
   topic name, table name, endpoint path — and returns file hits grouped by repo. This is
   the deterministic core of drafting and it is worth having as its own command. Note what
   it fixes: the original problem was that async consumers have no call site to grep for,
   but they do reference the *topic name*. Searching for the contract identifier rather than
   the caller is what makes fan-out findable, and it is cheap because the repos are local.
3. **Scaffold.** flowmap writes `drafts/<name>.json` itself, populated with everything
   deterministic: the repo checkouts with their shas, the files that matched, and candidate
   anchors extracted from the real source. The agent edits that file rather than authoring
   one, which moves the boundary to exactly the right place — a machine settles what is
   findable, a reader settles what is meant. Offered anchors resolve by construction, so the
   commonest agent failure (a plausible invented path) is designed out rather than caught
   later. Scaffolding keys are `_`-prefixed and stripped on finalize, so they cannot reach
   the committed map. The scaffold must tell the agent to mark hops it is unsure of rather
   than drop them, for the same reason stale entries stay visible.
4. **Machine-check.** Run the draft through anchor resolution before a human reads it. An
   agent proposing anchors will invent plausible file paths; that failure is deterministic
   and free to catch, so no person should ever spend review attention on it.

Drafts land in `drafts/`, never in `flowmap.json`, and are invisible to `impact` and
`journey` until a human moves them in. A draft has not been reviewed at all, which is a
different and worse state than stale — do not model it with a flag on a live journey.

What survives to human review is therefore a journey whose anchors are known to resolve.
Review attention goes where the machine cannot help: scope and altitude. Expect drafts to
be wrong in a consistent direction — too many hops, no editorial judgment about which
repos matter — because that is the half that was never derivable.

## UI principles

`flowmap ui` serves `lib/ui.html` from localhost over the same `flowmap.json`. Offline:
no CDN, no web fonts, no build step. The visual metaphor is a transit rail — stops are
repos, segments are contracts — because the mental model is literally a route.

The impact filter (highlight hops touching a field, dim the rest) is the feature that
matters most; it is the visual form of the same query the agent runs. One backend, two
consumers.

Verification state belongs in the view — an unresolved or stale hop should be visibly
marked on the rail, for the same reason it is marked in agent output.

## Build order

Strictly sequential. Each step must pay for itself before the next.

1. One real journey in `flowmap.json`, hand-written or drafted. **A human reads every
   anchor and confirms it points where they would actually edit.** If drafting, the
   sync-and-resolve core has to exist first; that is fine, it is the same machinery `verify`
   needs and is shared, not spent twice.
2. Wire the agent block into one repo. Run a real cross-repo ticket. **If the agent's
   output does not visibly improve here, stop — the rest is not worth building.** Guard the
   circularity: if an agent drafted the journey and an agent is the thing being measured,
   step 1's human check is the only thing keeping this gate honest. Skip it and the gate
   measures whether a model agrees with itself.
3. `flowmap verify` — sync the involved repos to default branch, resolve anchors, write the
   `verified` block. Buildable this early precisely because no other repo has to adopt
   anything first.
4. Expand to the three or four journeys covering the most cross-repo work. Confirms the
   model fits the real codebase, which is the thing per-repo cards were meant to prove.
5. Run `verify` on a schedule and route drift to a human as a report. PR-time comment for
   local anchors if step 2 showed people read it.
6. Optional: static-publish the UI for people without local checkouts.

## Known gaps

- No automatic extraction of `produces`/`consumes` from source. `draft` plus `search` gets
  an agent most of the way by grepping contract identifiers across synced repos, but the
  result is a proposal, not extraction — it finds candidates, and a human still decides.
  `verify` only checks that a *declared* anchor still resolves; nothing finds a hop nobody
  ever declared. Per-language discovery remains the obvious next investment.
- Draft quality is unevenly checkable. Anchors get machine-verified, so the half an agent is
  most likely to fabricate is also the half that is free to catch. Scope and altitude — how
  many hops, which repos belong in the story — have no ground truth and get exactly as much
  review as a human gives them. Watch for drafts being waved through because the anchors
  came back green.
- Drafting needs fuller checkouts than `verify` does, so its cache is meaningfully larger on
  disk. Shallow keeps it bounded; if it stops being bounded, scope drafting harder rather
  than reaching for a sparse checkout, which cannot work when finding the files *is* the
  task.
- No integration with distributed tracing. If OpenTelemetry spans are available, the traced
  call graph is ground truth and is fresh by construction; diffing it against the declared
  journeys would surface both undocumented paths and dead ones. Anchor resolution is the
  static, cheap cousin of this. Tracing is the strongest available answer to staleness and
  should be considered before building more inference.
- `verify` needs read access across the involved repos. The push model only ever touched
  the local one, so this is a new requirement: a token with read scope on everything the
  journeys name.
- Verification is against a moving target. A hop can go unresolved because of a merge
  elsewhere, with no change here. This is why nothing blocks and why the `verified` block
  records SHAs — the useful output is a diff against last known good, not a bare failure.
- `impact` matches contracts by substring on field paths. Fine at current scale; will need
  real field-path semantics if contracts start sharing field names.
- No cycle detection in journeys. Currently they are assumed linear with fan-out.

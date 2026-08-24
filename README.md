# flowmap

An ordered, anchored description of how data flows across repos — for the agent about to
make a cross-repo change, and the human reviewing it.

The unit is a **contract** (an endpoint, an event topic, a table) with a **file anchor on
both sides**, which is what turns "these two services are related" into "open this line."

**flowmap is advisory.** It never fails a build, blocks a merge, or votes on a PR. Findings
always exit 0. It is a context reference, not a gate — see
[DESIGN.md](./DESIGN.md#decisions-and-rationale) for why that constraint shapes everything
else.

## The three commands

```
cd ~/repos/orders-api
flowmap draft journey checkout      # no setup — discovers the repos itself
flowmap show journey checkout       # diagram it, with payload fields and types
flowmap finalize journey checkout   # accept the reviewed draft into flowmap.json
flowmap visualize                   # interactive UI, with payload simulation
```

There is no setup step. Run `draft journey` inside the repo where the feature starts and
flowmap treats that repo as the journey's origin, greps every sibling repo in the same parent
directory, and registers only the ones that actually mention the feature.

The wide pass is cheap because those repos are already on disk: `git grep <term> <branch>`
searches a default branch **without checking it out**, so scanning fifty neighbours takes a
couple of seconds and clones nothing. Only the repos that matched get cloned.

```
$ flowmap draft journey checkout --seed order.created
scanning repos beside orders-api for order.created…
discovered 3 of 54 repos: orders-api (start), fulfilment 12, billing 3
  not on their default branch, only on the branch checked out locally:
    notifications  1 hit(s) on feature/order-emails
drafted checkout -> drafts/checkout.json

  3 repo(s), 15 candidate file(s), 63 anchor(s) ready to use
```

That second warning matters: flowmap maps **merged** code. A repo whose match lives only on
an unmerged branch is not in the map, and saying so beats reporting a confident zero.

`flowmap init`, `flowmap repo add`, `search` and `sync` still exist for when you want to
pin a scope by hand, but you rarely need them.

## Status

| Command | State |
| --- | --- |
| `init`, `repo` | built |
| `draft journey` / `--check` | built |
| `show journey` | built |
| `finalize journey` | built |
| `visualize` | built |
| `search`, `sync` | built |
| `journey`, `impact` | built |
| `verify` | built |

## Install

Zero dependencies, Node 18+. There is no build step.

```
git clone <this-repo> && cd flowmap && npm link
```

`npm link` puts `flowmap` on your `PATH`. Remove it later with `npm unlink -g flowmap`.

## Quick start

```
cd ~/code/orders-api
flowmap init                                    # creates flowmap.json AND registers this repo
flowmap repo add billing git@github.com:org/billing.git

flowmap draft journey checkout                  # your agent reads the brief and drafts
flowmap show journey checkout                   # you review the rail + diagram
flowmap finalize journey checkout               # you accept
flowmap visualize                               # explore it, simulate a payload
```

`flowmap.json` is found by searching upward from wherever you are, like `.git`.

### Default branches

Repos disagree about this — `main`, `master`, `develop`, `trunk` all occur, often in one
org. flowmap detects it per repo from the **remote**, records it, and never guesses. So
registering a repo while you sit on a feature branch still records the real default. If a
repo later renames its default, `sync` fails with the exact fix rather than a git trace.

Local paths are accepted as sources, but flowmap records that repo's **origin URL**, because
`flowmap.json` is committed and an absolute path resolves on one machine only. `--keep-path`
overrides.

## flowmap.json

One committed file. The CLI and the UI read the same one, so they cannot disagree.

```json
{
  "repos": {
    "orders-api": {
      "url": "git@github.com:org/orders-api.git",
      "branch": "main",
      "produces": [
        { "contract": "event.order.created", "anchor": "src/events/publish.ts::publishOrderCreated" }
      ]
    }
  },
  "contracts": {
    "event.order.created": {
      "kind": "event",
      "schema": "src/events/schemas/order-created.json",
      "fields": ["order.id", "order.total"]
    }
  },
  "journeys": {
    "checkout": {
      "description": "cart submit through to stock reservation",
      "hops": [
        {
          "repo": "orders-api",
          "inbound": null,
          "outbound": "event.order.created",
          "reads": "src/routes/checkout.ts::createOrder",
          "writes": "src/events/publish.ts::publishOrderCreated",
          "note": "persists the order, emits created"
        }
      ]
    }
  },
  "verified": {}
}
```

Anchors are `path/to/file.ts::symbolName`, repo-relative. Full shape in
[schema.json](./schema.json).

`verified` is written by `flowmap verify` and never by hand. Journeys are the opposite:
drafted by an agent, authored by a human.

## Commands

### `flowmap init`

Create a `flowmap.json` in the current directory and register the repo you are standing in.
Refuses to overwrite an existing map without `--force`; skip self-registration with
`--no-self`.

```
$ flowmap init
created ~/code/orders-api/flowmap.json
added   orders-api -> git@github.com:acme/orders-api.git (main)
```

### `flowmap repo add [<id> <url-or-path>]`

Register a repo. With no arguments it detects the git repo you are standing in, including
its origin URL and default branch.

```
$ flowmap repo add fulfilment ~/code/fulfilment
added fulfilment -> git@github.com:acme/fulfilment.git (main)
```

Also `flowmap repo list` and `flowmap repo remove <id>`. Pass `--branch <name>` to override
detection, and `--force` to update a repo that is already registered — which is how you fix
a renamed default branch.

### `flowmap search <string>`

Grep a contract identifier across the repos in scope.

```
$ flowmap search order.created --repos orders-api,fulfilment

orders-api — 1 hit
  src/events/publish.ts:1  const TOPIC = 'order.created'

fulfilment — 1 hit
  src/handlers/order.ts:1  // subscribes to order.created
```

Async consumers have no call site to grep for — but they do reference the topic name.
Searching the *contract* rather than the caller is what makes fan-out findable. Repos are
synced on first use, so this is a local grep.

### `flowmap draft journey <feature>`

Writes `drafts/<feature>.json`, already filled in with everything a machine can settle.

```
$ flowmap draft journey checkout --seed order.created
drafted checkout -> drafts/checkout.json

  2 repo(s), 2 candidate file(s), 2 anchor(s) ready to use

  orders-api
    src/events/publish.ts  1 symbol(s)
  fulfilment
    src/handlers/order.ts  1 symbol(s)

  then  flowmap draft --check checkout
```

The file arrives with `hops: []` and four scaffolding keys for the agent:

| key | what it carries |
| --- | --- |
| `_searched` | each repo's checkout path, branch and sha — read these directly |
| `_candidates` | matching files per repo, each with **ready-made anchors** from real source |
| `_hopTemplate`, `_contractTemplate` | the exact shape to copy |
| `_instructions` | the rules, restated where the agent is working |

Offered anchors are extracted from the checked-out source, so they resolve by construction —
an agent picking from the list cannot invent a path. `_` keys are stripped by `finalize` and
never reach `flowmap.json`.

`--seed` is the strongest input: a topic, table or endpoint name beats the feature name,
because a silent consumer never names its producer — only the identifier. `--force`
overwrites an existing draft; `--brief` prints the long-form brief instead.

### `flowmap journey <feature>`

The ordered hops. This is the cheap read path — it touches `flowmap.json` and nothing else:
no sync, no network, no checkouts.

```
$ flowmap journey checkout --format=agent
1	storefront	-	gql.createOrder	…::CheckoutForm	…::submitOrder	ok
2	orders-api	gql.createOrder	event.order.created	…::CheckoutResolver	…::publishOrderCreated	ok
3	fulfilment	event.order.created	-	…::onOrderCreated	-	unverified
```

Bare `flowmap journey` lists the journeys in the map.

### `flowmap impact <field>`

Every hop that carries a field, on both sides — a field arriving and a field leaving are
different edit sites.

```
$ flowmap impact order.total
order.total — 4 hop(s) across 2 journey(s)

  gql.createOrder order.total: number
  event.order.created order.total: number
  …
```

Matching is substring over field paths. Fine at current scale; see Known gaps in DESIGN.md.

### `flowmap show journey <feature>`

Prints the rail with every anchor resolved live, and writes `diagrams/<feature>.md` — a
Mermaid diagram plus a per-step table of fields, types and transforms. It renders inline on
GitHub, so it can go straight into a PR. `--mermaid` prints only the graph.

```
$ flowmap show journey checkout
checkout
   1  orders-api
      ✓ reads  src/routes/checkout.ts::createOrder:3
      ✓ writes src/events/publish.ts::publishOrderCreated:3
        · adds order.id (string) from persist()
        · renames total to order.total
        · drops cart_id
        │
        └─ event.order.created  (order.id: string, order.total: number)
        ▼
   2  fulfilment
      ✓ reads  src/handlers/order.ts::onOrderCreated:2
```

### `flowmap finalize journey <feature>`

Accept a reviewed draft. Looks in `drafts/` by name, so you only pass the journey name. It
merges the journey, folds in any `newContracts`, strips draft-only bookkeeping, and deletes
the draft.

```
$ flowmap finalize journey checkout
finalized checkout — 2 hops -> flowmap.json
  added contracts: event.order.created
  1 hop(s) were marked unsure by the drafter — worth a second look
```

Refuses if an anchor does not resolve — data integrity, not gating; no build or merge is
affected. `--force` overrides, `--keep-draft` keeps the file.

### `flowmap verify [<feature>]`

Re-check every anchor in the map against the repos' current default branches, and record
what was seen. Name a feature to check just that journey.

```
$ flowmap verify
  ok  storefront  2/2 anchors  main @ 7f1662b
  ok  orders-api  2/2 anchors  main @ f181d5b
  !!  fulfilment  3/5 anchors  main @ 2b9dad8
      moved 4c81e0a -> 2b9dad8 since 2026-05-01

  2 anchor(s) no longer resolve:
    checkout hop 3 reads  fulfilment  …::onOrderCreated
      symbol not found
```

It syncs **sparse**, one pass per import level: the directories the anchors and schemas name,
then — after reading what landed — exactly the directories those schemas import from, repeated
until the walk depth is covered. Measured across ten
real repos that is 17MB and 1–17% of each large repo, against 96MB if the cone is simply
widened to the top-level directory. A full run also touches every registered repo — but only when it has to: when some contract
names a schema by a bare path (no `<repo>/` prefix) and the registry is small enough to sweep.
Where every schema ref names its own repo, or the registry is large, only those repos are
fetched, and a "schema exists nowhere" verdict is withheld rather than guessed.

It also checks each contract against the file at its `schema` path — a declared field whose
name appears nowhere in its own schema is a strong signal, whatever the format:

```
  contracts: 1 disagree with their schema
    event.order.created — src/events/schemas/order.ts
      not found in the schema: order.discount
```

It also names registry entries nothing uses — no hop names them and no contract schema lives
there. Discovery registers a repo whenever it merely mentions the search term, so these
accumulate, and each one costs a clone on a full run.

A bare `schema` path that exists in more than one registered repo is reported **ambiguous**
rather than judged against whichever repo came first — qualify it as `<repo>/<path>`.

Schemas compose, so it follows relative imports three levels; searching only the named file
would report `OrderSchema.omit(...)` fields as missing. Three is measured, not guessed: on a
real contracts package, depth 2 gave a definite verdict on 3 of 7 contracts and depth 3 on 4
of 7, while depths 4 and 6 gave no further improvement. Schema graphs deeper or more indirect
than that are reported **inconclusive** rather than guessed at. Where a schema also composes from a
package it cannot read, the contract is reported **inconclusive** rather than failing —
a flagged unknown beats a false alarm. A `schema` that names a package rather than a file, or
is absent, is not a failure: there is simply nothing to check against.

Afterwards `journey` and `impact` report `status: ok` instead of `unverified`, and the
`verified` block in `flowmap.json` records the branch, sha, date and anchor tally per repo.

Because the sha is recorded, a re-run answers a better question than pass/fail: it
distinguishes *"this moved since we last looked, here is the range"* from *"this never
resolved, the map is wrong"*.

| flag | |
| --- | --- |
| `--local` | only this repo's anchors — the PR-time scope, where every finding is something the author could have caused |
| `--repos a,b` | scope to specific repos |
| `<feature>` or `--journey <name>` | scope to one journey — **reports but does not record**, see below |
| `--format=agent` | tab-separated; only anchors and contracts that need attention — a clean one is not news. Read the `status` column: `schema-inconclusive` means *could not tell*, not *broken* |

**A scoped run records only what it fully covered.** The `verified` record is per repo, so a
repo is recorded when the scope happened to resolve *all* of its anchors — the common case of
one journey per repo — and skipped when it did not, because recording a partial check would
mark another journey's hops `ok` without having looked at them and move the sha so the next
run reports no drift. The output names any repo it skipped for that reason.

**It never fails.** Findings exit 0, like everything else here. A broken anchor means the
map is out of date, not that someone's build should stop.

### `flowmap visualize`

Serves an interactive UI on localhost. No CDN, no web fonts, no build step; the page is one
file read from disk, and `flowmap.json` is re-read per request so edits show up on refresh.

The panel simulates a payload. You type what arrives at the first hop and flowmap replays it
through the `transform` ops each hop declares — ops that were read out of the code at draft
time and anchored to the file that performs them. **Nothing is sent anywhere**; no service
needs to be running.

What it surfaces:

- fields **added**, **renamed** or **dropped** at each hop, and where an added value comes from
- fields the outbound contract promises that **never arrived** — where a consumer breaks
- fields flowing through that **no contract declares** — the map admitting a gap
- hops with no recorded transforms, marked **untraced** rather than drawn as unchanged

That last pair matters: a simulation that quietly passed unknown fields through would look
complete while describing nothing.

### `flowmap sync`

Refresh the local checkouts. Shallow, and scoped to the repos you name.

## Repo scope

Commands default to every registered repo — the registry only contains repos you chose to
add, so for a normal context repo that is a handful. Above **12** registered repos flowmap
stops defaulting and asks for `--repos a,b,c` or an explicit `--all`, because a sweep that
wide is the crawl this tool exists to avoid.

## Working with an AI

The intended loop is two commands from you and the rest from your agent:

```
flowmap draft journey checkout      # agent runs this — writes drafts/checkout.json
                                    # agent reads the repos and fills in "hops"
                                    # agent self-checks: flowmap draft --check checkout
flowmap show journey checkout       # you review the rail and the diagram
flowmap finalize journey checkout   # you accept — the agent must never run this
```

The brief tells the agent to stop at `show journey` and leave accepting to you. That single review
gate is the whole reason a generated journey is trustworthy: anchors are machine-checked, so
your attention goes to scope and altitude, which no machine can judge.

Two ready-made skills live in `skills/` — copy them to `~/.claude/skills/` to get them in
every repo:

| skill | for |
| --- | --- |
| `/flowmap-draft-journey <feature>` | **building** a map: discovers the repos, drafts the hops, verifies its own anchors |
| `/flowmap-analyze <change>` | **using** one: which hops a fix touches, what downstream consumes it, which files to open |

`analyze` is where the map pays off. Reading a journey costs a few hundred tokens; sweeping
the repos costs tens of thousands and still misses the async consumers — which is the whole
argument for the tool.

## The agent block

Paste into your `CLAUDE.md` or agent file. Keep it short — long always-loaded instructions
defeat the point of the tool. (Or use the skill in `skills/flowmap-draft-journey/`.)

```markdown
### flowmap — cross-repo data flow

Before editing anything that crosses a service boundary, ask flowmap instead of grepping:

  flowmap journey <feature> --format=agent   # ordered hops for a named flow
  flowmap impact <field> --format=agent      # every hop carrying a field

Tab-separated, no header. journey: hop, repo, inbound, outbound, reads, writes, status.
impact: journey, hop, repo, side, contract, field, reads, writes, status.

Open the anchored files it names; do not sweep the repos to rediscover them.
A `status` of stale or unverified means that hop has not been checked against source —
read the file before trusting it.

For anything the map does not cover, search the contract identifier — the topic, table or
endpoint name — not the caller. Async consumers have no call site, which is the whole
reason this tool exists:

  flowmap search <contract-id> --format=agent

flowmap is a map, not an authority. It never blocks anything. A hop it does not list may
still exist, and anything reported as stale or unresolved has not been checked against
source — read the file before trusting it.
```

## Agent output format

`--format=agent` (or `--agent`) emits tab-separated, uncolored, deterministic lines with no
header. Cells never contain tabs or newlines.

| Command | Columns |
| --- | --- |
| `journey` | `hop`, `repo`, `inbound`, `outbound`, `reads`, `writes`, `status` |
| `impact` | `journey`, `hop`, `repo`, `side`, `contract`, `field`, `reads`, `writes`, `status` |
| `verify` | `repo`, `journey`, `hop`, `side`, `anchor`, `status`, `line` |
| `search` | `repo`, `path`, `line`, `text` |
| `draft --check` | `hop`, `repo`, `side`, `anchor`, `status`, `line` |

Contract findings reuse the `verify` columns rather than adding new ones: `side` is `schema`
and `anchor` carries `<contract>:<field>`. Their `status` distinguishes `fields-missing` (the
schema really does not declare it) from `schema-inconclusive` (the schema composes from
something flowmap could not read) — never treat the second as a defect.

A missing value renders as `-`, never as an empty cell, so columns never shift.

`status` on `journey` and `impact` is `ok`, `stale` (verified over 90 days ago) or
`unverified` (never checked). Run `flowmap verify` to turn `unverified` into `ok` — an agent
must be able to tell a checked hop from an unchecked one before deciding whether to trust it.

`status` is one of `ok`, `symbol-missing`, `file-missing`, `repo-missing`, `malformed`,
`absent`.

This is a stable interface. **Changing column order is a breaking change.**

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ran successfully — *including when it reported findings* |
| 1 | the tool failed to run (git error, unreadable file) |
| 2 | usage error (bad arguments, unknown repo id, unbuilt command) |

Findings are never non-zero. There is deliberately no `--strict` mode; if you want a build
to fail on a contract change, that is a contract test in the producing repo.

## Environment

| Variable | Effect |
| --- | --- |
| `FLOWMAP_FILE` | path to `flowmap.json` (default: nearest one, searching upward) |
| `FLOWMAP_CACHE` | checkout cache (default: `.flowmap-cache/` beside `flowmap.json`) |
| `NO_COLOR` | disable colored output |

## Tests

```
npm test
```

## Why it is shaped this way

[DESIGN.md](./DESIGN.md) covers the rationale and the rejected alternatives — why it pulls
instead of receiving pushed cards, why anchors come in pairs, why stale entries stay
visible, and why nothing here is ever allowed to block.

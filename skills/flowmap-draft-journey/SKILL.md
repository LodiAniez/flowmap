---
name: flowmap-draft-journey
description: Draft a cross-repo data-flow journey for a feature using the flowmap CLI. Reads how the feature actually behaves across the repos, fills in the draft JSON with verified anchors and payload transforms, and hands it to the user for review. Use when asked to map, trace, diagram, or document how a feature flows across repositories, or when the user runs /flowmap-draft-journey.
---

# Draft a flowmap journey

Map how one feature actually moves data across repos, and hand the user something to review.
The feature name is the argument; if none was given, ask for it first.

flowmap does everything deterministic — syncing repos, searching them, extracting candidate
anchors, checking your work. **You do the reading.** Do not reimplement its half by hand.

## Do this

**1. Create the draft. There is no setup step.**

```
flowmap draft journey <feature>
```

Run it from inside the repo where the feature starts. flowmap then:

- treats that repo as the journey's starting point,
- greps every sibling repo in the same parent directory, on its default branch, in place —
  no cloning, a couple of seconds even across fifty repos,
- registers only the ones that actually mention the feature,
- clones just those, and writes `drafts/<feature>.json`.

Add `--seed <identifier>` whenever you know one — a topic, table, queue or endpoint name. It
beats the feature name substantially, because a silent consumer never names its producer; it
only names the identifier. Add `--from <path::symbol>` if the user gave an entry point.

Read what it reports. Two lines matter:

- *discovered N of M repos* — the shortlist it will work from. If a repo you expected is
  missing, the feature is named differently there; retry with a better `--seed`.
- *only on the branch checked out locally* — that repo has the feature on an unmerged
  branch, so it is **not** in the map. flowmap describes merged code. Tell the user; do not
  quietly proceed as though the repo were irrelevant.

**2. Open the draft.** It arrives with `hops: []` and everything a machine could settle:

- `_searched` — each repo's checkout path, branch and sha. Read these paths directly.
- `_candidates` — matching files per repo, each with **ready-made anchors** extracted from
  the real source. Prefer these; they are known to resolve.
- `_hopTemplate` / `_contractTemplate` — the exact shape to copy.
- `_instructions` — the rules, restated where you are working.

**3. Read the code and fill in `hops`.** Open the checkouts in `_searched`. Follow the data,
not the imports: what arrives at this hop, what leaves it, who else references that
identifier. `flowmap search <identifier>` finds anything the scaffold missed.

**4. Edit the draft file** — replace `hops`, add any `newContracts`, write a real
`description`. Leave the `_` keys alone; `finalize` strips them.

**5. Check your own anchors.**

```
flowmap draft --check <feature>
```

Every one must resolve. Fix and re-run until they do.

**6. Show the user and stop.**

```
flowmap show journey <feature>
```

Report what you found, then say plainly that `flowmap finalize journey <feature>` is theirs
to run.

## Rules

- **Never run `flowmap finalize journey`.** Merging into `flowmap.json` is the user's call.
  It is the only review gate in the tool; taking it away is what would make a generated
  journey worthless.
- **Record `transform` by reading the code, never from the field names.** At each anchor,
  write down what the code actually does to the payload: `add` (with `source`), `rename`,
  `drop`, `pass`. `flowmap visualize` replays these literally, so an invented op yields a
  confidently wrong simulation — the worst output this tool can produce. Omitting a hop's
  transforms is fine and shows up as *untraced*. Making them up is not.
- **Two anchors per hop.** `reads` is where data arrives, `writes` is where it leaves, and
  they are usually different files. One anchor makes the next agent edit half the hop.
- **Record a real entry payload in `sample`.** Copy it from a fixture, factory or test in
  the source — real membership numbers, real shapes — not values you made up. Put real
  values on `add` ops too, via `value`. `flowmap visualize` seeds its simulator from these,
  so recorded values make the trace show what actually flows; invented ones make it fiction
  that looks authoritative.
- **Type the fields** where the code states the type: `{ "name": "order.total", "type":
  "number" }`. You are already in the source, and it is what makes the diagram and the
  simulation worth looking at.
- **Mark uncertainty, never drop it.** `"confidence": "low"` plus an `uncertain` note. A
  flagged guess is useful; a silently omitted hop is the exact bug flowmap exists to prevent.
- **A branch consumer is a real hop.** Fan-out is normal: two services consuming one event
  are two hops, and the second has no `outbound`.
- **Prefer too few hops to too many.** Anchors get machine-checked; scope does not. Scope is
  precisely what the user is being asked to judge, so do not pad it to look thorough.

## Reporting back

Say which repos the journey crosses, which hops you were unsure of and why, and anything the
search surfaced that you deliberately left out. Then hand over the finalize command.

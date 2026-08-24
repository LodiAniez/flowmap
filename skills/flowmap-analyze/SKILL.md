---
name: flowmap-analyze
description: Analyse an existing cross-repo journey before changing it. Reads the flowmap map to find which hops a fix or feature touches, which downstream repos consume what is about to change, and which anchored files to open. Use when about to modify or extend behaviour that crosses repositories, when asked what a change will affect or break, or when the user runs /flowmap-analyze.
---

# Analyse a flowmap journey before changing it

The user wants to fix or extend something inside a journey that already exists. Your job is
to tell them **which hops the change touches, what downstream will see it, and which files to
open** — before any code is written.

The map exists so you do not have to rediscover the architecture. Reading it costs a few
hundred tokens; sweeping the repos costs tens of thousands and still misses async consumers.

## Do this

**1. Find the journey.**

```
flowmap journey                      # lists the journeys in the map
flowmap journey <feature> --format=agent
```

Columns: `hop, repo, inbound, outbound, reads, writes, status`. If the change is not obviously
in one of the listed journeys, say so and ask — do not silently start grepping.

**2. If the change concerns a field, follow it.**

```
flowmap impact <field> --format=agent
```

Columns: `journey, hop, repo, side, contract, field, reads, writes, status`. `side` matters:
`in` is where the field arrives, `out` is where it leaves, and they are usually different
files. Both are edit sites.

**3. Check freshness before trusting any of it.**

The `status` column is `ok`, `stale` or `unverified`. Anything other than `ok` means that hop
has not been checked against source. Run:

```
flowmap verify
```

`flowmap verify <feature>` also works and is cheaper. It records a repo only when that one
journey covered all of the repo's anchors — usually the case — and tells you which repos it
skipped, so check that line before concluding a hop is verified. Either way it is a few
seconds and sparse-syncs only the anchored files.

If a hop still will not resolve afterwards, **the map is wrong about that hop** — read the
source and say so in your report; do not quietly work around it.

**4. Open only the anchored files.** The map already names them. Do not re-derive the
architecture by grepping the repos — that is the cost the map exists to remove. Use
`flowmap search <contract-id>` only for something the map does not cover.

**5. Report before changing anything.** See below.

## What to report

- **Hops to change** — repo, file, symbol, and what changes in each.
- **Downstream hops that will see it.** This is the point of the exercise. Fan-out is normal:
  a field added to an event reaches every consumer of that event, and a consumer has no call
  site pointing back at the producer. Name every one, including the ones nobody remembers.
- **Contracts affected**, and whether the change is additive (a new optional field) or
  breaking (a rename, a removal, a type change). Say which, plainly.
- **What the map does not cover.** It knows only declared hops. If you suspect an undeclared
  consumer, say so as a suspicion and offer to check with `flowmap search <contract-id>`.
- **Whether the map itself needs updating** — see below.

## Rules

- **Do not sweep the repos.** If you find yourself grepping several repos to reconstruct the
  flow, stop: either the journey covers it and you should read the map, or it does not and the
  honest answer is that the map is incomplete.
- **Never present an unverified hop as fact.** Say `verify` has not run, or run it.
- **A missing hop is a finding, not a gap to paper over.** If the change touches a repo the
  journey does not list, that is exactly the "forgot to update repo D" bug the map exists to
  catch — report it prominently rather than just adding the file to your list.
- **Distinguish additive from breaking.** A new optional field is safe to ship ahead of
  consumers; a rename is not. Consumers of the contract are the blast radius.
- **Do not edit `flowmap.json` as a side effect** of analysing. Changing the map is a separate,
  reviewed act — see the map-maintenance note below.
- **Do not run `flowmap finalize journey`.** That is the user's review gate.

## After the change

Code that moves invalidates the map. When the work lands:

- A renamed or moved symbol breaks an anchor — `flowmap verify` will catch it, and the anchor
  needs updating in `flowmap.json`.
- A new field on a contract should be added to that contract's `fields`, with its type.
- A changed payload transform should be updated on the hop, read from the code, not guessed.
- A genuinely new hop means re-drafting: `/flowmap-draft-journey <feature>`.

Mention which of these apply. An out-of-date map is worse than no map, because the next
person trusts it.

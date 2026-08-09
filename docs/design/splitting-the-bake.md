---
summary: How an amplification bake could be split across machines, and what it would
  cost. The unit is the CATCHMENT, not a rectangle, because nothing flows across a
  divide — which is also why the compute decomposition and the tile decomposition are
  two different things that must not be conflated. Includes the ocean skip, which pays
  off with no decomposition at all.
date: 2026-08-09
status: direction agreed. STEP 1 BUILT 2026-08-09 (`npm run harness:amplify`); nothing decomposed yet
---

# Splitting the bake

A bake at 8192² peaks near 2.6 GB and takes minutes; a 16384² tiled render is
wanted eventually. Both point at the same question: can the work be cut into
pieces that run on separate machines, and along what line.

## What is actually coupled

The pipeline (`runAmplification`) has three stages, and they differ completely:

| Stage | Coupling | Splittable |
|---|---|---|
| `amplifyElevation` — upsample, ridges, warp | per pixel, small radius | trivially, anywhere |
| `runErosionPass` | **downstream**: drainage area accumulates from divide to sea | along the flow structure |
| routing → discharge → river extraction | the same | the same |

The important word is *downstream*, not *global*. Erosion is not coupled to the
whole world; it is coupled to everything upstream of a cell.

## Why catchments, and not tiles

Nothing flows across a divide. A catchment is therefore the only region that can
compute its own erosion: it receives water from rain, and rain it knows.

A rectangular tile in the middle of a river system cannot. A river enters it from
outside, carrying a drainage area computed elsewhere. The micro-tile prototype
needed `buildTileInflow` and `burnMacroTrunks` for exactly this — machinery that
catchment cuts do not need at all. (That prototype was removed 2026-08-09; the
code is in the history and its findings in
[the removed-prototype note](../decisions/worldmap-amplification.md).)

**The partition already exists.** `computeWatersheds` labels every land cell with
its catchment, ordered by area, ocean excluded. It is the watersheds overlay
today; it is the same question.

**A halo is still needed.** The divide itself erodes, and thermal transport is a
neighbourhood operator, so each job takes its catchment plus a margin, erodes,
and keeps only the interior. Without it there is a visible seam along the ridge —
the one place the eye is naturally drawn.

## Two decompositions, deliberately different

This is where 16k comes in, and where the design is easy to get wrong.

- **Compute by catchment**, because that is where the physics is local.
- **Store and serve by tile**, because a viewer wants a rectangle.

The bridge is better than it sounds: **every pixel belongs to exactly one
catchment**, so two jobs never write the same pixel. There is no merge step and
no conflict rule — only a completion barrier. A tile is finished when every
catchment overlapping it is.

## Sizes: merging is free, splitting is not

Catchment areas are wildly unequal — a few enormous, thousands tiny.

**Merging small ones costs nothing.** They are independent, so a job is simply a
set of them, packed to a memory and time budget. One requirement: the packing
must be **deterministic**, derived from a sorted order rather than from which
worker happened to be free — otherwise the bytes depend on scheduling.

**Splitting a huge one is the expensive case.** It can only be cut at
confluences, and then flow does cross the cut, which brings inflow injection
back — the machinery catchments were chosen to avoid.

So: do not build it until it is needed. Measure whether the largest catchment of
a quarter-Earth at 16k actually exceeds the budget. If it does not, the hard part
never has to exist.

## Two numbers that belong to nobody

`maxDischargeOverLand` and `meanLandRunoff` set the channel threshold, and both
are defined over the whole world. A job cannot know them, and if each computed
its own, every catchment would get a different river density — visible at every
boundary.

They come from a **macro pre-pass** on the saved raster, which is cheap and needs
no amplification, and are handed to every job as constants.

## The macro pass is the gate

That pre-pass is not only the two scalars. It is also where the catchments are
labelled — so it produces the partition, the threshold and the job list in one
step.

Which means the ordering needs no new mechanism: without its output there are no
jobs to start too early. A gate by construction rather than by state.

## The ocean skip, which needs no decomposition at all

Most of the map is ocean, and it is the cheapest saving available — worth doing
on its own, and it applies to the 4K browser bake too, which is the measured
232-second case.

But "skip the ocean" must not mean "skip below sea level", and there are **two
different thresholds** because two different stages care about different things:

- **Erosion and deposition** stop below `SHELF_BREAK` (−140 m). Marine deposition
  is ON (`depositBelowSeaLevel: true`) and builds the deltas at river mouths, on
  the shelf, with a depth-graded freeboard. Skipping at sea level would silently
  remove a shipped feature.
- **Seeding** — the ridged detail — stops below `SLOPE_FOOT` (−3000 m). Between
  the two lies the continental slope: three kilometres of relief, a real
  landform, and visible when descending near a coast. Flattening it to save time
  on the abyssal plain would be a poor trade.

Both are already named constants in `elevationScale`, which is the module that by
its own account says what a height MEANS.

## Who declares an artifact complete

`meta.json` is written by whoever ran the bake — the browser for a local one, the
Job for a cluster one — and it is written LAST on purpose: a reader checks for it
to decide whether the stage is there at all, so an interrupted write leaves an
entry that reads as absent rather than as present-but-truncated.

That is defensible today, and it is the reason to keep it: there is exactly one
writer, `writeAmplificationArtifact`, shared by the browser and the Job. Having
the server produce the same file for cluster bakes would be two producers of one
format, which is the duplication this codebase spends its time removing.

**Splitting inverts the argument.** With N catchment jobs, no single one can
claim completeness — each knows only its own piece, and the first meta written
would tell every reader the bake was finished. `bakeMs` changes meaning too: the
duration of the WHOLE bake is known only to whoever waited for all of them.

So the rule the split needs is: **the completeness marker is written by whoever
knows the work is complete.** In the browser that is the browser; with a fan-out
it is necessarily the server's barrier, and the jobs write only their own bytes.

Worth doing as one rule rather than as "it depends": for server-side bakes the
server writes the meta, always. The way for a job to hand back what the server
needs already exists — it reports over `POST /v1/bakes/{id}/progress` as of
2026-08-09, and its result can travel the same road. The Kubernetes runner
returns no `Result` today on the grounds that fetching the pod's log back would
be a second connection; that objection is spent.

## What comes first: proving equivalence

The bake's terrain is an explicitly documented blind spot — the golden harness
does not cover it. A decomposed bake that produces *almost* the same field is
exactly the failure nobody sees, and it would poison every cached artifact under
a key that claims to describe the undecomposed one.

So before any of the above: bake a small world whole, bake it decomposed, compare
byte for byte. Everything after that is cheap to verify; without it, none of it
is verifiable at all.

## Order of work

1. **The equivalence check. BUILT 2026-08-09** as `npm run harness:amplify`:
   invariants, determinism and an opt-in byte baseline over a 256×128 macro baked
   at factor 2, in 13 s. It is the "whole bake" half of the comparison, and it
   closes a gap that existed regardless of splitting — the bake's terrain was
   covered by nothing at all. The decomposed half plugs in beside it at step 4.
2. **The ocean skip** — value immediately, no decomposition, both bake sizes.
3. **Catchment labelling in the macro pre-pass**, as an artifact.
4. **Region-limited erosion and routing.** This is where nearly all the real work
   is. `fillDepressionsAndRouteFlow` still carries the `bounded` parameter from
   the micro-tile prototype, which is what a region needs.
5. **Fan-out into N jobs plus a completion barrier.** The job model gains parents
   and children, and progress becomes a weighted sum of theirs — the reporting
   built 2026-08-09 is what makes that possible.
6. **The server writes the meta**, and the jobs stop doing it — a one-line rule
   with a fan-out barrier behind it.
7. **Tiled artifacts.** After which 16k is a question of budget rather than of
   architecture.

Steps 1–3 are small. Step 4 is the project. Steps 5–7 are bookkeeping.

## Related

- [worldmap-amplification.md](../decisions/worldmap-amplification.md) — rule 4,
  and why the macro raster stays the authority whatever the bake produces
- [distributed-bake.md](../decisions/distributed-bake.md) — the Job model this
  would fan out, and the progress reporting it would aggregate
- [resolution-strategy.md](./resolution-strategy.md) — why the simulation grid
  and the detail resolution are separate layers

---
summary: Fluvial incision draining into the WORLD OCEAN is floored at estuary depth (SEA_LEVEL − estuaryMaxDepthM, 20 m) instead of grading to its receiver's bed — which sat at shelf/slope depth and let erosion carve "ocean arms" hundreds of km into continents. Enclosed sub-sea basins stay exempt. The bake inherits the same floor (ALGO v5); a deliberate ria mechanism ("carve first, drown after") is deferred.
date: 2026-08-11
area: worldgen
stage: built
status: SUPERSEDED 2026-08-16 by the erosion-v2 engine (docs/design/erosion-v2.md) — the implicit solve handles base level properly, so the estuary clamp and its constant were deleted in the P5 teardown; the problem analysis here remains the record of why v1 needed one
---

# River-mouth base level

## The problem

Erosion could carve long, valley-like sub-sea channels from the coast far into
a continent. The mechanism, confirmed in code: stream-power incision clamps a
cell only to its D8 receiver's elevation (`erosion.ts`,
`runStreamPowerIterations`). At the coast the receiver is an OCEAN cell at
shelf or slope depth, so a coastal land cell could be cut that deep in a single
round — and the downstream-first (Gauss-Seidel) update order then propagated
the depth headward without limit. Because every land/ocean test in the pipeline
is a sign test plus 4-connectivity, the carved arm *became* ocean everywhere:
climate, biomes, rendering, hydrology.

Physically this is a base-level violation: a river grades to the water
SURFACE of what it drains into, never its bed. The code knew half of this —
`surfaceTuneParams.ts` documented "why river mouths are drowned estuaries
rather than deltas (drainage area, and therefore incision, peaks exactly where
a delta should build)".

Two aggravating factors:

- The macro pass partially refills carved arms every round via the coupled
  uplift (`upliftRate 0.15`, from the 2026-07-23 mountain-realism review —
  chosen there as "coupled relaxation in the finishing pass" over in-loop
  uplift, Cordonnier-style forcing capped at the tectonic envelope). The
  refill only applies where the ENVELOPE is land, which is exactly where the
  arms are — so on the macro grid the artefact was self-limiting-ish.
- The amplification bake runs with `upliftRate 0` (deliberate and correct:
  the envelope IS the finished macro world, uplift would undo the carving the
  bake exists for). Without the refill, sub-sea incision there was permanent —
  the presentation tier could flip macro LAND to OCEAN, against the spirit of
  worldmap-amplification.md rule 4 ("refine, never contradict"). The
  `upliftRate 0` rationale called pure denudation "the safer reading of the
  authority rule"; that is true in the height dimension and had a gap in the
  land/water dimension.

## Options

1. **Status quo** — arms stay, uncontrolled; mouth deltas stay mechanically
   impossible.
2. **Hard floor at SEA_LEVEL** — land never incises below 0. Cleanest physics,
   but no drowned mouth can exist at all; coasts risk reading too clean.
3. **Graded floor at SEA_LEVEL − ε** — mouths may drown to estuary depth
   (real estuaries run ~5–30 m), never to canyon depth. The arm mechanism dies
   because the length came from the depth.

## Decision (user, 2026-08-11)

**Option 3, ε = 20 m** (`SURFACE_TUNING.estuaryMaxDepthM`), with two
qualifications:

- **Ocean only.** The floor applies when the receiver is in the world-ocean
  component (the same `largestWaterComponent` mask the erosion pass already
  builds). Enclosed sub-sea basins are exempt: tributaries of a rift lake or a
  Death-Valley-style depression legitimately grade toward its floor, not
  toward sea level.
- **The bake inherits the floor unchanged** — no additional hard protection
  of macro-land cells. Fine-scale river mouths in the bake may still drown a
  few macro-land texels, but only estuary-deep; that is refinement, not
  contradiction. Considered and rejected: clamping macro-land cells at exactly
  0 in the bake (would make bake mouths inconsistent with macro mouths for a
  marginal purity gain).

Deferred, not rejected: a deliberate **ria mechanism** — run erosion with an
effectively lower sea, apply part of the water offset AFTER erosion, so
finished valleys drown with bounded depth (the physically true origin of real
rias). Wait until worlds without the artefact have been looked at; it may not
be missed. Would need a spec parameter and state across erosion passes.

## Consequences

- The floor propagates by construction: once a mouth cell is held at −20 m,
  every cell upstream inherits the bound through the plain receiver clamp.
- Deposition finally gets a chance to build mouth deltas against a graded
  (rather than collapsing) base level; whether it visibly does is to be judged
  by eye on real worlds.
- `AMPLIFICATION_ALGO_VERSION` → 5: every cached 4k/8k artifact is stale. The
  constant itself is hashed via `AMPLIFY_CONSTANTS`, so future retuning
  invalidates automatically.
- Saved worlds are untouched until re-eroded or regenerated.
- The golden harness's coastal metrics move; the baseline is re-recorded with
  this change.

## Measured (synthetic 256×128 harness world, floor off vs 20 m)

That world is an extreme case — 43 % of its water is enclosed — which is
exactly what made the exemption visible:

- Deep carved cells (> 25 m below sea) connected to the WORLD OCEAN:
  1126 → **0**. The artefact mechanism is dead.
- Estuary-depth carved mouths (≤ 25 m): ~1164 cells remain — the intended
  drowned mouths.
- Deep carving on ENCLOSED-sea shores remains by design (549 cells there).
  A world dominated by landlocked seas will still show deep shore incision;
  if that ever bothers, the knob is applying the floor to any water receiver,
  at the cost of terminal-basin realism.

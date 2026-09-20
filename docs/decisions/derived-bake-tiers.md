---
summary: Whether the amplification tiers (4K/8K/16K) stay independent bakes of the macro raster or become downsamples of ONE finest bake. Decided — derive them. Independent bakes of the same world disagree by 100–140 m RMS about the same ground, the disagreement is intrinsic (no erosion model makes independent solves of two grids agree pointwise — measured on the current model AND on the v2 prototype), and downsampling one solution makes every tier byte-consistent by construction. A fast provisional 4K stays as the immediate preview, replaced by the derived family in one visible, documented swap.
date: 2026-08-16
updated: 2026-08-16
area: platform
stage: agreed
status: BUILT 2026-08-16 (erosion-v2 P3 ④) — the finest (8K) artifact carries its coarser tiers as `family-<factor>/` files in the same entry (box-downsampled pre-quantisation, rivers shared with texel scaling on read), and the worldmap's ladder is provisional-sketch → ONE swap to the family, resolution-only within it. Still open — the in-game documentation of the provisional state (i18n keys to approve) and the provisional-4K UX; 16K as designated finest waits on the engine's MFD memory work.
---

# Derived Bake Tiers

## The fork

Today every amplification tier bakes independently from the macro raster
(decided 2026-08-07: "each stage bakes FROM THE MACRO raster, never from the
previous stage"). The alternative: bake ONE finest tier and derive every
coarser tier from it by downsampling.

## What decided it

Three measurements, in escalating order of finality:

1. **The tiers disagree, badly and systematically.** 8K vs 4K of the same
   world: 140 m RMS; 16K vs 8K: 100 m — mostly SMOOTH offsets (the finer
   tier denudes interfluves less and carves channels deeper), so every
   fetch-ladder swap visibly moves the terrain (2026-08-16).
2. **Chaining does not fix it.** A cascade prototype (refine 16K from the
   finished 8K) destroyed inheritance at every scale with one erosion round
   while a tapered dose lost the deep carving that makes a finer tier worth
   baking. See the near-field plan's measurement log.
3. **No erosion model fixes it.** The erosion-v2 P0 prototype — implicit,
   mass-conserving, equilibrium-seeking, with sub-grid closures — was built
   partly to test the hope that convergent physics would make independent
   per-tier solves agree. It made them agree LESS (464 m vs the current
   model's 144 m at 1024-vs-512, systematic +142 m), for a reason the
   literature already knew: **landscape-evolution equilibria converge under
   grid refinement statistically, not pointwise.** A coarse grid's every
   cell is a channel; a finer grid resolves hillslopes standing above the
   channels; the two fields differ by exactly that sub-grid relief,
   whatever the model. More physics resolves MORE resolution-dependent
   structure, not less.

The conclusion is architectural, not parametric: cross-tier consistency
cannot be computed into independent solves. It can only come from there
being ONE solve.

## The decision

- **One authoritative bake per world at the designated finest tier** (which
  tier that is — 8K or 16K — is pinned per pipeline version, so it is part
  of an artifact's provenance like everything else).
- **Every coarser tier is a box-downsample of it.** Produced at bake time
  and stored alongside (they cost a downsample, not a bake), or derived on
  read — an implementation choice, not a fork. Within the family, a tier
  swap changes RESOLUTION only, never the terrain: 4K = box(8K) = box(16K)
  exactly.
- **A fast provisional 4K stays.** The independent 4K bake is ~90 s and was
  measured (2026-08-08) to be the single biggest visual step over macro —
  it remains the immediate preview and the "rough visual check" tier while
  the finest bake runs. When the derived family lands, ONE swap replaces
  it. That swap is the only terrain-changing swap left in the system.
- **The provisional state is documented in-game** (user requirement,
  2026-08-16): the player-facing surface must say when terrain is the
  provisional sketch and when it is final — its own build step once the
  system stands, with catalog keys approved then. Rationale: the old
  ladder's silent swaps were the defect; the new ladder's one swap is a
  feature only if it is legible.
- **Nothing durable binds to the provisional tier.** Classification, the
  near-field channel field, and anything else that derives state from
  terrain binds to the derived family (or to macro), never to the sketch —
  this also resolves the hex classification's tier-stability question
  (its band no longer changes shape as tiers land).

## What this does to the authority question

Authority becomes explicitly three-layered, and the existing rule survives
intact at the top:

| layer | role | persisted? |
|---|---|---|
| macro 2048 | THE authority: identity, save, hashes — unchanged | yes (the only one) |
| designated finest bake | the single presentation truth below macro scale; every display tier and every terrain-derived consumer reads it or a downsample of it | no — deterministic f(macro, seed, version), cached in the artifact store like today |
| provisional 4K | a sketch: visible, labelled, replaceable, never load-bearing | no, and nothing may depend on it |

"Derived, never serialized, never fed back" keeps meaning what it meant:
the finest bake refines macro and may never contradict or re-enter it.
What changes is only WITHIN the derived world: one member of the family is
the source and the rest are views — authority without persistence.

## Consequences

- `AMPLIFY_BAKE_STAGES` / `AMPLIFY_FETCH_STAGES` change meaning: the ladder
  stops being "which independent bakes exist" and becomes "provisional
  sketch, then the family".
- The server bakes ONCE per world (the finest tier) instead of per tier;
  coarser artifacts are written from the same run. Total bake cost drops
  (today 94 s + 465 s + 2515 s for three independent bakes; then ~one
  finest bake plus downsamples).
- The cross-tier disagreement tables (hex-world-view.md measurement log)
  become historical: within the family the number is zero by construction.
- The near-field plan's step-3 display question ("537 MB tab") is
  untouched — this decides tier PROVENANCE, not tier residency; the
  sampling pyramid of decisions/near-ground-clipmap.md is the residency
  answer, and the two compose: the pyramid's levels ARE the derived family.

## Open

- Which tier is designated finest per deployment (8K today, 16K when the
  memory work lands?) and whether that choice is global or per world size.
- Store the downsampled family or derive on read (storage vs read-cost;
  the artifact store's eviction already handles either).
- The provisional-4K UX: how the sketch state is shown, where the one swap
  is announced (the in-game documentation step above).

---
summary: The worldmap gets its fine terrain from a one-time, deterministic AMPLIFICATION BAKE at load — upsample the 2048 macro raster to 8192×4096, inject seed roughness, run a few real erosion passes, then RE-RUN hydrology on the amplified field. The 2048 sim raster stays the sole authority and the only thing saved; the 8k layer is derived presentation, recomputed per load, never serialized. Below ~1 km, detail remains synthesis/regional forever.
date: 2026-08-07
area: generator
stage: building
status: decided; river threshold reversed 2026-08-08 (see point 2 — amplification now enriches the network instead of preserving it); phases 1–4 built 2026-08-07 (upsample + seed roughness + rescaled erosion + re-run hydrology with river ribbons, staged). SHIPPING AT 4096 — the 8192 target crashed Safari (tab OOM) and waits on the memory work; caching also still open
---

# Worldmap terrain amplification (the 8k bake)

The worldmap's descent view exposed what the generator never had to show:
below ~15 km wavelengths the world has no structure. Isotropic noise
synthesis (the current near-field patch) reads as felt, not landscape —
the eye reads *drainage*: connected valleys, tributary junctions,
ridgelines as the complement of channels. Only an erosion process
produces that connectivity; no local synthesis can, because every gully
has to lead somewhere.

## Decision

1. **Amplification bake at load, in the worldmap.** After reading the
   save, upsample the 2048×1024 elevation raster to **8192×4096**
   (~1.95 km/cell), inject deterministic seed roughness (bilinear
   upsampling alone is too smooth for erosion to carve — the
   micro-tile prototype learned this first, before it was removed), and run a small number
   of real erosion passes in a worker. One-time per load, fully
   deterministic (same world + params → identical result every time).
2. **Hydrology re-runs on the amplified field.** Rivers and lakes are
   re-extracted from the 8k field's own routing — the saved 2048 D8
   polylines would lie beside (not in) the new fine valleys, defeating
   the whole point. Climate/biomes stay at their coarse resolution and
   are merely sampled onto the fine grid as inputs (they are regional
   quantities; precipitation feeds the discharge as before).

   *The lake half was written here in 2026-08-07 and only IMPLEMENTED on
   2026-08-14: until then the bake re-extracted rivers alone, and the map
   drew 7.8 km macro lake blocks under ~2 km terrain — the mismatch that
   made river mouths and lake shores visibly fail to meet once the hex
   grid put a 300 m ruler against them. The bake now runs `computeLakes`
   on the routing and discharge it already has (so the added cost is one
   pass, not a second bake) and the artifact carries a `lakeDepth.u8`
   layer beside its elevation — the same one-byte quantisation the save
   gives its own lake layer, i.e. half the elevation layer's size rather
   than double it. Temperature therefore joins precipitation as a bake
   input: evaporation decides which basins stay wet. A REGION bake makes
   no lakes on purpose — a basin straddling two jobs would be flooded
   twice from two partial catchments — and a missing layer means "keep
   the save's macro lakes", never "there are none".*
   The channel criterion is a critical drainage area in CELLS
   (`densityToCriticalArea`) and is **used as one at every stage**.

   REVERSED 2026-08-08, having shipped the opposite for a day. The
   original rule multiplied it by 1/r² so the physical catchment stayed
   constant, on the strength of one measurement — channel length agreed
   within 4 % between factors 2 and 4, while dropping the rescaling drew
   6× the channels, read at the time as the "mesh of parallel lines" the
   density floor exists to prevent.

   The agreement was the problem, not the evidence for it. Holding the
   physical catchment constant means amplification cannot enrich the
   network at all — it hands back exactly what the finer grid won:

   | stage          | min basin  | junctions | length      | density |
   |----------------|-----------:|----------:|------------:|--------:|
   | macro 2048     | 39,991 km² |        12 |  13,087 km  |    1.23 |
   | 4k, rescaled   | 39,991 km² |        13 |  12,922 km  |    1.20 |
   | 8k, rescaled   | 39,991 km² |        10 |  12,929 km  |    1.19 |
   | 4k, as now     |  9,998 km² |       108 |  39,250 km  |    3.65 |
   | 8k, as now     |  2,499 km² |       721 | 101,165 km  |    9.33 |

   (density = km of channel per 1,000 km² of land; same world, 2 rounds,
   density 55.) Four times the vertices, the same twelve junctions.

   39,991 km² is too coarse to be right in the first place: the Thames
   drains 13,000 km², the Moselle 28,000, and neither would be drawn.
   The density slider cannot rescue it either — `AREA_MIN` floors it at
   150 cells, still 9,126 km² on the macro grid. The slider is capped by
   the grid, and refining the grid is the only thing that lifts the cap.

   On the noise objection: the 6× reading counted channels and inferred
   an artefact. Decomposed, it is not one. The parallel-line failure is a
   CELL-COUNT property — too few cells supporting a channel — and a
   constant cell threshold holds that support constant (657 cells against
   a floor of 150) at every stage. Mean tributary length falls 190 km →
   84 km, which is tributaries rather than fragments, and junctions rise
   60× where mere fragmentation would not move them.

   **Still unjudged: how it LOOKS.** The structural case is measured, the
   aesthetic one is not, and the stages now deliberately differ — a finer
   map shows more rivers, as a real map does when you zoom in.

   Consequence: `AMPLIFICATION_ALGO_VERSION` → 3, so every 4k/8k artifact
   already cached locally or on a server is stale and must be rebaked.
3. **The bake erodes with the WORLD'S OWN erosion settings.** A save
   records `spec.erosion.erosionStrength` / `drainageRefresh` (the
   generator restores them into its sliders on load); the bake reads the
   same two values, so a world tuned for gentle incision does not come
   back from amplification carved like an aggressive one. The
   slider→params mapping lives in `erosion.erosionParamsWithControls` so
   both the generator's erode request and the bake apply it identically.
4. **The 2048 raster remains the sole authority and the only persisted
   form.** The amplified field is a derived presentation layer: never
   written into the save, never fed back into the generator, allowed to
   *refine* the macro shapes but never to contradict them. If game rules
   ever need official fine heights, the server reproduces the same
   deterministic pipeline — that is a known, accepted consequence.
5. **The ladder below ~1 km stays non-global.** 300 m hex-scale truth
   globally would be a 53k×27k grid — permanently out of reach. The
   agreed staging around this bake:
   hydrology-aware synthesis (shape the fine sampler with the save's own
   rivers/discharge — Génevaux-style "terrain from the river graph") →
   **this bake** → erosion-shaped detail normals + biome albedo in the
   shader (the industry's last mile; albedo carries more perceived
   detail than geometry) → regional micro-tile refinement in the hex
   era.

## Biomes on the amplified terrain (2026-08-09)

The Whittaker classification is **pointwise**, so it rides along for one pass
rather than needing a model. The worldmap now re-derives biomes from whatever
raster is current — macro at load, amplified after each bake stage — at the
paper texture's own resolution. That replaces upscaling the saved ids through a
domain-warped coordinate: a guess at what lies between two macro cells, where
the elevation at every texel is in fact already known.

**Recomputed, never stored.** One pointwise pass over an elevation raster that
has to be loaded anyway, against +8.4 MB at 4k / +33.6 MB at 8k in the artifact
store. The store exists to avoid the bake's *minutes*, not seconds.

**Two things had to come from elsewhere, and both follow rule 4** — the bake may
refine macro shapes, never contradict them:

- **The riparian effect** (rivers greening their surroundings) is now saved as
  `precipitationEffective`, a climate-resolution field (64 KB). Re-deriving it
  at bake resolution would mean routing and accumulating flow over 8 million
  cells per load to recover something regional. See queryable-world-save.md.
- **Salt flats and dry basin floors** are hydrology states the classification
  cannot reach; they are carried over from the saved macro biome ids.

**The one real trap, found before it shipped:** the coarse temperature field
carries a lapse correction for the elevation *the generator sampled*, so
reclassifying elsewhere has to undo it against **that** raster, not the one
being classified. Undoing it against carved terrain adds back more than was
subtracted. Measured at factor 2 with one erosion round: mean error only
−0.05 °C, but **−9.7 °C at the worst cell and 2.16% of land texels
misclassified** — small in the average, large exactly in the mountains this
feature exists for. Hence `computeBiomesFine`'s separate `seaLevelTemperature`
parameter.

**Honest gain at factor 2** (which is what ships): 5.7% of land texels differ
from the macro answer and biome boundary length rises 14%. Modest, because 4096
is only twice the macro grid — the mechanism scales with the bake factor, so 8k
would show more. Alpine area *shrinks* 4.7%, which is correct rather than a
regression: erosion runs with `upliftRate 0` and can only cut, so the carved
ridges hold slightly less ground above the treeline.

**What does NOT get finer, and must be said every time:** precipitation,
seasonality and monsoon stay at 62 km. The classification interpolates them, but
interpolation is not information. So this sharpens the elevation-driven
boundaries — treeline, alpine, valley warmth — and leaves rain-driven ones where
they were. In mountains that is the visible half; on a plain nothing changes.

## Why this does NOT overturn resolution-strategy.md

That doc argues 8192 is "the wrong direction" — for the **authoritative
sim grid**: per-pass cost in the epoch loop, several ~130 MB arrays in
the frozen snapshot, a server save that must stay small. All of that
still holds and none of it applies here: this layer is not the sim grid,
not part of the snapshot, not serialized at all, and runs exactly once
per load outside any epoch loop. Its "compositing caveat" (coarse
erosion upsampled goes mushy; high frequencies must come from a finer
process) is in fact the argument FOR re-eroding at the fine grid rather
than upscaling alone. The doc's procedural "micro layer" remains the
plan below this bake's reach.

## Costs, honestly

Resolution-strategy's estimate stands, and the full chain has now been
measured end to end (2 erosion rounds, synthetic world, Node/CPU):

| tier | seed | erosion | hydrology | total | peak memory |
|---|---|---|---|---|---|
| 4096×2048 | 0.3 s | 99 s | 3 s | **~102 s** | ~0.2 GB |
| 8192×4096 | 1.9 s | 431 s | 11 s | **~444 s** | **~3 GB** |

The 8k tier is therefore real but heavy — and the browser test settled
it: **tried in Safari (2026-08-07) the 8192 stage exhausted the tab's
memory and the browser reloaded the page.** So three gigabytes is not a
theoretical risk here, it is a crash.

Two consequences. The bake is **staged** (4096 lands first and is
swapped in; a deeper stage would follow), and a failed stage **degrades**
to the last good result — but note the limit of that safety net: a stage
that takes the whole *tab* down cannot be caught by `worker.onerror`, so
degradation covers a dead worker, not a dead page. Shipping default is
therefore `AMPLIFY_STAGES = [2]`; **8192 stays the target but waits on
the memory work**, not on a flag (memory audit, then basin decomposition
with per-basin workers — see
[amplification-artifacts.md](../design/amplification-artifacts.md)).

The measured cost also raises the value of caching considerably — a
multi-minute recomputation per load is a different proposition from a
one-minute one. Remaining implementation questions:

- ~~**Pass budget**~~ — **answered 2026-08-07 by measurement**: mean local
  relief (land above 1 km) goes seeded 162 m → 197 m after one round, then
  202 / 204 / 206 m after 2 / 3 / 5, at a linear ~50 s per round at 4096².
  The first round carries ~80 % of the gain; **two rounds** ship
  (`AMPLIFY_EROSION_ROUNDS`), keeping the valley-widening the second round
  exists for without paying for the flat part of the curve.
- ~~**Staging**~~ — **built 2026-08-07** (`AMPLIFY_STAGES = [2, 4]`): each
  factor is baked in turn and swapped in when it lands, so an amplified
  world arrives in ~100 s and sharpens later. Every stage bakes from the
  MACRO raster, never from the previous stage's output — re-amplifying
  invented detail would compound it, and rule 4 says derived tiers come
  from the authoritative one. A stage that dies leaves the last good
  result on screen (see the measured 8k cost below).
- **Caching** — recompute per load first (determinism makes it free of
  correctness risk); a cache keyed by a world hash is the obvious
  amortization, and at seven minutes per load it is a good deal more
  attractive than it looked when this was written. The zip stays
  untouched (30–70 MB of baked layers in every save is not worth it) —
  but a *separate* artifact store, local or server-side, is a different
  thing and is not excluded by that. Options and analysis:
  [amplification-artifacts.md](../design/amplification-artifacts.md).
- ~~**Constant rescaling**~~ — **derived and verified 2026-08-07**
  (`amplify.erosionParamsForCellSize`): with refinement 1/r, a
  neighbour slope scales by r and a cell-counted drainage area by 1/r², so
  **talusSlope** must be multiplied by r (it is a real angle converted
  through the cell size — leaving it would plane the mountains) and
  **transportCapacityKt** by r (capacity Kt·A·S grows as 1/r otherwise);
  **stream-power incision is scale-invariant** at m = 0.5, n = 1 because
  Aᵐ ∝ 1/r cancels Sⁿ ∝ r — which also means this stops holding if those
  exponents are ever retuned. Checked against measurement: eroded local
  relief 309 / 342 / 355 m at three cell sizes of the same world (a wrong
  rescaling shows up as factors, not percent).
- **Ocean cells** — most of the 33M cells buy nothing; masking or
  coarsening ocean is one of the optimizations if the budget hurts. See
  [amplification-artifacts.md](../design/amplification-artifacts.md) for
  the fuller set (memory audit, basin decomposition + parallel workers,
  GPU) and what each one actually buys.

## Rejected alternatives

- **Synthesis only** — no connectivity, stays felt (it remains as the
  sub-km garnish, not the answer).
- **Bake amplified layers into the save** — balloons every zip by tens
  of MB for something deterministically recomputable.
- **Raising the generator's global resolution** — re-litigated and
  re-rejected; see resolution-strategy.md, whose reasoning is untouched.
- **Regional-only refinement now** — the micro-tile lineage stays the
  hex-era plan; its tile-seam drainage problem is real work and the 1–8
  km band (the visually weakest today) is exactly what a global bake
  fixes wholesale.

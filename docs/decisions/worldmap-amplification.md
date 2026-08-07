---
summary: The worldmap gets its fine terrain from a one-time, deterministic AMPLIFICATION BAKE at load — upsample the 2048 macro raster to 8192×4096, inject seed roughness, run a few real erosion passes, then RE-RUN hydrology on the amplified field. The 2048 sim raster stays the sole authority and the only thing saved; the 8k layer is derived presentation, recomputed per load, never serialized. Below ~1 km, detail remains synthesis/regional forever.
date: 2026-08-07
status: decided; phases 1–2 built 2026-08-07 (upsample + seed roughness + rescaled erosion, at factor 2) — hydrology re-run, the 8192 target, caching and staging still open
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
   `tileErosion` micro-tile learned this first), and run a small number
   of real erosion passes in a worker. One-time per load, fully
   deterministic (same world + params → identical result every time).
2. **Hydrology re-runs on the amplified field.** Rivers and lakes are
   re-extracted from the 8k field's own routing — the saved 2048 D8
   polylines would lie beside (not in) the new fine valleys, defeating
   the whole point. Climate/biomes stay at their coarse resolution and
   are merely sampled onto the fine grid as inputs (they are regional
   quantities; precipitation feeds the discharge as before).
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

Resolution-strategy's estimate stands: ~33M cells ≈ 2.5 min per erosion
pass (CPU) — several passes means a multi-minute one-time bake, plus
sizeable transient memory (~1 GB across the working arrays) and a
priority-flood + routing pass for hydrology on top. That is the price of
"8k is a must" (user, 2026-08-07). Implementation questions left open,
deliberately:

- ~~**Pass budget**~~ — **answered 2026-08-07 by measurement**: mean local
  relief (land above 1 km) goes seeded 162 m → 197 m after one round, then
  202 / 204 / 206 m after 2 / 3 / 5, at a linear ~50 s per round at 4096².
  The first round carries ~80 % of the gain; **two rounds** ship
  (`AMPLIFY_EROSION_ROUNDS`), keeping the valley-widening the second round
  exists for without paying for the flat part of the curve.
- **Staging** — possibly bake 4096 first (~4× cheaper, interactive in
  ~a minute) and refine to 8192 in the background, swapping surfaces
  when ready.
- **Caching** — recompute per load first (determinism makes it free of
  correctness risk); an IndexedDB cache keyed by a world hash is the
  obvious amortization if the wait annoys. The zip stays untouched
  (30–70 MB of baked layers in every save is not worth it).
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
  coarsening ocean is the first optimization if the budget hurts.

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

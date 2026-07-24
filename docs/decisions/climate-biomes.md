---
summary: Static, latitude-based climate (temperature + precipitation + wind + ocean currents) computed at world-gen time, feeding a Whittaker biome classification. No dynamic weather.
date: 2026-07-24
status: designed; not implemented
---

# Climate & Biomes

Follows tectonics + erosion in the world-gen pipeline. Produces the static
climate fields a biome classification needs; **no dynamic weather** is
simulated for generation (local weather, if ever, is a runtime/visual layer,
fully separable). Designed 2026-07-24; not built.

## Goal & scope

Turn the finished topography into a believable-not-accurate climate, then into
biomes. "Only as much simulation as biomes need" — which turns out to be
**zero dynamic simulation**: biomes want static per-cell **mean temperature +
mean precipitation + seasonality**, so the whole step is static field
computation. Large-scale structure is **prescribed** (latitude bands, the
three-cell wind pattern) rather than solved from fluid dynamics; derived fields
(ocean currents, moisture) use simple advection/relaxation.

## Topology framing

The world is a flat torus (wraps in x and y), but for climate we treat it as an
**equirectangular (cylinder) projection of a sphere** — a pure design decree,
no physical justification needed.

- **Latitude** `φ = |y − H/2| / (H/2)` ∈ [0,1]: the horizontal midline (y=H/2)
  is the **equator** (φ=0, hot), the top/bottom edges are the **cold pole
  seam** (φ=1). Because both edges are the *same* glued seam, the two
  hemispheres are **mirror images** — self-consistent (cold-to-cold across the
  wrap) and simpler than a real sphere (no N/S asymmetry).
- **Not a function of axial tilt.** The base gradient is latitude; tilt would
  only add a seasonal wobble (the thermal equator migrating over the year).
  Dropped for the static baseline; seasonality is captured as an *amplitude*
  (below), not a moving sun.
- **Coriolis sign** flips across the midline (`sign(y − H/2)`): "northern"
  above, "southern" below — sets wind deflection and gyre rotation sense.
- Band latitudes: Hadley cell φ∈[0,⅓], Ferrel φ∈[⅓,⅔], Polar φ∈[⅔,1] (i.e.
  the "30°/60°" boundaries at φ=⅓, ⅔).

## Computation pipeline

Ordered; each stage outputs a field on a coarse climate grid (climate is
smooth — a coarse raster + sampling is plenty; elevation is read from the
full-res post-erosion field where needed, for lapse + orographic).

1. **Base temperature.** `T_base(φ)` decreasing equator→pole (cosine-ish).
2. **Lapse rate.** `T −= lapse · max(0, E − seaLevel)` (~6.5°C/km analog).
   Higher = colder. Uses the raft/erosion relief directly.
3. **Prevailing wind (prescribed 3-cell).** Per latitude band: trade
   easterlies (Hadley), westerlies (Ferrel), polar easterlies; meridional
   component toward the rising branches (ITCZ at equator, ~60° front) and away
   from the sinking ones (~30°, poles); zonal sign from Coriolis. One vector
   field `W(x,y)` — it drives currents + moisture **and** is surfaced as a wind
   overlay.
4. **Ocean currents (gyres) + SST.** Wind stress over ocean → surface currents,
   deflected by Coriolis, constrained tangential to coastlines → closed
   **gyres per basin** (subtropical ~30°, subpolar ~60°, opposite rotation).
   Advect a sea-surface-temperature field along them: **warm western boundary
   currents** (Gulf-Stream-like → mild high-latitude coasts), **cold eastern
   boundary currents + upwelling** (→ coastal deserts, Atacama/Namib). Coastal
   land temperature is nudged toward nearby SST.
5. **Continentality.** Distance-to-coast (distance transform) → interiors get
   larger seasonal swing + less moisture; coasts get their mean moderated
   toward SST.
6. **Temperature final.** `T_mean(x,y)` = base − lapse + coastal-SST +
   continental adjustments. `T_amplitude(x,y)` = seasonal swing (grows with
   latitude and continentality, damped near ocean) — the requested seasonality.
7. **Precipitation.**
   - **Latitudinal skeleton** `P_band(φ)`: wet equator (ITCZ), dry ~30°
     (subtropical high — the great deserts), wet ~60°, dry poles.
   - **Moisture advection + orographic.** Moisture evaporates over ocean
     (∝ SST), is advected downwind (`W`), and rains out on forced ascent —
     **windward mountain slopes wet, lee = rain shadow** — depleting inland.
   - Combine into `P_annual(x,y)`.
   - **Aridity** = `P / PET` where PET ∝ temperature — separates hot-dry
     (desert) from cold-dry (tundra); both feed biomes.
8. **Biomes (Whittaker).** Per cell `(T_mean, P_annual)` → Whittaker class
   (~9–12: tropical rainforest, tropical seasonal/savanna, subtropical desert,
   temperate rainforest, temperate seasonal forest, Mediterranean
   woodland/shrub, temperate grassland/cold desert, boreal/taiga, tundra),
   plus ocean, ice, and an alpine override above the treeline. Seasonality
   splits savanna vs rainforest (dry-season length); tune the set down later
   if it's too many.

## Decisions (locked)

- **Static fields only**, computed at gen time; no dynamic weather for biomes.
- **Real-ish units** — temperature in ~°C, precipitation in ~mm/yr — so the
  Whittaker thresholds are directly usable and tuning is intuitive.
- **Full driver stack** — lapse, orographic/rain-shadow, continentality, gyre
  ocean currents, aridity — not a latitude-only first cut.
- **Seasonality as a mean + amplitude** pair, not a time-varying sim.
- **Ocean currents via the gyre computation** (not a cheap coast heuristic) —
  but the *method* is not fixed: **revisit + prototype it on the coarse grid
  before implementing Phase 4** (the one genuinely open algorithm here).
- **Wind is a surfaced overlay** (immersion + gameplay), not just an internal
  input. Uses the existing `MapOverlayCompositor` (wind_on/off icons already
  in the repo).
- **Whittaker biome set** (~9–12), tunable later.
- Latitude = `|y − mid|`, symmetric hemispheres, Coriolis flips at the midline.
- **Land/ocean = `elevation > seaLevel`, not raft membership** — climate cares
  where *water* is (evaporation source, thermal moderation), so a submerged
  shelf is ocean. Climate never needs the rafts.
- **Orographic precip samples the full-res elevation**, even though the base
  climate grid is coarse: rain shadow needs the fine elevation *gradient* along
  the wind, which a coarse grid averages away. The one place "coarse" would
  otherwise disappoint.

## Integration & invalidation

- A new **`worldgen/climate/`** module, called **in the worker after erosion**
  (analogous to `runErosionPass`) — it needs the final, optionally-eroded
  elevation. Produces the coarse rasters, sent to the main thread for overlays.
- A **manual "compute climate" button** in a new climate panel (like Erode),
  not automatic — so the user erodes (or not) first, then computes climate on
  the current topography.
- **Invalidated when an upstream step is reset/re-run** (new tectonics or
  erosion changes the topography → the climate rasters are stale and must be
  recomputed).
- Coarse climate grid (start ~256×128, like the ocean-age field); revisit if
  too coarse. Elevation sampled from the full-res field where needed (lapse,
  orographic).

## Pipeline placement

`tectonics → erosion (+drainage skeleton) → CLIMATE (this) → rivers/lakes
(drainage × precip) → biomes`. Climate needs post-erosion elevation; its
moisture source is the **ocean** (known before rivers exist), so no
circularity. Rivers/lakes then combine erosion's drainage network with this
step's precipitation; biomes consume climate (+ water). See
[world-gen.md](../design/world-gen.md) for the overall pipeline and the
rivers/lakes split (channel geometry = erosion's, discharge/fill = climate's).

## UI / overlays

A climate panel (like the erosion panel), with a few global knobs (e.g. overall
temperature offset / "greenhouse", overall humidity, seasonality strength) and
**toggleable overlay layers** via `MapOverlayCompositor`: temperature,
precipitation, wind (arrows/streamlines), ocean currents, biomes. Each stage
below produces a visible overlay, so the build is incrementally verifiable the
way the raft work was.

## Phasing (each phase = a visible overlay)

1. Base temperature (latitude) + lapse rate → temperature overlay.
2. Prescribed 3-cell wind field → wind overlay.
3. Precipitation: latitudinal bands + moisture advection + orographic/rain
   shadow → precipitation overlay.
4. Ocean currents (gyres) + SST → coastal temperature adjustment. **Prototype
   the gyre method on the coarse grid and eyeball it before committing** — the
   one algorithmically open stage.
5. Continentality + seasonal amplitude.
6. Aridity + Whittaker biome classification → **biome map** (the payoff).

## Deferred / out of scope

- Dynamic local weather (runtime/visual only; not for generation).
- Monsoons (seasonal land–sea wind reversal), albedo–ice feedback, ocean heat
  inertia beyond the current field — nice-to-have refinements, not needed for a
  first believable biome map.
- Axial-tilt-driven true seasons (the torus makes hemispheres symmetric; the
  amplitude model covers what biomes need).

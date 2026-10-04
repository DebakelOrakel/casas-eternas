---
id: DEC-0004
title.en: Climate & Biomes
title.de: Klima und Biome
summary.en: Static, latitude-based climate (temperature + precipitation + wind + ocean
  currents) computed at world-gen time, feeding a Whittaker biome
  classification. No dynamic weather.
summary.de: Statisches, breitenabhängiges Klima (Temperatur, Niederschlag, Wind,
  Meeresströmungen), berechnet bei der Weltgenerierung, als Grundlage einer
  Biom-Klassifikation nach Whittaker. Kein dynamisches Wetter.
area: generator
stage: built
createdAt: 2026-07-24
updatedAt: 2026-09-20
concepts: [generator.concept.climate-classes, generator.concept.pressure-and-wind, generator.concept.ocean-currents, generator.concept.seasons]
related: [DES-0021]
---

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
4. **Ocean currents (gyres) + SST.** *(Built — method validated by prototype.)*
   Wind-stress **curl** forces a **streamfunction** ψ solved by relaxation with
   ψ=0 on land, so the flow is automatically tangent to coastlines and closes
   into basin-scale gyres (no explicit Coriolis/boundary bookkeeping). Velocity
   is derived from ψ (non-divergent). A sea-surface-temperature field is advected
   along it: **warm western ocean boundaries** → mild EASTERN continental coasts,
   **cold eastern ocean boundaries** → cool WESTERN continental coasts (coastal
   deserts). Coastal land temperature gets a maritime band (the SST anomaly
   propagated a few cells inland, decaying). A pure Poisson ψ gives symmetric
   gyres (no western intensification), which is enough because the *sides* — and
   thus the coastal warm/cold pattern — come out right; validated against exactly
   that (W-coast cold, E-coast warm, mirror-symmetric). Precipitation runs after
   this, so evaporation sees the current-adjusted temperature.
5. **Continentality + seasonal amplitude.** *(Built.)* Continentality = a
   distance-to-nearest-ocean transform (0 at coast → 1 deep inland). It drives
   the **seasonal temperature amplitude** (the annual summer−winter range):
   `MAX·φ × (coastFloor + (1−coastFloor)·continentality)` — ~0 at the equator,
   rising toward the poles, and far larger in continental interiors than on
   maritime coasts (ocean cells stay low, thermal inertia). Biomes read
   `T_mean ± amplitude/2`. (Continentality's drying effect is already covered by
   Phase 3's inland moisture depletion, so it isn't re-applied to precip here.)
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
   if it's too many. **Alpine override built 2026-08-06** (see
   `climate/biomes.ts`): a fixed global elevation threshold (2800 m, not
   latitude-dependent — see `ALPINE_TREELINE_ELEVATION`'s own comment for why
   a fixed value is the useful signal here, not a re-derivation of what the
   lapse rate already gives) reclassifies any cell above it to Alpine, except
   ones already cold enough to be Ice. "Mediterranean" was folded into
   Woodland rather than getting its own class — the shipped set has 12 ids
   including Alpine, within the original ~9–12 target.

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
- **Revisited 2026-08-08 — and the answer was to split the question.** The
  climate *model* stays coarse: temperature bands, winds and moisture advection
  are genuinely regional, the advection is iterative, and 64× the cells would
  buy little. But the biome *classification* is pointwise, and its sharpest
  input — elevation — already exists at full resolution, so it now runs on the
  world raster (`computeBiomesFine`) for one extra pass over an existing field.
  A 62 km cell decided a whole massif from one sampled elevation, which is why
  there was no treeline: `Alpine` is an elevation test, so a mountain came out
  alpine wholesale or not at all. Measured on the calibration seed: 15.2% of
  land cells now classify differently from the coarse cell containing them,
  biome boundary *length* roughly doubles, and inside the coarse cells that
  were called Alpine only 74% of the ground actually is — 927 of those cells
  now hold a boundary against 108 that are alpine throughout, plus 7,442 fine
  alpine cells on peaks the coarse grid missed entirely. The global biome mix
  stays within ±0.4pp of the coarse model on every class, which is the point:
  this buys detail, not a different climate.
- **Then, 2026-08-09: the four coarse inputs are INTERPOLATED, not
  nearest-sampled.** The first version read precipitation, seasonality, monsoon
  and the regional part of temperature from the containing cell, which left a
  visible staircase on the 62 km grid — elevation-driven boundaries looked
  organic while everything else stepped along cell borders. Measured as the
  share of biome boundaries sitting exactly on a coarse cell border, against
  the 12.5% that would land there by chance: nearest 36.1% (2.88× chance),
  temperature alone 33.9%, precipitation alone 23.2%, monsoon alone 33.1%,
  seasonality alone 36.1% (zero cells changed), **all four 12.4% — 0.99×, the
  grid signature is gone.** No single input is the culprit; each steps at its
  own cell borders, so fixing one leaves the others drawing the same grid.
  Temperature, the obvious suspect because it is the one with an elevation
  term, is nearly irrelevant here *precisely because* that term is already
  local. Two things make this safe: the temperature field is reduced to sea
  level before interpolating (blending the raw field would mix in each
  neighbour's sampled elevation and bleed a summit's cold sideways), and the
  other three are blended over LAND corners only with renormalised weights,
  since all three mark ocean with −1 and a plain bilinear would pull that
  sentinel into every coastal value. It also removed a bias nobody was looking
  for: nearest-sampling had inflated desert by +2.0pp, because a dry cell's
  value reached its whole 62 km unblended. The fine mix now tracks the coarse
  model within ±0.4pp everywhere.
- **Ecology keeps the coarse classification.** Every ecology field is a
  climate-grid field and its ecotone term reads the 4-neighbourhood as
  *regional* adjacency; handing it the fine array would silently redefine
  "neighbouring biome" from 62 km to 8 km. So the worker classifies twice from
  identical inputs — coarse for ecology, fine for display and the save.

## Pipeline placement

`tectonics → erosion (+drainage skeleton) → CLIMATE (this) → rivers/lakes
(drainage × precip) → biomes`. Climate needs post-erosion elevation; its
moisture source is the **ocean** (known before rivers exist), so no
circularity. Rivers/lakes then combine erosion's drainage network with this
step's precipitation; biomes consume climate (+ water). See
[world-gen.md](../design/world-gen.md) for the overall pipeline and the
rivers/lakes split (channel geometry = erosion's, discharge/fill = climate's).

## UI / overlays

A climate panel (like the erosion panel), with **three global knobs** (chosen to
stay minimal while spanning the model: the two Whittaker axes + one pattern
control) and **toggleable overlay layers** via `MapOverlayCompositor`.

- **Temperatur** — global °C offset ("greenhouse"), shifts the whole field.
- **Feuchtigkeit** — global precipitation multiplier (the Whittaker P-axis:
  desert ↔ rainforest).
- **Klimazonen-Kontrast** — equator↔pole temperature-spread multiplier, scaled
  around the mean: strong banding ↔ mild uniform world. Changes the *pattern*,
  independent of the offset. (Seasonality-strength and lapse-rate were
  considered and left out — too little visible effect per extra lever.)

Overlay layers: temperature, precipitation, wind (streamlines), ocean currents
(warm/cold streamlines), seasonality, biomes. Each stage produces a visible
overlay, so the build was incrementally verifiable the way the raft work was. A
reusable **hover tooltip** (`map/MapHoverTooltip.ts`) reports the active
overlays' values for the cell under the cursor.

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
   *(Built — `climate/biomes.ts`.)* 11 classes (ocean, ice, tundra, boreal,
   grassland, woodland, temperate forest, temperate rainforest, desert, savanna,
   tropical rainforest). `classify(T_mean, P_annual, amplitude)` is threshold-
   banded: aridity is implicit in the temperature bands (hotter needs more P to
   escape desert); seasonal amplitude splits continental grassland (>20 °C swing)
   from milder mediterranean woodland. Ocean = `elevation ≤ seaLevel`. Computed
   last in the worker's climate pass and surfaced as an opaque land-only overlay.

## Addendum 2026-09-20 — the monsoon index carries its phase

`monsoon.ts` runs the precipitation model twice, once per season, and used to
store the pair sorted: `wet = max`, `dry = min`, with the index built from the
difference. That kept HOW uneven the year is and threw away WHICH half of it is
the wet one. The two are not the same climate: a monsoon and a Mediterranean
winter-rain climate have the same index and opposite calendars.

The index is now **signed**, `(precipN − precipS) / (precipN + precipS + floor)`,
where `precipN` is the run with the top hemisphere in summer. Magnitude
unchanged, so nothing that classifies vegetation moves; sign = the phase.

Three consequences that are the actual content of this decision:

- **The magnitude is taken on the whole field, not per value.** The classifier's
  inputs are interpolated (see the 2026-08-09 bullet above), and two cells on
  opposite sides of the ITCZ now carry opposite signs — blending them would
  report an even year exactly in the belt where the wet-dry savanna lives.
  `seasonalityMagnitude()` converts the field once, before it enters
  `computeBiomes`/`computeBiomesFine`, which also keeps the `v >= 0` land test in
  `sampleLandBilinear` able to tell dry-summer land from ocean. Measured: 0 of
  32,768 coarse and 0 of 131,072 fine biome cells change.
- **The floor keeps the ocean sentinel free.** `|index| < 1` holds strictly
  because the denominator exceeds the numerator by `monsoonSeasonalityFloor`
  (500 mm/yr), so the `-1` that marks ocean stays unreachable by a real value.
  Measured maximum over a test world: 0.9717.
- **The save needed no new version.** The layer's encoding moved to
  `scale 2/255, offset -1`, and the manifest carries scale and offset per layer,
  so an older save still decodes with the range it was written at — it simply has
  no phase to report. Precision halves to 0.0078 per step, against thresholds
  around 0.35.

What it buys, beyond an honest readout: the rainfall year can be reconstructed
from the two numbers that already ship. The generator's probe card draws twelve
months from `annual` and `index` alone, exact in both height and phase. Measured
against the assumption it replaces — wet season = local summer — that assumption
was **half a year out on 31.2% of land cells, and on 36.8% of the strongly
seasonal ones** (|index| > 0.2). It was right only where the ITCZ does follow the
sun.

## Addendum 2026-09-20 — the wind gets a speed, by anchor not by derivation

The wind field is a prescribed three-cell band pattern with a relative
magnitude. Nothing in the model produces m/s: the two consumers, moisture
advection and the wind-stress curl, read a direction and a relative strength,
and `precipAdvectStep` is grid cells per iteration, with iterations that are not
time. So a readout that wants to say a number has two ways to get one.

**Taken: one calibration constant.** `windSpeedMsPerUnit = 8`, anchored on
Earth — surface trades run ~6-8 m/s and the mid-latitude westerlies ~8-10 m/s,
both at their band centre, which is where `windZonalStrength` is 1.0. Measured
over the field: 8.6 m/s at every band centre (the meridional part included),
0.2-0.6 m/s in the three calm belts, 5.5 m/s mean over all latitudes. No field
changes, no harness moves; it converts a label.

The number is a plausible magnitude with a stated anchor, not a prediction, and
one place shows the seam: the polar easterlies read the same 8.6 m/s as the
westerlies, because all three bands share one strength. On Earth they are
weaker. That is the prescribed pattern speaking, not the anchor.

**Not taken: physical units in the model.** Give the wind m/s and derive the
advection from cell size (a climate cell is ~62 km) and a residence time. Then
`precipAdvectStep` is no longer free, precipitation has to be re-tuned against a
golden re-baseline, and the whole thing needs a visual pass. What it buys is the
same number, earned — and a wind that could later feel a rotation rate or a
pressure field. Worth doing the day this world has a day; not worth it to print
a label.

The ocean currents are in the same position and keep no speed for now. Their
constant would be the second of this family, which is a reason to wait until
there is a second caller rather than to invent the family now.

## Deferred / out of scope

- Dynamic local weather (runtime/visual only; not for generation).
- Monsoons (seasonal land–sea wind reversal), albedo–ice feedback, ocean heat
  inertia beyond the current field — nice-to-have refinements, not needed for a
  first believable biome map.
- Axial-tilt-driven true seasons (the torus makes hemispheres symmetric; the
  amplitude model covers what biomes need).

## Status

implemented (all 6 phases built); the "revisit if too coarse" note under
Integration was revisited 2026-08-08 — the CLASSIFICATION moved to the world
raster, the climate fields did not, and its coarse inputs were switched from
nearest to interpolated 2026-08-09

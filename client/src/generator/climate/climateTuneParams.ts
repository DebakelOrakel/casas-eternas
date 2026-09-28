import { ELEVATION_METERS, SLOPE_RECALIBRATION, metersToElevation } from '../elevation/elevationScale'

// Algorithm tuning for the climate chain — temperature, wind, seasonality,
// monsoon, precipitation, ocean currents, and the one biome threshold that is a
// height rather than a Whittaker cut.
//
// Gathered from SEVEN files, which is why the keys carry a sub-domain prefix:
// `ADVECT_STEP` existed twice with different values (precipitation 2, currents
// 2.5) and would silently have collided in one object. The prefix is not
// decoration, it is what makes the merge safe.
//
// NOT here, deliberately:
//   - CLIMATE_RES_X/Y and the per-file RX/RY shorthands — grid shape, structural.
//   - OCEAN_PRECIP and OCEAN_AMPLITUDE — sentinels, not knobs.
//   - the Whittaker thresholds inside `classify` (climate/biomes.ts) — they are
//     INLINE LITERALS today, so the biggest block of climate tuning in the repo
//     is invisible to any grouping. Extracting them is a real change with real
//     risk and wants its own step; noting it here so it is not mistaken for done.

const lapseCPerKm = 6.5

export const CLIMATE_TUNING = {
  // --- from precipitation.ts (BUG_BOUNTY 13, moved 2026-09-22) ---
  // Evaporation as a fraction of the maximum: zero at this temperature,
  // rising by one over this span, held between the floor and the cap — a
  // Clausius-Clapeyron-ish increase that keeps the tropics humid and the
  // cold poles dry.
  precipEvapZeroC: -10,
  precipEvapSpanC: 40,
  precipEvapMin: 0.05,
  precipEvapMax: 1.2,
  // The three-cell rain belts: a cosine over the latitude with this mean
  // and swing (the ITCZ and the polar front wet, the subtropics dry).
  precipBandBase: 0.8,
  precipBandSwing: 0.7,
  // The most of a column's moisture one cell can rain out.
  precipRainoutMax: 0.85,

  // --- from temperature.ts ---

  // Real-ish units (°C), so the later Whittaker biome thresholds are directly
  // usable. Tune by eye — these set the equator-to-pole span.
  tempEquatorC: 30,
  tempPoleC: -25,

  // The environmental lapse rate — °C lost per unit of elevation. Now a derived
  // quantity rather than a tuned one: the real atmosphere loses ~6.5 °C/km, and
  // elevationScale says a full unit is ELEVATION_METERS, so this is simply the two
  // multiplied. A 1681 m peak (the measured 90th percentile of land) comes out
  // 10.9 °C cooler than its lowland, which is what 6.5 °C/km gives.
  //
  // This replaces a hand-tuned 35 paired with a LAND_LAPSE_REF = 0.35 offset, and
  // getting rid of that offset is the point. It existed because the old land
  // baseline of 0.35 was not physically a height at all — continental lowland was
  // SUPPOSED to read as sea-level-warm, but the scale placed it at what the lapse
  // rate had to treat as 3 km up, cooling every land cell on the planet by ~12 °C
  // and dragging the whole climate too cold (a ~18 °C equator, tundra across the
  // mid-latitudes, and a drier world via the suppressed evaporation). The offset
  // was the correct local fix for a scale that meant two different things in its
  // two halves. With lowland actually at 360 m, cooling can simply be measured
  // from sea level like it is in reality, and the special case disappears.
  lapseCPerKm,
  // The same lapse in ELEVATION units, which is what every consumer actually
  // multiplies by. Derived rather than restated so it follows both the rate and
  // the metre anchor; biomes.ts reads it too.
  lapseCPerElevation: lapseCPerKm * (ELEVATION_METERS / 1000),

  // --- from wind.ts ---

  // Relative strengths — zonal (east/west) dominates the surface pattern, the
  // meridional (toward/away from the equator) component is weaker. The model
  // itself runs on these bare numbers: moisture advection and the wind-stress
  // curl read a direction and a relative magnitude, never a speed.
  windZonalStrength: 1.0,
  windMeridionalStrength: 0.4,

  // What one of those units is worth in m/s, for the one consumer that has to
  // say a number out loud (the map readout). This is a CALIBRATION, not a
  // result: the band pattern is prescribed rather than solved, so nothing in the
  // model derives a speed, and the anchor is Earth's. Surface trade winds run
  // ~6-8 m/s and the mid-latitude westerlies ~8-10 m/s, both at their band
  // centre, where `windZonalStrength` is 1.0 — so one unit is 8 m/s, and a band
  // centre reads hypot(8, 3.2) = 8.6 m/s with the meridional part included.
  // Changing it moves no field; it moves a label.
  //
  // The alternative was to give the wind real units and derive the advection
  // from cell size and a residence time, which would make the number earned
  // instead of assigned — see the addendum in docs/decisions/climate-biomes.md
  // for why that is a different piece of work.
  windSpeedMsPerUnit: 8,

  // --- from seasonality.ts ---

  // Peak annual temperature range (°C, summer − winter) — reached by a
  // continental interior at high latitude. The equator sits near 0 (sun always
  // high), a coast/ocean stays low (thermal inertia). Tune by eye.
  seasonMaxAmplitude: 42,

  // Cells this many grid cells from the nearest ocean count as fully
  // continental; nearer ones interpolate. A big continent's core sits deep
  // enough to saturate.
  seasonContinentalityScale: 45,

  // Coastal land floor (continentality 0): even a coast swings a bit.
  seasonCoastDamp: 0.3,

  // --- from monsoon.ts ---

  // How far (fraction of map height) the ITCZ belt migrates toward the summer hemisphere.
  // Real seasonal swing is ~10-15° of latitude (bigger over monsoon land); 0.07 of the
  // map's height is 12.6° on this 2:1 torus (it was cited as 0.12 here while the
  // value stood at 0.07 — BUG_BOUNTY 58).
  monsoonItczSeasonalShift: 0.07,

  // Strength of the monsoon surface wind — a component up the seasonal-temperature
  // gradient (∇T points from cool sea toward hot summer land), added to the prescribed
  // zonal wind. Tuned so it reshapes moisture advection near coasts without swamping the
  // base three-cell circulation (base zonal strength ~1). See computeMonsoonWind.
  monsoonWindStrength: 0.05,

  // Wetness floor (mm/yr) added to the monsoon-index denominator so ARID cells don't read
  // as monsoonal: a desert with 50 mm wet / 5 mm dry is dry, not seasonal, yet a raw
  // (wet−dry)/(wet+dry) would call it 0.82. The floor damps the index where absolute
  // precipitation is small, so a high index means genuinely wet-in-one-season-dry-in-the-
  // other (a real monsoon), not just marginal noise. ~ a semi-arid annual total.
  monsoonSeasonalityFloor: 500,

  // --- from precipitation.ts ---

  // Iterations of moisture transport, and how far (in grid cells, per unit wind)
  // moisture advects each one. Needs enough to reach a steady state deep inland
  // — the flow is diagonal (zonal + meridional), so the path in is longer than
  // the straight-line distance; too few left continental interiors stuck at
  // their transient (empty) starting value.
  precipIters: 120,
  precipAdvectStep: 2,

  // Moisture is advected mostly ZONALLY (it penetrates inland from the nearest
  // east/west coast). The meridional wind is damped for transport, because at
  // full strength a backward streamline from a deep mid-latitude interior curves
  // down into the neighbouring cell where the zonal wind REVERSES (Hadley vs
  // Ferrel) — it then never traces back to an ocean, starving that cell to a
  // hard zero. A gentle meridional tilt keeps streamlines within their own band.
  precipAdvectMeridionalScale: 0.3,

  // Fraction of airborne moisture that rains out per iteration on flat land, and
  // the extra fraction per unit of upslope elevation along the wind (orographic
  // lift). The orographic term also creates rain shadows: moisture rains out
  // climbing the windward slope, so little is left for the lee side downwind.
  precipBaseRainout: 0.03,

  // Scaled by SLOPE_RECALIBRATION: land slopes halved when the continental
  // interior stopped being a flat plateau, so the same terrain now produces half
  // the measured upslope. Without this, orographic rain and its rain shadows both
  // collapse toward the BASE_RAINOUT floor.
  precipOrographicRate: 0.9 * SLOPE_RECALIBRATION,

  // Land moisture recycling (evapotranspiration): the fraction of rained-out water that
  // re-evaporates from soil/vegetation back into the airborne pool, feeding downwind rain.
  // This is a MAJOR real process — ~a third to a half of continental precipitation is
  // recycled from land ET, which is what keeps deep interiors (Amazon, Congo, monsoon
  // Asia) wet far from any coast rather than the near-zero our pure-depletion advection
  // gave. It sustains ALREADY-fed interiors (so rainforests/forests reach inland) without
  // rescuing genuine rain-shadow deserts (nothing rains → nothing recycles), so aridity
  // stays where it belongs. Net land depletion per step becomes rain·(1 − this).
  precipLandRecycleFrac: 0.5,

  // World px upwind to sample for the along-wind slope (needs the fine elevation,
  // not the coarse climate grid — the point of sampling full-res here).
  precipOrogSamplePx: 40,

  // Raw rainout → mm/yr. Tunes overall wetness; a wet windward mountain lands
  // around a few thousand mm, deserts/rain-shadow near zero.
  //
  // Known deviation, measured 2026-07-31 and deliberately left alone: the wettest
  // cells reach ~22500 mm/yr and ~1.3% of land exceeds Earth's all-time record of
  // 11900 — unphysical as a DISTRIBUTION (our cells are 62 km means, which should
  // sit below a point record, not above it). Do not reach for this constant to fix
  // it: the median is 813 mm/yr against Earth's ~700, so the overall calibration is
  // right and lowering it would drag the sound body down with the tail.
  //
  // The cause is the shape of the model, not a constant. `rainFrac` is a fraction
  // per iteration with no saturation, and one iteration advects 62 km — so at a p99
  // upslope roughly half the moisture column may rain out over that single step.
  // The 0.85 clamp below binds far too late to stop it (it needs a 4100 m rise over
  // the 312 km sample, and catches only 0.04-1.4% of land cells). The physical fix
  // is a soft saturation on rainFrac, not a lower ceiling here.
  //
  // Left as is because it costs nothing downstream: capping precipitation at 4000
  // changed ZERO biome cells on both test seeds (Whittaker's thresholds stop at
  // 1500 mm, and ecology's productivity is 1 − exp(−0.000664·P), already 0.98 at
  // 6000). It survives only into hydrology, which is linear in precip: mean runoff
  // +29% and maxDischarge +72%, i.e. rivers drawn about a quarter narrower. Those
  // are aesthetic knobs. A saturation would shift mean runoff ~30%, so it would cost
  // a re-tuned river-density default and a golden re-record — not worth it for a
  // number nothing reads. Three other suspects were ruled out first: the scale
  // (median is right), erosion's missing deposition (pre/post distributions are
  // identical), and ridged noise in the slope sample (the tail survives without
  // noise, and the wettest cells cluster 70-93%, so it is real orography).
  precipScale: 60000,

  // Zonal wet/dry from the general circulation: rising (wet) air at the equator
  // ITCZ (φ=0) and the subpolar front (φ≈2/3), sinking (dry) air at the
  // subtropical highs (φ≈1/3 — the great deserts) and the poles (φ=1).
  // Floor for the zonal band multiplier — the subtropical-high / polar dry minimum. At
  // 0.1 the subtropics got a 15× dry penalty vs the equator, which (with interior
  // depletion) turned nearly all subtropical land into extreme desert. A higher floor
  // keeps those belts the driest zones without erasing all vegetation there (semi-arid
  // grassland/savanna rather than bare desert).
  precipBandFloor: 0.13,

  // --- from oceanCurrents.ts ---

  // Streamfunction solve iterations (Gauss-Seidel, in place — converges roughly
  // twice as fast as Jacobi). One-shot per climate compute; the gyre structure
  // doesn't need a fully-converged ψ.
  currentsSolveIters: 700,

  // β, the northward growth of the Coriolis parameter, against a friction of
  // 1 per cell (Stommel). The western boundary current is about 1/β cells
  // wide; at 0.4 that is 2.5 cells (150 km) at the equator and more toward the
  // poles, the narrowest the 62 km grid can hold. Above 2 the central
  // difference loses diagonal dominance and the solve oscillates.
  currentsBeta: 0.4,

  // SST transport: how far (grid cells) it advects along the normalized current
  // per iteration, how many iterations, and the per-iteration relaxation back
  // toward the latitudinal base (anchors the SST to latitude so anomalies stay
  // bounded — a few °C, like real boundary currents on this coarse grid).
  // The step was 2.5 until the β term (2026-09-28): the western jet now sets
  // the normalisation, the mean speed fell to 0.61 of before, and the
  // anomalies with it (Astrakan: warm 29 → 16 % of the sea, cold 26 → 16 %).
  // At 4 they are back at warm 21 %, cold 24 %, +4.2/−7.5 °C. The cold
  // eastern coasts belong to upwelling, which is not modelled yet.
  currentsAdvectStep: 4,
  currentsAdvectIters: 80,
  currentsBaseRelax: 0.15,

  // How strongly a coastal land cell is pulled toward the adjacent ocean's SST
  // anomaly (warm current → milder coast, cold current/upwelling → cooler coast),
  // and how far inland that influence reaches, decaying per cell (a maritime band
  // a few cells wide rather than a single-cell edge).
  currentsCoastalFactor: 0.9,
  currentsCoastalSteps: 4,
  currentsCoastalDecay: 0.8,

  // --- from biomes.ts ---

  // The alpine override, promised by docs/decisions/climate-biomes.md ("plus ...
  // an alpine override above the treeline") but never built until 2026-08-06: a
  // mountain's cold-elevation biome used to fall out of the lapse rate alone —
  // which classifies it as Tundra, exactly the same id/color/label as arctic
  // lowland tundra. That is not wrong ecologically (a real snowline zone reads
  // similarly whether it got cold from latitude or elevation), but it meant an
  // equatorial snow-capped peak and a polar plain were visually and
  // mechanically indistinguishable — the elevation was invisible to gameplay.
  //
  // A single global elevation threshold (not latitude-dependent) is the whole
  // point of the override: real treeline elevation DOES fall with latitude, but
  // reproducing that here would just re-derive what the lapse-rate-driven T/P
  // classification already gives — the useful, DIFFERENT signal is "is this
  // high ground, regardless of where on the planet it is", so a fixed metres
  // threshold is what actually answers that. 2800 m sits within the commonly
  // cited real-world treeline range (roughly 2500-3800 m depending on
  // latitude/region) as a single representative value.
  //
  // A cell that would already classify as Ice (T < -10°C — a true glaciated
  // summit) is left alone: Alpine means "bare rock / sparse cold-adapted
  // vegetation above the treeline", not "less ice than Ice" — a permanently
  // glaciated peak should still read as ice, elevation or not.
  alpineTreelineElevation: metersToElevation(2800),

  // --- the Whittaker classifier's own thresholds ---------------------------
  //
  // These were INLINE LITERALS inside `classify`, which made the largest block
  // of climate tuning in the repo invisible to every grouping — including the
  // one this file exists to be. Naming them changes nothing and makes them
  // findable, comparable and hashable.
  //
  // Two values appear twice (250 and 600 mm, once per temperature band) and stay
  // SEPARATE — asked and answered 2026-08-09: the agreement is coincidence, not
  // a shared threshold. The temperate 600 splits grassland from woodland, the hot
  // 600 marks the savanna edge; they are different statements that happen to land
  // on one number. Sharing a constant would couple them, so moving the tropical
  // desert edge would drag the temperate one along with it.

  // Temperature band edges (°C), coldest first.
  iceMaxC: -10,
  tundraMaxC: 0,
  borealMaxC: 7,
  temperateMaxC: 20,

  // In the cold band, dryness gives tundra rather than boreal forest.
  borealMinPrecipMm: 200,

  // Temperate / subtropical precipitation edges (mm/yr).
  temperateDesertMaxPrecipMm: 250,
  temperateGrasslandMaxPrecipMm: 600,
  temperateForestMaxPrecipMm: 1500,

  // Strong precipitation seasonality opens the canopy: a marginal forest with a
  // pronounced dry season reads as woodland or grassland, not closed forest.
  temperateOpenCanopyAmplitudeC: 20,
  temperateOpenCanopySeason: 0.3,
  temperateWoodlandSeason: 0.4,

  // Hot band (T >= temperateMaxC). The rainforest/savanna split is driven by
  // SEASONALITY rather than the annual total: evergreen rainforest needs rain
  // most of the year, while a strong wet-dry rhythm gives savanna even when the
  // total is high.
  hotDesertMaxPrecipMm: 250,
  hotSavannaMaxPrecipMm: 600,
  tropicalSavannaSeason: 0.45,
} as const

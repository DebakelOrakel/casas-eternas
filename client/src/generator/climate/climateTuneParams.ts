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
  // The most of a column's moisture one cell can rain out: five times the
  // base rainout, as a mountain rains some two to five times what the plain
  // before it does (Earth's wettest places, 10 000–12 000 mm/yr). It was 0.85,
  // 28 times the base; on Earth's relief (scripts/earthClimate.mjs,
  // 2026-09-29) that gave Nairobi 12 900 mm and Bogotá 29 800 (both ~1000),
  // at 0.15 7 100 each and the mean rain error ×2.65 → ×2.35; at 0.10 the
  // places lost a class.
  precipRainoutMax: 0.15,

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

  // The along-wind lever, world px at a wind of 1: the slope across a cell
  // (read on the fine elevation, not the coarse climate grid — the point of
  // sampling full-res here) counts as the rise over this distance. Measured
  // on Earth (scripts/earthClimate.mjs, 2026-09-29), after the slope moved
  // into the cell: at 40 (the old sample distance) the places' rain ×2.01
  // off, at 20 ×1.98, at 10 ×1.93 and the land with the right group 65 →
  // 66 %; Bogotá 1600 mm (1000), Alice Springs 900 (280). Nairobi and Riyadh
  // stay wet at any lever: their cells hold real escarpments.
  precipOrogLeverPx: 20,

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
  // The season's shift of the rain bands (computePrecipitation's beltShift)
  // tapers from full at the equator to this share of it from the latitude,
  // degrees, below: the rain belt follows the sun some 10–15°, the
  // subtropical highs some 4–5°.
  precipBeltTaperDeg: 30,
  precipBeltShiftFloor: 0.35,

  // --- from energyBalance.ts (the climate step's year) ---
  // Not measured yet (2026-09-28); physical orders of magnitude, then the
  // exchange and the carry set against Earth's seasonal ranges.

  // The solar constant at 1 AU, W/m², and the top hemisphere's vernal
  // equinox as a fraction of the year from 1 January: about 20 September,
  // so its summer is the southern one and the bottom hemisphere — the
  // screen's upper half — has the northern calendar (climateField.
  // TOP_SUMMER_MONTH). It was 0.22 (20 March) until 2026-09-29.
  ebmSolarWm2: 1361,
  ebmVernalEquinoxYear: 0.72,
  // Albedo: what the surface and the air above it reflect. Ice where the
  // annual mean is below `ebmIceBelowC`.
  ebmAlbedoLand: 0.3,
  ebmAlbedoSea: 0.1,
  ebmAlbedoIce: 0.6,
  ebmIceBelowC: -10,
  // Sea whose annual mean is below this, °C, counts as ice-covered for the
  // heat capacity (sea water freezes at −1.8 °C; a mean a little above it
  // still freezes in winter).
  ebmSeaIceBelowC: 0,
  // Heat capacity, J/m²K: land is the air column and a little soil
  // (~1.2·10⁷), the sea a 50 m mixed layer (~2.1·10⁸).
  ebmCapacityLand: 1e7,
  ebmCapacitySea: 2.1e8,
  // The damping per kelvin, W/m²K: the outgoing radiation (Budyko's B,
  // ~2) and the heat the surface gives to the air above it, which the
  // cycle's anomaly loses too. Measured on Earth with the land's capacity
  // (scripts/earthClimate.mjs, 2026-09-29): at B 2.1 and 3·10⁷ the northern
  // land's warmest month was August (3981 cells) or September (1565), not
  // July (109): an interior continent has no neighbour to damp it, and
  // C/B gave it a lag of some 70°. At 8 and 1·10⁷: July 4720, August 908;
  // the land with the right class 27 → 31 %, the places' January and July
  // error 4.1 → 3.8 and 3.7 → 3.1 °C. The capacity alone widened the swing
  // by 7 °C; the damping holds it.
  ebmRadiation: 8,
  // Exchange with each of the four neighbours, W/m²K, and the carry by the
  // wind per unit of wind (8 m/s), W/m²K. The carry measured on Earth
  // (scripts/earthClimate.mjs, 2026-09-29): at 400 the sea's air reached so
  // far inland that the places' years came out 2.8 °C too narrow on average
  // (Winnipeg's January +2 °C, real −16); at 150 0.6 °C, and the land's
  // Köppen groups 29 → 18 points off Beck 2018's rounded shares. At 50 the swings stay right
  // but the D group overgrows (29 % of land, Earth 22). With the damping
  // at 8 (above), 100 (swing −0.5 °C against 150's −1.1).
  ebmExchange: 40,
  ebmCarryPerWind: 100,
  // Gauss-Seidel sweeps per harmonic.
  ebmSolveIters: 400,

  // --- from phenomena.ts (the climate step's weather phenomena) ---
  // Not measured yet (2026-09-28); orders of magnitude.

  // Fog reaches this many cells (62 km) inland, thinning each cell; it is
  // full where the sea is this much colder than its latitude's base and the
  // air this much warmer than the sea, and it takes this share of the
  // difference off the coast's month (the marine layer's chill).
  fogReachCells: 2,
  fogFullColdC: 2,
  fogFullContrastC: 3,
  // A wind this onshore (the cosine to the coast's normal) counts in full.
  fogFullOnshore: 0.5,
  fogCooling: 0.5,
  // Föhn: the highest ground within this many cells upwind, over the ground
  // here, from this barrier (m) on, full at this much more; full at this wind
  // (8 m/s units); this much warmer on a month of it, °C (a monthly mean; the
  // days themselves run 10–20 °C warmer).
  foehnReachCells: 4,
  // From 600 m: the air sheds its water above the cloud base on the
  // windward side and comes down the lee dry, some 0.4 °C warmer per 100 m.
  foehnMinBarrierM: 600,
  foehnFullBarrierM: 2000,
  foehnFullWind: 1,
  foehnWarmingC: 3,

  // --- from reliability.ts (the rain's reliability, the ENSO see-saw) ---
  // Not measured yet (2026-09-28); orders of magnitude.

  // The rain's own year-to-year spread (coefficient of variation):
  // scale/√(annual mm), so 100 mm → 45 %, 400 mm → 22 %, 1600 mm → 11 %
  // (deserts vary by 40–50 %, wet coasts by 10–15 %); the rain floored at
  // this many mm, the spread capped here; this much more on a fully seasonal
  // year (the monsoon's margins fail).
  rainVariabilityScale: 4.5,
  rainVariabilityFloorMm: 50,
  rainVariabilityMax: 0.8,
  rainVariabilitySeason: 0.3,
  // The see-saw: basins are the sea runs within this latitude of the
  // equator, shore to shore; full where the west third is this much warmer
  // than the east third, and from this width to that (the Pacific spans
  // ~150°, the Atlantic ~60°, and its see-saw is weak).
  ensoRowsDeg: 5,
  ensoFullGradientC: 3,
  ensoMinWidthDeg: 50,
  ensoFullWidthDeg: 120,
  // Its reach on land: this latitude and this many cells (62 km) from the
  // basin's ends, as Gaussians; this much spread at full reach.
  ensoReachLatDeg: 25,
  ensoReachCells: 20,
  ensoVariability: 0.3,
  // Its period, years, from a narrow basin to one of 180°: a 150° basin
  // comes out at about 4.5 years (Earth's ENSO recurs every 2–7, some 4 on
  // average). At 7 the 150° test basin gave 6.2.
  ensoPeriodMinYears: 2,
  ensoPeriodMaxYears: 5,

  // --- from storms.ts (the climate step's storms) ---
  // Not measured yet (2026-09-28); orders of magnitude.

  // Thunder: from this warmth, full this much warmer, full at this month's
  // rain (mm); the sea builds this share of the land's.
  thunderFromC: 10,
  thunderSpanC: 18,
  thunderFullRainMm: 150,
  thunderSeaShare: 0.25,
  // Blizzard: a month below this °C with this much snow (mm water) and this
  // much wind (8 m/s units).
  blizzardBelowC: -5,
  blizzardMinSnowMm: 15,
  blizzardMinWind: 0.7,
  // Dust: a month under this rain (mm) is dry, a wind this strong lifts in
  // full; it drifts this many cells along the year's wind, keeping this
  // share per cell.
  dustDryBelowMm: 25,
  dustFullWind: 0.8,
  dustSteps: 20,
  dustKeep: 0.75,
  // Tornado: a plain below this height (m); ground this high within this
  // many cells upwind, full this much higher (the dry air aloft); warm and
  // moist from this °C, full this much warmer and at this month's rain;
  // full at this wind.
  tornadoPlainBelowM: 1000,
  tornadoReachCells: 12,
  tornadoMinBarrierM: 1500,
  tornadoFullBarrierM: 1500,
  tornadoFromC: 12,
  tornadoSpanC: 10,
  tornadoFullRainMm: 80,
  tornadoFullWind: 1,
  // Cyclones form between these latitudes over sea warmer than 26.5 °C,
  // full this much warmer; each step one cell along the month's wind with
  // this drift west and poleward; over land a track keeps this share per
  // cell, over sea colder than this °C that share; it ends below this weight
  // or after this many cells.
  cycloneMinLatDeg: 5,
  cycloneMaxLatDeg: 20,
  cycloneWarmC: 26.5,
  cycloneSpanC: 3,
  cycloneDriftWest: 0.3,
  cycloneDriftPole: 0.6,
  cycloneLandKeep: 0.7,
  cycloneColdC: 24,
  cycloneColdKeep: 0.8,
  cycloneFadeBelow: 0.02,
  cycloneSteps: 60,

    // --- from salinity.ts (the sea's salt and the overturning) ---
  // Not measured yet (2026-09-29); orders of magnitude.

  // The ocean's mean salinity, psu, and the range a cell is held in (the
  // Baltic runs to 7, the Red Sea to 41).
  salinityMeanPsu: 35,
  salinityMinPsu: 5,
  salinityMaxPsu: 42,
  // What the sea evaporates at the evaporation factor's 1 (~30 °C), mm/yr
  // (tropical seas lose some 1800); land evaporates this share of it.
  salinityEvapMm: 1800,
  salinityLandEvapShare: 0.6,
  // The sea's rain: this many mm/yr at the rain model's zonal band factor and
  // evaporation factor of 1 (salinity.ts). The band runs 1.5 at the equator
  // and the 60th parallels, 0.13 in the subtropics and at the poles, so the
  // equatorial sea gets ~2200 mm/yr, 60° ~900, the subtropics ~150 (Earth:
  // ~2200, ~1000, 500–700 — the subtropics too dry, the gradient right).
  salinitySeaRainMm: 1550,
  // psu per mm/yr of net fresh water, per pass, with this relaxation toward
  // the mean per pass, over this many passes: a surplus of 1000 mm/yr of
  // evaporation settles near +2 psu (the subtropical gyres run 36–37).
  salinityPsuPerMm: 1e-4,
  salinityRelax: 0.05,
  salinityIters: 150,
  // psu per pass where the sea freezes (the salt the ice leaves behind).
  // Small: freezing and melting nearly cancel over a year; what is left is
  // the brine of the ice that drifts away.
  salinityBrinePsu: 0.01,
  // Surface water sinks poleward of this latitude where the sea is colder
  // than this °C (fully at freezing, −1.8 °C) and saltier than its
  // latitude's mean, fully this much saltier. At 0.5 psu a fifth or more of
  // the sinking reached 6 % of Astrakan's sea; at 1 psu 3 % (the test world
  // with an Atlantic-like basin 5 %), at a mean 68–71°, and the overturning
  // warms the land beside it by up to 1.7–2.4 °C. Earth's sinking is a few
  // small patches (55–70°), its warmth some degrees on Europe's coasts.
  seaFreezesC: -1.8,
  deepWaterBelowC: 5,
  deepWaterFullAnomalyPsu: 1,
  deepWaterMinLatDeg: 50,
  // The sinking's surface inflow (oceanCurrents.computeSinkInflow): its
  // fastest cell as this share of the wind's fastest current, and the
  // Gauss-Seidel sweeps of its potential.
  conveyorFlow: 0.3,
  conveyorSolveIters: 700,

  // --- from refinement.ts ---
  // When the equatorial rain belt stands furthest toward the top hemisphere,
  // as a fraction of the year: about mid-January, a few weeks after its
  // solstice, as the sea's lag holds it back (climateField.TOP_SUMMER_MONTH;
  // mid-July, 0.54, until 2026-09-29).
  refineItczPeakYear: 0.04,

  // The rain's multiplier from the anomaly of the sea the air rose from
  // (computePrecipitation's refined path): e^(perC × °C), clamped. Measured
  // on Earth (scripts/earthClimate.mjs, 2026-09-29): 0.2 moves the land's
  // Köppen groups from 18 points off Beck 2018's rounded shares to 8 (B 20 → 26 %, the dry
  // west coasts); 0.3 gives 6 but dries the places' rain further (×2.49 →
  // ×2.58 off).
  rainSourcePerC: 0.2,
  rainSourceMin: 0.2,
  // The ocean highs (refinement.ts): ± hPa from a basin's western shore to
  // its eastern, in full in a basin this many cells wide, over the latitudes
  // between (a sine bump); smoothed over the radius, cells, as a mean over
  // the sea, and nothing where less than the share of the smoothing is sea.
  // Under the western flank the band's dryness gives way toward
  // `rainFlankFactor`, in full at −`rainFlankFullHpa`
  // (computePrecipitation's flankRelief). Measured on Earth
  // (scripts/earthClimate.mjs, 2026-09-29): of the real C land, 51 % came
  // out dry (B), now 30 %; the land with the right group 63 → 65 %, the
  // places' classes 10 → 15 of 47, their rain ×2.49 → ×2.06 off. The groups'
  // shares 13 → 19 points off: C grows past Earth's (18 % against 13).
  // A high from the sea's own anomaly (cold high, warm low, 3–10 hPa/°C)
  // was tried first and dried the east coasts further: their warm currents
  // come out at +0.5 °C here, and the cold seas set the mean.
  oceanHighFlankHpa: 8,
  oceanHighBasinCells: 40,
  oceanHighFromDeg: 15,
  oceanHighToDeg: 50,
  oceanHighSmoothCells: 8,
  oceanHighMinSeaShare: 0.05,
  rainFlankFactor: 1,
  rainFlankFullHpa: 1.5,
  // The share of the moisture the sinking air mixes away per iteration over
  // land, where it sinks in full, and the band factor below which the band
  // counts as sinking air (computePrecipitation's subsidence). Measured on
  // Earth (scripts/earthClimate.mjs, 2026-09-29): a small effect. At 0.05
  // the groups' shares 19 → 16 points off, the cells and the places
  // unchanged; Cairo 99 → 63 mm, Tehran 518 → 445, Dakar 454 → 354. More
  // dries New York and Chicago, whose air crosses the band's core on its way
  // from the Gulf. The band counted from 1 down made the storm tracks at 40°
  // sink too (New York, Chicago → B). The wet deserts left are the
  // upslope rainout's: without it Riyadh 496 → 244, Alice Springs 2051 → 431.
  rainSubsidenceMix: 0.05,
  rainSubsidenceBand: 0.3,
  rainSourceMax: 4,

  // --- from pressure.ts ---
  // Not measured yet (2026-09-28); set from Earth's orders of magnitude.

  // Half the range of the zonal bands: 1013 ± 8 hPa, the equatorial trough
  // and the subpolar lows against the subtropical highs.
  pressureBandHpa: 8,
  // Thermal part: hPa per °C of departure from the row's mean. The Siberian
  // winter high is some +20–30 hPa over air 20–30 °C colder than its
  // latitude.
  pressureHpaPerC: 1,
  // Smoothing radius, cells (62 km): three box passes, σ ≈ 370 km, the scale
  // of heat lows and cold highs rather than of coasts.
  pressureSmoothCells: 6,
  // Wind units (8 m/s) per hPa per cell of gradient before the balance: 20 hPa
  // over 2000 km at 45° gives some 5 m/s over the sea.
  pressureWindPerHpa: 0.8,
  // Surface friction against the Coriolis parameter (1 at the pole, 24 h day):
  // the wind crosses the isobars at about 20° over the sea at mid latitudes,
  // at about 40° over land.
  pressureFrictionSea: 0.3,
  pressureFrictionLand: 0.6,
  // The elevated heat source (refinement.ts): hPa per km of height over the
  // threshold per °C of the month's departure from the year's mean.
  // Measured on Earth (scripts/earthClimate.mjs, 2026-09-29): at 0.6 the
  // July pressure over Tibet 1016 → 1007 hPa, the wind over the Bay of
  // Bengal turns southwest, Beijing's rain 117 → 574 mm (570), Tehran 491 →
  // 354 (230); the land with the right group 70 → 71 %. At 1 Beijing 1166.
  // Delhi stays dry: it lies in the westerly on the low's south side, off
  // the Thar, as the heat low over Pakistan is too shallow here.
  pressurePlateauHpaPerKmC: 0.6,
  pressurePlateauFromKm: 1,
  // A range turns the part of the wind that blows up its slope: nothing below
  // the first height, the full share `pressureBlockMax` above the second.
  pressureBlockFromM: 1500,
  pressureBlockFullM: 4000,
  pressureBlockMax: 0.7,

  // --- from oceanCurrents.ts (upwelling, the climate step's refinement) ---
  // Not measured yet (2026-09-28).

  // |f| is held at least here (sin 12°) near the equator, with its sign, so
  // the Ekman transport τ/f stays finite and still turns both ways. A
  // numerical guard, not a planet property: Ekman's balance fails where f
  // goes to 0, and this sets how strong the equatorial band comes out. At 0.1
  // the band set the layer's scale (Astrakan: equator 0.68 of the 98th
  // percentile, rising coasts 0.60); at 0.2 the coasts stand out (equator
  // 0.62, coasts 1.09) and the equator cools −0.89 °C instead of −1.03 °C.
  upwellingMinF: 0.2,
  // Sea cooling per unit of upwelling divergence, and its cap: real upwelling
  // coasts run some 4–8 °C colder than the open sea at their latitude.
  upwellingCoolingC: 2,
  upwellingMaxCoolingC: 6,
  // Latitude, degrees, over which the equatorial rule (cold only in the east
  // of a basin) fades into the coastal one (cold wherever it comes up).
  upwellingEquatorBandDeg: 12,

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
  // The relaxation measured on Earth (scripts/earthClimate.mjs,
  // 2026-09-29): at 0.15 the anomalies came out at a third of Earth's (off
  // Norway +2.1 °C, some +7; off California −1.7, some −4), the North
  // Atlantic's warmth fading before it reached Europe; at 0.1 +2.6 and
  // −2.4, Reykjavik's year 3 °C → right, London's 4 → 2 °C too cold, the
  // places' January error 3.9 → 3.7 °C. At 0.05 the anomalies grow on
  // (+3.4, −3.8) and the scores do not.
  currentsAdvectStep: 4,
  currentsAdvectIters: 80,
  currentsBaseRelax: 0.1,

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
  // Köppen Aw/As: savanna below this annual rain, tropical dry forest above
  // (the wet end of Aw). Not hotSavannaMaxPrecipMm: that is a Whittaker
  // bound, and Köppen already calls anything under ~780 mm at 25 °C dry (B),
  // so every Aw cell passed 600 and the savanna was gone (Astrakan 0.2 %).
  // Real savannas reach 1300–1500 mm.
  savannaMaxPrecipMm: 1400,
  tropicalSavannaSeason: 0.45,
} as const

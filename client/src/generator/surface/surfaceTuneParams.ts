// Algorithm tuning grouped into one object so it can be hashed — see the module
// contract in client/src/generator/CLAUDE.md.
//
// The v1 erosion pass's whole section ("from erosion.ts": the delta freeboard
// family, the estuary clamp, the zoned-incision thresholds, the talus angle —
// each with its measurement history) was deleted with the pass in the erosion-v2
// P5 teardown; the v2 engine's parameters live in the engine
// (surface/erosion_engine.rs) and are hashed via its amplify_constants. Git history keeps
// the measurements.
//
// Also out: RIVER_MIN/MAX_WIDTH (drawn width, presentation), and the
// engine's amplify_constants, which already exists as its own hashed set.

export const SURFACE_TUNING = {
  // The flow regime from the climate step's months (the engine's
  // `dry_water_from_months`): the dry season is the mean of this many driest
  // thawed months' water — six, the drier half-year, which is what the
  // regime's thresholds were set against (the smaller of the two seasons,
  // F6); three read far drier (Astrakan: the dry season's median share of
  // the year 0.20 against 0.77). Snow melts at this many mm per °C above
  // freezing per month (a degree-day factor of ~4 mm/°C/day, the common one
  // for snow).
  regimeDryMonths: 6,
  snowMeltMmPerDegreeMonth: 120,

  // HYDROGEOLOGY (surface/hydrogeology.ts, ADAPTIVE_MESH_PLAN.md phase 5a;
  // a classification, nothing moves). Permeability of the top material in
  // [0, 1]: coarse fill, fine fill, bedrock at neutral hardness (divided by
  // the crust-history hardness, clamped). A column layer thinner than
  // hydrogeologyLayerMinM is no material. The infiltration is the
  // permeability times the cover's hold (bare ground infiltrates
  // infiltrationBare of it, a full cover all), capped. A spring needs a
  // permeable top over a sealed base and springMinBaseflow of accumulated
  // infiltration above it (the discharge's unit: mm/yr over cells). The
  // water table rises from the nearest channel by aquiferRiseBase metres
  // per metre of flow distance on tight ground at the reference recharge,
  // less by aquiferRisePermeableDrop × permeability where the ground
  // drains, scaled by the recharge (capped). All unmeasured.
  hydrogeologyLayerMinM: 2,
  permeabilityCoarse: 0.9,
  permeabilityFine: 0.1,
  permeabilityBedrock: 0.35,
  permeabilityBedrockMin: 0.1,
  permeabilityBedrockMax: 0.7,
  infiltrationBare: 0.5,
  infiltrationMax: 0.9,
  springPermeableAbove: 0.6,
  springSealedBelow: 0.4,
  springMinBaseflow: 500,
  aquiferRiseBase: 0.05,
  aquiferRisePermeableDrop: 0.9,
  aquiferRechargeRefMm: 1000,
  aquiferRechargeCap: 2,
  // HILLSLOPE ADDITIONS (ADAPTIVE_MESH_PLAN.md phase 5.6, the coupled
  // loop's per-node scales on the engine's Roering kernel). The critical
  // slope from the lithology: S_c × K^(−exponent) — hard rock (a low
  // erodibility K) stands steeper, soft fill lies flatter; with the
  // cover's rise (surface/cover.ts) on top. Solifluction: the hillslope
  // diffusivity rises with cold, up to solifluctionBoost× at
  // solifluctionSpanC below solifluctionBelowC (the periglacial regime
  // moves regolith by freeze and thaw where nothing else does). All three
  // unmeasured.
  massWastingLithoExponent: 0.25,
  solifluctionBelowC: 0,
  solifluctionSpanC: 15,
  solifluctionBoost: 3,
  // --- from hydrology.ts ---
  // Lake water depth per full-res cell (0 = dry). Climate-aware / endorheic:
  // priority-flood `filled` marks every depression's cells (filled > raw) and its
  // spill level; for each basin (a connected flooded region) we weigh the water
  // arriving (max discharge through it) against evaporation from the lake surface
  // (evaporationPotential × area). If inflow ≥ evaporation at the spill-full area,
  // the basin brims to its spill and overflows (an open lake feeding the river
  // below); otherwise it's ENDORHEIC — the level settles where inflow balances
  // evaporation, a shrunken closed lake (a hot dry basin becomes a small salt lake,
  // or nothing). Depth = level − raw for cells under the level. 4-connected,
  // toroidally wrapped. See docs/decisions/climate-biomes.md.
  // Basins shallower than this (spill level minus the basin's lowest point)
  // are not lakes — they are terrain texture. Became necessary 2026-08-06 when
  // computeElevation gained the plains micro-relief seed (PLAIN_DETAIL_MAX,
  // ±10 m typical): every noise dimple with any inflow classified as a lake and
  // the plains drowned in puddles. Re-swept under the overflow-only rule
  // (one seed; "plains" = bodies whose basin sits below 600 m tectonic):
  //
  //     gate    lakes   on plains
  //      0 m     816       740      <- every dimple on a river overflows
  //      4 m     199       139
  //      8 m      88        35      <- chosen: plains keep a visible lake
  //     12 m      71        22         population without the puddle flood
  //     15 m      66        20      <- at 15 (under the older endorheic
  //                                    model) the plains read as lakeless
  //
  // The 135k km² shallow mega-pan (a genuine Lake-Chad-style feature, present
  // without the noise too) survives every gate under the overflow rule — the
  // spill-brimming level keeps it a throughflow lake. Genuine deep lakes sit
  // far above the gate either way (rift grabens are depth-capped in the
  // hundreds of metres).
  minLakeBasinReliefM: 8,

  // A basin whose MEAN ANNUAL temperature sits below this is permanently
  // frozen: its water column stays (ice is water; the depth layer is
  // unchanged), but the surface is a glacier — Biome.Ice overrides the
  // classification on its wet cells, it feeds no riparian moisture and no
  // freshwater fishery, and the maps paint it as ice instead of open water.
  // −5 °C and not 0: lakes with seasonal ice cover but a liquid summer
  // (Baikal-class, mean around 0 °C) stay lakes; only genuinely polar/
  // high-cold basins freeze through. The −50 °C brim-full "lakes" this rule
  // exists for were found 2026-08-16 (see docs/decisions/uplift-soft-knee.md
  // — the PET floor of evaporationPotential holds any cold basin full, which
  // is physically right for ice and looked absurd as blue water). Tune by eye.
  lakeFrozenBelowC: -5,

  // Evaporites concentrate where the last water stood — the salt flat is a BAND
  // above the waterline, not the whole exposed floor (a fully-dry 2800 m deep
  // basin is a salt PAN at the bottom and hot desert rock on the slopes, not a
  // kilometres-tall salt wall). Thickness is a starting value for the usual
  // by-eye pass.
  saltBandM: 75,

  // Open-water evaporation potential (mm/yr) as a line in mean annual
  // temperature, clamped: `petBaseMm + petPerDegC × °C` between petMinMm and
  // petMaxMm. Warm basins lose far more water, which is what makes hot dry
  // basins into shrunken salt lakes while cold/wet ones brim over. Tune by
  // eye; the four are part of the bake's artifact key (AMPLIFY_CONSTANTS).
  petBaseMm: 150,
  petPerDegC: 60,
  petMinMm: 100,
  petMaxMm: 3000,

  // FLOW REGIME per reach (ADAPTIVE_MESH_PLAN.md F6, the hydrogeology
  // forerunner from climate alone): a reach is EPHEMERAL when its whole
  // catchment is arid — precipitation over potential evaporation, both
  // summed over the contributing cells, below the UNEP arid/semi-arid
  // boundary of 0.2 — and INTERMITTENT when the dry half-year alone cannot
  // keep it wet: the dry season's precipitation (annual × (1 − seasonality))
  // over the same potential evaporation below the same 0.2. Everything else
  // is perennial. A big river through a desert stays perennial because the
  // ratio is summed over the catchment, headwaters included — the Nile
  // rule. No storage term: groundwater buffering (a baseflow that bridges a
  // dry season) waits for phase 5a, so a monsoon river with a wet-but-short
  // year reads intermittent here.
  //
  // The potential evaporation is the lake model's open-water PET above
  // (150 + 60/°C, floored at 100), which is low on cold land, and these
  // worlds are cool and wet: measured 2026-09-22 on the golden world alpha
  // (384 reaches), the catchment P/PET is p5 0.95, median 7.1 — no reach
  // drains an arid catchment, so the ephemeral class comes from the wadis
  // (riverGraph.ts) and from reaches under the channel threshold. The dry
  // season's P/PET is p5 0.39, median 2.6; at 0.2 three reaches read
  // intermittent, at 0.5 thirty-eight (10 %) — the value chosen, so the
  // seasonal savanna and Mediterranean rivers of a world show it while the
  // even-year majority stays perennial.
  regimeAridBelow: 0.2,
  regimeDrySeasonBelow: 0.5,

  // COAST TYPE per reach (surface/coastGraph.ts, ADAPTIVE_MESH_PLAN.md F5):
  // reaches every 312 km of coast unless a mouth cuts them; the fetch that
  // saturates the wave energy (1500 km — beyond that the sea state is
  // fully developed); how far a mouth's sediment feeds the coast (300 km —
  // littoral drift carries a big river's sand hundreds of kilometres along
  // a coast). The type thresholds read RELATIVE exposure and supply (0..1
  // against the world's 90th-percentile coast, clamped; measured
  // 2026-09-22 on golden alpha, half the coasts are lee coasts with no
  // fetch under a zonal wind) and absolute relief: a cliff needs 60 m of
  // land within one 7.8 km step of the shore (a real sea cliff is tens of
  // metres, at this step a steep coastal slope) and waves of a fifth of
  // the maximum on rock no softer than K 1.1; marsh needs calm water
  // (under 0.15), flat land (under 40 m) and some sediment. Tune by eye;
  // the coast process of phase 7 replaces the rules with rates.
  //
  // On the terrain mesh since DEC-0036 phase 7b; the lengths below were
  // counts of the 7.8 km world cell it walked until then (the torus's,
  // not recalibrated): a reach 40 cells (coastReachM), the fetch's march a
  // cell a step (coastGraphFetchStepM), the relief the highest land of the
  // eight neighbours (coastReliefStepM: the eight compass points that far
  // out, a diagonal √2 of it), a mouth's coast cell the nearest within
  // three cells (coastMouthReachM), a delta's coast two cells each way
  // around its mouth (coastDeltaReachM).
  coastReachM: 312_000,
  coastFetchCapKm: 1500,
  coastGraphFetchStepM: 7_800,
  coastReliefStepM: 7_800,
  coastMouthReachM: 23_400,
  coastDeltaReachM: 15_600,
  // The fetch's march step, metres (surface/coastal.ts, the history's
  // coast): the 62.4 km climate cell it stepped in until DEC-0036 phase 7.
  coastFetchStepM: 62_400,
  // THE COAST PROCESS (surface/coastal.ts, phase 7). The wave base: the
  // sea cuts a shore node down to this depth below sea level (the
  // platform). The shore retreats coastRetreatPerYr metres a year at
  // full exposure over the rock's hardness (a kilometre an epoch on an
  // exposed neutral coast — the fast end of real cliff coasts; a node
  // half retreated is half cut). The drift's capacity per year at full
  // exposure and the best wave angle (the largest real longshore
  // transports are a million m³/yr), the deposit's freeboard (a beach
  // stands this much above the sea) and the depth it can build up from
  // (the nearshore; what falls off the shelf is exported). All
  // unmeasured.
  coastWaveBaseM: 10,
  coastRetreatPerYr: 0.001,
  coastDriftCapacityM3PerYr: 5e5,
  coastDepositFreeboardM: 2,
  coastDepositMaxDepthM: 30,
  coastSupplyReachKm: 300,
  coastCliffReliefM: 60,
  coastCliffExposure: 0.2,
  coastCliffMaxK: 1.1,
  coastCalmExposure: 0.15,
  coastMarshReliefM: 40,
  coastMarshSupply: 0.02,
  coastBeachSupply: 0.1,

  // SEDIMENT BASINS (surface/sedimentBasins.ts, ADAPTIVE_MESH_PLAN.md F1):
  // a node counts as a deposit when the erosion pass raised it by this
  // much (5 m — below it the marine diffusion's smoothing and the plains
  // micro-relief would make basins of noise), and a basin needs this much
  // area (four 7.8 km world cells, the 4-cell minimum it had on the
  // raster until DEC-0036 phase 7b — a single raised cell is not a
  // feature; not recalibrated).
  sedimentBasinMinThicknessM: 5,
  sedimentBasinMinAreaKm2: 243.36,

  // ICE (surface/glacial.ts on the mesh; F4's raster surface/iceFlow.ts
  // until DEC-0036 phase 7, ADAPTIVE_MESH_PLAN.md F4). Snow to ice: a
  // metre of precipitation as snow makes this much ice (density 0.35 →
  // 0.9). Melt: metres of ice per year per degree of the WARMEST MONTH
  // (the annual mean plus half the seasonal range) above the threshold —
  // a degree-day rate on the summer (DEC-0036 phase 8b-2). It was the
  // annual mean above −8 °C, where an ice sheet's interior stops losing
  // mass; at the range the history's climate gives where the ice ends
  // (median 13–16 °C over six torus worlds at 30 % land, 2026-10-13) that
  // is a warmest month near −1 °C, the threshold now — the margin stays
  // where it was at Earth's tilt, a milder summer (a coast, a smaller
  // tilt) keeps more ice and a hotter one less. Flow: Γ = 2A(ρg)³/5 with A = 1e-16 Pa⁻³
  // yr⁻¹ (temperate ice) and ρg = 8829 Pa/m → 2.8e-5 m⁻³ yr⁻¹; the minimum
  // slope keeps the flat interior of a sheet from going infinitely thick
  // (3 m/km, the slope of a sheet's summit region); the cap is Antarctica.
  // Rounds of the balance-flux fixed point; the minimum thickness drops
  // the film the fixed point leaves on the margins.
  iceSnowToIce: 0.4,
  iceMeltFromWarmestC: -1,
  iceMeltPerDegC: 0.3,
  iceFlowGamma: 2.8e-5,
  iceMinSlope: 0.003,
  iceMaxThicknessM: 4000,
  iceFlowRounds: 12,
  iceMinThicknessM: 5,
  // GLACIAL EROSION (surface/glacial.ts, phase 6): metres of rock per year
  // per metre of sliding (thickness × ice-surface slope) — Hallet's rule.
  // At 2e-5 a trunk glacier 1800 m thick on a 0.5 % surface slope cuts
  // 0.2 mm/yr (180 m an epoch) and its 200 m-thick margins a tenth of
  // that, which is what turns a V into a U; at 1e-4 the whole valley hit
  // the per-epoch cap and lowered as one (the harness's V stayed a V).
  // The cap is a fjord's rate. Till splits into coarse and fine at the
  // terminus. All unmeasured.
  glacialErosionPerSliding: 2e-5,
  // The steepest an ice surface falls across the ice, m/m: a trunk
  // glacier's surface carried out over the valley walls (surface/glacial.ts).
  iceSurfaceMaxSlope: 0.03,
  glacialErosionMaxM: 800,
  // THE BUZZSAW (surface/glacial.ts glacialErosionOnMesh, DEC-0036 phase
  // 8d): κ in dR/dt = −κ b R, per metre of ice balance — the height R
  // over the ELA falls by the share κ b of itself per year. Hallet's
  // Kg = 1e-4 (1979, J. Glaciol. 23) and Nye's τy = 100 kPa give
  // κ = Kg ρ g / τy = 8.8e-6 for a node all of whose bed is glacier bed;
  // the calibration's 6.7e-7 is 1/13 of it — the share of a node's area
  // its glaciers' beds take, and Kg is known only to an order of
  // magnitude (Koppes et al. 2015, Nature 526). At b = 0.15 m/yr (the
  // wet ranges' summits) R falls by a tenth an epoch, and a range stands
  // where the cut equals its uplift, R = U / (κ b): 1–2 km over its line
  // at 0.1–0.2 mm/yr (the plate takes the cut and the uplift alike).
  // Measured 2026-10-13 on 3 + 3 worlds,
  // 6.7e-7 to 2e-6: the land above 6000 m falls to 0–0.005 % of the land
  // at all of them, the peaks by 0.6–2 km; 6.7e-7 keeps the rare 8 km
  // summit of a fast, dry range. It replaces a Gaussian ×2 of the sliding
  // cut within 300 m of the ELA (phase 6, unmeasured).
  glacialBuzzsawPerBalance: 6.7e-7,
  glacialTillCoarse: 0.5,
  // The thickest a terminus's till lies, metres: it spreads over the ice-free
  // nodes around the terminus until it is no thicker (surface/glacial.ts).
  // Terminal moraines stand tens of metres to a hundred-odd. Unmeasured.
  glacialTillMaxM: 100,

  // Peak precipitation bonus (mm/yr) a cell gets right at a full-strength river/lake
  // — enough to lift a hot desert (P<250) into savanna/forest (the Nile effect).
  maxRiparianMm: 900,

  // How far the moisture bleeds from its water, metres, and its falloff:
  // riparianDecay per riparianDecayLengthM (the engine's `riparian_precipitation_on`).
  // On the terrain mesh since DEC-0036 phase 7; until then it bled
  // riparianSpread 1 coarse cell at 0.45 per cell — the reach and the length
  // are that 62.4 km cell (the torus's climate cell), not recalibrated. One
  // cell already reads as a green valley band without washing out the whole
  // continent.
  riparianReachM: 62_400,
  riparianDecayLengthM: 62_400,
  riparianDecay: 0.45,

  // --- the river-density curve's endpoints ---------------------------------
  //
  // These were FUNCTION-LOCAL inside `densityToCriticalArea`, which put them
  // beyond the reach of any grouping and, more to the point, beyond the artifact
  // key: the bake re-extracts rivers on the amplified field, so changing either
  // one changes the baked network under an unchanged key.
  //
  // m² since DEC-0036 phase 8a: the torus's 4000 and 150 cells of
  // (7.8 km)² — 243 360 and 9 126 km². Counted in cells, the sphere's
  // critical catchment was 57 % larger (its cell is 9.8 km).
  channelAreaMaxM2: 243_360_000_000,
  // Floored well above 1 cell: on smooth (un-eroded) terrain a too-low threshold
  // draws a channel from nearly every cell, and D8 picks the same steepest
  // direction for whole neighbourhoods → a mess of parallel lines. Keeping even
  // max density at a few hundred cells of support suppresses that noise.
  channelAreaMinM2: 9_126_000_000,
} as const

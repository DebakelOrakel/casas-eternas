// Algorithm tuning grouped into one object so it can be hashed — see the module
// contract in client/src/generator/CLAUDE.md.
//
// The v1 erosion pass's whole section ("from erosion.ts": the delta freeboard
// family, the estuary clamp, the zoned-incision thresholds, the talus angle —
// each with its measurement history) was deleted with the pass in the erosion-v2
// P5 teardown; the v2 engine's parameters live in DEFAULT_ENGINE_PARAMS
// (erosionEngine.ts) and are hashed via AMPLIFY_CONSTANTS. Git history keeps
// the measurements.
//
// Also out: CHANNEL_SLOPE_EXPONENT and CANONICAL_RIVER_DENSITY (exported =
// contract), RIVER_MIN/MAX_WIDTH (drawn width, presentation), and
// AMPLIFY_CONSTANTS, which already exists as its own hashed set.

export const SURFACE_TUNING = {
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
  // reaches every 40 cells (≈ 310 km at 7.8 km) unless a mouth cuts them;
  // the fetch that saturates the wave energy (1500 km — beyond that the
  // sea state is fully developed); how far a mouth's sediment feeds the
  // coast (300 km — littoral drift carries a big river's sand hundreds of
  // kilometres along a coast). The type thresholds read RELATIVE exposure
  // and supply (0..1 against the world's 90th-percentile coast, clamped;
  // measured 2026-09-22 on golden alpha, half the coasts are lee coasts
  // with no fetch under a zonal wind) and absolute relief: a
  // cliff needs 60 m of land within one cell (7.8 km — a real sea cliff is
  // tens of metres, at this cell size a steep coastal slope) and waves of
  // a fifth of the maximum on rock no softer than K 1.1; marsh needs calm
  // water (under 0.15), flat land (under 40 m) and some sediment. Tune by
  // eye; the coast process of phase 7 replaces the rules with rates.
  coastReachCells: 40,
  coastFetchCapKm: 1500,
  coastSupplyReachKm: 300,
  coastCliffReliefM: 60,
  coastCliffExposure: 0.2,
  coastCliffMaxK: 1.1,
  coastCalmExposure: 0.15,
  coastMarshReliefM: 40,
  coastMarshSupply: 0.02,
  coastBeachSupply: 0.1,

  // SEDIMENT BASINS (surface/sedimentBasins.ts, ADAPTIVE_MESH_PLAN.md F1):
  // a cell counts as a deposit when the erosion pass raised it by this
  // much (5 m — below it the marine diffusion's smoothing and the plains
  // micro-relief would make basins of noise), and a basin needs this many
  // cells (4 — a single raised cell is not a feature).
  sedimentBasinMinThicknessM: 5,
  sedimentBasinMinCells: 4,

  // ICE (surface/iceFlow.ts, ADAPTIVE_MESH_PLAN.md F4). Snow to ice: a
  // metre of precipitation as snow makes this much ice (density 0.35 →
  // 0.9). Melt: metres of ice per year per degree of mean annual
  // temperature above the threshold — a degree-day rate on the annual
  // mean; −8 °C is where an ice sheet's interior stops losing mass, so the
  // ELA sits near the −8 °C mean-annual isotherm, about where it sits on
  // Earth's ice sheets (the alpine ELA is warmer, at the −4 °C summer
  // isotherm ≈ −7 °C annual). Flow: Γ = 2A(ρg)³/5 with A = 1e-16 Pa⁻³
  // yr⁻¹ (temperate ice) and ρg = 8829 Pa/m → 2.8e-5 m⁻³ yr⁻¹; the minimum
  // slope keeps the flat interior of a sheet from going infinitely thick
  // (3 m/km, the slope of a sheet's summit region); the cap is Antarctica.
  // Rounds of the balance-flux fixed point; the minimum thickness drops
  // the film the fixed point leaves on the margins.
  iceSnowToIce: 0.4,
  iceMeltFromC: -8,
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
  // The cap is a fjord's rate. The buzzsaw: the extra factor at the ELA
  // (a Gaussian in height, the band's half-width in metres). Till splits
  // into coarse and fine at the terminus. All unmeasured.
  glacialErosionPerSliding: 2e-5,
  // The steepest an ice surface falls across the ice, m/m: a trunk
  // glacier's surface carried out over the valley walls (surface/glacial.ts).
  iceSurfaceMaxSlope: 0.03,
  glacialErosionMaxM: 800,
  glacialBuzzsawBoost: 1,
  glacialBuzzsawBandM: 300,
  glacialTillCoarse: 0.5,

  // Peak precipitation bonus (mm/yr) a cell gets right at a full-strength river/lake
  // — enough to lift a hot desert (P<250) into savanna/forest (the Nile effect).
  maxRiparianMm: 900,

  // How far the moisture bleeds into neighbouring coarse cells, and its per-step
  // falloff. Coarse cells are large (~60 km), so 1 step already reads as a green
  // valley band without washing out the whole continent.
  riparianSpread: 1,

  riparianDecay: 0.45,

  // --- the river-density curve's endpoints ---------------------------------
  //
  // These were FUNCTION-LOCAL inside `densityToCriticalArea`, which put them
  // beyond the reach of any grouping and, more to the point, beyond the artifact
  // key: the bake re-extracts rivers on the amplified field, so changing either
  // one changes the baked network under an unchanged key.
  channelAreaMax: 4000,
  // Floored well above 1 cell: on smooth (un-eroded) terrain a too-low threshold
  // draws a channel from nearly every cell, and D8 picks the same steepest
  // direction for whole neighbourhoods → a mess of parallel lines. Keeping even
  // max density at a few hundred cells of support suppresses that noise.
  channelAreaMin: 150,
} as const

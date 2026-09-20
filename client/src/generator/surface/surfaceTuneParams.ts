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

//! The surface stages' tuning, grouped into one object so it can be hashed
//! (the constants hash, casas-generator-api's `constants`).
//!
//! Out: the erosion engine's parameters (surface/erosion_engine.rs), hashed
//! via `amplify_constants`, which already exists as its own hashed set.

use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceTuning {
    pub regime_dry_months: f64,
    pub snow_melt_mm_per_degree_month: f64,
    pub hydrogeology_layer_min_m: f64,
    pub permeability_coarse: f64,
    pub permeability_fine: f64,
    pub permeability_bedrock: f64,
    pub permeability_bedrock_min: f64,
    pub permeability_bedrock_max: f64,
    pub infiltration_bare: f64,
    pub infiltration_max: f64,
    pub spring_permeable_above: f64,
    pub spring_sealed_below: f64,
    pub spring_min_baseflow: f64,
    pub aquifer_rise_base: f64,
    pub aquifer_rise_permeable_drop: f64,
    pub aquifer_recharge_ref_mm: f64,
    pub aquifer_recharge_cap: f64,
    pub mass_wasting_litho_exponent: f64,
    pub solifluction_below_c: f64,
    pub solifluction_span_c: f64,
    pub solifluction_boost: f64,
    pub min_lake_basin_relief_m: f64,
    pub lake_frozen_below_c: f64,
    pub salt_band_m: f64,
    pub pet_base_mm: f64,
    pub pet_per_deg_c: f64,
    pub pet_min_mm: f64,
    pub pet_max_mm: f64,
    pub regime_arid_below: f64,
    pub regime_dry_season_below: f64,
    pub coast_reach_m: f64,
    pub coast_fetch_cap_km: f64,
    pub coast_graph_fetch_step_m: f64,
    pub coast_relief_step_m: f64,
    pub coast_mouth_reach_m: f64,
    pub coast_delta_reach_m: f64,
    pub coast_fetch_step_m: f64,
    pub coast_wave_base_m: f64,
    pub coast_retreat_per_yr: f64,
    pub coast_drift_capacity_m3_per_yr: f64,
    pub coast_deposit_freeboard_m: f64,
    pub coast_deposit_max_depth_m: f64,
    pub coast_supply_reach_km: f64,
    pub coast_cliff_relief_m: f64,
    pub coast_cliff_exposure: f64,
    pub coast_cliff_max_k: f64,
    pub coast_calm_exposure: f64,
    pub coast_marsh_relief_m: f64,
    pub coast_marsh_supply: f64,
    pub coast_beach_supply: f64,
    /// The shelf's fill (shelf_fill.rs): up to this far below the sea, over
    /// a baseline down to `shelf_fill_slope_m`, this far out from the coast.
    pub shelf_fill_depth_m: f64,
    pub shelf_fill_slope_m: f64,
    pub shelf_fill_reach_km: f64,
    pub sediment_basin_min_thickness_m: f64,
    pub sediment_basin_min_area_km2: f64,
    pub ice_snow_to_ice: f64,
    pub ice_melt_from_warmest_c: f64,
    pub ice_melt_per_deg_c: f64,
    pub ice_flow_gamma: f64,
    pub ice_min_slope: f64,
    pub ice_max_thickness_m: f64,
    pub ice_flow_rounds: f64,
    pub ice_min_thickness_m: f64,
    pub ice_surface_max_slope: f64,
    /// The sliding cut's bound (surface/glacial.rs `glacial_erosion_on_mesh`,
    /// DES-0027 entry 17, 2026-10-30): the basal shear stress ρ g h S
    /// that ice holds at most, Pa — above it the ice deforms (Nye's
    /// plastic ice, 50–150 kPa under glaciers) — and the cut at it, mm/yr.
    /// The cut goes with the stress below it, as with Hallet's sliding.
    /// Earth's glaciers cut 0.01–1 mm/yr, its tidewater glaciers 10–100.
    /// Until 2026-10-30 the cut was 2e-5 per year per metre of h S, capped
    /// at 800 m an epoch: the raw law reached 13–30 km an epoch (p90) and
    /// the cap took 56–74 % of its volume.
    pub glacial_yield_stress_pa: f64,
    pub glacial_erosion_at_yield_mm_per_yr: f64,
    pub glacial_buzzsaw_per_balance: f64,
    pub glacial_till_coarse: f64,
    pub glacial_till_max_m: f64,
    pub max_riparian_mm: f64,
    pub riparian_reach_m: f64,
    pub riparian_decay_length_m: f64,
    pub riparian_decay: f64,
    pub channel_area_max_m2: f64,
    pub channel_area_min_m2: f64,
}

pub const SURFACE_TUNING: SurfaceTuning = SurfaceTuning {
    // The flow regime from the climate step's months (`dry_water_from_months`,
    // hydrology.rs): the dry season is the mean of this many driest
    // thawed months' water — six, the drier half-year, which is what the
    // regime's thresholds were set against (the smaller of the two seasons,
    // F6); three read far drier (Astrakan: the dry season's median share of
    // the year 0.20 against 0.77). Snow melts at this many mm per °C above
    // freezing per month (a degree-day factor of ~4 mm/°C/day, the common one
    // for snow).
    regime_dry_months: 6.0,
    snow_melt_mm_per_degree_month: 120.0,
    // HYDROGEOLOGY (surface/hydrogeology.rs, ADAPTIVE_MESH_PLAN.md phase 5a;
    // a classification, nothing moves). Permeability of the top material in
    // [0, 1]: coarse fill, fine fill, bedrock at neutral hardness (divided by
    // the crust-history hardness, clamped). A column layer thinner than
    // hydrogeology_layer_min_m is no material. The infiltration is the
    // permeability times the cover's hold (bare ground infiltrates
    // infiltration_bare of it, a full cover all), capped. A spring needs a
    // permeable top over a sealed base and spring_min_baseflow of accumulated
    // infiltration above it (the discharge's unit: mm/yr over cells). The
    // water table rises from the nearest channel by aquifer_rise_base metres
    // per metre of flow distance on tight ground at the reference recharge,
    // less by aquifer_rise_permeable_drop × permeability where the ground
    // drains, scaled by the recharge (capped). All unmeasured.
    hydrogeology_layer_min_m: 2.0,
    permeability_coarse: 0.9,
    permeability_fine: 0.1,
    permeability_bedrock: 0.35,
    permeability_bedrock_min: 0.1,
    permeability_bedrock_max: 0.7,
    infiltration_bare: 0.5,
    infiltration_max: 0.9,
    spring_permeable_above: 0.6,
    spring_sealed_below: 0.4,
    spring_min_baseflow: 500.0,
    aquifer_rise_base: 0.05,
    aquifer_rise_permeable_drop: 0.9,
    aquifer_recharge_ref_mm: 1000.0,
    aquifer_recharge_cap: 2.0,
    // HILLSLOPE ADDITIONS (ADAPTIVE_MESH_PLAN.md phase 5.6, the coupled
    // loop's per-node scales on the engine's Roering kernel). The critical
    // slope from the lithology: S_c × K^(−exponent) — hard rock (a low
    // erodibility K) stands steeper, soft fill lies flatter; with the
    // cover's rise (surface/cover.rs) on top. Solifluction: the hillslope
    // diffusivity rises with cold, up to solifluction_boost× at
    // solifluction_span_c below solifluction_below_c (the periglacial regime
    // moves regolith by freeze and thaw where nothing else does). All three
    // unmeasured.
    mass_wasting_litho_exponent: 0.25,
    solifluction_below_c: 0.0,
    solifluction_span_c: 15.0,
    solifluction_boost: 3.0,
    // --- from hydrology.rs ---
    // Lake water depth per full-res cell (0 = dry). Climate-aware / endorheic:
    // priority-flood `filled` marks every depression's cells (filled > raw) and its
    // spill level; for each basin (a connected flooded region) we weigh the water
    // arriving (max discharge through it) against evaporation from the lake surface
    // (evaporation_potential × area). If inflow ≥ evaporation at the spill-full area,
    // the basin brims to its spill and overflows (an open lake feeding the river
    // below); otherwise it's ENDORHEIC — the level settles where inflow balances
    // evaporation, a shrunken closed lake (a hot dry basin becomes a small salt lake,
    // or nothing). Depth = level − raw for cells under the level. 4-connected,
    // toroidally wrapped. See docs/decisions/climate-biomes.md.
    // Basins shallower than this (spill level minus the basin's lowest point)
    // are not lakes — they are terrain texture. Became necessary 2026-08-06 when
    // compute_elevation gained the plains micro-relief seed
    // (ELEVATION_TUNING.plain_detail_max, ±10 m typical): every noise dimple with
    // any inflow classified as a lake and the plains drowned in puddles. Re-swept
    // under the overflow-only rule (one seed; "plains" = bodies whose basin sits
    // below 600 m tectonic):
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
    min_lake_basin_relief_m: 8.0,
    // A basin whose MEAN ANNUAL temperature sits below this is permanently
    // frozen: its water column stays (ice is water; the depth layer is
    // unchanged), but the surface is a glacier — the ice biome overrides the
    // classification on its wet cells, it feeds no riparian moisture and no
    // freshwater fishery, and the maps paint it as ice instead of open water.
    // −5 °C and not 0: lakes with seasonal ice cover but a liquid summer
    // (Baikal-class, mean around 0 °C) stay lakes; only genuinely polar/
    // high-cold basins freeze through. The −50 °C brim-full "lakes" this rule
    // exists for were found 2026-08-16 (see docs/decisions/uplift-soft-knee.md
    // — the PET floor of evaporation_potential holds any cold basin full, which
    // is physically right for ice and looked absurd as blue water). Tune by eye.
    lake_frozen_below_c: -5.0,
    // Evaporites concentrate where the last water stood — the salt flat is a BAND
    // above the waterline, not the whole exposed floor (a fully-dry 2800 m deep
    // basin is a salt PAN at the bottom and hot desert rock on the slopes, not a
    // kilometres-tall salt wall). Thickness is a starting value for the usual
    // by-eye pass.
    salt_band_m: 75.0,
    // Open-water evaporation potential (mm/yr) as a line in mean annual
    // temperature, clamped: `pet_base_mm + pet_per_deg_c × °C` between pet_min_mm
    // and pet_max_mm. Warm basins lose far more water, which is what makes hot dry
    // basins into shrunken salt lakes while cold/wet ones brim over. Tune by
    // eye; the four are part of the bake's artifact key (AMPLIFY_CONSTANTS,
    // amplify.rs).
    pet_base_mm: 150.0,
    pet_per_deg_c: 60.0,
    pet_min_mm: 100.0,
    pet_max_mm: 3000.0,
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
    // (river_graph.rs) and from reaches under the channel threshold. The dry
    // season's P/PET is p5 0.39, median 2.6; at 0.2 three reaches read
    // intermittent, at 0.5 thirty-eight (10 %) — the value chosen, so the
    // seasonal savanna and Mediterranean rivers of a world show it while the
    // even-year majority stays perennial.
    regime_arid_below: 0.2,
    regime_dry_season_below: 0.5,
    // COAST TYPE per reach (surface/coast_graph.rs, ADAPTIVE_MESH_PLAN.md F5):
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
    // not recalibrated): a reach 40 cells (coast_reach_m), the fetch's march a
    // cell a step (coast_graph_fetch_step_m), the relief the highest land of the
    // eight neighbours (coast_relief_step_m: the eight compass points that far
    // out, a diagonal √2 of it), a mouth's coast cell the nearest within
    // three cells (coast_mouth_reach_m), a delta's coast two cells each way
    // around its mouth (coast_delta_reach_m).
    coast_reach_m: 312000.0,
    coast_fetch_cap_km: 1500.0,
    coast_graph_fetch_step_m: 7800.0,
    coast_relief_step_m: 7800.0,
    coast_mouth_reach_m: 23400.0,
    coast_delta_reach_m: 15600.0,
    // The fetch's march step, metres (surface/coastal.rs, the history's
    // coast): the 62.4 km climate cell it stepped in until DEC-0036 phase 7.
    coast_fetch_step_m: 62400.0,
    // THE COAST PROCESS (surface/coastal.rs, phase 7). The wave base: the
    // sea cuts a shore node down to this depth below sea level (the
    // platform). The shore retreats coast_retreat_per_yr metres a year at
    // full exposure over the rock's hardness (a kilometre an epoch on an
    // exposed neutral coast — the fast end of real cliff coasts; a node
    // half retreated is half cut). The drift's capacity per year at full
    // exposure and the best wave angle (the largest real longshore
    // transports are a million m³/yr), the deposit's freeboard (a beach
    // stands this much above the sea) and the depth it can build up from
    // (the nearshore; what falls off the shelf is exported). All
    // unmeasured.
    coast_wave_base_m: 10.0,
    coast_retreat_per_yr: 0.001,
    coast_drift_capacity_m3_per_yr: 5.0e5,
    coast_deposit_freeboard_m: 2.0,
    coast_deposit_max_depth_m: 30.0,
    coast_supply_reach_km: 300.0,
    coast_cliff_relief_m: 60.0,
    coast_cliff_exposure: 0.2,
    coast_cliff_max_k: 1.1,
    coast_calm_exposure: 0.15,
    coast_marsh_relief_m: 40.0,
    coast_marsh_supply: 0.02,
    coast_beach_supply: 0.1,
    shelf_fill_depth_m: 20.0,
    shelf_fill_slope_m: 1500.0,
    shelf_fill_reach_km: 120.0,
    // SEDIMENT BASINS (surface/sediment_basins.rs, ADAPTIVE_MESH_PLAN.md F1):
    // a node counts as a deposit when the erosion pass raised it by this
    // much (5 m — below it the marine diffusion's smoothing and the plains
    // micro-relief would make basins of noise), and a basin needs this much
    // area (four 7.8 km world cells, the 4-cell minimum it had on the
    // raster until DEC-0036 phase 7b — a single raised cell is not a
    // feature; not recalibrated).
    sediment_basin_min_thickness_m: 5.0,
    sediment_basin_min_area_km2: 243.36,
    // ICE (surface/glacial.rs on the mesh; F4's raster ice flow until
    // DEC-0036 phase 7, ADAPTIVE_MESH_PLAN.md F4). Snow to ice: a
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
    ice_snow_to_ice: 0.4,
    ice_melt_from_warmest_c: -1.0,
    ice_melt_per_deg_c: 0.3,
    ice_flow_gamma: 2.8e-5,
    ice_min_slope: 0.003,
    ice_max_thickness_m: 4000.0,
    ice_flow_rounds: 12.0,
    ice_min_thickness_m: 5.0,
    // The steepest an ice surface falls across the ice, m/m: a trunk
    // glacier's surface carried out over the valley walls (surface/glacial.rs).
    ice_surface_max_slope: 0.03,
    glacial_yield_stress_pa: 100_000.0,
    glacial_erosion_at_yield_mm_per_yr: 1.0,
    // THE BUZZSAW (surface/glacial.rs `glacial_erosion_on_mesh`, DEC-0036 phase
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
    glacial_buzzsaw_per_balance: 6.7e-7,
    // Till splits into coarse and fine at the terminus. Unmeasured.
    glacial_till_coarse: 0.5,
    // The thickest a terminus's till lies, metres: it spreads over the ice-free
    // nodes around the terminus until it is no thicker (surface/glacial.rs).
    // Terminal moraines stand tens of metres to a hundred-odd. Unmeasured.
    glacial_till_max_m: 100.0,
    // Peak precipitation bonus (mm/yr) a cell gets right at a full-strength river/lake
    // — enough to lift a hot desert (P<250) into savanna/forest (the Nile effect).
    max_riparian_mm: 900.0,
    // How far the moisture bleeds from its water, metres, and its falloff:
    // riparian_decay per riparian_decay_length_m (`riparian_precipitation_on`).
    // On the terrain mesh since DEC-0036 phase 7; until then it bled
    // riparianSpread 1 coarse cell at 0.45 per cell — the reach and the length
    // are that 62.4 km cell (the torus's climate cell), not recalibrated. One
    // cell already reads as a green valley band without washing out the whole
    // continent.
    riparian_reach_m: 62400.0,
    riparian_decay_length_m: 62400.0,
    riparian_decay: 0.45,
    // --- the river-density curve's endpoints ---
    //
    // These were FUNCTION-LOCAL inside `density_to_critical_area`, which put them
    // beyond the reach of any grouping and, more to the point, beyond the artifact
    // key: the bake re-extracts rivers on the amplified field, so changing either
    // one changes the baked network under an unchanged key.
    //
    // m² since DEC-0036 phase 8a: the torus's 4000 and 150 cells of
    // (7.8 km)² — 243 360 and 9 126 km². Counted in cells, the sphere's
    // critical catchment was 57 % larger (its cell is 9.8 km).
    channel_area_max_m2: 243360000000.0,
    // Floored well above 1 cell: on smooth (un-eroded) terrain a too-low threshold
    // draws a channel from nearly every cell, and D8 picks the same steepest
    // direction for whole neighbourhoods → a mess of parallel lines. Keeping even
    // max density at a few hundred cells of support suppresses that noise.
    channel_area_min_m2: 9126000000.0,
};

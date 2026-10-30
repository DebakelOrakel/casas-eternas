//! Algorithm tuning for the climate chain — temperature, wind, seasonality,
//! monsoon, precipitation, ocean currents, the climate step's year and
//! weather, and the biome thresholds — grouped into one object so it can be
//! hashed (the constants hash, casas-generator-api's `constants`).
//!
//! Gathered from many files, which is why the keys carry a sub-domain
//! prefix: `ADVECT_STEP` existed twice with different values (precipitation
//! 2, currents 2.5) and would silently have collided in one object. The
//! prefix is not decoration, it is what makes the merge safe.
//!
//! NOT here, deliberately: OCEAN_PRECIP and OCEAN_AMPLITUDE — sentinels, not
//! knobs.

use crate::elevation::elevation_scale::{ELEVATION_METERS, SLOPE_RECALIBRATION};
use serde::Serialize;

const LAPSE_C_PER_KM: f64 = 6.5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClimateTuning {
    pub precip_evap_zero_c: f64,
    pub precip_evap_span_c: f64,
    pub precip_evap_min: f64,
    pub precip_evap_max: f64,
    pub precip_band_base: f64,
    pub precip_band_swing: f64,
    pub precip_rainout_max: f64,
    pub temp_equator_c: f64,
    pub temp_pole_c: f64,
    pub temp_plateau_c_per_km: f64,
    pub temp_plateau_sigma_m: f64,
    pub lapse_c_per_km: f64,
    pub lapse_c_per_elevation: f64,
    pub wind_zonal_strength: f64,
    pub wind_meridional_strength: f64,
    pub wind_speed_ms_per_unit: f64,
    pub season_max_amplitude: f64,
    pub season_continentality_scale_m: f64,
    pub season_coast_damp: f64,
    pub monsoon_itcz_seasonal_shift: f64,
    pub monsoon_wind_strength: f64,
    pub climate_gradient_length_m: f64,
    pub monsoon_seasonality_floor: f64,
    pub precip_iters: f64,
    pub precip_advect_step_m: f64,
    pub precip_advect_meridional_scale: f64,
    pub precip_base_rainout: f64,
    pub precip_orographic_rate: f64,
    pub precip_land_recycle_frac: f64,
    pub precip_orog_lever_m: f64,
    pub precip_orog_half_span_m: f64,
    pub precip_scale: f64,
    pub precip_band_floor: f64,
    pub precip_band_storm_peak: f64,
    pub precip_belt_taper_deg: f64,
    pub precip_belt_shift_floor: f64,
    pub belt_shift_pole_taper_deg: f64,
    pub ebm_solar_wm2: f64,
    pub ebm_vernal_equinox_year: f64,
    pub ebm_albedo_land: f64,
    pub ebm_albedo_sea: f64,
    pub ebm_albedo_ice: f64,
    pub ebm_ice_below_c: f64,
    pub ebm_sea_ice_below_c: f64,
    pub ebm_capacity_land: f64,
    pub ebm_capacity_sea: f64,
    pub ebm_radiation: f64,
    pub ebm_diffusion_w_per_k: f64,
    pub ebm_carry_per_wind_m: f64,
    pub ebm_tropic_damping: f64,
    pub ebm_tropic_full_deg: f64,
    pub ebm_tropic_none_deg: f64,
    pub fog_reach_m: f64,
    pub fog_full_within_m: f64,
    pub fog_full_cold_c: f64,
    pub fog_full_contrast_c: f64,
    pub fog_full_onshore: f64,
    pub fog_cooling: f64,
    pub foehn_reach_m: f64,
    pub foehn_min_barrier_m: f64,
    pub foehn_full_barrier_m: f64,
    pub foehn_full_wind: f64,
    pub foehn_warming_c: f64,
    pub rain_variability_scale: f64,
    pub rain_variability_floor_mm: f64,
    pub rain_variability_max: f64,
    pub rain_variability_season: f64,
    pub enso_rows_deg: f64,
    pub enso_full_gradient_c: f64,
    pub enso_min_width_deg: f64,
    pub enso_full_width_deg: f64,
    pub enso_reach_lat_deg: f64,
    pub enso_reach_m: f64,
    pub enso_same_basin_m: f64,
    pub enso_variability: f64,
    pub enso_period_min_years: f64,
    pub enso_period_max_years: f64,
    pub thunder_from_c: f64,
    pub thunder_span_c: f64,
    pub thunder_full_rain_mm: f64,
    pub thunder_sea_share: f64,
    pub blizzard_below_c: f64,
    pub blizzard_min_snow_mm: f64,
    pub blizzard_min_wind: f64,
    pub dust_dry_below_mm: f64,
    pub dust_full_wind: f64,
    pub dust_track_m: f64,
    pub dust_keep: f64,
    pub tornado_plain_below_m: f64,
    pub tornado_reach_m: f64,
    pub tornado_min_barrier_m: f64,
    pub tornado_full_barrier_m: f64,
    pub tornado_from_c: f64,
    pub tornado_span_c: f64,
    pub tornado_full_rain_mm: f64,
    pub tornado_full_wind: f64,
    pub cyclone_min_lat_deg: f64,
    pub cyclone_max_lat_deg: f64,
    pub cyclone_warm_c: f64,
    pub cyclone_span_c: f64,
    pub cyclone_drift_west: f64,
    pub cyclone_drift_pole: f64,
    pub cyclone_land_keep: f64,
    pub cyclone_cold_c: f64,
    pub cyclone_cold_keep: f64,
    pub cyclone_fade_below: f64,
    pub cyclone_track_m: f64,
    pub climate_track_step_m: f64,
    pub salinity_mean_psu: f64,
    pub salinity_min_psu: f64,
    pub salinity_max_psu: f64,
    pub salinity_evap_mm: f64,
    pub salinity_land_evap_share: f64,
    pub salinity_sea_rain_mm: f64,
    pub salinity_psu_per_mm: f64,
    pub salinity_relax: f64,
    pub salinity_iters: f64,
    pub salinity_brine_psu: f64,
    pub sea_freezes_c: f64,
    pub deep_water_below_c: f64,
    pub deep_water_full_anomaly_psu: f64,
    pub deep_water_min_lat_deg: f64,
    pub conveyor_flow: f64,
    pub refine_itcz_peak_year: f64,
    pub rain_source_per_c: f64,
    pub rain_source_min: f64,
    pub ocean_high_flank_hpa: f64,
    pub ocean_high_basin_m: f64,
    pub ocean_high_from_deg: f64,
    pub ocean_high_to_deg: f64,
    pub ocean_high_smooth_sigma_m: f64,
    pub ocean_high_min_sea_share: f64,
    pub rain_flank_factor: f64,
    pub rain_flank_full_hpa: f64,
    pub rain_subsidence_mix: f64,
    pub rain_subsidence_band: f64,
    pub rain_source_max: f64,
    pub pressure_band_hpa: f64,
    pub pressure_hpa_per_c: f64,
    pub pressure_smooth_sigma_m: f64,
    pub pressure_wind_per_hpa: f64,
    pub pressure_friction_sea: f64,
    pub pressure_friction_land: f64,
    pub pressure_plateau_hpa_per_km_c: f64,
    pub pressure_plateau_from_km: f64,
    pub pressure_block_from_m: f64,
    pub pressure_block_full_m: f64,
    pub pressure_block_max: f64,
    pub upwelling_min_f: f64,
    pub upwelling_cooling_c: f64,
    pub upwelling_max_cooling_c: f64,
    pub upwelling_equator_band_deg: f64,
    pub currents_boundary_width_m: f64,
    pub currents_advect_step_m: f64,
    pub currents_advect_iters: f64,
    pub currents_base_relax: f64,
    pub currents_coastal_factor: f64,
    pub currents_inland_reach_m: f64,
    pub currents_inland_decay_m: f64,
    pub currents_coastal_lee_share: f64,
    pub alpine_treeline_elevation: f64,
    pub boreal_min_precip_mm: f64,
    pub temperate_grassland_max_precip_mm: f64,
    pub temperate_forest_max_precip_mm: f64,
    pub temperate_open_canopy_amplitude_c: f64,
    pub temperate_open_canopy_season: f64,
    pub temperate_woodland_season: f64,
    pub savanna_max_precip_mm: f64,
}

pub const CLIMATE_TUNING: ClimateTuning = ClimateTuning {
    // --- from precipitation.rs (BUG_BOUNTY 13, moved 2026-09-22) ---
    // Evaporation as a fraction of the maximum: zero at this temperature,
    // rising by one over this span, held between the floor and the cap — a
    // Clausius-Clapeyron-ish increase that keeps the tropics humid and the
    // cold poles dry.
    precip_evap_zero_c: -10.0,
    precip_evap_span_c: 40.0,
    precip_evap_min: 0.05,
    precip_evap_max: 1.2,
    // The three-cell rain belts: a cosine over the latitude with this mean
    // and swing (the ITCZ and the polar front wet, the subtropics dry).
    precip_band_base: 0.8,
    precip_band_swing: 0.7,
    // The most of a column's moisture one cell can rain out: five times the
    // base rainout, as a mountain rains some two to five times what the plain
    // before it does (Earth's wettest places, 10 000–12 000 mm/yr). It was 0.85,
    // 28 times the base; on Earth's relief (engine/scripts/earthClimate.mjs,
    // 2026-09-29) that gave Nairobi 12 900 mm and Bogotá 29 800 (both ~1000),
    // at 0.15 7 100 each and the mean rain error ×2.65 → ×2.35; at 0.10 the
    // places lost a class.
    precip_rainout_max: 0.15,
    // --- from temperature.rs ---

    // Real-ish units (°C), so the later Whittaker biome thresholds are directly
    // usable. Tune by eye — these set the equator-to-pole span.
    // Measured on Earth (engine/scripts/earthClimate.mjs, 2026-09-29): at 30 and −25
    // the places' annual means ran 1.0 °C warm on average, the tropics some
    // 2 °C, the east coasts at 35–42° 4–6 °C; Earth's zonal mean near sea
    // level fits −30 + 56.5 cos φ, but that profile here (26.5, −30) ran
    // 2.7 °C cold and shrank the A climates from 22 to 15 % of the land,
    // mostly on the tropical highlands, which were already too cold without
    // the mass elevation effect below. 28 and −25 with it: the annual mean
    // error 2.47 → 2.23 °C, the bias +1.0 → +0.3, January's error 3.8 →
    // 3.5 °C; the groups' shares 6 → 9 points off (A 22 → 21 %, C 15 → 17).
    // The pole −25 → −33 (DEC-0036 phase 8b-2): judged on the ZONAL MEANS,
    // which the places cannot show. On twelve sphere worlds (30 % land,
    // 1000 Ma) the year at 40–50° / 50–60° / 60–70° / 80–90° ran +3.5 /
    // +4.2 / +5.5 / +8.7 °C over ERA5's, the tropics within 0.5; Earth's own
    // relief on the sphere +3.1 / +3.6 / +3.8 / +4.0. The profile Earth's
    // zonal means ask for, less what the terrain and the sea add on those
    // worlds, fits −34.5 + 62.5 cos φ (the equator at 28); at −33 every 10°
    // band lies within 1.6 °C of ERA5. The places' annual mean bias +0.1 →
    // −1.5 °C (the places are coasts and lowlands, where the zonal mean is
    // a cold interior's and a sea's too).
    // The pole −33 → −28 (DES-0027 entries 10 and 14, 2026-10-30), with the
    // tropics' damping (`ebm_tropic_damping`): on Earth's relief on the sphere
    // (engine/scripts/earthClimate.mjs) 70–80° came out −21.0 °C (ERA5
    // −16) and 18 % of the land Beck calls D came out E. At −28, damping
    // in place: the groups 9 → 4 points off (E 19 → 15 %, Beck 15; D 22 →
    // 24, Beck 22), the places' bias −1.4 → −0.4 °C, January and July 3.6 /
    // 3.6 → 3.3 / 3.4 °C off; the zonal means 70–80° −21.0 → −17.3, 80–90°
    // −30.2 → −25.8 (−27), but 40–50° 9.3 → 10.8 (8.5) and 50–60° 1.3 → 3.4
    // (1.5). The torus alike: 12 → 4 points off. The pole feeds the
    // history's ice and so its sea level and erosion (DEC-0049, DEC-0050):
    // on 12 histories per shape (2048 × 1024, archean 200, epochs 1–100,
    // with the coastal upslope rain of precipitation.rs) the land under ice
    // at epoch 40 25.3 → 20.3 % on the torus, 9.2 → 6.4 % on the sphere,
    // at epoch 100 29.3 → 24.1 and 8.4 → 6.1 %; the torus's ice still grows
    // after epoch 40 (+3.9 → +3.8 points by epoch 100), and its land rises
    // as before (mean height 695 → 701 m at epoch 40, 1020 → 1018 at 100);
    // the land's share within 0.2 points.
    temp_equator_c: 28.0,
    temp_pole_c: -28.0,
    // The mass elevation effect (temperature.rs): °C per km of the land's
    // height smoothed by a Gaussian of this σ, metres. At 2 the Tibetan
    // plateau's warmest month 0 → 7 °C (some 8–10 on Earth at 4500 m), the
    // Altiplano's 7 → 8; at 1 the tropical highlands stay too cold (Brasília,
    // Bogotá, Mexico City −2..−5 °C); a radius of 6 cells changed nothing.
    // The σ is the former blur's on the torus's 62.4 km climate grid (three
    // box passes of radius 3 cells, σ² = 3 · 4 cells², DEC-0036 phase 3).
    temp_plateau_c_per_km: 2.0,
    temp_plateau_sigma_m: 216000.0,
    // The environmental lapse rate — °C lost per unit of elevation. Now a derived
    // quantity rather than a tuned one: the real atmosphere loses ~6.5 °C/km, and
    // elevation_scale.rs says a full unit is ELEVATION_METERS, so this is simply the two
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
    lapse_c_per_km: LAPSE_C_PER_KM,
    // The same lapse in ELEVATION units, which is what every consumer actually
    // multiplies by. Derived rather than restated so it follows both the rate and
    // the metre anchor.
    lapse_c_per_elevation: LAPSE_C_PER_KM * (ELEVATION_METERS / 1000.0),
    // --- from wind.rs ---

    // Relative strengths — zonal (east/west) dominates the surface pattern, the
    // meridional (toward/away from the equator) component is weaker. The model
    // itself runs on these bare numbers: moisture advection and the wind-stress
    // curl read a direction and a relative magnitude, never a speed.
    wind_zonal_strength: 1.0,
    wind_meridional_strength: 0.4,
    // What one of those units is worth in m/s, for the one consumer that has to
    // say a number out loud (the map readout). This is a CALIBRATION, not a
    // result: the band pattern is prescribed rather than solved, so nothing in the
    // model derives a speed, and the anchor is Earth's. Surface trade winds run
    // ~6-8 m/s and the mid-latitude westerlies ~8-10 m/s, both at their band
    // centre, where `wind_zonal_strength` is 1.0 — so one unit is 8 m/s, and a band
    // centre reads hypot(8, 3.2) = 8.6 m/s with the meridional part included.
    // Changing it moves no field; it moves a label.
    //
    // The alternative was to give the wind real units and derive the advection
    // from cell size and a residence time, which would make the number earned
    // instead of assigned — see the addendum in docs/decisions/climate-biomes.md
    // for why that is a different piece of work.
    wind_speed_ms_per_unit: 8.0,
    // --- from seasonality.rs ---

    // Peak annual temperature range (°C, summer − winter) — reached by a
    // continental interior at the pole; it falls as sin φ to the equator (the
    // summer's and the winter's sun differ so), and a coast keeps
    // season_coast_damp of it (thermal inertia). Fitted 2026-10-27 to the
    // refinement's twelve months, which classify the world: the history's ice
    // reads this static range, and at 42 °C and φ itself its summers were
    // some 10 °C colder than the refinement's past 50°
    // (docs/decisions/seasons-and-ice.md).
    season_max_amplitude: 62.0,
    // Land this far from the nearest ocean, metres along the field mesh,
    // counts as fully continental; nearer interpolates. A big continent's
    // core sits deep enough to saturate. 45 cells of the torus's former
    // 62.4 km climate grid (DEC-0036 phase 3).
    season_continentality_scale_m: 2808000.0,
    // Coastal land floor (continentality 0): even a coast swings a bit.
    season_coast_damp: 0.45,
    // --- from monsoon.rs ---

    // How far (fraction of map height) the ITCZ belt migrates toward the summer hemisphere.
    // Real seasonal swing is ~10-15° of latitude (bigger over monsoon land); 0.07 of the
    // map's height is 12.6° on this 2:1 torus (it was cited as 0.12 here while the
    // value stood at 0.07 — BUG_BOUNTY 58).
    monsoon_itcz_seasonal_shift: 0.07,
    // Strength of the monsoon surface wind — a component up the seasonal-temperature
    // gradient (∇T points from cool sea toward hot summer land), added to the prescribed
    // zonal wind. Tuned so it reshapes moisture advection near coasts without swamping the
    // base three-cell circulation (base zonal strength ~1). See the engine's
    // compute_monsoon_wind (climate/monsoon.rs).
    // Per °C of difference over `climate_gradient_length_m`.
    monsoon_wind_strength: 0.05,
    // The length a gradient in the climate is stated over (the monsoon's
    // ∇T, the pressure's ∇p): what a strength per °C or per hPa "per cell"
    // meant on the torus's former 62.4 km climate grid, so the strengths
    // keep their values (DEC-0036 phase 3). The pressure's blocking also
    // looks this far downwind for the barrier's top.
    climate_gradient_length_m: 62400.0,
    // Wetness floor (mm/yr) added to the monsoon-index denominator so ARID cells don't read
    // as monsoonal: a desert with 50 mm wet / 5 mm dry is dry, not seasonal, yet a raw
    // (wet−dry)/(wet+dry) would call it 0.82. The floor damps the index where absolute
    // precipitation is small, so a high index means genuinely wet-in-one-season-dry-in-the-
    // other (a real monsoon), not just marginal noise. ~ a semi-arid annual total.
    monsoon_seasonality_floor: 500.0,
    // --- from precipitation.rs ---

    // Iterations of moisture transport, and how far (metres per unit wind)
    // moisture advects each one. Needs enough to reach a steady state deep inland
    // — the flow is diagonal (zonal + meridional), so the path in is longer than
    // the straight-line distance; too few left continental interiors stuck at
    // their transient (empty) starting value. The step is 2 cells of the
    // torus's former 62.4 km climate grid (DEC-0036 phase 3).
    precip_iters: 120.0,
    precip_advect_step_m: 124800.0,
    // Moisture is advected mostly ZONALLY (it penetrates inland from the nearest
    // east/west coast). The meridional wind is damped for transport, because at
    // full strength a backward streamline from a deep mid-latitude interior curves
    // down into the neighbouring cell where the zonal wind REVERSES (Hadley vs
    // Ferrel) — it then never traces back to an ocean, starving that cell to a
    // hard zero. A gentle meridional tilt keeps streamlines within their own band.
    precip_advect_meridional_scale: 0.3,
    // Fraction of airborne moisture that rains out per iteration on flat land, and
    // the extra fraction per unit of upslope elevation along the wind (orographic
    // lift). The orographic term also creates rain shadows: moisture rains out
    // climbing the windward slope, so little is left for the lee side downwind.
    precip_base_rainout: 0.03,
    // Scaled by SLOPE_RECALIBRATION: land slopes halved when the continental
    // interior stopped being a flat plateau, so the same terrain now produces half
    // the measured upslope. Without this, orographic rain and its rain shadows both
    // collapse toward the BASE_RAINOUT floor.
    // Measured on Earth (engine/scripts/earthClimate.mjs, 2026-09-29), which runs
    // this rate at 1/2.5 (Earth's slopes are 2.5 times too steep at this
    // scale): at 0.9 the mountains and the deserts on a slope were far too
    // wet (Madrid 1345 mm, real 420; Seattle 2390, 950; Nairobi 7970, 900;
    // Riyadh 1260, 100; Alice Springs 910, 280). At 0.2 the places' rain
    // ×1.98 → ×1.78 off, the land with the right group 71 → 73 %, Earth's
    // dry land that is dry 58 → 64 %, the groups' shares 10 → 7 points off;
    // Madrid 530, Seattle 1100, Riyadh 390, Alice Springs 465. Istanbul goes
    // dry (800 → 310). Without the term the scores are about the same, but
    // no range makes a rain shadow.
    precip_orographic_rate: 0.2 * SLOPE_RECALIBRATION,
    // Land moisture recycling (evapotranspiration): the fraction of rained-out water that
    // re-evaporates from soil/vegetation back into the airborne pool, feeding downwind rain.
    // This is a MAJOR real process — ~a third to a half of continental precipitation is
    // recycled from land ET, which is what keeps deep interiors (Amazon, Congo, monsoon
    // Asia) wet far from any coast rather than the near-zero our pure-depletion advection
    // gave. It sustains ALREADY-fed interiors (so rainforests/forests reach inland) without
    // rescuing genuine rain-shadow deserts (nothing rains → nothing recycles), so aridity
    // stays where it belongs. Net land depletion per step becomes rain·(1 − this).
    precip_land_recycle_frac: 0.5,
    // The along-wind lever, metres at a wind of 1: the slope across a cell
    // (read on the fine elevation, not the coarse climate grid — the point of
    // sampling full-res here) counts as the rise over this distance. Measured
    // on Earth (engine/scripts/earthClimate.mjs, 2026-09-29), after the slope moved
    // into the cell: at 40 px (the old sample distance) the places' rain ×2.01
    // off, at 20 ×1.98, at 10 ×1.93 and the land with the right group 65 →
    // 66 %; Bogotá 1600 mm (1000), Alice Springs 900 (280). Nairobi and Riyadh
    // stay wet at any lever: their cells hold real escarpments. 20 px of the
    // torus's 7.8 km world raster (DEC-0036 phase 3).
    precip_orog_lever_m: 156000.0,
    // The slope is read from this far upwind of a cell's centre to this far
    // downwind: half the torus's former 62.4 km climate cell.
    precip_orog_half_span_m: 31200.0,
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
    // The cause is the shape of the model, not a constant. `rain_frac` is a fraction
    // per iteration with no saturation, and one iteration advects 62 km — so at a p99
    // upslope roughly half the moisture column may rain out over that single step.
    // The 0.85 clamp below binds far too late to stop it (it needs a 4100 m rise over
    // the 312 km sample, and catches only 0.04-1.4% of land cells). The physical fix
    // is a soft saturation on rain_frac, not a lower ceiling here.
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
    precip_scale: 60000.0,
    // Zonal wet/dry from the general circulation: rising (wet) air at the equator
    // ITCZ (φ=0) and the subpolar front (φ≈2/3), sinking (dry) air at the
    // subtropical highs (φ≈1/3 — the great deserts) and the poles (φ=1).
    // Floor for the zonal band multiplier — the subtropical-high / polar dry minimum. At
    // 0.1 the subtropics got a 15× dry penalty vs the equator, which (with interior
    // depletion) turned nearly all subtropical land into extreme desert. A higher floor
    // keeps those belts the driest zones without erasing all vegetation there (semi-arid
    // grassland/savanna rather than bare desert).
    precip_band_floor: 0.13,
    // The band multiplier at the subpolar front (φ ≈ 2/3, the storm tracks'
    // rain), where the equator's is precip_band_base + precip_band_swing = 1.5:
    // the poleward half of the profile rises from its dry minimum to this
    // instead (DEC-0036 phase 8b-2). At 1.5 the land at 50–60° got 790 mm a
    // year on the sphere and 880 on the torus (twelve worlds each, 30 %
    // land), Earth's land some 550; the 40–50° band was right (680, 650).
    // At 1.15 (with the colder poles) 50–60° 610 / 690 mm, 40–50° 565 / 520
    // (sphere / torus); Earth's 550 and 650.
    precip_band_storm_peak: 1.15,
    // The season's shift of the rain bands (`compute_precipitation`'s `belt_shift`)
    // tapers from full at the equator to this share of it from the latitude,
    // degrees, below: the rain belt follows the sun some 10–15°, the
    // subtropical highs some 4–5°.
    precip_belt_taper_deg: 30.0,
    precip_belt_shift_floor: 0.35,
    // On the sphere only (climate_field.rs `belt_y_norm`): the shift goes linearly to
    // 0 over this many degrees before each pole, because a pole is a point and
    // does not move. 30°: the polar cell's width, so its equatorward edge
    // moves in full and its end stays at the pole.
    belt_shift_pole_taper_deg: 30.0,
    // --- from energy_balance.rs (the climate step's year) ---
    // Not measured yet (2026-09-28); physical orders of magnitude, then the
    // exchange and the carry set against Earth's seasonal ranges.

    // The solar constant at 1 AU, W/m², and the top hemisphere's vernal
    // equinox as a fraction of the year from 1 January: about 20 September,
    // so its summer is the southern one and the bottom hemisphere — the
    // screen's upper half — has the northern calendar (climate_field.rs
    // TOP_SUMMER_MONTH). It was 0.22 (20 March) until 2026-09-29.
    ebm_solar_wm2: 1361.0,
    ebm_vernal_equinox_year: 0.72,
    // Albedo: what the surface and the air above it reflect. Ice where the
    // annual mean is below `ebm_ice_below_c`.
    ebm_albedo_land: 0.3,
    ebm_albedo_sea: 0.1,
    ebm_albedo_ice: 0.6,
    ebm_ice_below_c: -10.0,
    // Sea whose annual mean is below this, °C, counts as ice-covered for the
    // heat capacity (sea water freezes at −1.8 °C, but the annual mean read
    // here is the air's, which over an open sea in winter runs well below
    // the water's). At 0 the Nordic seas froze in the model (the Norwegian
    // Sea's air comes out near −2 °C a year with the cooler profile of
    // 2026-09-29), swung like land, and took the coasts with them: on
    // Earth's relief Reykjavik's year swung 28 °C (11), Nuuk's 27 (14). At −6
    // 14 and 20; the places' January error 3.5 → 3.3 °C, their swing error
    // 5.2 → 4.7 °C. At −10 the groups' shares go 9 → 16 points off (D gives
    // way to E).
    ebm_sea_ice_below_c: -6.0,
    // Heat capacity, J/m²K: land is the air column and a little soil
    // (~1.2·10⁷), the sea a 50 m mixed layer (~2.1·10⁸).
    ebm_capacity_land: 1.0e7,
    ebm_capacity_sea: 2.1e8,
    // The damping per kelvin, W/m²K: the outgoing radiation (Budyko's B,
    // ~2) and the heat the surface gives to the air above it, which the
    // cycle's anomaly loses too. Measured on Earth with the land's capacity
    // (engine/scripts/earthClimate.mjs, 2026-09-29): at B 2.1 and 3·10⁷ the northern
    // land's warmest month was August (3981 cells) or September (1565), not
    // July (109): an interior continent has no neighbour to damp it, and
    // C/B gave it a lag of some 70°. At 8 and 1·10⁷: July 4720, August 908;
    // the land with the right class 27 → 31 %, the places' January and July
    // error 4.1 → 3.8 and 3.7 → 3.1 °C. The capacity alone widened the swing
    // by 7 °C; the damping holds it. 8 → 6.5 with the colder poles of
    // DEC-0036 phase 8b-2 (temp_pole_c −25 → −33): the annual means came down
    // 3–4 °C at 40–70° and, the swing unchanged, the summers with them —
    // Earth's relief on the sphere had 23 % of its land E (Beck 15) and 18 %
    // D (22), the groups 18 points off. The damping is the land's swing (the
    // sea's is its capacity's): at 6.5 E 19, D 22, 13 points off, the
    // places' swing −0.8 → +0.9 °C, July the warmest month on 66 % of the
    // northern land (53).
    ebm_radiation: 6.5,
    // The exchange with the neighbouring air, as a diffusion D ∇²T' (W/K:
    // W/m²K times m²), and the carry by the wind, a (u · ∇T') per unit of
    // wind (8 m/s) (W/m²K times m). Stated until DEC-0036 phase 4 per
    // neighbour of the torus's 62.4 km climate cell — 40 W/m²K each, and 100
    // W/m²K per unit of wind across one cell — and kept at those lengths:
    // 40 × 62 400² and 100 × 62 400. The carry measured on Earth
    // (engine/scripts/earthClimate.mjs, 2026-09-29): at 400 the sea's air reached so
    // far inland that the places' years came out 2.8 °C too narrow on average
    // (Winnipeg's January +2 °C, real −16); at 150 0.6 °C, and the land's
    // Köppen groups 29 → 18 points off Beck 2018's rounded shares. At 50 the swings stay right
    // but the D group overgrows (29 % of land, Earth 22). With the damping
    // at 8 (above), 100 (swing −0.5 °C against 150's −1.1).
    ebm_diffusion_w_per_k: 40.0 * 62_400.0 * 62_400.0,
    ebm_carry_per_wind_m: 100.0 * 62_400.0,
    // The tropics' weak temperature gradient (energy_balance.rs
    // `damp_tropical_land`): the share of the land's departure taken out at the
    // equator, the latitude up to which all of it is taken out, and the one
    // past which none is (°, a smoothstep between). Measured 2026-10-30
    // (DES-0027 entry 10). On Earth's relief on the sphere: the groups 14 →
    // 9 points off (A 19 → 23 %, Beck 23; C 15 → 12, Beck 13), January and
    // July 4.0 / 3.8 → 3.6 / 3.6 °C off, the places' swing +0.9 → 0.0 °C;
    // the torus 16 → 12 points. On three worlds at full size (2048 × 1024,
    // spheres m15 and Thalassor, torus Zephyra; the nodes of level 0): Cwa
    // 7.1 / 8.4 / 4.7 → 3.8 / 7.3 / 3.8 % of the land (Earth 1.5–2), Aw 6.6
    // / 6.7 / 2.0 → 8.6 / 8.3 / 3.4; the savanna +2.3 / +4.9 / +2.2 points,
    // the temperate forest −1.3 / −7.4 / −0.6. What Cwa is left lies at
    // 20–35° (Thalassor: 92 % of it, coldest month 11 °C, range 17 °C): the
    // monsoon's subtropical winter, which the damping does not reach. With
    // the pole at −28, 0.3 / 0.4 / 0.5 put Earth's groups 5 / 4 / 5 points
    // off and the places' swing +0.1 / −0.2 / −0.4 °C: past 0.4 the land's
    // years come out narrower than Earth's.
    ebm_tropic_damping: 0.4,
    ebm_tropic_full_deg: 15.0,
    ebm_tropic_none_deg: 30.0,
    // --- from phenomena.rs (the climate step's weather phenomena) ---
    // Not measured yet (2026-09-28); orders of magnitude.

    // Fog reaches this far inland from its sea cell (the distance between
    // the two cells' centres, metres; 2 cells of the former 62.4 km climate
    // grid, DEC-0036 phase 5), full up to `fog_full_within_m` (the next cell's)
    // and thinning by the reach beyond it (half at the reach), none past it;
    // it is
    // full where the sea is this much colder than its latitude's base and the
    // air this much warmer than the sea, and it takes this share of the
    // difference off the coast's month (the marine layer's chill).
    fog_reach_m: 124800.0,
    fog_full_within_m: 62400.0,
    fog_full_cold_c: 2.0,
    fog_full_contrast_c: 3.0,
    // A wind this onshore (the cosine to the coast's normal) counts in full.
    fog_full_onshore: 0.5,
    fog_cooling: 0.5,
    // Föhn: the highest ground within this far upwind (metres, 4 former
    // cells, in steps of `climate_track_step_m`), over the ground
    // here, from this barrier (m) on, full at this much more; full at this wind
    // (8 m/s units); this much warmer on a month of it, °C (a monthly mean; the
    // days themselves run 10–20 °C warmer).
    foehn_reach_m: 249600.0,
    // From 600 m: the air sheds its water above the cloud base on the
    // windward side and comes down the lee dry, some 0.4 °C warmer per 100 m.
    foehn_min_barrier_m: 600.0,
    foehn_full_barrier_m: 2000.0,
    foehn_full_wind: 1.0,
    foehn_warming_c: 3.0,
    // --- from reliability.rs (the rain's reliability, the ENSO see-saw) ---
    // Not measured yet (2026-09-28); orders of magnitude.

    // The rain's own year-to-year spread (coefficient of variation):
    // scale/√(annual mm), so 100 mm → 45 %, 400 mm → 22 %, 1600 mm → 11 %
    // (deserts vary by 40–50 %, wet coasts by 10–15 %); the rain floored at
    // this many mm, the spread capped here; this much more on a fully seasonal
    // year (the monsoon's margins fail).
    rain_variability_scale: 4.5,
    rain_variability_floor_mm: 50.0,
    rain_variability_max: 0.8,
    rain_variability_season: 0.3,
    // The see-saw: basins are the sea runs within this latitude of the
    // equator, shore to shore; full where the west third is this much warmer
    // than the east third, and from this width to that (the Pacific spans
    // ~150°, the Atlantic ~60°, and its see-saw is weak).
    enso_rows_deg: 5.0,
    enso_full_gradient_c: 3.0,
    enso_min_width_deg: 50.0,
    enso_full_width_deg: 120.0,
    // Its reach on land: this latitude and this far (metres along the
    // parallel, 20 former cells) from the basin's ends, as Gaussians; this
    // much spread at full reach. Two runs whose ends lie within
    // `enso_same_basin_m` of each other (at the equator, 3 former cells) are
    // one basin seen on two parallels.
    enso_reach_lat_deg: 25.0,
    enso_reach_m: 1248000.0,
    enso_same_basin_m: 187200.0,
    enso_variability: 0.3,
    // Its period, years, from a narrow basin to one of 180°: a 150° basin
    // comes out at about 4.5 years (Earth's ENSO recurs every 2–7, some 4 on
    // average). At 7 the 150° test basin gave 6.2.
    enso_period_min_years: 2.0,
    enso_period_max_years: 5.0,
    // --- from storms.rs (the climate step's storms) ---
    // Not measured yet (2026-09-28); orders of magnitude.

    // Thunder: from this warmth, full this much warmer, full at this month's
    // rain (mm); the sea builds this share of the land's.
    thunder_from_c: 10.0,
    thunder_span_c: 18.0,
    thunder_full_rain_mm: 150.0,
    thunder_sea_share: 0.25,
    // Blizzard: a month below this °C with this much snow (mm water) and this
    // much wind (8 m/s units).
    blizzard_below_c: -5.0,
    blizzard_min_snow_mm: 15.0,
    blizzard_min_wind: 0.7,
    // Dust: a month under this rain (mm) is dry, a wind this strong lifts in
    // full; it drifts this far along the year's wind (metres, 20 former
    // cells), keeping this share per step of `climate_track_step_m`.
    dust_dry_below_mm: 25.0,
    dust_full_wind: 0.8,
    dust_track_m: 1248000.0,
    dust_keep: 0.75,
    // Tornado: a plain below this height (m); ground this high within this
    // far upwind (metres, 12 former cells), full this much higher (the dry
    // air aloft); warm and
    // moist from this °C, full this much warmer and at this month's rain;
    // full at this wind.
    tornado_plain_below_m: 1000.0,
    tornado_reach_m: 748800.0,
    tornado_min_barrier_m: 1500.0,
    tornado_full_barrier_m: 1500.0,
    tornado_from_c: 12.0,
    tornado_span_c: 10.0,
    tornado_full_rain_mm: 80.0,
    tornado_full_wind: 1.0,
    // Cyclones form between these latitudes over sea warmer than 26.5 °C,
    // full this much warmer; each step `climate_track_step_m` along the month's
    // wind with this drift west and poleward; over land a track keeps this
    // share per step, over sea colder than this °C that share; it ends below
    // this weight or after this far (metres, 60 former cells).
    cyclone_min_lat_deg: 5.0,
    cyclone_max_lat_deg: 20.0,
    cyclone_warm_c: 26.5,
    cyclone_span_c: 3.0,
    cyclone_drift_west: 0.3,
    cyclone_drift_pole: 0.6,
    cyclone_land_keep: 0.7,
    cyclone_cold_c: 24.0,
    cyclone_cold_keep: 0.8,
    cyclone_fade_below: 0.02,
    cyclone_track_m: 3744000.0,
    // The step of the refinement's tracks and marches (the cyclones, the
    // dust, the föhn's and the tornado's look upwind), metres along the
    // great circle: the former climate cell, so the keeps per step above
    // keep their values (DEC-0036 phase 5).
    climate_track_step_m: 62400.0,
    // --- from salinity.rs (the sea's salt and the overturning) ---
    // Not measured yet (2026-09-29); orders of magnitude.

    // The ocean's mean salinity, psu, and the range a cell is held in (the
    // Baltic runs to 7, the Red Sea to 41).
    salinity_mean_psu: 35.0,
    salinity_min_psu: 5.0,
    salinity_max_psu: 42.0,
    // What the sea evaporates at the evaporation factor's 1 (~30 °C), mm/yr
    // (tropical seas lose some 1800); land evaporates this share of it.
    salinity_evap_mm: 1800.0,
    salinity_land_evap_share: 0.6,
    // The sea's rain: this many mm/yr at the rain model's zonal band factor and
    // evaporation factor of 1 (salinity.rs). The band runs 1.5 at the equator
    // and the 60th parallels, 0.13 in the subtropics and at the poles, so the
    // equatorial sea gets ~2200 mm/yr, 60° ~900, the subtropics ~150 (Earth:
    // ~2200, ~1000, 500–700 — the subtropics too dry, the gradient right).
    salinity_sea_rain_mm: 1550.0,
    // psu per mm/yr of net fresh water, per pass, with this relaxation toward
    // the mean per pass, over this many passes: a surplus of 1000 mm/yr of
    // evaporation settles near +2 psu (the subtropical gyres run 36–37).
    salinity_psu_per_mm: 1.0e-4,
    salinity_relax: 0.05,
    salinity_iters: 150.0,
    // psu per pass where the sea freezes (the salt the ice leaves behind).
    // Small: freezing and melting nearly cancel over a year; what is left is
    // the brine of the ice that drifts away.
    salinity_brine_psu: 0.01,
    // Surface water sinks poleward of this latitude where the sea is colder
    // than this °C (fully at freezing, −1.8 °C) and saltier than its
    // latitude's mean, fully this much saltier. At 0.5 psu a fifth or more of
    // the sinking reached 6 % of Astrakan's sea; at 1 psu 3 % (the test world
    // with an Atlantic-like basin 5 %), at a mean 68–71°, and the overturning
    // warms the land beside it by up to 1.7–2.4 °C. Earth's sinking is a few
    // small patches (55–70°), its warmth some degrees on Europe's coasts.
    sea_freezes_c: -1.8,
    deep_water_below_c: 5.0,
    deep_water_full_anomaly_psu: 1.0,
    deep_water_min_lat_deg: 50.0,
    // The sinking's surface inflow (ocean_currents.rs `compute_sink_inflow`): its
    // fastest cell as this share of the wind's fastest current.
    conveyor_flow: 0.3,
    // --- from refinement.rs ---
    // When the equatorial rain belt stands furthest toward the top hemisphere,
    // as a fraction of the year: about mid-January, a few weeks after its
    // solstice, as the sea's lag holds it back (climate_field.rs TOP_SUMMER_MONTH;
    // mid-July, 0.54, until 2026-09-29).
    refine_itcz_peak_year: 0.04,
    // The rain's multiplier from the anomaly of the sea the air rose from
    // (`compute_precipitation`'s refined path): e^(perC × °C), clamped. Measured
    // on Earth (engine/scripts/earthClimate.mjs, 2026-09-29): 0.2 moves the land's
    // Köppen groups from 18 points off Beck 2018's rounded shares to 8 (B 20 → 26 %, the dry
    // west coasts); 0.3 gives 6 but dries the places' rain further (×2.49 →
    // ×2.58 off).
    rain_source_per_c: 0.2,
    rain_source_min: 0.2,
    // The ocean highs (refinement.rs): ± hPa from a basin's western shore to
    // its eastern, in full in a basin this wide along its parallel (metres,
    // 40 former cells), over the latitudes
    // between (a sine bump); smoothed by a Gaussian of this σ (metres, the
    // former three box passes of 8 cells: √(8 · 9) cells) as a mean over
    // the sea, and nothing where less than the share of the smoothing is sea.
    // Under the western flank the band's dryness gives way toward
    // `rain_flank_factor`, in full at −`rain_flank_full_hpa`
    // (`compute_precipitation`'s `flank_relief`). Measured on Earth
    // (engine/scripts/earthClimate.mjs, 2026-09-29): of the real C land, 51 % came
    // out dry (B), now 30 %; the land with the right group 63 → 65 %, the
    // places' classes 10 → 15 of 47, their rain ×2.49 → ×2.06 off. The groups'
    // shares 13 → 19 points off: C grows past Earth's (18 % against 13).
    // A high from the sea's own anomaly (cold high, warm low, 3–10 hPa/°C)
    // was tried first and dried the east coasts further: their warm currents
    // come out at +0.5 °C here, and the cold seas set the mean.
    ocean_high_flank_hpa: 8.0,
    ocean_high_basin_m: 2496000.0,
    ocean_high_from_deg: 15.0,
    ocean_high_to_deg: 50.0,
    ocean_high_smooth_sigma_m: 529000.0,
    ocean_high_min_sea_share: 0.05,
    rain_flank_factor: 1.0,
    rain_flank_full_hpa: 1.5,
    // The share of the moisture the sinking air mixes away per iteration over
    // land, where it sinks in full, and the band factor below which the band
    // counts as sinking air (`compute_precipitation`'s subsidence). Measured on
    // Earth (engine/scripts/earthClimate.mjs, 2026-09-29): a small effect. At 0.05
    // the groups' shares 19 → 16 points off, the cells and the places
    // unchanged; Cairo 99 → 63 mm, Tehran 518 → 445, Dakar 454 → 354. More
    // dries New York and Chicago, whose air crosses the band's core on its way
    // from the Gulf. The band counted from 1 down made the storm tracks at 40°
    // sink too (New York, Chicago → B). The wet deserts left are the
    // upslope rainout's: without it Riyadh 496 → 244, Alice Springs 2051 → 431.
    rain_subsidence_mix: 0.05,
    rain_subsidence_band: 0.3,
    rain_source_max: 4.0,
    // --- from pressure.rs ---
    // Not measured yet (2026-09-28); set from Earth's orders of magnitude.

    // Half the range of the zonal bands: 1013 ± 8 hPa, the equatorial trough
    // and the subpolar lows against the subtropical highs.
    pressure_band_hpa: 8.0,
    // Thermal part: hPa per °C of departure from the row's mean. The Siberian
    // winter high is some +20–30 hPa over air 20–30 °C colder than its
    // latitude.
    pressure_hpa_per_c: 1.0,
    // Smoothing, a Gaussian of this σ, metres: the scale of heat lows and
    // cold highs rather than of coasts. The former blur's on the torus's
    // 62.4 km climate grid (three box passes of radius 6 cells, σ² = 6 · 7
    // cells², DEC-0036 phase 3).
    pressure_smooth_sigma_m: 404000.0,
    // Wind units (8 m/s) per hPa of difference over `climate_gradient_length_m`
    // before the balance: 20 hPa over 2000 km at 45° gives some 5 m/s over
    // the sea.
    pressure_wind_per_hpa: 0.8,
    // Surface friction against the Coriolis parameter (1 at the pole, 24 h day):
    // the wind crosses the isobars at about 20° over the sea at mid latitudes,
    // at about 40° over land.
    pressure_friction_sea: 0.3,
    pressure_friction_land: 0.6,
    // The elevated heat source (refinement.rs): hPa per km of height over the
    // threshold per °C of the month's departure from the year's mean.
    // Measured on Earth (engine/scripts/earthClimate.mjs, 2026-09-29): at 0.6 the
    // July pressure over Tibet 1016 → 1007 hPa, the wind over the Bay of
    // Bengal turns southwest, Beijing's rain 117 → 574 mm (570), Tehran 491 →
    // 354 (230); the land with the right group 70 → 71 %. At 1 Beijing 1166.
    // Delhi stays dry: it lies in the westerly on the low's south side, off
    // the Thar, as the heat low over Pakistan is too shallow here.
    pressure_plateau_hpa_per_km_c: 0.6,
    pressure_plateau_from_km: 1.0,
    // A range turns the part of the wind that blows up its slope: nothing below
    // the first height, the full share `pressure_block_max` above the second.
    pressure_block_from_m: 1500.0,
    pressure_block_full_m: 4000.0,
    pressure_block_max: 0.7,
    // --- from ocean_currents.rs (upwelling, the climate step's refinement) ---
    // Not measured yet (2026-09-28).

    // |f| is held at least here (sin 12°) near the equator, with its sign, so
    // the Ekman transport τ/f stays finite and still turns both ways. A
    // numerical guard, not a planet property: Ekman's balance fails where f
    // goes to 0, and this sets how strong the equatorial band comes out. At 0.1
    // the band set the layer's scale (Astrakan: equator 0.68 of the 98th
    // percentile, rising coasts 0.60); at 0.2 the coasts stand out (equator
    // 0.62, coasts 1.09) and the equator cools −0.89 °C instead of −1.03 °C.
    upwelling_min_f: 0.2,
    // Sea cooling per unit of upwelling divergence, and its cap: real upwelling
    // coasts run some 4–8 °C colder than the open sea at their latitude.
    upwelling_cooling_c: 2.0,
    upwelling_max_cooling_c: 6.0,
    // Latitude, degrees, over which the equatorial rule (cold only in the east
    // of a basin) fades into the coastal one (cold wherever it comes up).
    upwelling_equator_band_deg: 12.0,
    // --- from ocean_currents.rs ---

    // Stommel's boundary width r / β at the equator, metres: β, the
    // northward growth of the Coriolis parameter, is cos φ over this against
    // a friction of 1 (ocean_currents.rs). The western boundary current is
    // about this wide at the equator and wider toward the poles. Stated until
    // DEC-0036 phase 4 as β = 0.4 per 62.4 km cell of the torus's climate grid
    // (2.5 cells), kept at that length: the narrowest that grid could hold.
    // Where β times a cell's spacing passes 2 the central difference of the
    // β term loses diagonal dominance (at 78 km 0.5).
    currents_boundary_width_m: 156000.0,
    // SST transport: how far (metres) it advects along the normalized current
    // per iteration, how many iterations, and the per-iteration relaxation back
    // toward the latitudinal base (anchors the SST to latitude so anomalies stay
    // bounded — a few °C, like real boundary currents on this coarse grid).
    // The step was 2.5 until the β term (2026-09-28): the western jet now sets
    // the normalisation, the mean speed fell to 0.61 of before, and the
    // anomalies with it (Astrakan: warm 29 → 16 % of the sea, cold 26 → 16 %).
    // At 4 they are back at warm 21 %, cold 24 %, +4.2/−7.5 °C. The cold
    // eastern coasts belong to upwelling, which is not modelled yet. The step
    // was 4 cells of the torus's 62.4 km climate grid until DEC-0036 phase 4,
    // kept at that length.
    // The relaxation measured on Earth (engine/scripts/earthClimate.mjs,
    // 2026-09-29): at 0.15 the anomalies came out at a third of Earth's (off
    // Norway +2.1 °C, some +7; off California −1.7, some −4), the North
    // Atlantic's warmth fading before it reached Europe; at 0.1 +2.6 and
    // −2.4, Reykjavik's year 3 °C → right, London's 4 → 2 °C too cold, the
    // places' January error 3.9 → 3.7 °C. At 0.05 the anomalies grow on
    // (+3.4, −3.8) and the scores do not.
    currents_advect_step_m: 249600.0,
    currents_advect_iters: 80.0,
    currents_base_relax: 0.1,
    // How strongly the land takes the sea's anomaly it gets (warm current →
    // milder coast, cold current/upwelling → cooler coast).
    currents_coastal_factor: 0.9,
    // The anomaly carried onto the land with the wind (ocean_currents.rs
    // `carry_inland`): looked for this far upwind (metres), e^(−d / decay) over
    // land, and the share a coast gets off its own shore where the wind
    // blows out to sea. The overturning's warmth goes the same way
    // (refinement.rs). Measured on Earth
    // (engine/scripts/earthClimate.mjs, 2026-09-29) against the old spread: the
    // places' annual mean error 2.54 → 2.47 °C, Oslo −4 → −1 °C, Ushuaia −3 →
    // +4 (a cold coast downwind of nothing now), classes 17 → 18 of 47; at a
    // decay of 6 or 10 cells a little less. The east coasts (Tokyo, New
    // York, Beijing +4..+6 °C) did not move: their warmth is the latitude
    // profile's, not the currents'. Stated until DEC-0036 phase 4 as 30 and
    // 15 cells of the torus's 62.4 km climate grid, kept at those lengths.
    currents_inland_reach_m: 1872000.0,
    currents_inland_decay_m: 936000.0,
    currents_coastal_lee_share: 0.3,
    // --- from biomes.rs ---

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
    alpine_treeline_elevation: 2800.0 / ELEVATION_METERS,
    // --- the Whittaker classifier's own thresholds ---------------------------
    //
    // These were INLINE LITERALS inside `classify`, which made the largest block
    // of climate tuning in the repo invisible to every grouping — including the
    // one this file exists to be. Naming them changes nothing and makes them
    // findable, comparable and hashable.

    // In the cold band, dryness gives tundra rather than boreal forest.
    boreal_min_precip_mm: 200.0,
    // Temperate / subtropical precipitation edges (mm/yr).
    temperate_grassland_max_precip_mm: 600.0,
    temperate_forest_max_precip_mm: 1500.0,
    // Strong precipitation seasonality opens the canopy: a marginal forest with a
    // pronounced dry season reads as woodland or grassland, not closed forest.
    temperate_open_canopy_amplitude_c: 20.0,
    temperate_open_canopy_season: 0.3,
    temperate_woodland_season: 0.4,
    // Hot band. The rainforest/savanna split is driven by SEASONALITY rather
    // than the annual total: evergreen rainforest needs rain most of the year,
    // while a strong wet-dry rhythm gives savanna even when the total is high.
    // Köppen Aw/As: savanna below this annual rain, tropical dry forest above
    // (the wet end of Aw). Not the Whittaker bound of 600 mm: Köppen already
    // calls anything under ~780 mm at 25 °C dry (B), so every Aw cell passed
    // 600 and the savanna was gone (Astrakan 0.2 %). Real savannas reach
    // 1300–1500 mm.
    savanna_max_precip_mm: 1400.0,
};

//! `tectonics/tectonicsTuneParams.ts`: the tectonics' tuning in one object.
//! The reasoning and the measurements behind each value are in the
//! TypeScript file; this port keeps the values and their order.

use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TectonicsTuning {
    pub detection_lattice_resolution_x: usize,
    pub detection_lattice_resolution_y: usize,
    pub mantle_flow_speed_km_per_myr: f64,
    pub uplift_per_km: f64,
    pub orogen_crust_m: f64,
    pub shortening_half_life_ma: f64,
    pub crust_side_m: f64,
    pub intraplate_shortening: f64,
    pub coast_search_m: f64,
    pub lock_epochs_required: f64,
    pub rift_accumulator_threshold: f64,
    pub merge_accumulator_threshold: f64,
    pub plate_count_pressure_strength: f64,
    pub plate_count_pressure_clamp: f64,
    pub min_plate_count: usize,
    pub thickness_decay_per_epoch: f64,
    pub oceanic_subsidence_decay_per_epoch: f64,
    pub feature_prune_thickness: f64,
    pub feature_prune_inactivity_epochs: f64,
    pub feature_prune_max_inactivity_epochs: f64,
    pub age_multiplier_floor: f64,
    pub age_multiplier_range: f64,
    pub age_multiplier_half_life_epochs: f64,
    pub trench_offset_m: f64,
    pub trench_depth_fraction: f64,
    pub trench_half_width_m: f64,
    pub trench_relief_per_subsidence: f64,
    pub accretion_blob_radius_m: f64,
    pub accretion_inset_m: f64,
    pub accretion_min_gap_m: f64,
    pub accretion_max_attach_m: f64,
    pub accretion_epoch_interval: f64,
    pub stabilisation_epochs: f64,
    pub recycle_downwelling_threshold: f64,
    pub split_max_dist_m: f64,
    pub split_gap_m: f64,
    pub split_merge_immunity_epochs: f64,
    pub cont_rift_lock_epochs: f64,
    pub cont_rift_threshold_factor: f64,
    pub cont_rift_cooldown_epochs: f64,
    pub ocean_age_init: f64,
    pub breakup_fresh_crust_radius_m: f64,
    pub mantle_coupling_rate: f64,
    pub seed_recentre_rate: f64,
    pub keel_drag: f64,
    pub hotspot_deposit_per_epoch: f64,
    pub hotspot_epoch_interval: f64,
    pub flood_basalt_deposit: f64,
    pub volcano_build_m_per_myr: f64,
    pub volcano_top_m: f64,
    pub volcano_radius_m: f64,
    pub volcano_spacing_m: f64,
    pub volcano_reach_m: f64,
    pub volcano_arc_gap_m: f64,
    pub rift_cool_radius_m: f64,
    pub rift_cool_amount: f64,
    pub rift_reset_radius_m: f64,
    pub rift_margin_recovery_epochs: f64,
    pub rift_basin_floor_thickness: f64,
    pub flexure_te_young_km: f64,
    pub flexure_te_craton_km: f64,
    pub flexure_te_ocean_floor_km: f64,
    pub flexure_te_ocean_age_km: f64,
    pub flexure_te_ocean_max_km: f64,
    pub flexure_crust_density: f64,
    pub flexure_mantle_density: f64,
    #[serde(rename = "flexureYoungsModulusGPa")]
    pub flexure_youngs_modulus_gpa: f64,
    pub flexure_poisson: f64,
    pub flexure_deflection_scale: f64,
    pub collapse_height_m: f64,
    pub collapse_smoothing_m: f64,
    pub wedge_radius_m: f64,
    pub wedge_height_m: f64,
    pub fold_wavelength_km: f64,
    pub fold_amplitude: f64,
}

const SPLIT_GAP_M: f64 = 624_000.0;

pub const TECTONICS_TUNING: TectonicsTuning = TectonicsTuning {
    detection_lattice_resolution_x: 256,
    detection_lattice_resolution_y: 128,
    // 16 → 28 with the keel's drag (TEG-51; DES-0027 entry 2, 2026-10-29):
    // the drag slows the continental plates, the faster flow brings the
    // oceanic ones back to Earth's 50–100 km/Myr. Tuned with `keel_drag`.
    mantle_flow_speed_km_per_myr: 28.0,
    uplift_per_km: 0.01 / (0.05 * 7.8),
    orogen_crust_m: 40_000.0,
    shortening_half_life_ma: 2.0,
    crust_side_m: 156_000.0,
    // 0.3 → 0.2 with `collapse_height_m` (TEG-71; DES-0027 entry 26,
    // 2026-10-30). Target: a mean land height of 700–850 m on both shapes
    // (Earth ~840 m), held from epoch 40 to 100. Before, the land rose all
    // history long; the interior push lifts broad land that the erosion
    // reaches slowly. 6 seeds per shape, epochs 40 / 100 (torus / sphere):
    // 0.3 → 0.15 lowered the mean land height 883 → 771 / 711 → 675 and
    // 1300 → 1099 / 860 → 795 m; 0.6 raised it.
    intraplate_shortening: 0.2,
    coast_search_m: 936_000.0,
    lock_epochs_required: 40.0,
    rift_accumulator_threshold: -40.0,
    merge_accumulator_threshold: 60.0,
    plate_count_pressure_strength: 0.03,
    plate_count_pressure_clamp: 0.6,
    min_plate_count: 3,
    thickness_decay_per_epoch: 0.99,
    oceanic_subsidence_decay_per_epoch: 0.85,
    feature_prune_thickness: 0.05,
    feature_prune_inactivity_epochs: 40.0,
    feature_prune_max_inactivity_epochs: 150.0,
    age_multiplier_floor: 0.5,
    age_multiplier_range: 1.0,
    age_multiplier_half_life_epochs: 150.0,
    trench_offset_m: 468_000.0,
    trench_depth_fraction: 0.6,
    trench_half_width_m: 50_000.0,
    trench_relief_per_subsidence: 1.6,
    accretion_blob_radius_m: 546_000.0,
    accretion_inset_m: 234_000.0,
    accretion_min_gap_m: 663_000.0,
    accretion_max_attach_m: 1_170_000.0,
    accretion_epoch_interval: 3.0,
    stabilisation_epochs: 150.0,
    recycle_downwelling_threshold: -0.05,
    split_max_dist_m: 1_248_000.0,
    split_gap_m: SPLIT_GAP_M,
    split_merge_immunity_epochs: 0.0,
    cont_rift_lock_epochs: 20.0,
    cont_rift_threshold_factor: 0.55,
    cont_rift_cooldown_epochs: 20.0,
    ocean_age_init: 40.0,
    breakup_fresh_crust_radius_m: SPLIT_GAP_M,
    mantle_coupling_rate: 0.15,
    // THE SEEDS' LLOYD STEP (TEG-53, TEG-104; DES-0027 entry 4,
    // 2026-10-29): each epoch a seed moves this share of the way to its
    // footprint's centroid (epoch/mantle_coupling.rs). 6 seeds per shape
    // (torus / sphere), 2048 × 1024, archean 200, 600 plain epochs, before
    // → after: the seeds' Clark–Evans ratio at epochs 500–600 0.54 / 0.95
    // → 1.31 / 1.39, the plates at epoch 600 3 / 9 → 12 / 11.5, plates
    // with no mantle cell 0 / 0.08 an epoch → 0 (DES-0027 entry 4).
    seed_recentre_rate: 0.05,
    // THE KEEL'S DRAG (TEG-51; DES-0027 entry 2, 2026-10-29): a plate's
    // fitted motion over 1 + this × its continental share
    // (epoch/mantle_coupling.rs). Tuned with `mantle_flow_speed_km_per_myr`
    // on 6 seeds per shape (torus / sphere, epochs 1–100, by the crust's
    // area): continents / oceans 47 / 46 and 33 / 45 km/Myr before, 23 /
    // 55 and 21 / 53 with 4 and 28 (3 and 25 gave a ratio of 0.52 once the
    // events read the crust; DES-0027 entry 2 has the sweep).
    keel_drag: 4.0,
    hotspot_deposit_per_epoch: 4.0,
    hotspot_epoch_interval: 2.0,
    flood_basalt_deposit: 50.0,
    // THE ISLAND ARCS (TEG-54; DES-0027 entry 5, 2026-10-30): an arc builds
    // while it is active (fed within volcanoes.rs ARC_ACTIVE_EPOCHS, not
    // only in an epoch with a deposit), its cones `volcano_arc_gap_m` into
    // the overriding plate (Earth's arc–trench gap is 100–250 km; at the
    // boundary they stood on the trench), and at 2250 m/Myr at the summit:
    // at most about 30 km³ per km of arc and Myr (Earth 30–90). The cone's
    // load bends the plate (the flexure takes some 0.8 of it on young
    // ocean); at 1500 m/Myr the cones stopped near −3000 m. 12 seeds per
    // shape (torus / sphere), 2048 × 1024, archean 200, epochs 1–100: the
    // active arcs' volcanic front with land within 80 km at epochs 40 / 60
    // / 100 23 / 42 / 52 % and 28 / 39 / 47 % (the arc features before: 3
    // / 5 / 9 % and 7 / 9 / 10 %; 3000 m/Myr, 6 seeds: 37 / 53 / 66 % and
    // 37 / 48 / 60 %, with twice the arc islands' area).
    volcano_build_m_per_myr: 2250.0,
    volcano_top_m: 1500.0,
    volcano_radius_m: 50_000.0,
    volcano_spacing_m: 120_000.0,
    volcano_reach_m: 120_000.0,
    volcano_arc_gap_m: 150_000.0,
    rift_cool_radius_m: 2_964_000.0,
    rift_cool_amount: 1.8,
    rift_reset_radius_m: 3_120_000.0,
    rift_margin_recovery_epochs: 45.0,
    rift_basin_floor_thickness: -0.9,
    flexure_te_young_km: 20.0,
    flexure_te_craton_km: 70.0,
    flexure_te_ocean_floor_km: 5.0,
    flexure_te_ocean_age_km: 3.0,
    flexure_te_ocean_max_km: 50.0,
    flexure_crust_density: 2700.0,
    flexure_mantle_density: 3300.0,
    flexure_youngs_modulus_gpa: 70.0,
    flexure_poisson: 0.25,
    flexure_deflection_scale: 1.0,
    // The plateau's balance 4000 → 2500 m with `intraplate_shortening`
    // (TEG-71; DES-0027 entry 26, 2026-10-30): the broad highlands stood at
    // 2–3 km and grew each epoch. 6 seeds per shape, epochs 40 / 100 (torus
    // / sphere): 3000 m lowered the mean land height 883 → 832 / 711 → 691
    // and 1300 → 1160 / 860 → 803 m, 2500 m to 799 / 678 and 1090 / 764 m.
    // The 12-seed result of both is in DES-0027 entry 26.
    collapse_height_m: 2500.0,
    collapse_smoothing_m: 150_000.0,
    wedge_radius_m: 10_000.0,
    wedge_height_m: 9500.0,
    fold_wavelength_km: 15.0,
    fold_amplitude: 0.5,
};

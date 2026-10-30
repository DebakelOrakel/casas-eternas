//! The module test of the tectonics against the TypeScript engine's
//! `tectonics/`: the same scenarios give the same bits
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/tectonicsFixture.mjs`; the scenarios below are that
//! script's, step for step. A change to the model that is meant records
//! the lines it moves (`fixture`, CASAS_RECORD=1).

#![allow(clippy::needless_range_loop)]

use casas_generator::core::domain::Domain;
use casas_generator::core::rng::Mulberry32;
use casas_generator::crust::raft_types::{Raft, RaftBlob};
use casas_generator::fields::field_mesh::shared_field_mesh;
use casas_generator::fields::field_operators::SolveOptions;
use casas_generator::mantle::mantle_field as m;
use casas_generator::mantle::mantle_tune_params::MANTLE_TUNING;
use casas_generator::tectonics::boundary_classification::{
    BoundaryCharacter, UpliftSide, classify_boundary,
};
use casas_generator::tectonics::boundary_detection::detect_boundaries;
use casas_generator::tectonics::boundary_lattice::generate_detection_lattice;
use casas_generator::tectonics::flexure as fx;
use casas_generator::tectonics::ocean_age as oa;
use casas_generator::tectonics::plate_motion::{self as pm, PlateMotion};
use casas_generator::tectonics::plate_seeds::PlateSeed;
use casas_generator::tectonics::plate_types::PlateType;
use casas_generator::tectonics::plate_velocity_decomposition::{
    BoundaryMotionClass, classify_boundary_motion,
};
use casas_generator::tectonics::plumes as pl;
use casas_generator::tectonics::tectonics_tune_params::TECTONICS_TUNING as T;

mod fixture;

use casas_generator::tectonics::terrain_features::{
    FeatureKind, MovesWith, TerrainFeature, advance_terrain_features, find_or_create_feature_index,
};
use casas_generator::tectonics::volcanoes::{VolcanoKind, collect_volcanoes};
use fixture::check;

const FILE: &str = "tectonics.txt";
const FIXTURE: &str = include_str!("fixtures/tectonics.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
    fn int(&mut self, lo: f64, hi: f64) -> i64 {
        self.uniform(lo, hi).floor() as i64
    }
}

struct Hash(u32);

impl Hash {
    fn new() -> Self {
        Hash(0x811c_9dc5)
    }
    fn add(&mut self, v: f64) {
        let b = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.0 = (self.0 ^ b as u32).wrapping_mul(0x0100_0193);
        self.0 = (self.0 ^ (b >> 32) as u32).wrapping_mul(0x0100_0193);
    }
    fn motion(&mut self, m: &PlateMotion) {
        match m {
            PlateMotion::Euler(e) => {
                for v in [e.pole_x, e.pole_y, e.pole_z, e.rate] {
                    self.add(v);
                }
            }
            PlateMotion::Rigid(r) => {
                for v in [r.drift_x, r.drift_y, r.spin, r.centroid_x, r.centroid_y] {
                    self.add(v);
                }
            }
        }
    }
    fn feature(&mut self, t: &TerrainFeature) {
        let moves = match t.moves_with {
            MovesWith::Both => -1.0,
            MovesWith::Plate(p) => p as f64,
        };
        for v in [
            t.x,
            t.y,
            t.thickness,
            t.tangent_x,
            t.tangent_y,
            if t.kind == FeatureKind::Trench {
                1.0
            } else {
                0.0
            },
            t.plate_a as f64,
            t.plate_b as f64,
            moves,
            if t.subsides { 1.0 } else { 0.0 },
            t.epochs_since_deposit,
        ] {
            self.add(v);
        }
    }
    fn line(&self, name: &str) -> String {
        format!("{name} {:08x}", self.0)
    }
}

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

#[test]
fn the_tuning_is_the_typescript_tuning() {
    let mut h = Hash::new();
    for v in [
        T.detection_lattice_resolution_x as f64,
        T.detection_lattice_resolution_y as f64,
        T.mantle_flow_speed_km_per_myr,
        T.uplift_per_km,
        T.orogen_crust_m,
        T.shortening_half_life_ma,
        T.crust_side_m,
        T.intraplate_shortening,
        T.coast_search_m,
        T.lock_epochs_required,
        T.rift_accumulator_threshold,
        T.merge_accumulator_threshold,
        T.plate_count_pressure_strength,
        T.plate_count_pressure_clamp,
        T.min_plate_count as f64,
        T.thickness_decay_per_epoch,
        T.oceanic_subsidence_decay_per_epoch,
        T.feature_prune_thickness,
        T.feature_prune_inactivity_epochs,
        T.feature_prune_max_inactivity_epochs,
        T.age_multiplier_floor,
        T.age_multiplier_range,
        T.age_multiplier_half_life_epochs,
        T.trench_offset_m,
        T.trench_depth_fraction,
        T.trench_half_width_m,
        T.trench_relief_per_subsidence,
        T.accretion_blob_radius_m,
        T.accretion_inset_m,
        T.accretion_min_gap_m,
        T.accretion_max_attach_m,
        T.accretion_epoch_interval,
        T.stabilisation_epochs,
        T.recycle_downwelling_threshold,
        T.split_max_dist_m,
        T.split_gap_m,
        T.split_merge_immunity_epochs,
        T.cont_rift_lock_epochs,
        T.cont_rift_threshold_factor,
        T.cont_rift_cooldown_epochs,
        T.ocean_age_init,
        T.breakup_fresh_crust_radius_m,
        T.mantle_coupling_rate,
        T.seed_recentre_rate,
        T.keel_drag,
        T.hotspot_deposit_per_epoch,
        T.hotspot_epoch_interval,
        T.flood_basalt_deposit,
        T.rift_cool_radius_m,
        T.rift_cool_amount,
        T.rift_reset_radius_m,
        T.rift_margin_recovery_epochs,
        T.rift_basin_floor_thickness,
        T.flexure_te_young_km,
        T.flexure_te_craton_km,
        T.flexure_te_ocean_floor_km,
        T.flexure_te_ocean_age_km,
        T.flexure_te_ocean_max_km,
        T.flexure_crust_density,
        T.flexure_mantle_density,
        T.flexure_youngs_modulus_gpa,
        T.flexure_poisson,
        T.flexure_deflection_scale,
        T.collapse_height_m,
        T.collapse_smoothing_m,
        T.wedge_radius_m,
        T.wedge_height_m,
        T.fold_wavelength_km,
        T.fold_amplitude,
    ] {
        h.add(v);
    }
    check(FILE, &h.line("tuning"), &expected("tuning"), "tuning");
}

fn scenario(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let seeds: Vec<PlateSeed> = (0..30)
        .map(|_| {
            let x = g.uniform(0.0, d.width);
            PlateSeed {
                x,
                y: g.uniform(0.0, d.height),
            }
        })
        .collect();
    let mut rng = Mulberry32::new(seed * 11);
    let mut motions = pm::generate_plate_motions(&seeds, &d, &mut || rng.next());
    let mut h = Hash::new();
    for mo in &motions {
        h.motion(mo);
    }
    for _ in 0..3000 {
        let (px, py) = (g.uniform(0.0, d.width), g.uniform(0.0, d.height));
        let mo = motions[g.int(0.0, motions.len() as f64) as usize];
        let v = pm::get_velocity_at(px, py, &mo, &d);
        h.add(v.x);
        h.add(v.y);
        let step = g.uniform(0.5, 5.0);
        let a = pm::advance_point_by_motion(px, py, &mo, step, &d);
        h.add(a.x);
        h.add(a.y);
        let b = pm::reverse_point_by_motion(a.x, a.y, &mo, step, &d);
        h.add(b.x);
        h.add(b.y);
        let (vx, vy) = (g.uniform(-3.0, 3.0), g.uniform(-3.0, 3.0));
        h.motion(&pm::motion_moving_at(px, py, vx, vy, &d));
        if let PlateMotion::Euler(e) = &mo {
            h.add(pm::arc_to_euler_pole(px, py, e, &d));
        }
        h.add(pm::km_per_myr(v.x, &d));
    }
    let mm = m::mantle_mesh(&d);
    let mut mrng = Mulberry32::new(seed * 13);
    let field = m::create_mantle_field(&mut || mrng.next(), &mm, m::DEFAULT_INITIAL_SMOOTHING);
    let flow = m::compute_mantle_flow(&field, &mm, MANTLE_TUNING.flow_speed_scale);
    let fit = pm::fit_motions_to_flow(&seeds, &flow, &mm, &d);
    for mo in &fit {
        h.motion(mo);
    }
    for p in 0..motions.len() {
        pm::relax_motion_toward(&mut motions[p], &fit[p], 0.15);
        h.motion(&motions[p]);
    }
    let line = format!("{name}_motion");
    check(FILE, &h.line(&line), &expected(&line), &line);

    let mut h = Hash::new();
    let lattice = generate_detection_lattice(&d, 256, 128);
    h.add(lattice.len() as f64);
    for p in &lattice {
        h.add(p.x);
        h.add(p.y);
    }
    let boundaries = detect_boundaries(&lattice, &seeds, &d);
    let types: Vec<PlateType> = (0..seeds.len())
        .map(|_| {
            if g.next() & 1 == 1 {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            }
        })
        .collect();
    let ages: Vec<f64> = (0..seeds.len()).map(|_| g.uniform(0.0, 100.0)).collect();
    for b in &boundaries {
        for v in [
            b.lattice_index as f64,
            b.x,
            b.y,
            b.plate_a as f64,
            b.plate_b as f64,
        ] {
            h.add(v);
        }
        let (pa, pb) = (b.plate_a as usize, b.plate_b as usize);
        let point = PlateSeed { x: b.x, y: b.y };
        let c = classify_boundary_motion(
            &point,
            &seeds[pa],
            &motions[pa],
            &seeds[pb],
            &motions[pb],
            &d,
        );
        h.add(c.normal);
        h.add(c.tangential);
        h.add(match c.motion_class {
            BoundaryMotionClass::Convergent => 0.0,
            BoundaryMotionClass::Divergent => 1.0,
            BoundaryMotionClass::Transform => 2.0,
        });
        let k = classify_boundary(types[pa], ages[pa], types[pb], ages[pb], c.motion_class);
        h.add(match k.character {
            BoundaryCharacter::FoldMountains => 0.0,
            BoundaryCharacter::SubductionArc => 1.0,
            BoundaryCharacter::IslandArc => 2.0,
            BoundaryCharacter::RiftValley => 3.0,
            BoundaryCharacter::MidOceanRidge => 4.0,
            BoundaryCharacter::TransformFault => 5.0,
        });
        h.add(match k.uplift_side {
            UpliftSide::A => 0.0,
            UpliftSide::B => 1.0,
            UpliftSide::Both => 2.0,
        });
        h.add(k.rate);
        h.add(k.elevation_sign as f64);
    }
    let line = format!("{name}_boundaries");
    check(FILE, &h.line(&line), &expected(&line), &line);

    let mut h = Hash::new();
    let mut features: Vec<TerrainFeature> = Vec::new();
    for k in (0..boundaries.len()).step_by(3) {
        let b = &boundaries[k];
        let moves = if k % 2 == 0 {
            MovesWith::Both
        } else if g.next() & 1 == 1 {
            MovesWith::Plate(b.plate_a as u32)
        } else {
            MovesWith::Plate(b.plate_b as u32)
        };
        let (tx, ty) = (g.uniform(-1.0, 1.0), g.uniform(-1.0, 1.0));
        let kind = if k % 5 == 0 {
            FeatureKind::Trench
        } else {
            FeatureKind::Range
        };
        let i = find_or_create_feature_index(
            &mut features,
            b.x,
            b.y,
            b.plate_a,
            b.plate_b,
            moves,
            tx,
            ty,
            kind,
            k % 7 == 0,
            &d,
        );
        h.add(i as f64);
    }
    for t in features.iter_mut() {
        t.thickness = g.uniform(-10.0, 20.0);
        t.epochs_since_deposit = g.int(0.0, 12.0) as f64;
        if g.next() & 1 == 1 {
            t.volcanic = Some(true);
        }
    }
    for _ in 0..5 {
        advance_terrain_features(&mut features, &motions, 1.0, &d);
    }
    for t in &features {
        h.feature(t);
    }
    let extra = |x, y, thickness, plate_b| TerrainFeature {
        x,
        y,
        thickness,
        tangent_x: 1.0,
        tangent_y: 0.0,
        kind: FeatureKind::Range,
        plate_a: 3,
        plate_b,
        moves_with: MovesWith::Plate(3),
        subsides: false,
        epochs_since_deposit: 0.0,
        volcanic: None,
        shortening_km_per_myr: None,
        shortening_first: false,
    };
    features.push(extra(10.0, 20.0, 5.0, -1));
    features.push(extra(30.0, 40.0, -7.0, -2));
    for v in collect_volcanoes(&features) {
        h.add(v.x);
        h.add(v.y);
        h.add(v.thickness);
        h.add(match v.kind {
            VolcanoKind::Hotspot => 0.0,
            VolcanoKind::Flood => 1.0,
            VolcanoKind::Arc => 2.0,
            // The ecology's list alone has it (ecology_volcanoes).
            VolcanoKind::ExtinctArc => 3.0,
        });
    }
    let line = format!("{name}_features");
    check(FILE, &h.line(&line), &expected(&line), &line);
}

#[test]
fn the_torus_tectonics_give_the_typescript_values() {
    scenario("torus", Domain::torus(2048.0, 1024.0), 1);
}

#[test]
fn the_sphere_tectonics_give_the_typescript_values() {
    scenario("sphere", Domain::sphere(2048.0, 1024.0), 2);
}

fn stage_two(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let mut seeds: Vec<PlateSeed> = (0..30)
        .map(|_| {
            let x = g.uniform(0.0, d.width);
            PlateSeed {
                x,
                y: g.uniform(0.0, d.height),
            }
        })
        .collect();
    let mut rng = Mulberry32::new(seed);
    let motions = pm::generate_plate_motions(&seeds, &d, &mut || rng.next());
    let mut rafts = Vec::new();
    for r in 0..20 {
        let cx = g.uniform(0.0, d.width);
        let cy = g.uniform(0.0, d.height);
        let mut blobs = Vec::new();
        for _ in 0..4 {
            let x = d.wrap_x(cx + g.uniform(-60.0, 60.0));
            let y = d.height.min(0f64.max(cy + g.uniform(-40.0, 40.0)));
            let radius = g.uniform(20.0, 90.0);
            let birth = g.int(0.0, 100.0) as f64;
            blobs.push(RaftBlob {
                x,
                y,
                radius,
                birth_epoch: Some(birth),
            });
        }
        rafts.push(Raft {
            id: r,
            name: None,
            blobs,
            no_merge_until_epoch: None,
        });
    }
    let mut sm = shared_field_mesh(&d, oa::ocean_age_spacing_m(&d));
    let mut o = oa::ocean_age(&sm);
    let mut h = Hash::new();
    let mut age = oa::create_ocean_age_field(T.ocean_age_init, &sm);
    let membership = oa::ocean_age_membership(&sm, &rafts);
    for &v in &membership {
        h.add(v);
    }
    for e in 0..8 {
        let previous = if e == 0 { None } else { Some(seeds.clone()) };
        seeds = seeds
            .iter()
            .enumerate()
            .map(|(k, p)| {
                let q = pm::advance_point_by_motion(p.x, p.y, &motions[k], 1.0, &d);
                PlateSeed { x: q.x, y: q.y }
            })
            .collect();
        age = oa::advect_ocean_age(
            &mut o,
            &mut sm,
            &age,
            &seeds,
            &motions,
            1.0,
            &membership,
            previous.as_deref(),
        );
        for &v in &age {
            h.add(v);
        }
    }
    for _ in 0..5 {
        let (x, y, r) = (
            g.uniform(0.0, d.width),
            g.uniform(0.0, d.height),
            g.uniform(5.0, 60.0),
        );
        oa::reset_ocean_age_around(&mut o, &mut sm, &mut age, x, y, r);
    }
    for &v in &age {
        h.add(v);
    }
    for _ in 0..2000 {
        let (x, y) = (g.uniform(0.0, d.width), g.uniform(0.0, d.height));
        h.add(oa::ocean_age_at(&mut sm, &age, x, y));
    }
    for v in oa::ocean_age_raster(&mut sm, &age, 256, 128) {
        h.add(v as f64);
    }
    let saved = oa::saved_ocean_age(&o, &sm, &age);
    h.add(saved.cells as f64);
    h.add(saved.spacing_m);
    h.add(
        if oa::ocean_age_fits(&o, &sm, saved.cells, saved.spacing_m) {
            1.0
        } else {
            0.0
        },
    );
    let line = format!("{name}_ocean_age");
    check(FILE, &h.line(&line), &expected(&line), &line);

    let mut h = Hash::new();
    for k in 0..500 {
        let (old, oage) = (g.uniform(-0.5, 1.5), g.uniform(-10.0, 200.0));
        h.add(fx::elastic_thickness_km(k % 2 == 0, old, oage));
        let te = g.uniform(3.0, 80.0);
        h.add(fx::flexural_rigidity_m4(te));
        h.add(fx::flexural_alpha_km(te));
    }
    let mut spread = fx::node_load_spreader(&sm);
    let n = sm.mesh.count;
    let mut load_m3 = vec![0.0; n];
    for k in 0..3000 {
        let area = if k % 4 == 0 {
            g.uniform(1e10, 6e10)
        } else {
            g.uniform(1e7, 2e9)
        };
        let (x, y) = (g.uniform(0.0, d.width), g.uniform(0.0, d.height));
        let volume = g.uniform(-3.0, 3.0) * area;
        spread.spread(&mut sm, x, y, area, volume, &mut load_m3);
    }
    for &v in &load_m3 {
        h.add(v);
    }
    let load_m: Vec<f64> = (0..n).map(|i| load_m3[i] / sm.mesh.area[i]).collect();
    let rigidity: Vec<f64> = (0..n)
        .map(|i| fx::flexural_rigidity_m4(fx::elastic_thickness_km(age[i] == 0.0, 0.5, age[i])))
        .collect();
    let mut deflection = vec![0.0; n];
    let r = fx::flexural_response(
        &sm.mesh,
        &load_m,
        &rigidity,
        &mut deflection,
        SolveOptions::default(),
    );
    h.add(r.iterations as f64);
    h.add(r.residual);
    h.add(if r.converged { 1.0 } else { 0.0 });
    for &v in &deflection {
        h.add(v);
    }
    h.add(sm.mesh.tri.last_tri as f64);
    h.add(sm.mesh.tri.walk_steps as f64);
    let line = format!("{name}_flexure");
    check(FILE, &h.line(&line), &expected(&line), &line);

    let mut h = Hash::new();
    let mut mm = m::mantle_mesh(&d);
    let mut mrng = Mulberry32::new(seed + 100);
    let mut field = m::create_mantle_field(&mut || mrng.next(), &mm, m::DEFAULT_INITIAL_SMOOTHING);
    for _ in 0..4 {
        field = m::evolve_mantle_field(field, &rafts, &mm, MANTLE_TUNING.diffusion_passes);
    }
    m::sustain_mantle_vigour(&mut field, 0.6, &mm);
    let mut plumes = pl::find_plume_sites(&field, &mm, &d, 0.0, &[]);
    for e in 1..=12 {
        field = m::evolve_mantle_field(field, &rafts, &mm, MANTLE_TUNING.diffusion_passes);
        m::sustain_mantle_vigour(&mut field, 0.6, &mm);
        pl::advance_plumes(&mut plumes, &field, &mut mm, &d, e as f64);
        h.add(plumes.len() as f64);
        for p in &plumes {
            h.add(p.x);
            h.add(p.y);
            h.add(p.id as f64);
            h.add(p.birth_epoch);
        }
    }
    let line = format!("{name}_plumes");
    check(FILE, &h.line(&line), &expected(&line), &line);
}

#[test]
fn the_torus_ocean_age_flexure_and_plumes_give_the_typescript_values() {
    stage_two("torus", Domain::torus(2048.0, 1024.0), 21);
}

#[test]
fn the_sphere_ocean_age_flexure_and_plumes_give_the_typescript_values() {
    stage_two("sphere", Domain::sphere(2048.0, 1024.0), 22);
}

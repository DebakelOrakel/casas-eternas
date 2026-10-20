//! The module test of the elevation (scale, capsule, the noises, the warp,
//! the hypsometry, the elevation field) and of the trench and the folds
//! against the TypeScript engine: the same calls give the same bits
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/elevationFixture.mjs`; the calls below are that
//! script's, one for one.

#![allow(clippy::needless_range_loop)]

use casas_engine::core::domain::Domain;
use casas_engine::core::rng::Mulberry32;
use casas_engine::crust::raft_field::{build_blob_index, compute_owner_field};
use casas_engine::crust::raft_types::{Raft, RaftBlob};
use casas_engine::elevation::capsule::capsule_weight;
use casas_engine::elevation::domain_warp::{Axis, domain_warp_delta, domain_warp_point};
use casas_engine::elevation::elevation_field as ef;
use casas_engine::elevation::elevation_scale as es;
use casas_engine::elevation::elevation_tune_params::ELEVATION_TUNING as E;
use casas_engine::elevation::globe_noise as gn;
use casas_engine::elevation::hypsometry as hy;
use casas_engine::elevation::ridged_noise as rn;
use casas_engine::fields::field_mesh::shared_field_mesh;
use casas_engine::tectonics::folds::fold_factor_at;
use casas_engine::tectonics::ocean_age as oa;
use casas_engine::tectonics::plate_motion::generate_plate_motions;
use casas_engine::tectonics::plate_seeds::PlateSeed;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};
use casas_engine::tectonics::trench::trench_depression;

const FIXTURE: &str = include_str!("fixtures/elevation.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
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

const SEEDS: [f64; 7] = [
    0.0,
    1.0,
    12345.0,
    2147483647.0,
    2147483648.0,
    3000000000.0,
    4294967295.0,
];

#[test]
fn the_scale_capsule_and_tuning_give_the_typescript_values() {
    let mut g = Gen(1);
    let mut h = Hash::new();
    for v in [
        E.range_perp_radius_m,
        E.range_segment_half_length_m,
        E.trench_perp_radius_m,
        E.trench_segment_half_length_m,
        E.thickness_to_elevation_scale,
        E.ridge_relative_strength,
        E.gdh1_young_max_age,
        E.gdh1_young_coeff,
        E.gdh1_old_coeff,
        E.gdh1_old_decay,
        E.plain_detail_max,
        E.plain_detail_height_fraction,
        E.mountain_redistribution_gamma,
        E.hypsometry_range_m,
        E.hypsometry_t_in,
        E.hypsometry_t_full,
        E.warp_amplitude_m,
        E.axis_salt_x,
        E.axis_salt_y,
        E.axis_salt_z,
        E.dynamic_topography_per_unit,
    ] {
        h.add(v);
    }
    for v in [
        es::LAND_BASE,
        es::COASTAL_PLAIN,
        es::SHELF_BREAK,
        es::SLOPE_FOOT,
        es::RIDGE_CREST,
        es::ABYSSAL_FLOOR,
        es::shoreline_field(),
    ] {
        h.add(v);
    }
    for _ in 0..5000 {
        let t = g.uniform(-0.2, 1.2);
        let floor = g.uniform(-0.7, -0.2);
        h.add(es::margin_profile(t, floor));
        h.add(es::margin_parameter(g.uniform(-0.2, 1.5)));
        let (ox, oy, tx, ty) = (
            g.uniform(-50.0, 50.0),
            g.uniform(-50.0, 50.0),
            g.uniform(-1.0, 1.0),
            g.uniform(-1.0, 1.0),
        );
        let (hl, pr) = (g.uniform(5.0, 40.0), g.uniform(5.0, 40.0));
        h.add(capsule_weight(ox, oy, tx, ty, hl, pr));
    }
    assert_eq!(h.line("scale"), expected("scale"));
}

fn noise(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let mut h = Hash::new();
    for s in SEEDS {
        for _ in 0..600 {
            let x = g.uniform(-100.0, d.width + 100.0);
            let y = g.uniform(0.0, d.height);
            let (px, py) = (g.uniform(-10.0, 600.0), g.uniform(-10.0, 300.0));
            h.add(rn::periodic_value_noise_2d(px, py, 512.0, 256.0, s));
            h.add(rn::ridged_multifractal(x, y, d.width, d.height, s));
            h.add(rn::ridged_multifractal_on(&d, x, y, s));
            h.add(rn::fine_detail_noise(x, y, d.width, d.height, s));
            h.add(rn::fine_detail_noise_on(&d, x, y, s));
            if d.is_sphere() {
                h.add(rn::fine_detail_noise_scaled_on(&d, x, y, 3.0, s));
            }
            let (vx, vy, vz) = (
                g.uniform(-50.0, 50.0),
                g.uniform(-50.0, 50.0),
                g.uniform(-50.0, 50.0),
            );
            h.add(gn::value_noise_3d(vx, vy, vz, s));
            if d.is_sphere() {
                let gf = d.globe_frame(x, y);
                h.add(gn::globe_octave_on(&gf, 64.0, &d, s));
                h.add(gn::globe_octave(&gf, 64.0, d.width, s));
            }
            h.add(domain_warp_delta(x, y, &d, s, Axis::X));
            h.add(domain_warp_delta(x, y, &d, s, Axis::Y));
            let p = domain_warp_point(x, y, &d, s);
            h.add(p.x);
            h.add(p.y);
            let t = g.uniform(0.0, 1.0);
            h.add(hy::hypsometry_weight(g.uniform(0.5, 1.0)));
            h.add(hy::hypsometry_relief(x, y, &d, s));
            h.add(hy::continental_hypsometry(x, y, t, &d, s));
        }
    }
    assert_eq!(
        h.line(&format!("{name}_noise")),
        expected(&format!("{name}_noise"))
    );
}

#[test]
fn the_torus_noises_give_the_typescript_values() {
    noise("torus", Domain::torus(2048.0, 1024.0), 2);
}

#[test]
fn the_sphere_noises_give_the_typescript_values() {
    noise("sphere", Domain::sphere(2048.0, 1024.0), 3);
}

fn field(name: &str, d: Domain, seed: u32) {
    let mut g = Gen(seed);
    let seeds: Vec<PlateSeed> = (0..24)
        .map(|_| {
            let x = g.uniform(0.0, d.width);
            PlateSeed {
                x,
                y: g.uniform(0.0, d.height),
            }
        })
        .collect();
    let mut rng = Mulberry32::new(seed);
    let motions = generate_plate_motions(&seeds, &d, &mut || rng.next());
    let ages: Vec<f64> = (0..seeds.len()).map(|_| g.uniform(0.0, 150.0)).collect();
    let mut rafts = Vec::new();
    for r in 0..16 {
        let cx = g.uniform(0.0, d.width);
        let cy = g.uniform(0.0, d.height);
        let mut blobs = Vec::new();
        for _ in 0..5 {
            let x = d.wrap_x(cx + g.uniform(-60.0, 60.0));
            let y = d.height.min(0f64.max(cy + g.uniform(-40.0, 40.0)));
            let radius = g.uniform(20.0, 90.0);
            blobs.push(RaftBlob {
                x,
                y,
                radius,
                birth_epoch: Some(0.0),
            });
        }
        rafts.push(Raft {
            id: r,
            name: None,
            blobs,
            no_merge_until_epoch: None,
        });
    }
    let mut features = Vec::new();
    for k in 0..400 {
        let (tx, ty) = (g.uniform(-1.0, 1.0), g.uniform(-1.0, 1.0));
        let l = (tx * tx + ty * ty).sqrt();
        let l = if l == 0.0 { 1.0 } else { l };
        let (x, y, thickness) = (
            g.uniform(0.0, d.width),
            g.uniform(0.0, d.height),
            g.uniform(-20.0, 60.0),
        );
        features.push(TerrainFeature {
            x,
            y,
            thickness,
            tangent_x: tx / l,
            tangent_y: ty / l,
            kind: if k % 4 == 0 {
                FeatureKind::Trench
            } else {
                FeatureKind::Range
            },
            plate_a: 0,
            plate_b: 1,
            moves_with: MovesWith::Both,
            subsides: false,
            epochs_since_deposit: 0.0,
            volcanic: None,
            shortening_km_per_myr: None,
        });
    }
    let warp_seed = 2900000000.0 + seed as f64;
    let mut h = Hash::new();
    let fb = ef::build_feature_buckets(&features, &d);
    h.add(fb.buckets_x as f64);
    h.add(fb.buckets_y as f64);
    h.add(fb.bucket_size_x);
    h.add(fb.bucket_size_y);
    for &v in fb.row_span() {
        h.add(v as f64);
    }
    let no_features: Vec<TerrainFeature> = Vec::new();
    let empty = ef::build_feature_buckets(&no_features, &d);
    let mut near = Vec::new();
    h.add(empty.buckets_x as f64);
    h.add(empty.buckets_y as f64);
    for k in 0..3000 {
        let x = g.uniform(0.0, d.width);
        let y = g.uniform(0.0, d.height);
        fb.near(x, y, &mut near);
        h.add(near.len() as f64);
        for &b in &near {
            h.add(b as f64);
        }
        h.add(ef::uplift_deck_at(x, y, &fb, &d, &mut near));
        let base = g.uniform(-0.6, 0.2);
        let ridge = g.uniform(0.0, 1.0);
        let fine = if k % 3 == 0 {
            g.uniform(-0.5, 0.5)
        } else {
            0.0
        };
        h.add(ef::compute_elevation(
            x, y, base, &fb, &d, ridge, fine, &mut near,
        ));
        h.add(ef::ocean_floor_at_age(g.uniform(0.0, 200.0)));
        let spacing = if k % 2 == 0 { 0.0 } else { g.uniform(0.5, 4.0) };
        h.add(fold_factor_at(&fb, x, y, &d, spacing, &mut near));
        let ws = ef::warped_sample_point(x, y, &d, warp_seed);
        h.add(ws.x);
        h.add(ws.y);
    }
    assert_eq!(
        h.line(&format!("{name}_features")),
        expected(&format!("{name}_features"))
    );

    let mut h = Hash::new();
    let mut sm = shared_field_mesh(&d, oa::ocean_age_spacing_m(&d));
    let mut age = oa::create_ocean_age_field(30.0, &sm);
    for a in age.iter_mut() {
        *a = g.uniform(0.0, 160.0);
    }
    let blobs = build_blob_index(&rafts, &d, 1.0);
    let trench = trench_depression(&seeds, &motions, &ages, &rafts, &d).unwrap();
    let mut trenches = 0;
    for _ in 0..4000 {
        let x = g.uniform(0.0, d.width);
        let y = g.uniform(0.0, d.height);
        h.add(ef::raft_baseline_at(
            x, y, &rafts, None, &d, warp_seed, None, None,
        ));
        h.add(ef::raft_baseline_at(
            x,
            y,
            &rafts,
            Some((&mut sm, &age)),
            &d,
            warp_seed,
            Some(&blobs),
            None,
        ));
        h.add(ef::raft_baseline_at(
            x,
            y,
            &rafts,
            Some((&mut sm, &age)),
            &d,
            warp_seed,
            None,
            Some(&trench),
        ));
        let (m, a) = (g.uniform(-0.05, 0.2), g.uniform(0.0, 160.0));
        let td = trench(x, y, m, a);
        if td != 0.0 {
            trenches += 1;
        }
        h.add(td);
    }
    h.add(trenches as f64);
    for v in ef::compute_raft_baseline(&rafts, Some((&mut sm, &age)), 256, 128, &d, warp_seed) {
        h.add(v as f64);
    }
    for v in ef::compute_raft_baseline(&rafts, None, 64, 32, &d, warp_seed) {
        h.add(v as f64);
    }
    h.add(sm.mesh.tri.last_tri as f64);
    h.add(sm.mesh.tri.walk_steps as f64);
    assert_eq!(
        h.line(&format!("{name}_baseline")),
        expected(&format!("{name}_baseline"))
    );
}

#[test]
fn the_torus_elevation_field_gives_the_typescript_values() {
    field("torus", Domain::torus(2048.0, 1024.0), 4);
}

#[test]
fn the_sphere_elevation_field_gives_the_typescript_values() {
    field("sphere", Domain::sphere(2048.0, 1024.0), 5);
}

#[test]
fn the_redistribution_gives_the_typescript_values() {
    let mut g = Gen(6);
    let d = Domain::torus(256.0, 128.0);
    let mut rafts = Vec::new();
    for r in 0..6 {
        let (x, y, radius) = (
            g.uniform(0.0, 256.0),
            g.uniform(0.0, 128.0),
            g.uniform(10.0, 40.0),
        );
        rafts.push(Raft {
            id: r,
            name: None,
            blobs: vec![RaftBlob {
                x,
                y,
                radius,
                birth_epoch: None,
            }],
            no_merge_until_epoch: None,
        });
    }
    let owner = compute_owner_field(&rafts, 64, 32, &d);
    let mut elev: Vec<f32> = (0..256 * 128)
        .map(|_| g.uniform(-0.3, 0.6) as f32)
        .collect();
    ef::apply_mountain_redistribution(&mut elev, &d, &owner, 64, 32);
    let mut h = Hash::new();
    for &v in &elev {
        h.add(v as f64);
    }
    assert_eq!(h.line("redistribution"), expected("redistribution"));
}

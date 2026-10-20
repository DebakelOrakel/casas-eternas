//! The module test of the hydrology (surface/hydrology over the mesh's flow
//! substrate, mesh/mesh_hydrology) and of mesh/mesh_raster and
//! mesh/mesh_serial against the TypeScript engine
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/hydrologyFixture.mjs`; the scenarios below are that
//! script's, step for step.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_hydrology::{
    MeshSubstrate, mesh_areas, mesh_routing, water_fields_from_mesh,
};
use casas_engine::mesh::mesh_raster::{
    land_bilinear_at_nodes, nearest_cell_at_nodes, rasterise_node_field, rasterise_node_part,
    triangle_raster,
};
use casas_engine::mesh::mesh_serial::{
    compact_mesh, decode_mesh, encode_mesh, hilbert_vertex_order, permute,
};
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::surface::hydrology::{
    CANONICAL_RIVER_DENSITY, ClimateMonths, LakeFields, WaterBody, WaterKind,
    accumulate_discharge_on, accumulate_regime_inputs_on, build_channel_mask_on,
    channel_reference_slope_on, channel_threshold, compute_lakes_on, density_to_critical_area,
    discharge_to_m3s, evaporation_potential, lake_depth_from_bodies, max_discharge_over_land,
    riparian_precipitation_on, water_level_field, watersheds_on,
};
use casas_engine::surface::surface_tune_params::SURFACE_TUNING;

const FIXTURE: &str = include_str!("fixtures/hydrology.txt");

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
    fn add_all<T: Copy + Into<f64>>(&mut self, a: &[T]) {
        for &v in a {
            self.add(v.into());
        }
    }
    fn bodies(&mut self, bodies: &[WaterBody]) {
        for b in bodies {
            self.add(b.id as f64);
            self.add(match b.kind {
                WaterKind::Lake => 0.0,
                WaterKind::Terminal => 1.0,
                WaterKind::Dry => 2.0,
            });
            for v in [
                b.level, b.spill, b.floor, b.seed_x, b.seed_y, b.outlet_x, b.outlet_y, b.cells,
            ] {
                self.add(v);
            }
            self.add(f64::from(u8::from(b.frozen)));
        }
    }
    fn lakes(&mut self, l: &LakeFields) {
        self.add_all(&l.depth);
        self.add_all(&l.salt_flat);
        self.add_all(&l.dry_basin);
        self.add_all(&l.frozen);
        self.add_all(&l.level);
        self.add_all(&l.body);
    }
    fn mesh(&mut self, m: &PeriodicTriangulation, edges: bool) {
        let n = m.vertex_slots();
        self.add_all(&m.vx[..n]);
        self.add_all(&m.vy[..n]);
        self.add_all(&m.tris[..3 * m.tri_slots()]);
        self.add_all(&m.twin[..3 * m.tri_slots()]);
        if edges {
            self.add_all(&m.v_edge[..n]);
        }
    }
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        assert_eq!(format!("{name} {:08x}", self.0), want);
    }
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        0.09 * det_sin(x * 0.006) * det_cos(y * 0.008)
            + 0.05 * det_sin(x * 0.019 + y * 0.011)
            + 0.03 * det_cos(x * 0.043 - y * 0.027)
            - 0.02
            - 0.06 * (det_sin(x * 0.011 + 2.0) * det_cos(y * 0.013 + 1.0) - 0.6).max(0.0)
    }
    fn discharge_at(&self, x: f64, y: f64) -> Option<f64> {
        Some(2500.0 * (1.0 + det_sin(x * 0.05 + y * 0.03)))
    }
    fn has_discharge(&self) -> bool {
        true
    }
}

fn run(name: &str, domain: Domain) {
    let built = build_mesh(&domain, &Analytic, 7, 12.0, 24);
    let mut mesh = built.mesh;
    let slots = mesh.vertex_slots();
    let z: Vec<f32> = built.state.get(MESH_Z)[..slots].to_vec();
    let routing = mesh_routing(&mut mesh, &z, &DEFAULT_SOLVER_PARAMS);
    let areas = mesh_areas(&mut mesh);
    let mut temp = vec![0f32; slots];
    let mut precip = vec![0f32; slots];
    let mut monsoon = vec![0f32; slots];
    for v in 0..slots {
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        let lat = (y / domain.height - 0.5).abs() * 2.0;
        let land = z[v] > 0.0;
        temp[v] = (28.0 - 45.0 * lat + 4.0 * det_sin(x * 0.01)
            - if land { z[v] as f64 * 58.0 } else { 0.0 }) as f32;
        precip[v] = if land {
            (100.0 + 700.0 * (1.0 + det_sin(x * 0.007 + y * 0.004))) as f32
        } else {
            -1.0
        };
        monsoon[v] = if land {
            (0.8 * det_cos(x * 0.003)) as f32
        } else {
            -1.0
        };
    }
    let (lakes, dry, discharge, bare) = {
        let sub = MeshSubstrate {
            mesh: &mesh,
            routing: &routing,
            areas: &areas,
        };
        let bare = accumulate_discharge_on(&sub, &z, &precip, None);
        let discharge = accumulate_discharge_on(&sub, &z, &precip, Some(&temp));
        let lakes = compute_lakes_on(
            &sub,
            &discharge,
            &z,
            &temp,
            SURFACE_TUNING.min_lake_basin_relief_m,
        );
        let hot: Vec<f32> = temp.iter().map(|&t| (t as f64 + 25.0) as f32).collect();
        let trickle: Vec<f32> = discharge
            .iter()
            .map(|&q| (q as f64 * 0.02) as f32)
            .collect();
        let dry = compute_lakes_on(&sub, &trickle, &z, &hot, 2.0);
        (lakes, dry, discharge, bare)
    };
    let mut h = Hash::new();
    h.add_all(&routing.flow_target);
    h.add_all(&routing.filled);
    h.add_all(&routing.accumulation);
    h.add_all(&routing.pop_order);
    h.add(routing.popped_count as f64);
    h.add_all(&areas);
    h.add_all(&bare);
    h.add_all(&discharge);
    h.lakes(&lakes);
    h.add(lakes.bodies.len() as f64);
    h.bodies(&lakes.bodies);
    h.lakes(&dry);
    h.bodies(&dry.bodies);
    assert!(
        dry.bodies.iter().any(|b| b.kind == WaterKind::Dry)
            && lakes.bodies.iter().any(|b| b.kind == WaterKind::Terminal),
        "{name}: no dry or terminal basin to test against"
    );
    h.check(&format!("{name}_lakes"));

    let mut h = Hash::new();
    {
        let sub = MeshSubstrate {
            mesh: &mesh,
            routing: &routing,
            areas: &areas,
        };
        let regime = accumulate_regime_inputs_on(&sub, &z, &temp, &precip, Some(&monsoon), None);
        h.add_all(&regime.loss);
        h.add_all(&regime.dry);
        let mut mt = vec![0f32; 12 * slots];
        let mut mp = vec![0f32; 12 * slots];
        for m in 0..12 {
            for v in 0..slots {
                let phase = if mesh.vy[v] < domain.height / 2.0 {
                    0.0
                } else {
                    3.1
                };
                mt[m * slots + v] =
                    (temp[v] as f64 + 12.0 * det_cos(m as f64 * 0.523 + phase)) as f32;
                mp[m * slots + v] = if precip[v] < 0.0 {
                    -1.0
                } else {
                    (precip[v] as f64 * (1.0 + 0.9 * det_sin(m as f64 * 0.523 + v as f64 * 0.001)))
                        as f32
                };
            }
        }
        let months = ClimateMonths {
            temperature: &mt,
            precipitation: &mp,
            count: 12,
        };
        let regime2 =
            accumulate_regime_inputs_on(&sub, &z, &temp, &precip, Some(&monsoon), Some(&months));
        h.add_all(&regime2.loss);
        h.add_all(&regime2.dry);
        let max_q = max_discharge_over_land(&discharge, &z);
        h.add(max_q);
        let (mut land_sum, mut land_area) = (0.0, 0.0);
        for v in 0..slots {
            if z[v] > 0.0 {
                land_sum += (precip[v] as f64).max(0.0) * areas[v] as f64;
                land_area += areas[v] as f64;
            }
        }
        let threshold = channel_threshold(
            density_to_critical_area(CANONICAL_RIVER_DENSITY, &domain),
            land_sum / land_area,
        );
        h.add(threshold);
        h.add(channel_reference_slope_on(&sub, &z, &discharge, threshold));
        h.add_all(&build_channel_mask_on(&sub, &z, &discharge, threshold));
        h.add_all(&watersheds_on(&sub, &z, 12_168.0));
        h.add_all(&watersheds_on(&sub, &z, 1000.0));
        h.add_all(&riparian_precipitation_on(
            &sub,
            &z,
            &discharge,
            threshold,
            max_q,
            &lakes.depth,
            Some(&lakes.frozen),
            &precip,
        ));
        h.add_all(&riparian_precipitation_on(
            &sub,
            &z,
            &discharge,
            threshold * 0.3,
            max_q,
            &lakes.depth,
            None,
            &precip,
        ));
        for k in 0..=20 {
            let k = k as f64;
            h.add(discharge_to_m3s(k * 1e6, 7800.0));
            h.add(evaporation_potential(-40.0 + k * 4.0));
            h.add(density_to_critical_area(k * 6.0 - 10.0, &domain));
        }
    }
    h.check(&format!("{name}_rivers"));

    let mut h = Hash::new();
    const RX: usize = 512;
    const RY: usize = 256;
    let el = rasterise_node_field(&mut mesh, &z, RX, RY);
    h.add_all(&el);
    let water = water_fields_from_mesh(&mut mesh, &lakes.body, &lakes.bodies, &el, RX, RY);
    h.add_all(&water.depth);
    h.add_all(&water.level);
    h.add_all(&water.body);
    h.add_all(&water.surface);
    h.add_all(&water.salt_flat);
    h.add_all(&water.dry_basin);
    h.add_all(&water.frozen);
    let el_grid = domain.scaled_to(RX as f64, RY as f64).grid(RX, RY);
    let scaled: Vec<WaterBody> = lakes
        .bodies
        .iter()
        .map(|b| WaterBody {
            seed_x: b.seed_x * RX as f64 / domain.width,
            seed_y: b.seed_y * RY as f64 / domain.height,
            ..b.clone()
        })
        .collect();
    let levels = water_level_field(&scaled, &el, &el_grid);
    h.add_all(&levels.level);
    h.add_all(&levels.body);
    h.add_all(&levels.surface);
    h.add_all(&lake_depth_from_bodies(&scaled, &el, &el_grid));
    let node_land: Vec<u8> = (0..slots)
        .map(|v| u8::from(mesh.v_alive[v] != 0 && z[v] > 0.0))
        .collect();
    let pixel_land: Vec<u8> = el.iter().map(|&e| u8::from(e > -0.005)).collect();
    let plan = triangle_raster(&mut mesh, RX, RY);
    h.add_all(&plan.tri);
    h.add_all(&plan.w0);
    h.add_all(&plan.w1);
    h.add_all(&rasterise_node_part(
        &mut mesh,
        &precip,
        &node_land,
        Some(&pixel_land),
        -1.0,
        RX,
        RY,
        false,
        Some(&plan),
    ));
    let body_f: Vec<f64> = lakes.body.iter().map(|&b| b as f64).collect();
    h.add_all(&rasterise_node_part(
        &mut mesh, &body_f, &node_land, None, -7.0, RX, RY, true, None,
    ));
    let coarse: Vec<f32> = (0..64 * 32)
        .map(|i| {
            if i % 5 == 0 {
                -1.0
            } else {
                det_sin(i as f64 * 0.37) as f32
            }
        })
        .collect();
    h.add_all(&nearest_cell_at_nodes(&coarse, 64, 32, &mesh));
    h.add_all(&land_bilinear_at_nodes(
        &coarse,
        &domain.grid(64, 32),
        &mesh,
    ));
    h.add(mesh.last_tri as f64);
    h.check(&format!("{name}_raster"));

    let mut h = Hash::new();
    let order = hilbert_vertex_order(&mesh);
    h.add_all(&order);
    let serial = encode_mesh(&mesh, &order);
    h.add(serial.count as f64);
    h.add_all(&serial.nodes);
    h.add_all(&serial.connectivity);
    let back = decode_mesh(&domain, &serial).unwrap();
    h.mesh(&back, false);
    let (compact, corder) = compact_mesh(&mesh);
    h.add_all(&corder);
    h.mesh(&compact, true);
    h.add_all(&permute(&z, &corder));
    h.check(&format!("{name}_serial"));
}

#[test]
fn the_torus_hydrology_gives_the_typescript_fields() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_hydrology_gives_the_typescript_fields() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

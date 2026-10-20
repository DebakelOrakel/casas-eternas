//! The module test of the rivers (surface/river_graph, surface/
//! hydrogeology, surface/river_course over the mesh's flow substrate)
//! against the TypeScript engine (docs/decisions/rust-engine.md, fork 5).
//! The fixture is written by `engine/scripts/riversFixture.mjs`; the
//! scenarios below are that script's, step for step.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_column::{COLUMN_DEPTH, COLUMN_VALUES, SedimentColumn};
use casas_engine::mesh::mesh_hydrology::{MeshSubstrate, mesh_areas, mesh_routing};
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::surface::hydrogeology::{
    HydrogeologyInputs, compute_hydrogeology, hydrogeology_invariants,
};
use casas_engine::surface::hydrology::{
    CANONICAL_RIVER_DENSITY, accumulate_discharge_on, accumulate_regime_inputs_on,
    channel_threshold, compute_lakes_on, density_to_critical_area, max_discharge_over_land,
};
use casas_engine::surface::river_course::{
    RiverCourse, RiverCourseOptions, RiverPattern, channel_width_m, classify_pattern,
    compute_river_courses,
};
use casas_engine::surface::river_graph::{
    RiverGraph, RiverGraphInputs, RiverNodeKind, RiverPolylines, RiverReachKind, build_river_graph,
    river_graph_invariants, river_polylines_from_graph,
};
use casas_engine::surface::surface_tune_params::SURFACE_TUNING;

const FIXTURE: &str = include_str!("fixtures/rivers.txt");

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
    fn flag(&mut self, b: bool) {
        self.add(f64::from(u8::from(b)));
    }
    fn add_all<T: Copy + Into<f64>>(&mut self, a: &[T]) {
        for &v in a {
            self.add(v.into());
        }
    }
    fn graph(&mut self, g: &RiverGraph) {
        self.add(g.width);
        self.add(g.height);
        for n in &g.nodes {
            self.add(n.id as f64);
            self.add(match n.kind {
                RiverNodeKind::Source => 0.0,
                RiverNodeKind::Junction => 1.0,
                RiverNodeKind::Mouth => 2.0,
                RiverNodeKind::Inlet => 3.0,
                RiverNodeKind::Outlet => 4.0,
            });
            self.add(n.cell as f64);
            self.add(n.x);
            self.add(n.y);
            self.add(n.body as f64);
            self.add(n.catchment_cells);
        }
        for r in &g.reaches {
            self.add(r.id as f64);
            self.flag(r.kind == RiverReachKind::Lake);
            for v in [r.from, r.to, r.cell_start, r.cell_count] {
                self.add(v as f64);
            }
            for v in [
                r.discharge_in,
                r.discharge_out,
                r.width_px,
                r.length_km,
                r.drop_m,
                r.slope,
                r.sediment_m3,
                r.bank as f64,
                r.order as f64,
                r.regime.code() as f64,
                r.runoff_out,
            ] {
                self.add(v);
            }
            self.flag(r.spring_fed);
        }
        self.add_all(&g.cells);
        self.add_all(&g.cell_x);
        self.add_all(&g.cell_y);
        self.add(g.bodies.len() as f64);
    }
    fn invariants(&mut self, o: &[(&str, usize)]) {
        for (k, v) in o {
            for c in k.encode_utf16() {
                self.add(c as f64);
            }
            self.add(*v as f64);
        }
    }
    fn polylines(&mut self, p: &RiverPolylines) {
        self.add_all(&p.points);
        self.add_all(&p.lengths);
        self.add_all(&p.regimes);
    }
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        assert_eq!(format!("{name} {:08x}", self.0), want);
    }
}

fn pattern_code(p: RiverPattern) -> f64 {
    match p {
        RiverPattern::Straight => 0.0,
        RiverPattern::Meandering => 1.0,
        RiverPattern::Braided => 2.0,
        RiverPattern::Anastomosing => 3.0,
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
    let mut biomes = vec![0u8; slots];
    let mut flux = vec![0f32; slots];
    let mut hardness = vec![0f32; slots];
    let mut cover = vec![0f32; slots];
    let mut column = SedimentColumn {
        data: vec![0f32; slots * COLUMN_DEPTH],
        epochs: vec![3.0, 5.0, 8.0],
    };
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
        biomes[v] = ((v * 7 + (x / 97.0).floor() as usize) % 15) as u8;
        flux[v] = (1e6 * det_sin(x * 0.002 + y * 0.003)).max(0.0) as f32;
        hardness[v] = (0.2 + 1.5 * (0.5 + 0.5 * det_cos(x * 0.004 - y * 0.006))) as f32;
        cover[v] = (0.5 + 0.5 * det_sin(y * 0.009)) as f32;
        for layer in 0..3 {
            let at = v * COLUMN_DEPTH + layer * COLUMN_VALUES;
            let l = layer as f64;
            column.data[at] = (6.0 * det_sin(x * 0.013 + l * 1.7 + y * 0.002)).max(0.0) as f32;
            column.data[at + 1] = (7.0 * det_cos(y * 0.011 - l * 2.3 + x * 0.003)).max(0.0) as f32;
        }
    }
    let sub = MeshSubstrate {
        mesh: &mesh,
        routing: &routing,
        areas: &areas,
    };
    let relief = SURFACE_TUNING.min_lake_basin_relief_m;
    let discharge = accumulate_discharge_on(&sub, &z, &precip, Some(&temp));
    let lakes = compute_lakes_on(&sub, &discharge, &z, &temp, relief);
    let regime = accumulate_regime_inputs_on(&sub, &z, &temp, &precip, Some(&monsoon), None);
    let max_q = max_discharge_over_land(&discharge, &z);
    let critical = density_to_critical_area(CANONICAL_RIVER_DENSITY, &domain);
    let (mut land_sum, mut land_area) = (0.0, 0.0);
    for v in 0..slots {
        if z[v] > 0.0 {
            land_sum += (precip[v] as f64).max(0.0) * areas[v] as f64;
            land_area += areas[v] as f64;
        }
    }
    let threshold = channel_threshold(critical, land_sum / land_area);
    let inputs = RiverGraphInputs {
        substrate: &sub,
        discharge: &discharge,
        elevation: &z,
        threshold,
        max_discharge: max_q,
        bodies: &lakes.bodies,
        body: &lakes.body,
        lake_depth: &lakes.depth,
        sediment_flux: None,
        biomes: None,
        regime: None,
        critical_area: None,
    };

    // The graph, bare and with every input, and a wet world's.
    let mut h = Hash::new();
    let mut bare = build_river_graph(&inputs);
    h.graph(&bare);
    h.invariants(&river_graph_invariants(&bare, &z));
    let mut graph = build_river_graph(&RiverGraphInputs {
        sediment_flux: Some(&flux),
        biomes: Some(&biomes),
        regime: Some(&regime),
        critical_area: Some(critical),
        ..inputs
    });
    h.graph(&graph);
    h.invariants(&river_graph_invariants(&graph, &z));
    let wet_precip: Vec<f32> = precip.iter().map(|&p| (p as f64 * 4.0) as f32).collect();
    let wet_q = accumulate_discharge_on(&sub, &z, &wet_precip, None);
    let cold: Vec<f32> = temp.iter().map(|&t| (t as f64 - 30.0) as f32).collect();
    let wet_lakes = compute_lakes_on(&sub, &wet_q, &z, &cold, relief);
    let wet = build_river_graph(&RiverGraphInputs {
        discharge: &wet_q,
        max_discharge: max_discharge_over_land(&wet_q, &z),
        bodies: &wet_lakes.bodies,
        body: &wet_lakes.body,
        lake_depth: &wet_lakes.depth,
        ..inputs
    });
    h.graph(&wet);
    h.invariants(&river_graph_invariants(&wet, &z));
    h.check(&format!("{name}_graph"));

    // The hydrogeology over both graphs.
    let mut h = Hash::new();
    let cell_m = domain.metres_per_unit;
    for (g, col, hard) in [
        (&mut graph, Some(&column), Some(&hardness[..])),
        (&mut bare, None, None),
    ] {
        let ground = compute_hydrogeology(
            &HydrogeologyInputs {
                sub: &sub,
                elevation: &z,
                column: col,
                hardness: hard,
                precipitation: &precip,
                temperature: &temp,
                monsoon_index: col.map(|_| &monsoon[..]),
                cover: &cover,
                regime: &regime,
                discharge: &discharge,
                cell_m,
            },
            g,
        );
        h.add_all(&ground.permeability);
        h.add_all(&ground.water_table_depth_m);
        for s in &ground.springs {
            h.add(s.id as f64);
            h.add(s.cell as f64);
            h.add(s.x);
            h.add(s.y);
            h.add(s.elevation);
            h.flag(s.oasis);
        }
        h.graph(g);
        h.invariants(&hydrogeology_invariants(&ground, g, &z));
    }
    h.check(&format!("{name}_ground"));

    // The courses.
    let mut h = Hash::new();
    let mut steep = graph.clone();
    for r in &mut steep.reaches {
        r.slope *= 30.0;
    }
    let options = |cell_m: f64,
                   seed: u32,
                   min_width_m: Option<f64>,
                   steps: Option<usize>,
                   points: Option<f64>| {
        RiverCourseOptions {
            cell_m,
            seed,
            domain: &domain,
            min_width_m,
            max_points_per_reach: points,
            steps,
        }
    };
    for c in compute_river_courses(
        &steep,
        &options(cell_m / 400.0, 19, Some(0.01), Some(4), Some(200.0)),
    ) {
        h.add(c.reach as f64);
        h.add(pattern_code(c.pattern));
        h.add(c.slope);
        for l in &c.lines {
            h.add_all(l);
        }
        h.add_all(&c.line_width);
        h.add(c.sinuosity);
    }
    let mut last: Vec<RiverCourse> = Vec::new();
    for o in [
        options(cell_m, 7, None, None, None),
        options(cell_m, 11, Some(5.0), Some(30), Some(600.0)),
        options(cell_m / 20.0, 13, Some(0.5), Some(10), Some(300.0)),
        options(cell_m / 400.0, 17, Some(0.01), Some(4), Some(200.0)),
    ] {
        let courses = compute_river_courses(&graph, &o);
        for c in &courses {
            h.add(c.reach as f64);
            h.add(pattern_code(c.pattern));
            for v in [
                c.discharge_m3s,
                c.width_m,
                c.depth_m,
                c.slope,
                c.bank_strength,
            ] {
                h.add(v);
            }
            h.add(c.lines.len() as f64);
            for l in &c.lines {
                h.add_all(l);
            }
            h.add_all(&c.line_width);
            h.add(c.sinuosity);
            h.add(c.belt_width_m);
            h.add(c.oxbows.len() as f64);
            for o in &c.oxbows {
                h.add_all(o);
            }
            h.add_all(&c.lobe_ages);
        }
        last = courses;
    }
    graph.courses = Some(last);
    for k in 0..=20 {
        let k = k as f64;
        h.add(channel_width_m(k * 400.0 - 100.0));
        h.flag(
            classify_pattern(k * 300.0, k * 4e-4, 1e5, 300.0, k / 20.0, k % 2.0)
                == RiverPattern::Braided,
        );
    }
    h.check(&format!("{name}_courses"));

    // The ribbons.
    let mut h = Hash::new();
    h.polylines(&river_polylines_from_graph(&graph, max_q, None));
    h.polylines(&river_polylines_from_graph(&graph, max_q, Some(&domain)));
    h.polylines(&river_polylines_from_graph(&bare, max_q, Some(&domain)));
    h.polylines(&river_polylines_from_graph(&bare, 0.0, None));
    h.check(&format!("{name}_ribbons"));
}

#[test]
fn the_rivers_on_the_torus_are_the_typescript_engine_s() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_rivers_on_the_sphere_are_the_typescript_engine_s() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

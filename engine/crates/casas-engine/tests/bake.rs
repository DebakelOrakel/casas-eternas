//! The module test of the level bake (pipeline/mesh_bake_stage) against
//! the TypeScript engine (docs/decisions/rust-engine.md, fork 5). The
//! fixture is written by `engine/scripts/bakeFixture.mjs`; the scenarios
//! below are that script's, step for step. A change to the model records
//! the lines it moves (`fixture`, CASAS_RECORD=1).

mod fixture;
use fixture::check;

use casas_engine::climate::climate_mesh::{ClimateMesh, climate_cell_m};
use casas_engine::climate::climate_points::ClimateCellValues;
use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::fields::field_mesh::shared_field_mesh;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_serial::{encode_mesh, hilbert_vertex_order, permute};
use casas_engine::pipeline::mesh_bake_stage::{
    MeshBakeInputs, MeshBakeOptions, MeshLevel, bake_mesh_level, level_budget,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::surface::hydrology::WaterKind;
use casas_engine::surface::river_course::RiverPattern;
use casas_engine::surface::river_graph::RiverNodeKind;

const FIXTURE: &str = include_str!("fixtures/bake.txt");

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
    fn level(&mut self, lv: &MeshLevel) {
        self.add(lv.level as f64);
        self.add(lv.inserted as f64);
        let m = &lv.mesh;
        self.add_all(&m.vx[..m.vertex_slots()]);
        self.add_all(&m.vy[..m.vertex_slots()]);
        self.add_all(&m.tris[..3 * m.tri_slots()]);
        self.add_all(&lv.z);
        let r = &lv.routing;
        self.add_all(&r.flow_target);
        self.add_all(&r.filled);
        self.add_all(&r.accumulation);
        self.add_all(&r.pop_order);
        self.add(r.popped_count as f64);
        self.add_all(&lv.discharge);
        for b in &lv.water_bodies {
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
        self.add(f64::from(u8::from(lv.graph.is_some())));
        let Some(g) = &lv.graph else {
            return;
        };
        for n in &g.nodes {
            self.add(match n.kind {
                RiverNodeKind::Source => 0.0,
                RiverNodeKind::Junction => 1.0,
                RiverNodeKind::Mouth => 2.0,
                RiverNodeKind::Inlet => 3.0,
                RiverNodeKind::Outlet => 4.0,
            });
            for v in [n.cell as f64, n.x, n.y, n.body as f64, n.catchment_cells] {
                self.add(v);
            }
        }
        for r in &g.reaches {
            for v in [
                r.from as f64,
                r.to as f64,
                r.cell_count as f64,
                r.discharge_out,
                r.width_px,
                r.length_km,
                r.slope,
                r.sediment_m3,
                r.order as f64,
                r.regime.code() as f64,
            ] {
                self.add(v);
            }
        }
        self.add_all(&g.cells);
        self.add_all(&g.cell_x);
        self.add_all(&g.cell_y);
        for c in g.courses.iter().flatten() {
            self.add(c.reach as f64);
            self.add(match c.pattern {
                RiverPattern::Straight => 0.0,
                RiverPattern::Meandering => 1.0,
                RiverPattern::Braided => 2.0,
                RiverPattern::Anastomosing => 3.0,
            });
            self.add(c.width_m);
            self.add(c.sinuosity);
            self.add(c.belt_width_m);
            for l in &c.lines {
                self.add_all(l);
            }
            for o in &c.oxbows {
                self.add_all(o);
            }
            self.add_all(&c.line_width);
            self.add_all(&c.lobe_ages);
        }
        let rivers = lv.rivers.as_ref().unwrap();
        self.add_all(&rivers.points);
        self.add_all(&rivers.lengths);
        self.add_all(&rivers.regimes);
    }
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        check("bake.txt", &format!("{name} {:08x}", self.0), want, name);
    }
}

fn height_at(x: f64, y: f64) -> f64 {
    0.09 * det_sin(x * 0.006) * det_cos(y * 0.008)
        + 0.05 * det_sin(x * 0.019 + y * 0.011)
        + 0.03 * det_cos(x * 0.043 - y * 0.027)
        - 0.02
        - 0.06 * (det_sin(x * 0.011 + 2.0) * det_cos(y * 0.013 + 1.0) - 0.6).max(0.0)
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        height_at(x, y)
    }
}

#[test]
fn a_level_bakes_as_the_typescript_engine() {
    const W: usize = 1024;
    const H: usize = 512;
    let domain = Domain::torus(W as f64, H as f64);
    let built = build_mesh(&domain, &Analytic, 7, 4.0, 24);
    let order = hilbert_vertex_order(&built.mesh);
    let serial = encode_mesh(&built.mesh, &order);
    let z = permute(built.state.get(MESH_Z), &order);
    // The climate per cell of the climate mesh.
    let mut sh = shared_field_mesh(&domain, climate_cell_m(&domain));
    let nc = sh.mesh.count;
    let mut climate = ClimateCellValues {
        cells: nc,
        spacing_m: ClimateMesh::new(&sh.mesh).cell_m,
        sea_level_temperature: vec![0.0; nc],
        precipitation: vec![0.0; nc],
        seasonal_amplitude: vec![0.0; nc],
        monsoon_index: vec![0.0; nc],
    };
    for i in 0..nc {
        let (x, y) = (sh.mesh.x[i], sh.mesh.y[i]);
        let lat = (y / H as f64 - 0.5).abs() * 2.0;
        let land = height_at(x, y) > 0.0;
        climate.sea_level_temperature[i] = (28.0 - 40.0 * lat + 3.0 * det_sin(x * 0.02)) as f32;
        climate.precipitation[i] = if land {
            (200.0 + 800.0 * (1.0 + det_sin(x * 0.009 + y * 0.005))) as f32
        } else {
            -1.0
        };
        climate.seasonal_amplitude[i] = (4.0 + 14.0 * lat) as f32;
        climate.monsoon_index[i] = if land {
            (0.7 * det_cos(x * 0.004)) as f32
        } else {
            -1.0
        };
    }
    let uplift: Vec<f32> = (0..64 * 32)
        .map(|i| (0.5 + 0.5 * det_sin(i as f64 * 0.13)) as f32)
        .collect();
    let erodibility: Vec<f32> = (0..64 * 32)
        .map(|i| (1.0 + 0.4 * det_cos(i as f64 * 0.07)) as f32)
        .collect();
    let inputs = MeshBakeInputs {
        mesh: &serial,
        z: &z,
        width: W,
        height: H,
        detail_seed: 4242,
        litho_seed: 99,
        controls: ErosionControls {
            alluvium: Some(60.0),
            rock_contrast: Some(35.0),
        },
        uplift: Some(&uplift),
        erodibility: Some(&erodibility),
        forcing_res_x: 64,
        forcing_res_y: 32,
        climate: Some(&climate),
    };

    let mut h = Hash::new();
    for k in 0..=4 {
        h.add(level_budget(k));
    }
    h.check("budget");
    let options = MeshBakeOptions {
        level: 1,
        budget: 2.0,
        rounds: 6,
        pool: None,
    };
    for (name, inputs) in [
        ("climate", MeshBakeInputs { ..inputs }),
        (
            "dry",
            MeshBakeInputs {
                climate: None,
                uplift: None,
                erodibility: None,
                forcing_res_x: 0,
                forcing_res_y: 0,
                ..inputs
            },
        ),
    ] {
        let lv = bake_mesh_level(&inputs, &options, &mut sh).unwrap();
        let mut h = Hash::new();
        h.level(&lv);
        h.check(&format!("level_{name}"));
    }
}

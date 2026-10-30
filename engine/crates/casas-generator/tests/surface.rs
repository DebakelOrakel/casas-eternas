//! The module test of the surface stages, first part (mesh/mesh_column,
//! surface/cover, surface/glacial, surface/coastal) against the TypeScript
//! engine (docs/decisions/rust-engine.md, fork 5). The fixture is written
//! by `engine/scripts/surfaceFixture.mjs`; the scenarios below are that
//! script's, step for step. A change to the model records the lines it
//! moves (`fixture`, CASAS_RECORD=1).

use casas_generator::core::det_math::{det_cos, det_sin};
use casas_generator::core::domain::Domain;
use casas_generator::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_generator::mesh::mesh_column::{
    column_thickness, create_column, cut, decode_column, deposit, encode_column, erodibility_over,
    open_layer, permute_column,
};
use casas_generator::surface::coastal::{CoastalInputs, compute_coastal, find_shore};
use casas_generator::surface::cover::cover_field;
use casas_generator::surface::glacial::{
    MeshIceInputs, compute_ice_on_mesh, glacial_erosion_on_mesh,
};

mod fixture;
use fixture::check;

const FIXTURE: &str = include_str!("fixtures/surface.txt");

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
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        check("surface.txt", &format!("{name} {:08x}", self.0), want, name);
    }
}

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

#[test]
fn the_column_and_the_cover_give_the_typescript_values() {
    let mut g = Gen(1);
    let slots = 300;
    let mut col = create_column(slots);
    let mut h = Hash::new();
    for e in 0..11 {
        open_layer(&mut col, 100.0 + e as f64 * 3.0, slots);
        for k in 0..500 {
            let v = g.next() as usize % slots;
            let thickness = g.uniform(-2.0, 30.0);
            let craton = g.uniform(0.0, 1.0);
            let hard = g.uniform(0.3, 2.0);
            let temp = g.uniform(-20.0, 30.0);
            let precip = g.uniform(0.0, 3000.0);
            deposit(
                &mut col,
                v,
                thickness,
                craton,
                hard,
                temp,
                precip,
                k % 3 == 0,
            );
        }
        for _ in 0..200 {
            let v = g.next() as usize % slots;
            let t = g.uniform(-1.0, 40.0);
            h.add(cut(&mut col, v, t));
        }
        h.add_all(&col.epochs);
        for v in (0..slots).step_by(7) {
            h.add(column_thickness(&col.data, v, col.epochs.len()));
            h.add(erodibility_over(&col.data, v, col.epochs.len(), 0.7));
        }
    }
    h.add_all(&col.data);
    let bytes = encode_column(&col, slots);
    h.add_all(&bytes);
    let back = decode_column(&bytes, slots, slots + 20).unwrap();
    h.add_all(&back.data);
    h.add_all(&back.epochs);
    let order: Vec<i32> = (0..slots).map(|i| ((i * 37) % slots) as i32).collect();
    h.add_all(&permute_column(&col.data, &order));
    let biomes: Vec<u8> = (0..40).map(|i| (i % 20) as u8).collect();
    h.add_all(&cover_field(&biomes, true));
    h.add_all(&cover_field(&biomes, false));
    h.check("column");
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        0.09 * det_sin(x * 0.006) * det_cos(y * 0.008)
            + 0.05 * det_sin(x * 0.019 + y * 0.011)
            + 0.03 * det_cos(x * 0.043 - y * 0.027)
            - 0.03
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
    let cell_m = domain.metres_per_unit;
    let mut tsl = vec![0f32; slots];
    let mut precip = vec![0f32; slots];
    let mut amp = vec![0f32; slots];
    let mut wind_e = vec![0f32; slots];
    let mut wind_s = vec![0f32; slots];
    let mut hardness = vec![0f32; slots];
    let mut flux = vec![0f32; slots];
    let mut areas = vec![0f32; slots];
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        let lat = (y / domain.height - 0.5).abs() * 2.0;
        let land = z[v] > 0.0;
        tsl[v] = (27.0 - 55.0 * lat + 3.0 * det_sin(x * 0.01)) as f32;
        precip[v] = if land {
            (400.0 + 900.0 * (1.0 + det_sin(x * 0.007 + y * 0.004))) as f32
        } else {
            -1.0
        };
        amp[v] = if land {
            (8.0 + 30.0 * lat) as f32
        } else {
            -1.0
        };
        wind_e[v] = (det_cos(y * 0.012) * 0.9) as f32;
        wind_s[v] = (0.3 * det_sin(x * 0.009)) as f32;
        hardness[v] = (0.8 + 0.6 * det_cos(x * 0.02)) as f32;
        flux[v] = if land {
            (1e7 * (1.0 + det_sin(x * 0.03))) as f32
        } else {
            0.0
        };
        areas[v] = mesh.voronoi_area(v) as f32;
    }
    let ice = compute_ice_on_mesh(
        &mut mesh,
        &MeshIceInputs {
            z: &z,
            sea_level_temperature: &tsl,
            precipitation: &precip,
            seasonal_amplitude: &amp,
            cell_m,
        },
    );
    let mut h = Hash::new();
    h.add(slots as f64);
    h.add_all(&ice.thickness);
    h.add_all(&ice.balance);
    h.add_all(&ice.receiver);
    h.add_all(&ice.slope);
    h.add_all(&ice.order);
    h.add_all(&ice.ela_m);
    h.add(ice.mass_in);
    h.add(ice.mass_melt);
    h.add(ice.mass_out);
    let glacial = glacial_erosion_on_mesh(&mut mesh, &z, &ice, 1e6, cell_m);
    h.add_all(&glacial.cut_m);
    h.add_all(&glacial.till_m);
    h.add(glacial.cut_m3);
    h.add(glacial.till_m3);
    let iced = ice.thickness.iter().filter(|&&t| t > 0.0).count();
    assert!(
        iced > 0 && glacial.till_m3 > 0.0,
        "{name}: no ice to test against"
    );
    h.check(&format!("{name}_ice"));

    let mut h = Hash::new();
    let shore = find_shore(&mesh, &z);
    h.add_all(&shore.shore);
    h.add_all(&shore.normal_x);
    h.add_all(&shore.normal_y);
    let coast = compute_coastal(
        &mut mesh,
        &CoastalInputs {
            z: &z,
            areas: &areas,
            wind_e: &wind_e,
            wind_s: &wind_s,
            cell_m,
            hardness: &hardness,
            sediment_flux: &flux,
            iterations: 4.0,
            epoch_years: 1e6,
        },
    );
    h.add_all(&coast.cut_m);
    h.add_all(&coast.deposit_m);
    h.add_all(&coast.exposure);
    h.add(coast.shore_nodes as f64);
    h.add(coast.eroded_m3);
    h.add(coast.supplied_m3);
    h.add(coast.deposited_m3);
    h.add(coast.exported_m3);
    h.add(mesh.last_tri as f64);
    assert!(
        coast.deposited_m3 > 0.0 && coast.exported_m3 > 0.0,
        "{name}: no drift to test against"
    );
    h.check(&format!("{name}_coast"));
}

#[test]
fn the_torus_surface_gives_the_typescript_fields() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_surface_gives_the_typescript_fields() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

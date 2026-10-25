//! The module test of the ecology (ecology/ecology_field) against the
//! TypeScript engine (docs/decisions/rust-engine.md, fork 5). The fixture
//! is written by `engine/scripts/ecologyFixture.mjs`; the scenarios below
//! are that script's, step for step.

use casas_engine::climate::climate_points::{PointClimate, PointMonths};
use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::ecology::ecology_field::{
    ECOLOGY_FIELDS, EcologyField, EcologyInputs, EcologyParams, SEASONAL_ECOLOGY_FIELDS,
    apply_ecology, decode_fine_value, ecology_month, ecology_rasters, encode_fine_field,
    prepare_ecology,
};
use casas_engine::ecology::ecology_tune_params::ecology_constants;
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_raster::rasterise_node_field;
use casas_engine::tectonics::volcanoes::{Volcano, VolcanoKind};

const FIXTURE: &str = include_str!("fixtures/ecology.txt");

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
        assert_eq!(format!("{name} {:08x}", self.0), want);
    }
}

#[test]
fn the_tuning_and_the_codec_are_the_typescript_engine_s() {
    let mut h = Hash::new();
    for (k, v) in ecology_constants() {
        for c in k.encode_utf16() {
            h.add(c as f64);
        }
        h.add(v);
    }
    for c in 0..=255u8 {
        h.add(decode_fine_value(c));
    }
    h.add_all(&encode_fine_field(&[
        -1.0,
        0.0,
        0.01,
        1.5,
        2.999,
        3.0,
        7.0,
        -0.2,
        f32::NAN,
    ]));
    h.check("tuning");
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
}

fn run(name: &str, domain: Domain) {
    let built = build_mesh(&domain, &Analytic, 7, 12.0, 24);
    let mut mesh = built.mesh;
    let n = mesh.vertex_slots();
    let z: Vec<f32> = built.state.get(MESH_Z)[..n].to_vec();
    let mut land = vec![0u8; n];
    let mut temperature = vec![0f32; n];
    let mut precipitation = vec![0f32; n];
    let mut upwelling = vec![0f32; n];
    let mut rain_variability = vec![0f32; n];
    let mut biomes = vec![0u8; n];
    let mut discharge = vec![0f32; n];
    let mut lake_depth = vec![0f32; n];
    let mut salt_flat = vec![0u8; n];
    let mut water_table = vec![0f32; n];
    let mut craton_age = vec![0f32; n];
    let mut mt = vec![0f32; 12 * n];
    let mut mp = vec![0f32; 12 * n];
    let mut max_discharge = 0.0f64;
    for v in 0..n {
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        let lat = (y / domain.height - 0.5).abs() * 2.0;
        land[v] = u8::from(mesh.v_alive[v] != 0 && z[v] > 0.0);
        let l = land[v] != 0;
        temperature[v] = (30.0 - 48.0 * lat + 3.0 * det_sin(x * 0.01)
            - if l { z[v] as f64 * 58.0 } else { 0.0 }) as f32;
        precipitation[v] = if l {
            (50.0 + 900.0 * (1.0 + det_sin(x * 0.007 + y * 0.004))) as f32
        } else {
            -1.0
        };
        upwelling[v] = if l {
            0.0
        } else {
            (4.0 * det_cos(x * 0.005) * det_sin(y * 0.02)).max(0.0) as f32
        };
        rain_variability[v] = (0.3 + 0.3 * det_sin(y * 0.01)) as f32;
        biomes[v] = (1 + (v * 5 + (x / 61.0).floor() as usize) % 17) as u8;
        discharge[v] = if l {
            (5e5 * (det_sin(x * 0.03) * det_cos(y * 0.021) - 0.2)).max(0.0) as f32
        } else {
            0.0
        };
        if discharge[v] as f64 > max_discharge {
            max_discharge = discharge[v] as f64;
        }
        lake_depth[v] = if l && v % 37 == 0 { 0.002 } else { 0.0 };
        salt_flat[v] = u8::from(l && v % 53 == 0);
        water_table[v] = if l {
            (40.0 * (1.0 + det_sin(x * 0.02 - y * 0.01)) - 15.0) as f32
        } else {
            -1.0
        };
        craton_age[v] = (det_sin(x * 0.004) * det_cos(y * 0.005)) as f32;
        for m in 0..12 {
            let mf = m as f64;
            let phase = if y < domain.height / 2.0 { 0.0 } else { 3.1 };
            mt[m * n + v] = (temperature[v] as f64 + 11.0 * det_cos(mf * 0.523 + phase)) as f32;
            mp[m * n + v] = if precipitation[v] < 0.0 {
                -1.0
            } else {
                (precipitation[v] as f64 * (1.0 + 0.8 * det_sin(mf * 0.523 + x * 0.002))) as f32
            };
        }
    }
    let mut volcanoes = Vec::new();
    let mut orogen = Vec::new();
    let mut oases = Vec::new();
    for k in 0..90 {
        let kf = k as f64;
        let x = (kf * 233.7) % domain.width;
        let y = (kf * 91.3 + 37.0) % domain.height;
        volcanoes.push(Volcano {
            x,
            y,
            thickness: (k % 5) as f64,
            kind: match k % 3 {
                0 => VolcanoKind::Hotspot,
                1 => VolcanoKind::Arc,
                _ => VolcanoKind::Flood,
            },
        });
        orogen.push((
            (x + 400.0) % domain.width,
            (y * 0.7 + 100.0) % domain.height,
        ));
        if k % 9 == 0 {
            oases.push(((x + 50.0) % domain.width, y));
        }
    }
    let zero = vec![0f32; n];
    let climate = |refined: bool| PointClimate {
        count: n,
        sea_level_temperature: temperature.clone(),
        temperature: temperature.clone(),
        precipitation: precipitation.clone(),
        seasonal_amplitude: zero.clone(),
        monsoon_index: zero.clone(),
        months: refined.then(|| PointMonths {
            count: 12,
            temperature: mt.clone(),
            precipitation: mp.clone(),
        }),
        upwelling: refined.then(|| upwelling.clone()),
        rain_variability: refined.then(|| rain_variability.clone()),
        wind_e: None,
        wind_s: None,
    };
    let mut weights = [None; 14];
    weights[EcologyField::Fish.index()] = Some(1.4);
    weights[EcologyField::Tin.index()] = Some(0.7);
    weights[EcologyField::Gems.index()] = Some(2.0);
    weights[EcologyField::Arable.index()] = Some(0.8);
    let param_sets = [
        EcologyParams {
            carrying_capacity: 100.0,
            concentration: 0.0,
            province_strength: 0.5,
            ..Default::default()
        },
        EcologyParams {
            carrying_capacity: 130.0,
            concentration: 40.0,
            province_strength: 1.0,
            weights,
            tin_rarity: Some(0.6),
        },
    ];
    let grid = domain.grid(512, 256);
    let el = rasterise_node_field(&mut mesh, &z, 512, 256);
    let pixel_land: Vec<u8> = el.iter().map(|&e| u8::from(e > 0.0)).collect();
    for (variant, refined) in [("refined", true), ("plain", false)] {
        let mut h = Hash::new();
        let c = climate(refined);
        let mut eco = prepare_ecology(
            &mut mesh,
            &EcologyInputs {
                z: &z,
                land: &land,
                climate: &c,
                biomes: &biomes,
                discharge: refined.then_some(&discharge[..]),
                max_discharge: if refined { max_discharge } else { 0.0 },
                lake_depth: refined.then_some(&lake_depth[..]),
                salt_flat: refined.then_some(&salt_flat[..]),
                water_table: refined.then_some(&water_table[..]),
                oases: if refined { &oases } else { &[] },
                volcanoes: &volcanoes,
                orogen_points: &orogen,
                craton_age: &craton_age,
                warp_seed: 3_735_928_559,
            },
        );
        let r = &eco.raw;
        for a in [
            &r.arable,
            &r.fish,
            &r.game,
            &r.pasture,
            &r.timber,
            &r.salt,
            &r.tool_stone,
            &r.copper,
            &r.iron,
            &r.gold,
            &r.silver,
        ] {
            h.add_all(a);
        }
        h.add_all(&eco.gem_belt);
        h.add_all(&eco.aridity);
        h.add_all(&eco.province_deviation);
        for &(x, y) in &eco.tin_points {
            h.add(x);
            h.add(y);
        }
        let mut fields = Vec::new();
        for params in &param_sets {
            fields = apply_ecology(&eco, &mut mesh, params);
            for f in &fields {
                h.add_all(f);
            }
        }
        for id in SEASONAL_ECOLOGY_FIELDS {
            for m in [1, 7, 12] {
                let month = ecology_month(&eco, &mesh, id, m, 1.3);
                h.add(f64::from(u8::from(month.is_some())));
                if let Some(month) = month {
                    h.add_all(&month);
                }
            }
        }
        let wanted = [
            EcologyField::CarryingCapacity,
            EcologyField::Fish,
            EcologyField::Gold,
        ];
        let given: Vec<Option<&[f32]>> = ECOLOGY_FIELDS
            .iter()
            .enumerate()
            .map(|(k, id)| wanted.contains(id).then(|| &fields[k][..]))
            .collect();
        let rasters = ecology_rasters(&mut eco, &mut mesh, &given, &pixel_land, &grid);
        for id in wanted {
            h.add_all(rasters.fields[id.index()].as_ref().unwrap());
            h.add_all(rasters.fine[id.index()].as_ref().unwrap());
        }
        h.add(mesh.last_tri as f64);
        h.check(&format!("{name}_{variant}"));
    }
}

#[test]
fn the_ecology_on_the_torus_is_the_typescript_engine_s() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_ecology_on_the_sphere_is_the_typescript_engine_s() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

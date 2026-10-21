//! The module test of the static climate (climate/ through `weather`, and
//! planet/planet_forcing) against the TypeScript engine: the same scenarios
//! give the same bits (docs/decisions/rust-engine.md, fork 5). The fixture
//! is written by `engine/scripts/climateFixture.mjs`; the scenarios below
//! are that script's, step for step.

use casas_engine::climate::biomes::{biome_from_koppen, classify_points};
use casas_engine::climate::climate_field::{belt_y_norm, in_top_summer_half, top_summer_cos};
use casas_engine::climate::climate_mesh::{
    ClimateTerrain, basin_rows, climate_cell_m, distance_to_sea, mesh_components, zonal_mean,
};
use casas_engine::climate::climate_points::{
    ClimateMonthCells, ClimatePoints, Heights, climate_at_points, climate_cells_from_weather,
    mean_land_runoff,
};
use casas_engine::climate::koppen::{classify_koppen, synthesize_months};
use casas_engine::climate::monsoon::seasonality_magnitude;
use casas_engine::climate::ocean_currents::{compute_sink_inflow, compute_upwelling};
use casas_engine::climate::precipitation::{
    RefinedRain, band_factor, compute_precipitation, earth_hadley_edge, evaporation,
};
use casas_engine::climate::temperature::{
    base_temperature_at_latitude, sea_level_temperature_band,
};
use casas_engine::climate::weather::{WeatherParams, compute_weather, default_weather_params};
use casas_engine::climate::wind::compute_wind;
use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::fields::field_mesh::shared_field_mesh;
use casas_engine::fields::field_operators::SolveReport;
use casas_engine::planet::planet_forcing::{
    DEFAULT_PLANET_FORCING, PlanetForcing, hadley_edge, obliquity_contrast, seasonality_factor,
    solar_temperature_offset_c,
};

const FIXTURE: &str = include_str!("fixtures/climate.txt");

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
    fn solve(&mut self, s: &SolveReport) {
        self.add(s.iterations as f64);
        self.add(s.residual);
        self.add(f64::from(u8::from(s.converged)));
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
fn the_planet_and_the_bands_give_the_typescript_values() {
    let mut h = Hash::new();
    for k in 0..=40 {
        let deg = 5.0 + k as f64;
        h.add(obliquity_contrast(deg));
        h.add(solar_temperature_offset_c(0.9 + k as f64 * 0.005));
        h.add(hadley_edge(10.0 + k as f64));
        let forcing = PlanetForcing {
            obliquity_deg: deg,
            eccentricity: k as f64 * 0.002,
            precession_deg: k as f64 * 9.0,
            ..DEFAULT_PLANET_FORCING
        };
        h.add(seasonality_factor(&forcing, true));
        h.add(seasonality_factor(&forcing, false));
    }
    for k in 0..=200 {
        let phi = k as f64 / 200.0;
        h.add(band_factor(phi, earth_hadley_edge()));
        h.add(band_factor(phi, 0.25));
        h.add(evaporation(-40.0 + k as f64 * 0.4));
        h.add(belt_y_norm(phi, 0.07, false));
        h.add(belt_y_norm(phi, -0.07, true));
        h.add(top_summer_cos(k as f64 * 0.1));
        h.add(f64::from(u8::from(in_top_summer_half((k % 12) as f64))));
        h.add(base_temperature_at_latitude(
            phi,
            1.3,
            &DEFAULT_PLANET_FORCING,
            k % 2 == 1,
        ));
    }
    h.add_all(&sea_level_temperature_band(
        2.0,
        0.8,
        &DEFAULT_PLANET_FORCING,
        true,
    ));
    h.check("functions");
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
fn the_koppen_classes_and_the_biomes_give_the_typescript_values() {
    let mut g = Gen(5);
    let mut h = Hash::new();
    let mut t = [0.0; 12];
    let mut p = [0.0; 12];
    for k in 0..20000 {
        let mean = g.uniform(-30.0, 32.0);
        let range = g.uniform(0.0, 45.0);
        let wet = g.uniform(0.0, 300.0);
        for m in 0..12 {
            t[m] = mean + range * det_cos(m as f64 * 0.52 + k as f64);
            p[m] = (wet * (1.0 + det_sin(m as f64 * 0.7 + k as f64 * 0.3)) * g.uniform(0.0, 1.2))
                .max(0.0);
        }
        h.add(classify_koppen(&t, &p) as f64);
        let index = g.uniform(-0.9, 0.9);
        synthesize_months(
            mean,
            range,
            wet * 12.0,
            index,
            k % 2 == 0,
            500.0,
            &mut t,
            &mut p,
        );
        h.add_all(&t);
        h.add_all(&p);
        h.add(classify_koppen(&t, &p) as f64);
    }
    for id in 0..32u8 {
        for map in [100.0, 300.0, 700.0, 1450.0, 2000.0] {
            let amp = g.uniform(5.0, 30.0);
            let season = g.uniform(0.0, 0.8);
            h.add(biome_from_koppen(id, map, amp, season) as f64);
        }
    }
    h.check("koppen");
}

fn height_at(x: f64, y: f64) -> f64 {
    0.08 * det_sin(x * 0.006) * det_cos(y * 0.009)
        + 0.04 * det_sin(x * 0.021 + y * 0.013)
        + 0.02 * det_cos(x * 0.05 - y * 0.03)
        - 0.03
}

fn run(name: &str, d: Domain) {
    const RX: usize = 512;
    const RY: usize = 256;
    let mut elevation = vec![0f32; RX * RY];
    let mut dry = vec![0u8; RX * RY];
    for i in 0..elevation.len() {
        let x = ((i % RX) * 4 + 2) as f64;
        let y = ((i / RX) * 4 + 2) as f64;
        elevation[i] = height_at(x, y) as f32;
        if elevation[i] < 0.0 && elevation[i] > -0.01 && i % 3 == 0 {
            dry[i] = 1;
        }
    }
    let mut sh = shared_field_mesh(&d, climate_cell_m(&d));
    let terrain = ClimateTerrain::new(&sh, &elevation, RX, RY, Some(&dry));
    let cm = &terrain.cm;
    let mut h = Hash::new();
    h.add(sh.mesh.count as f64);
    h.add(cm.cell_m);
    h.add(cm.bands as f64);
    h.add_all(&cm.band);
    h.add_all(&terrain.z);
    h.add_all(&terrain.land);
    h.add_all(&terrain.dry);
    h.add_all(terrain.mean_elevation(&mut sh));
    h.add_all(terrain.peak_elevation(&mut sh));
    h.add_all(&zonal_mean(cm, &sh.mesh, &terrain.z, None));
    h.add_all(&zonal_mean(
        cm,
        &sh.mesh,
        &terrain.z,
        Some(&|i| terrain.land[i] == 1),
    ));
    let (dist, nearest) = distance_to_sea(&sh.mesh, &terrain.land);
    h.add_all(&dist);
    h.add_all(&nearest);
    let parts = mesh_components(&sh.mesh, &terrain.land);
    h.add_all(&parts.label);
    h.add_all(&parts.area);
    let rows = basin_rows(&mut sh, &terrain);
    h.add_all(&rows.eastward);
    h.add_all(&rows.run_points);
    h.add_all(&rows.run_m);
    for ring in &rows.rings {
        h.add(ring.count as f64);
        h.add(ring.point_m);
        h.add_all(&ring.run_start);
    }
    h.check(&format!("{name}_mesh"));

    let moved = WeatherParams {
        temperature_offset: 3.0,
        temperature_contrast: 1.2,
        humidity: 0.8,
        equator_offset: 0.05,
        planet: Some(PlanetForcing {
            obliquity_deg: 30.0,
            rotation_hours: 30.0,
            eccentricity: 0.03,
            precession_deg: 20.0,
            solar_constant: 1.04,
            ..DEFAULT_PLANET_FORCING
        }),
    };
    for (variant, params) in [("default", default_weather_params()), ("moved", moved)] {
        let wm = compute_weather(&mut sh, &terrain, &params);
        let mut h = Hash::new();
        h.add_all(&wm.temperature);
        h.add_all(&wm.wind.e);
        h.add_all(&wm.wind.s);
        h.add_all(&wm.currents.e);
        h.add_all(&wm.currents.s);
        h.add_all(&wm.currents.psi);
        h.solve(&wm.currents.solve);
        h.add(wm.currents.islands as f64);
        h.add(wm.currents.landmasses as f64);
        h.add_all(&wm.current_anomaly);
        h.add_all(&wm.seasonal_amplitude);
        h.add_all(&wm.seasonal.annual);
        h.add_all(&wm.seasonal.index);
        h.check(&format!("{name}_weather_{variant}"));

        let n = sh.mesh.count;
        let mut h = Hash::new();
        let wind2 = compute_wind(cm, &sh.mesh, 0.02, 20.0, 0.04);
        h.add_all(&wind2.e);
        h.add_all(&wind2.s);
        h.add_all(&compute_upwelling(
            &sh,
            &terrain,
            &wm.wind,
            params.equator_offset,
            26.0,
        ));
        let sink: Vec<f64> = (0..n)
            .map(|i| {
                if terrain.land[i] != 0 {
                    0.0
                } else {
                    (cm.y_norm[i] - 0.8).max(0.0) + if i % 13 == 0 { 0.01 } else { 0.0 }
                }
            })
            .collect();
        let flow = compute_sink_inflow(&sh, &terrain, &sink);
        h.add_all(&flow.e);
        h.add_all(&flow.s);
        h.solve(&flow.solve);
        let high_hpa: Vec<f64> = (0..n)
            .map(|i| 6.0 * det_sin(sh.mesh.x[i] * 0.01) * det_cos(sh.mesh.y[i] * 0.02))
            .collect();
        let sea_anomaly: Vec<f64> = (0..n)
            .map(|i| 2.0 * det_cos(sh.mesh.x[i] * 0.005 + sh.mesh.y[i] * 0.003))
            .collect();
        let sea_temperature: Vec<f64> = wm.temperature.iter().map(|t| t + 1.0).collect();
        let refined = RefinedRain {
            sea_temperature: &sea_temperature,
            sea_anomaly: &sea_anomaly,
            high_hpa: &high_hpa,
        };
        h.add_all(&compute_precipitation(
            &mut sh,
            &terrain,
            &wm.temperature,
            &wm.wind,
            1.1,
            params.equator_offset,
            0.03,
            Some(&refined),
            0.3,
        ));
        let index: Vec<f32> = wm.seasonal.index.iter().map(|&v| v as f32).collect();
        h.add_all(&seasonality_magnitude(&index));
        h.check(&format!("{name}_refined_{variant}"));

        let cells = climate_cells_from_weather(&terrain, &wm);
        let mut g = Gen(11);
        let count = 6000;
        let (mut xs, mut ys, mut height) = (vec![0.0; count], vec![0.0; count], vec![0f32; count]);
        let (mut pland, mut pdry, mut alive) =
            (vec![0u8; count], vec![0u8; count], vec![0u8; count]);
        for i in 0..count {
            xs[i] = g.uniform(0.0, d.width);
            ys[i] = g.uniform(0.0, d.height);
            height[i] = g.uniform(-0.1, 0.6) as f32;
            pland[i] = u8::from(i % 5 == 0 || height[i] > 0.0);
            pdry[i] = u8::from(i % 17 == 0);
            alive[i] = u8::from(i % 23 != 0);
        }
        let points = ClimatePoints {
            count,
            x: &xs,
            y: &ys,
            height: Heights::F32(&height),
            land: pland,
            dry: Some(&pdry),
            alive: Some(&alive),
        };
        let nc = n;
        let mut months_t = vec![0f32; 12 * nc];
        let mut months_p = vec![0f32; 12 * nc];
        for m in 0..12 {
            for i in 0..nc {
                months_t[m * nc + i] = (cells.sea_level_temperature[i] as f64
                    + 8.0 * det_cos(m as f64 * 0.523 + cm.y_norm[i] * 3.0))
                    as f32;
                months_p[m * nc + i] = if cells.precipitation[i] == -1.0 {
                    -1.0
                } else {
                    (cells.precipitation[i] as f64
                        * (1.0 + 0.95 * det_sin(m as f64 * 0.523 + i as f64 * 0.001)))
                        as f32
                };
            }
        }
        let up: Vec<f32> = (0..nc)
            .map(|i| {
                if terrain.land[i] != 0 {
                    0.0
                } else {
                    det_sin(i as f64 * 0.1) as f32
                }
            })
            .collect();
        let rv: Vec<f32> = (0..nc)
            .map(|i| {
                if terrain.land[i] != 0 {
                    (0.3 + 0.2 * det_cos(i as f64 * 0.07)) as f32
                } else {
                    0.0
                }
            })
            .collect();
        let mut full = cells.clone();
        full.months = Some(ClimateMonthCells {
            count: 12,
            sea_level_temperature: months_t,
            precipitation: months_p,
        });
        full.upwelling = Some(up);
        full.rain_variability = Some(rv);
        let over: Vec<f32> = (0..count)
            .map(|_| g.uniform(-10.0, 3000.0) as f32)
            .collect();
        let mut h = Hash::new();
        h.add(mean_land_runoff(&sh, &cells));
        for (c, wind) in [(&cells, true), (&full, false)] {
            let at = climate_at_points(&mut sh, c, &points, wind);
            for a in [
                Some(&at.sea_level_temperature),
                Some(&at.temperature),
                Some(&at.precipitation),
                Some(&at.seasonal_amplitude),
                Some(&at.monsoon_index),
                at.upwelling.as_ref(),
                at.rain_variability.as_ref(),
                at.wind_e.as_ref(),
                at.wind_s.as_ref(),
            ]
            .into_iter()
            .flatten()
            {
                h.add_all(a);
            }
            if let Some(m) = &at.months {
                h.add_all(&m.temperature);
                h.add_all(&m.precipitation);
            }
            for o in [None, Some(&over[..])] {
                let b = classify_points(&at, &points, &d, o);
                h.add_all(&b.biome);
                h.add_all(&b.koppen);
            }
        }
        h.check(&format!("{name}_points_{variant}"));
    }
}

#[test]
fn the_torus_climate_gives_the_typescript_fields() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_climate_gives_the_typescript_fields() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

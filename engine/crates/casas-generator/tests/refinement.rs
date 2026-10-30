//! The module test of the climate's refinement (climate/refinement and its
//! parts: pressure, energy_balance, phenomena, reliability, storms,
//! salinity) and of the climate at points it gives, against the TypeScript
//! engine (docs/decisions/rust-engine.md, fork 5). The fixture was written
//! by `engine/scripts/refinementFixture.mjs`, and is recorded from this
//! engine since DEC-0050 (`fixture`); the scenarios below are that
//! script's, step for step.

use casas_generator::climate::biomes::classify_points;
use casas_generator::climate::climate_chart::{
    ChartTerrain, cells_chart, refined_chart, weather_chart,
};
use casas_generator::climate::climate_mesh::{ClimateTerrain, climate_cell_m};
use casas_generator::climate::climate_points::{
    ClimatePoints, Heights, climate_at_points, climate_cells_from_refined,
};
use casas_generator::climate::energy_balance::month_insolation;
use casas_generator::climate::refinement::refine_climate;
use casas_generator::climate::weather::{WeatherParams, compute_weather, default_weather_params};
use casas_generator::core::det_math::{det_cos, det_sin};
use casas_generator::core::domain::Domain;
use casas_generator::fields::field_mesh::shared_field_mesh;
use casas_generator::fields::field_operators::SolveReport;
use casas_generator::planet::planet_forcing::{DEFAULT_PLANET_FORCING, PlanetForcing};

mod fixture;

const FILE: &str = "refinement.txt";
const FIXTURE: &str = include_str!("fixtures/refinement.txt");

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
        fixture::check(FILE, &format!("{name} {:08x}", self.0), want, name);
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
fn the_insolation_gives_the_typescript_values() {
    let mut h = Hash::new();
    for k in 0..=300 {
        let planet = PlanetForcing {
            obliquity_deg: 10.0 + (k % 31) as f64,
            eccentricity: (k % 7) as f64 * 0.01,
            precession_deg: k as f64 * 3.0,
            solar_constant: 0.95 + (k % 11) as f64 * 0.01,
            ..DEFAULT_PLANET_FORCING
        };
        h.add(month_insolation(
            ((k % 61) - 30) as f64 * 0.05,
            (k % 24) as f64 / 24.0,
            &planet,
        ));
    }
    h.check("insolation");
}

fn height_at(x: f64, y: f64) -> f64 {
    0.08 * det_sin(x * 0.006) * det_cos(y * 0.009)
        + 0.04 * det_sin(x * 0.021 + y * 0.013)
        + 0.02 * det_cos(x * 0.05 - y * 0.03)
        + 0.05 * (det_sin(x * 0.004 + 1.0) * det_sin(y * 0.007)).max(0.0)
        - 0.03
}

fn run(name: &str, d: Domain) {
    const W: usize = 2048;
    const H: usize = 1024;
    let elevation: Vec<f32> = (0..W * H)
        .map(|i| height_at((i % W) as f64 + 0.5, (i / W) as f64 + 0.5) as f32)
        .collect();
    let mut sh = shared_field_mesh(&d, climate_cell_m(&d));
    let moved = WeatherParams {
        temperature_offset: -2.0,
        temperature_contrast: 0.9,
        humidity: 1.3,
        equator_offset: 0.0,
        planet: Some(PlanetForcing {
            obliquity_deg: 28.0,
            rotation_hours: 20.0,
            eccentricity: 0.04,
            precession_deg: 200.0,
            ..DEFAULT_PLANET_FORCING
        }),
    };
    let mut last = None;
    for (variant, params) in [("default", default_weather_params()), ("moved", moved)] {
        let terrain = ClimateTerrain::new(&sh, &elevation, W, H, None);
        let wm = compute_weather(&mut sh, &terrain, &params);
        let r = refine_climate(&mut sh, &elevation, &params, &wm.temperature, &wm.wind);
        let mut h = Hash::new();
        h.add(r.months as f64);
        h.add(r.cells as f64);
        h.add(r.spacing_m);
        for a in [
            &r.temperature,
            &r.precipitation,
            &r.pressure,
            &r.wind_e,
            &r.wind_s,
            &r.current_e,
            &r.current_s,
            &r.current_anomaly,
            &r.upwelling,
            &r.salinity,
            &r.deep_water,
            &r.fog,
            &r.foehn,
            &r.reliability.rain_variability,
            &r.reliability.enso_pattern,
        ] {
            h.add_all(a);
        }
        h.add(r.reliability.enso_period_years);
        h.add(r.reliability.enso_strength);
        let s = &r.storms;
        for a in [&s.cyclone, &s.tornado, &s.blizzard, &s.dust, &s.thunder] {
            h.add_all(a);
        }
        let solves = r.solves.as_ref().unwrap();
        h.solve(&solves.currents);
        h.solve(&solves.inflow);
        for c in &solves.cycle {
            h.solve(c);
        }
        h.check(&format!("{name}_refined_{variant}"));

        let cells = climate_cells_from_refined(&r, &terrain);
        let mut g = Gen(3);
        let count = 4000;
        let (mut xs, mut ys, mut height, mut land) = (
            vec![0.0; count],
            vec![0.0; count],
            vec![0f32; count],
            vec![0u8; count],
        );
        for i in 0..count {
            xs[i] = g.uniform(0.0, d.width);
            ys[i] = g.uniform(0.0, d.height);
            height[i] = g.uniform(-0.1, 0.5) as f32;
            land[i] = u8::from(height[i] > 0.0 || i % 6 == 0);
        }
        let points = ClimatePoints {
            count,
            x: &xs,
            y: &ys,
            height: Heights::F32(&height),
            land,
            dry: None,
            alive: None,
        };
        let at = climate_at_points(&mut sh, &cells, &points, true);
        let mut h = Hash::new();
        for a in [
            &cells.sea_level_temperature,
            &cells.precipitation,
            &cells.seasonal_amplitude,
            &cells.monsoon_index,
            &cells.wind_e,
            &cells.wind_s,
            &cells.months.as_ref().unwrap().sea_level_temperature,
        ] {
            h.add_all(a);
        }
        for a in [
            &at.sea_level_temperature,
            &at.temperature,
            &at.precipitation,
            &at.seasonal_amplitude,
            &at.monsoon_index,
            at.upwelling.as_ref().unwrap(),
            at.rain_variability.as_ref().unwrap(),
            at.wind_e.as_ref().unwrap(),
            at.wind_s.as_ref().unwrap(),
        ] {
            h.add_all(a);
        }
        let m = at.months.as_ref().unwrap();
        h.add_all(&m.temperature);
        h.add_all(&m.precipitation);
        let b = classify_points(&at, &points, &d, None);
        h.add_all(&b.biome);
        h.add_all(&b.koppen);
        h.check(&format!("{name}_points_{variant}"));
        last = Some((terrain, wm, r, cells));
    }

    let (terrain, wm, r, cells) = last.unwrap();
    let mut h = Hash::new();
    let wc = weather_chart(&mut sh, &terrain, &wm);
    for a in [
        &wc.temperature,
        &wc.wind,
        &wc.seasonal_amplitude,
        &wc.precipitation,
        &wc.monsoon_index,
        &wc.currents,
        &wc.current_anomaly,
    ] {
        h.add_all(a);
    }
    let rc = refined_chart(&mut sh, &r, &terrain);
    for a in [
        &rc.temperature,
        &rc.precipitation,
        &rc.pressure,
        &rc.wind,
        &rc.currents,
        &rc.current_anomaly,
        &rc.upwelling,
        &rc.salinity,
        &rc.deep_water,
        &rc.fog,
        &rc.foehn,
        &rc.reliability.rain_variability,
        &rc.reliability.enso_pattern,
        &rc.storms.cyclone,
        &rc.storms.tornado,
        &rc.storms.blizzard,
        &rc.storms.dust,
        &rc.storms.thunder,
    ] {
        h.add_all(a);
    }
    let chart_terrain = ChartTerrain {
        domain: &d,
        elevation: &elevation,
        res_x: W,
        res_y: H,
        dry_land: None,
    };
    for (rx, ry) in [(256, 128), (512, 256)] {
        let cc = cells_chart(&mut sh, &cells, &chart_terrain, rx, ry);
        for a in [
            &cc.temperature,
            &cc.precipitation,
            &cc.seasonal_amplitude,
            &cc.monsoon_index,
            &cc.land_mask,
        ] {
            h.add_all(a);
        }
    }
    h.check(&format!("{name}_chart"));
}

#[test]
fn the_torus_refinement_gives_the_typescript_climate() {
    run("torus", Domain::torus(2048.0, 1024.0));
}

#[test]
fn the_sphere_refinement_gives_the_typescript_climate() {
    run("sphere", Domain::sphere(2048.0, 1024.0));
}

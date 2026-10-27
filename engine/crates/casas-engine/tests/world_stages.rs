//! The module test of the world stages (pipeline/world_stages) against the
//! TypeScript engine (docs/decisions/rust-engine.md, fork 5): the stages in
//! the runtime's order on the synthetic simulation after 12 tectonic and 2
//! coupled epochs. The fixture was written by
//! `engine/scripts/worldStagesFixture.mjs`, and is recorded from this
//! engine since DEC-0049 (`fixture`); the scenarios below are that
//! script's, step for step.

use casas_engine::climate::climate_chart::WeatherChart;
use casas_engine::climate::climate_points::{ClimateCells, mean_land_runoff};
use casas_engine::climate::weather::WeatherParams;
use casas_engine::core::domain::Domain;
use casas_engine::ecology::ecology_field::{
    ECOLOGY_FIELDS, EcologyField, EcologyParams, apply_ecology, ecology_rasters, prepare_ecology,
};
use casas_engine::mesh::mesh_raster::rasterise_node_field;
use casas_engine::pipeline::coupled_epoch::{
    CoupledEpochOptions, CoupledTerrain, create_coupled_terrain, step_coupled_epoch,
};
use casas_engine::pipeline::world_stages::{
    HydrologyClimate, HydrologyFeatures, LandClimate, MeshHydrology, MeshTerrainRef,
    chart_max_of_nodes, climate_chain, collect_orogens, ecology_inputs_of, hydrology_features,
    hydrology_threshold, land_climate_of, pixel_land_of, refined_climate_of, route_hydrology,
};
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::surface::hydrology::max_discharge_over_land;
use casas_engine::tectonics::plate_simulation::step_epoch;

mod fixture;
mod synthetic_sim;

use fixture::check;
use synthetic_sim::synthetic_sim;

const FILE: &str = "worldStages.txt";
const FIXTURE: &str = include_str!("fixtures/worldStages.txt");

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
    fn cells(&mut self, c: &ClimateCells) {
        self.add_all(&c.sea_level_temperature);
        self.add_all(&c.precipitation);
        self.add_all(&c.seasonal_amplitude);
        self.add_all(&c.monsoon_index);
    }
    fn chart(&mut self, c: &WeatherChart) {
        for a in [
            &c.temperature,
            &c.wind,
            &c.seasonal_amplitude,
            &c.precipitation,
            &c.monsoon_index,
            &c.currents,
            &c.current_anomaly,
        ] {
            self.add_all(a);
        }
    }
    fn land(&mut self, l: &LandClimate) {
        self.add_all(&l.land);
        self.add_all(&l.climate.temperature);
        self.add_all(&l.climate.precipitation);
        self.add_all(&l.biome);
        self.add_all(&l.koppen);
    }
    fn on_mesh(&mut self, om: &MeshHydrology) {
        self.add_all(&om.discharge);
        let l = &om.lakes;
        self.add_all(&l.depth);
        self.add_all(&l.salt_flat);
        self.add_all(&l.dry_basin);
        self.add_all(&l.frozen);
        self.add_all(&l.level);
        self.add_all(&l.body);
        self.add(l.bodies.len() as f64);
        for b in &l.bodies {
            self.add(b.level);
            self.add(b.cells);
        }
        let r = &om.raster;
        self.add_all(&r.depth);
        self.add_all(&r.level);
        self.add_all(&r.body);
        self.add_all(&r.surface);
        self.add_all(&r.salt_flat);
        self.add_all(&r.dry_basin);
        self.add_all(&r.frozen);
        self.land(&om.land);
    }
    fn features(&mut self, ft: &HydrologyFeatures, om: &MeshHydrology) {
        let g = &ft.graph;
        self.add(g.nodes.len() as f64);
        self.add(g.reaches.len() as f64);
        for r in &g.reaches {
            self.add(r.from as f64);
            self.add(r.to as f64);
            self.add(r.discharge_out);
            self.add(r.order as f64);
            self.flag(r.spring_fed);
            self.add(r.runoff_out);
        }
        self.add_all(&g.cells);
        self.add_all(&g.cell_x);
        let courses = g.courses.as_ref().unwrap();
        self.add(courses.len() as f64);
        for c in courses {
            self.add(c.reach as f64);
            self.add(c.width_m);
            self.add(c.sinuosity);
            for l in &c.lines {
                self.add_all(l);
            }
        }
        self.add_all(&ft.coast.nodes);
        self.add_all(&ft.coast.coast_type);
        for r in &ft.coast.reaches {
            self.add(r.node_count as f64);
            self.add(r.exposure);
            self.add(r.supply);
        }
        for b in &ft.sediment_basins {
            self.add(b.nodes as f64);
            self.add(b.volume_km3);
            self.add(b.craton_age);
            self.add(b.hardness);
            self.add(b.x);
        }
        for s in &ft.oases {
            self.add(s.cell as f64);
            self.add(s.x);
        }
        self.add_all(&ft.ice);
        self.add_all(&ft.precipitation_effective);
        self.add_all(&ft.watersheds);
        self.add_all(&ft.discharge);
        self.add_all(&ft.coast_type);
        self.add_all(&ft.biomes);
        self.add_all(om.biome.as_ref().unwrap());
        self.add_all(om.ecology_biome.as_ref().unwrap());
        self.add_all(om.water_table.as_ref().unwrap());
    }
    /// The line's check, and a fresh hash for the next.
    fn line(&mut self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        check(FILE, &format!("{name} {:08x}", self.0), want, name);
        *self = Hash::new();
    }
}

fn run(name: &str, d: Domain, seed: u32) {
    let mut sim = synthetic_sim(d, seed);
    for _ in 0..12 {
        step_epoch(&mut sim);
    }
    let mut coupled = create_coupled_terrain(&mut sim, 4.0);
    let options = CoupledEpochOptions {
        weather: None,
        iterations_per_epoch: 4,
        budget: Some(4.0),
        climate_every: Some(3.0),
        remesh_every: Some(3.0),
        uplift_scale: Some(1.0),
        controls: ErosionControls::default(),
        leaf_workers: None,
    };
    for _ in 0..2 {
        step_coupled_epoch(&mut sim, &mut coupled, &options);
    }
    let (w, h) = (sim.width as usize, sim.height as usize);
    let raster = rasterise_node_field(&mut coupled.mesh, &coupled.z, w, h);
    let mut plan = None;
    let params = WeatherParams {
        temperature_offset: 9.0,
        temperature_contrast: 1.0,
        humidity: 0.35,
        equator_offset: 0.0,
        planet: None,
    };
    let mut hh = Hash::new();

    // The climate step.
    let chain = climate_chain(&mut sim.meshes.shared, &raster, &params, None);
    hh.cells(&chain.cells);
    hh.chart(&chain.chart);
    let land = land_climate_of(
        &mut sim.meshes.shared,
        &chain.cells,
        &coupled.mesh,
        &coupled.z,
        None,
    );
    hh.land(&land);
    hh.line(&format!("{name}_climate"));

    // The hydrology.
    let (mut om, v2) = {
        let CoupledTerrain {
            mesh,
            z,
            routing,
            areas,
            ..
        } = &mut coupled;
        let t = MeshTerrainRef {
            z,
            routing: routing.as_ref().unwrap(),
            areas,
        };
        route_hydrology(
            &mut sim.meshes.shared,
            mesh,
            &t,
            &raster,
            &raster,
            w,
            h,
            HydrologyClimate {
                params: &params,
                cells: &chain.cells,
                refined: false,
                land: Some(land.clone()),
            },
            &mut |_, _, _, _| {},
        )
    };
    let (v2_chain, v2_dry) = v2.unwrap();
    hh.cells(&v2_chain.cells);
    hh.chart(&v2_chain.chart);
    // The land the v2 ran the hydrology under is the route's.
    hh.land(&om.land);
    hh.add_all(&v2_dry);
    hh.on_mesh(&om);
    let max_q = max_discharge_over_land(&om.discharge, &coupled.z);
    let mean_runoff = mean_land_runoff(&sim.meshes.shared, &v2_chain.cells);
    let threshold = hydrology_threshold(&sim.domain, mean_runoff);
    hh.add(max_q);
    hh.add(mean_runoff);
    hh.add(threshold);
    hh.line(&format!("{name}_route"));
    let dry = om.raster.dry_basin.clone();
    let ft = hydrology_features(
        &mut sim,
        None,
        &mut coupled,
        &mut om,
        max_q,
        threshold,
        &raster,
        &raster,
        Some(&dry),
        &v2_chain.cells,
        w,
        h,
        &mut plan,
    );
    hh.features(&ft, &om);
    hh.add_all(&chart_max_of_nodes(
        &coupled.mesh,
        &om.discharge,
        &coupled.z,
    ));
    for (x, y) in collect_orogens(&sim.features) {
        hh.add(x);
        hh.add(y);
    }
    hh.line(&format!("{name}_features"));

    // The ecology.
    let world = ecology_inputs_of(&sim, &coupled.mesh, Some(&om), Some((max_q, &ft.oases)));
    let mut eco = {
        let z = coupled.z.clone();
        prepare_ecology(&mut coupled.mesh, &world.inputs(&z, &om.land, Some(&om)))
    };
    let fields = apply_ecology(
        &eco,
        &mut coupled.mesh,
        &EcologyParams {
            carrying_capacity: 100.0,
            concentration: 0.0,
            province_strength: 0.5,
            ..Default::default()
        },
    );
    for f in &fields {
        hh.add_all(f);
    }
    let cc = EcologyField::CarryingCapacity.index();
    let given: Vec<Option<&[f32]>> = ECOLOGY_FIELDS
        .iter()
        .enumerate()
        .map(|(k, _)| (k == cc).then(|| &fields[k][..]))
        .collect();
    let rasters = ecology_rasters(
        &mut eco,
        &mut coupled.mesh,
        &given,
        &pixel_land_of(&raster, Some(&dry)),
        &sim.domain.grid(w, h),
    );
    hh.add_all(rasters.fields[cc].as_ref().unwrap());
    hh.add_all(rasters.fine[cc].as_ref().unwrap());
    hh.line(&format!("{name}_ecology"));

    // The refinement and the hydrology on it.
    let step = refined_climate_of(
        &mut sim.meshes.shared,
        &raster,
        &params,
        &chain.weather.temperature,
        &chain.weather.wind,
        None,
    );
    hh.cells(&step.cells);
    hh.add_all(&step.annual.temperature);
    hh.add_all(&step.annual.precipitation);
    hh.add_all(&step.annual_wind);
    hh.add_all(&step.mesh_wind.e);
    hh.add_all(&step.mesh_temperature);
    hh.add_all(&step.chart.temperature);
    hh.add_all(&step.chart.fog);
    let land2 = land_climate_of(
        &mut sim.meshes.shared,
        &step.cells,
        &coupled.mesh,
        &coupled.z,
        None,
    );
    hh.land(&land2);
    let (mut om2, none) = {
        let CoupledTerrain {
            mesh,
            z,
            routing,
            areas,
            ..
        } = &mut coupled;
        let t = MeshTerrainRef {
            z,
            routing: routing.as_ref().unwrap(),
            areas,
        };
        route_hydrology(
            &mut sim.meshes.shared,
            mesh,
            &t,
            &raster,
            &raster,
            w,
            h,
            HydrologyClimate {
                params: &params,
                cells: &step.cells,
                refined: true,
                land: Some(land2),
            },
            &mut |_, _, _, _| {},
        )
    };
    assert!(none.is_none(), "no v2 over a refinement");
    hh.on_mesh(&om2);
    let max_q2 = max_discharge_over_land(&om2.discharge, &coupled.z);
    let threshold2 = hydrology_threshold(
        &sim.domain,
        mean_land_runoff(&sim.meshes.shared, &step.cells),
    );
    let dry2 = om2.raster.dry_basin.clone();
    let ft2 = hydrology_features(
        &mut sim,
        None,
        &mut coupled,
        &mut om2,
        max_q2,
        threshold2,
        &raster,
        &raster,
        Some(&dry2),
        &step.cells,
        w,
        h,
        &mut plan,
    );
    hh.features(&ft2, &om2);
    hh.add(coupled.mesh.last_tri as f64);
    hh.line(&format!("{name}_refined"));
}

#[test]
fn the_world_stages_on_the_torus_are_the_typescript_engine_s() {
    run("torus", Domain::torus(2048.0, 1024.0), 7);
}

#[test]
fn the_world_stages_on_the_sphere_are_the_typescript_engine_s() {
    run("sphere", Domain::sphere(2048.0, 1024.0), 8);
}

//! The world stages through the boundary (`pipeline/worldStages.ts` as
//! the runtime's handlers call it): what a stage keeps between calls is
//! the world's, as the runtime's module state is the worker's, and each
//! call gives the body of the message the runtime posts.

use casas_engine::climate::biomes::biome;
use casas_engine::climate::climate_mesh::ClimateTerrain;
use casas_engine::climate::climate_points::ClimateCells;
use casas_engine::climate::refinement::refinement_fits;
use casas_engine::climate::weather::WeatherParams;
use casas_engine::climate::wind::CellVectors;
use casas_engine::mesh::mesh_hydrology::mesh_routing;
use casas_engine::mesh::mesh_raster::TriangleRaster;
use casas_engine::pipeline::coupled_epoch::CoupledTerrain;
use casas_engine::pipeline::world_stages::{
    LandClimate, climate_chain, id_raster, land_climate_of, pixel_land_of, refined_climate_of,
    triangles_of,
};
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::tectonics::plate_simulation_types::PlateSimulation;

use crate::forms::{self, ClimateData};
use crate::{Era, EraError, Value, World, read, wrong};

/// What the stages keep (the runtime's `lastRawElevations`,
/// `pixelTriangles` and `climate`).
#[derive(Default)]
pub(crate) struct Stages {
    /// The last render's raw elevation on the world raster.
    pub(crate) elevation: Option<Vec<f32>>,
    /// The pixels' triangles on the terrain mesh, made on the first ask
    /// after the mesh changed.
    pub(crate) pixel_triangles: Option<TriangleRaster>,
    climate: Option<Climate>,
}

impl Stages {
    /// A render's new raster: what was computed on the last one no longer
    /// describes the world (the runtime's `invalidateAfter('tectonics')`).
    pub(crate) fn rendered(&mut self, elevation: Vec<f32>) {
        self.elevation = Some(elevation);
        self.climate = None;
    }

    /// The hand-over: the climate was never the plates'; the last render
    /// stays until the next.
    pub(crate) fn handed_over(&mut self) {
        self.climate = None;
    }
}

/// The climate the step shows (the runtime's `ClimateResult`). The
/// hydrology and the ecology read the rest when they cross.
#[allow(dead_code)]
struct Climate {
    params: WeatherParams,
    cells: ClimateCells,
    terrain: ClimateTerrain<'static>,
    mesh_temperature: Vec<f64>,
    mesh_wind: CellVectors,
    refined: bool,
    land: LandClimate,
}

/// A biome or a Köppen class per node on the world raster, through the
/// pixels' triangles (the runtime's `idRasterOf`).
fn id_raster_of(
    triangles: &mut Option<TriangleRaster>,
    coupled: &mut CoupledTerrain,
    land: &LandClimate,
    ids: &[u8],
    pixel_land: &[u8],
    (width, height): (usize, usize),
    sea: f64,
) -> Vec<u8> {
    let plan = triangles_of(triangles, &mut coupled.mesh, width, height);
    id_raster(
        &mut coupled.mesh,
        land,
        ids,
        pixel_land,
        width,
        height,
        sea,
        plan,
    )
}

/// The terrain the land fields are read on, routed (the runtime's
/// `landTerrain`).
fn routed(coupled: &mut CoupledTerrain) {
    if coupled.routing.is_none() {
        coupled.routing = Some(mesh_routing(
            &mut coupled.mesh,
            &coupled.z,
            &DEFAULT_SOLVER_PARAMS,
        ));
    }
}

impl World {
    fn staged(
        &mut self,
    ) -> Result<(&mut PlateSimulation, &mut CoupledTerrain, &mut Stages), EraError> {
        match &mut self.era {
            Era::Plates { sim, coupled } => Ok((sim, coupled, &mut self.stages)),
            _ => Err(wrong("the world has no plates yet")),
        }
    }

    /// The climate step (the runtime's `handleClimateRun`): the chain on
    /// the last render's raster under `params` (`ClimateParams`), the
    /// climate at the terrain's nodes; the body of its `climateData`.
    pub fn climate(&mut self, params: &Value) -> Result<Value, EraError> {
        let params = read::weather(params)?;
        let (sim, coupled, stages) = self.staged()?;
        let elevation = stages
            .elevation
            .as_deref()
            .ok_or_else(|| wrong("the world has no render yet"))?;
        let size = (sim.width as usize, sim.height as usize);
        routed(coupled);
        let shared = &mut sim.meshes.shared;
        let chain = climate_chain(shared, elevation, &params, None);
        let land = land_climate_of(shared, &chain.cells, &coupled.mesh, &coupled.z, None);
        let pixel_land = pixel_land_of(elevation, None);
        let spacing_m = chain.terrain.cm.cell_m;
        let wind_mesh =
            forms::mesh_vectors(spacing_m, &chain.weather.wind.e, &chain.weather.wind.s);
        let currents_mesh = forms::mesh_vectors(
            spacing_m,
            &chain.weather.currents.e,
            &chain.weather.currents.s,
        );
        let tri = &mut stages.pixel_triangles;
        let koppen = id_raster_of(tri, coupled, &land, &land.koppen, &pixel_land, size, 0.0);
        let biomes = id_raster_of(
            tri,
            coupled,
            &land,
            &land.biome,
            &pixel_land,
            size,
            biome::OCEAN as f64,
        );
        let c = &chain.chart;
        let data = forms::climate_data(
            &ClimateData {
                temperature: &c.temperature,
                wind: &c.wind,
                currents: &c.currents,
                current_anomaly: &c.current_anomaly,
                precipitation: &c.precipitation,
                seasonal_amplitude: &c.seasonal_amplitude,
                monsoon_index: &c.monsoon_index,
            },
            wind_mesh,
            currents_mesh,
            koppen,
            biomes,
        );
        stages.climate = Some(Climate {
            params,
            cells: chain.cells,
            mesh_temperature: chain.weather.temperature,
            mesh_wind: chain.weather.wind,
            terrain: chain.terrain.into_owned(),
            refined: false,
            land,
        });
        Ok(data)
    }

    /// The climate step's refinement (the runtime's
    /// `handleClimateRefine`) on the climate the step shows, or a save's
    /// refinement taken as it is: `{ refined, annual }`, the bodies of its
    /// `climateRefined` and of the annual `climateData` that follows.
    pub fn refine_climate(&mut self, restored: Option<&Value>) -> Result<Value, EraError> {
        let restored = restored.map(read::refined_climate).transpose()?;
        let (sim, coupled, stages) = self.staged()?;
        let elevation = stages
            .elevation
            .as_deref()
            .ok_or_else(|| wrong("the world has no render yet"))?;
        let size = (sim.width as usize, sim.height as usize);
        routed(coupled);
        if stages.climate.is_none() {
            return Err(wrong("the world has no climate yet"));
        }
        let shared = &mut sim.meshes.shared;
        if restored
            .as_ref()
            .is_some_and(|r| !refinement_fits(shared, r.cells, r.spacing_m))
        {
            return Err(wrong(
                "the saved refinement belongs to another climate mesh",
            ));
        }
        let climate = stages.climate.take().unwrap();
        let step = refined_climate_of(
            shared,
            elevation,
            &climate.params,
            &climate.mesh_temperature,
            &climate.mesh_wind,
            restored,
        );
        let land = land_climate_of(shared, &step.cells, &coupled.mesh, &coupled.z, None);
        let pixel_land = pixel_land_of(elevation, None);
        let tri = &mut stages.pixel_triangles;
        let koppen = id_raster_of(tri, coupled, &land, &land.koppen, &pixel_land, size, 0.0);
        let refined = forms::climate_refined(&step.chart, &step.refined, koppen);
        let r = &step.refined;
        let wind_mesh = forms::mesh_vectors(r.spacing_m, &step.mesh_wind.e, &step.mesh_wind.s);
        let current_e: Vec<f64> = r.current_e.iter().map(|&v| v as f64).collect();
        let current_s: Vec<f64> = r.current_s.iter().map(|&v| v as f64).collect();
        let currents_mesh = forms::mesh_vectors(r.spacing_m, &current_e, &current_s);
        let koppen = id_raster_of(tri, coupled, &land, &land.koppen, &pixel_land, size, 0.0);
        let biomes = id_raster_of(
            tri,
            coupled,
            &land,
            &land.biome,
            &pixel_land,
            size,
            biome::OCEAN as f64,
        );
        let a = &step.annual;
        let annual = forms::climate_data(
            &ClimateData {
                temperature: &a.temperature,
                wind: &step.annual_wind,
                currents: &step.chart.currents,
                current_anomaly: &step.chart.current_anomaly,
                precipitation: &a.precipitation,
                seasonal_amplitude: &a.seasonal_amplitude,
                monsoon_index: &a.monsoon_index,
            },
            wind_mesh,
            currents_mesh,
            koppen,
            biomes,
        );
        stages.climate = Some(Climate {
            params: climate.params,
            cells: step.cells,
            terrain: step.terrain.into_owned(),
            mesh_temperature: step.mesh_temperature,
            mesh_wind: step.mesh_wind,
            refined: true,
            land,
        });
        Ok(crate::value::ObjBuilder::new()
            .put("refined", refined)
            .put("annual", annual)
            .build())
    }
}

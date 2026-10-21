//! The world stages through the boundary (`pipeline/worldStages.ts` as
//! the runtime's handlers call it): what a stage keeps between calls is
//! the world's, as the runtime's module state is the worker's, and each
//! call gives the body of the message the runtime posts.

use casas_engine::climate::biomes::biome;
use casas_engine::climate::climate_points::{ClimateCells, climate_cell_values, mean_land_runoff};
use casas_engine::climate::refinement::refinement_fits;
use casas_engine::climate::weather::WeatherParams;
use casas_engine::climate::wind::CellVectors;
use casas_engine::ecology::ecology_field::{
    ECOLOGY_FIELDS, EcologyBase, EcologyField, EcologyParams, apply_ecology, ecology_fine,
    ecology_month, ecology_rasters, encode_fine_field, is_seasonal_ecology_field, prepare_ecology,
};
use casas_engine::elevation::elevation_scale::meters_to_elevation;
use casas_engine::mantle::mantle_field::rasterise_mantle;
use casas_engine::mesh::mesh_hydrology::mesh_routing;
use casas_engine::mesh::mesh_raster::TriangleRaster;
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::pipeline::coupled_epoch::CoupledTerrain;
use casas_engine::pipeline::world_stages::{
    ClimateChain, HydrologyClimate, LandClimate, MeshHydrology, MeshTerrainRef, climate_chain,
    ecology_inputs_of, hydrology_features, hydrology_threshold, id_raster, land_climate_of,
    pixel_land_of, refined_climate_of, route_hydrology, triangles_of,
};
use casas_engine::surface::coast_graph::CoastGraph;
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::surface::hydrogeology::SpringFeature;
use casas_engine::surface::hydrology::{SURFACE_ICE, discharge_to_m3s, max_discharge_over_land};
use casas_engine::surface::river_graph::{RiverGraph, river_polylines_from_graph};
use casas_engine::surface::sediment_basins::SedimentBasin;
use casas_engine::tectonics::plate_simulation_types::PlateSimulation;

use crate::forms::{self, ClimateData};
use crate::value::ObjBuilder;
use crate::{Era, EraError, Value, World, read, wrong};

/// What the stages keep (the runtime's `lastRawElevations`,
/// `pixelTriangles`, `climate`, `hydrology`, `ecologyBase` and
/// `ecologyParams`).
#[derive(Default)]
pub(crate) struct Stages {
    /// The last render's raw elevation on the world raster.
    pub(crate) elevation: Option<Vec<f32>>,
    /// The pixels' triangles on the terrain mesh, made on the first ask
    /// after the mesh changed.
    pub(crate) pixel_triangles: Option<TriangleRaster>,
    climate: Option<Climate>,
    hydrology: Option<Hydrology>,
    ecology: Option<Ecology>,
}

impl Stages {
    /// A render's new raster: what was computed on the last one no longer
    /// describes the world (the runtime's `invalidateAfter('tectonics')`).
    pub(crate) fn rendered(&mut self, elevation: Vec<f32>) {
        self.elevation = Some(elevation);
        self.climate = None;
        self.hydrology = None;
        self.ecology = None;
    }

    /// The hand-over: the climate was never the plates'; the last render
    /// stays until the next.
    pub(crate) fn handed_over(&mut self) {
        self.pixel_triangles = None;
        self.climate = None;
        self.hydrology = None;
        self.ecology = None;
    }

    /// An epoch: a new terrain mesh, and the ecology's key holds the
    /// epoch. The climate and the hydrology stay, on the mesh before.
    pub(crate) fn epoched(&mut self) {
        self.pixel_triangles = None;
        self.ecology = None;
        if let Some(c) = &mut self.climate {
            c.current = false;
        }
        if let Some(h) = &mut self.hydrology {
            h.current = false;
        }
    }
}

/// The climate the step shows (the runtime's `ClimateResult`; its
/// terrain only the migration reads, which does not cross).
struct Climate {
    params: WeatherParams,
    cells: ClimateCells,
    mesh_temperature: Vec<f64>,
    mesh_wind: CellVectors,
    refined: bool,
    land: LandClimate,
    /// `land` is at the nodes of the terrain mesh now (the runtime's
    /// `land.mesh === meshTerrain.mesh`).
    current: bool,
}

/// The hydrology the step shows (the runtime's `HydrologyResult`): the
/// route on the mesh and its features once a pass made them.
struct Hydrology {
    on_mesh: MeshHydrology,
    max_discharge: f64,
    mean_runoff: f64,
    graph: Option<RiverGraph>,
    coast: Option<CoastGraph>,
    sediment_basins: Vec<SedimentBasin>,
    ice: Option<Vec<f32>>,
    oases: Vec<SpringFeature>,
    /// The route is on the terrain mesh now.
    current: bool,
}

/// The ecology's physics and what it was computed on (the runtime's
/// `ecologyBase`), with the sliders of the last run (`ecologyParams`).
struct Ecology {
    base: EcologyBase,
    pixel_land: Vec<u8>,
    params: Option<EcologyParams>,
}

/// The fields' ids (`ECOLOGY_FIELD_IDS`), in `ECOLOGY_FIELDS` order.
const ECOLOGY_FIELD_IDS: [&str; 14] = [
    "carryingCapacity",
    "arable",
    "fish",
    "game",
    "pasture",
    "timber",
    "salt",
    "toolStone",
    "copper",
    "tin",
    "iron",
    "gold",
    "silver",
    "gems",
];

fn field_of(id: &str) -> Option<EcologyField> {
    ECOLOGY_FIELD_IDS
        .iter()
        .position(|&f| f == id)
        .map(|k| ECOLOGY_FIELDS[k])
}

/// `EcologyParams`: `{ carryingCapacity, concentration, provinceStrength,
/// tinRarity?, weights? }`.
fn ecology_params(v: &Value) -> Result<EcologyParams, EraError> {
    let f = read::Fields::of(v, "the ecology's sliders")?;
    let mut weights = [None; 14];
    if let Some(w) = f.get("weights") {
        let w = read::Fields::of(w, "the ecology's weights")?;
        for (k, id) in ECOLOGY_FIELD_IDS.iter().enumerate() {
            weights[k] = w.opt_num(id)?;
        }
    }
    Ok(EcologyParams {
        carrying_capacity: f.num("carryingCapacity")?,
        concentration: f.num("concentration")?,
        province_strength: f.num("provinceStrength")?,
        weights,
        tin_rarity: f.opt_num("tinRarity")?,
    })
}

/// A biome or a Köppen class per node on the world raster, through the
/// pixels' triangles (the runtime's `idRasterOf`).
fn id_raster_of(
    triangles: &mut Option<TriangleRaster>,
    mesh: &mut PeriodicTriangulation,
    land: &LandClimate,
    ids: &[u8],
    pixel_land: &[u8],
    (width, height): (usize, usize),
    sea: f64,
) -> Vec<u8> {
    let plan = triangles_of(triangles, mesh, width, height);
    id_raster(mesh, land, ids, pixel_land, width, height, sea, plan)
}

/// The body of a `climateData` (the runtime's `postClimate`): the chart's
/// fields, the marks' vectors, then the Köppen classes and the biomes per
/// pixel of `pixel_land`.
#[allow(clippy::too_many_arguments)]
fn climate_data_of(
    triangles: &mut Option<TriangleRaster>,
    mesh: &mut PeriodicTriangulation,
    fields: &ClimateData,
    wind_mesh: Value,
    currents_mesh: Value,
    land: &LandClimate,
    pixel_land: &[u8],
    size: (usize, usize),
) -> Value {
    let koppen = id_raster_of(triangles, mesh, land, &land.koppen, pixel_land, size, 0.0);
    let ocean = biome::OCEAN as f64;
    let biomes = id_raster_of(triangles, mesh, land, &land.biome, pixel_land, size, ocean);
    forms::climate_data(fields, wind_mesh, currents_mesh, koppen, biomes)
}

/// A chain's `climateData` body (the runtime's `withMarks` and
/// `postClimate` over `chain.chart`).
fn chain_data(
    triangles: &mut Option<TriangleRaster>,
    mesh: &mut PeriodicTriangulation,
    chain: &ClimateChain,
    land: &LandClimate,
    pixel_land: &[u8],
    size: (usize, usize),
) -> Value {
    let spacing_m = chain.terrain.cm.cell_m;
    let w = &chain.weather;
    let c = &chain.chart;
    climate_data_of(
        triangles,
        mesh,
        &ClimateData {
            temperature: &c.temperature,
            wind: &c.wind,
            currents: &c.currents,
            current_anomaly: &c.current_anomaly,
            precipitation: &c.precipitation,
            seasonal_amplitude: &c.seasonal_amplitude,
            monsoon_index: &c.monsoon_index,
        },
        forms::mesh_vectors(spacing_m, &w.wind.e, &w.wind.s),
        forms::mesh_vectors(spacing_m, &w.currents.e, &w.currents.s),
        land,
        pixel_land,
        size,
    )
}

/// The climate a chain made, at the nodes of `land`'s terrain (the
/// runtime's `climateResultOf`).
fn climate_of(chain: ClimateChain, params: WeatherParams, land: LandClimate) -> Climate {
    Climate {
        params,
        cells: chain.cells,
        mesh_temperature: chain.weather.temperature,
        mesh_wind: chain.weather.wind,
        refined: false,
        land,
        current: true,
    }
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
        let tri = &mut stages.pixel_triangles;
        let data = chain_data(tri, &mut coupled.mesh, &chain, &land, &pixel_land, size);
        stages.climate = Some(climate_of(chain, params, land));
        stages.hydrology = None;
        stages.ecology = None;
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
        let mesh = &mut coupled.mesh;
        let koppen = id_raster_of(tri, mesh, &land, &land.koppen, &pixel_land, size, 0.0);
        let refined = forms::climate_refined(&step.chart, &step.refined, koppen);
        let r = &step.refined;
        let current_e: Vec<f64> = r.current_e.iter().map(|&v| v as f64).collect();
        let current_s: Vec<f64> = r.current_s.iter().map(|&v| v as f64).collect();
        let a = &step.annual;
        let annual = climate_data_of(
            tri,
            mesh,
            &ClimateData {
                temperature: &a.temperature,
                wind: &step.annual_wind,
                currents: &step.chart.currents,
                current_anomaly: &step.chart.current_anomaly,
                precipitation: &a.precipitation,
                seasonal_amplitude: &a.seasonal_amplitude,
                monsoon_index: &a.monsoon_index,
            },
            forms::mesh_vectors(r.spacing_m, &step.mesh_wind.e, &step.mesh_wind.s),
            forms::mesh_vectors(r.spacing_m, &current_e, &current_s),
            &land,
            &pixel_land,
            size,
        );
        stages.climate = Some(Climate {
            params: climate.params,
            cells: step.cells,
            mesh_temperature: step.mesh_temperature,
            mesh_wind: step.mesh_wind,
            refined: true,
            land,
            current: true,
        });
        stages.hydrology = None;
        stages.ecology = None;
        Ok(ObjBuilder::new()
            .put("refined", refined)
            .put("annual", annual)
            .build())
    }

    /// The hydrology step (the runtime's `handleHydrologyRun`) under the
    /// history's planet (`PlanetForcing` or null). A first pass routes:
    /// the lakes and the discharge, the climate v2 on the dry floors
    /// unless the climate is the refinement, the map's render of the dry
    /// floors, the features. A pass after reuses the route. The body of
    /// its `hydrologyData`, with the river graph as `RiverGraph` (the world
    /// layer serializes it), and `climate` (the v2's `climateData`, or
    /// null) and `render` (`{ mantle, dryBasin, saltFlat }`: the render
    /// the runtime posts after the route, or null).
    pub fn hydrology(&mut self, planet: Option<&Value>) -> Result<Value, EraError> {
        let planet = planet.map(read::planet).transpose()?;
        let (sim, coupled, stages) = self.staged()?;
        let Stages {
            elevation,
            pixel_triangles: tri,
            climate,
            hydrology,
            ecology,
        } = stages;
        let terrain = elevation
            .as_deref()
            .ok_or_else(|| wrong("the world has no render yet"))?;
        if climate.is_none() {
            return Err(wrong("the world has no climate yet"));
        }
        let (width, height) = (sim.width as usize, sim.height as usize);
        routed(coupled);
        let mut v2_data = Value::Null;
        let mut render = Value::Null;
        let rerouted = hydrology.is_none();
        if rerouted {
            let weather = climate.as_ref().unwrap();
            let mut v2_land = None;
            let (on_mesh, v2) = {
                let t = MeshTerrainRef {
                    z: &coupled.z,
                    routing: coupled.routing.as_ref().unwrap(),
                    areas: &coupled.areas,
                };
                let on_climate = &mut |mesh: &mut PeriodicTriangulation,
                                       chain: &ClimateChain,
                                       land: &LandClimate,
                                       dry: &[u8]| {
                    let pixel_land = pixel_land_of(terrain, Some(dry));
                    let size = (width, height);
                    v2_data = chain_data(tri, mesh, chain, land, &pixel_land, size);
                    v2_land = Some(land.clone());
                };
                route_hydrology(
                    &mut sim.meshes.shared,
                    &mut coupled.mesh,
                    &t,
                    terrain,
                    terrain,
                    width,
                    height,
                    HydrologyClimate {
                        params: &weather.params,
                        cells: &weather.cells,
                        refined: weather.refined,
                        land: Some(weather.land.clone()),
                    },
                    on_climate,
                )
            };
            if let (Some((chain, _)), Some(land)) = (v2, v2_land) {
                let params = climate.as_ref().unwrap().params;
                *climate = Some(climate_of(chain, params, land));
            }
            // The render after the route (`renderAndPost` over the
            // terrain with the dry floors): of the engine's, the mantle's
            // raster, which moves its mesh's walk.
            let lakes = &on_mesh.raster;
            render = ObjBuilder::new()
                .put(
                    "mantle",
                    Value::F32s(rasterise_mantle(&mut sim.meshes.mantle, &sim.mantle)),
                )
                .put("dryBasin", Value::U8s(lakes.dry_basin.clone()))
                .put("saltFlat", Value::U8s(lakes.salt_flat.clone()))
                .build();
            let cells = &climate.as_ref().unwrap().cells;
            // The render gave the runtime a new raster and the climate
            // may be the v2's: the ecology's key no longer holds.
            *ecology = None;
            *hydrology = Some(Hydrology {
                max_discharge: max_discharge_over_land(&on_mesh.discharge, &coupled.z),
                mean_runoff: mean_land_runoff(&sim.meshes.shared, cells),
                on_mesh,
                graph: None,
                coast: None,
                sediment_basins: Vec::new(),
                ice: None,
                oases: Vec::new(),
                current: true,
            });
        }
        let result = hydrology.as_mut().unwrap();
        let threshold = hydrology_threshold(&sim.domain, result.mean_runoff);
        let lakes = &result.on_mesh.raster;
        let (mut level_out, mut surface_out) = (Vec::new(), Vec::new());
        let mut body = ObjBuilder::new();
        if rerouted {
            level_out = lakes.level.clone();
            surface_out = lakes.surface.clone();
            let dry_basin = lakes.dry_basin.clone();
            let cells = &climate.as_ref().unwrap().cells;
            let features = hydrology_features(
                sim,
                planet,
                coupled,
                &mut result.on_mesh,
                result.max_discharge,
                threshold,
                terrain,
                terrain,
                Some(&dry_basin),
                cells,
                width,
                height,
                tri,
            );
            result.graph = Some(features.graph);
            result.oases = features.oases;
            result.coast = Some(features.coast);
            result.sediment_basins = features.sediment_basins;
            result.ice = Some(features.ice);
            body = body
                .put("biomes", Value::U8s(features.biomes))
                .put(
                    "precipitationEffective",
                    Value::F32s(features.precipitation_effective),
                )
                .put("watersheds", Value::U16s(features.watersheds))
                .put("discharge", Value::F32s(features.discharge))
                .put("coastType", Value::U8s(features.coast_type));
        } else {
            body = body
                .put("biomes", Value::U8s(Vec::new()))
                .put("precipitationEffective", Value::F32s(Vec::new()))
                .put("watersheds", Value::U16s(Vec::new()))
                .put("discharge", Value::F32s(Vec::new()))
                .put("coastType", Value::U8s(Vec::new()));
        }
        let rivers = result
            .graph
            .as_ref()
            .map(|g| river_polylines_from_graph(g, result.max_discharge, Some(&sim.domain)));
        // The glaciers ride in the level field the shore drawing reads.
        if let (true, Some(ice)) = (rerouted, &result.ice) {
            for c in 0..level_out.len() {
                if ice[c] <= 0.0 {
                    continue;
                }
                let top = terrain[c] as f64 + meters_to_elevation(ice[c] as f64);
                level_out[c] = (level_out[c] as f64).max(top) as f32;
                surface_out[c] = SURFACE_ICE;
            }
        }
        let lakes = &result.on_mesh.raster;
        let given = |v: Value| if rerouted { v } else { Value::Null };
        let (points, lengths, regimes) = rivers
            .map(|r| (r.points, r.lengths, r.regimes))
            .unwrap_or_default();
        let body = body
            .put("riverPoints", Value::F32s(points))
            .put("riverLengths", Value::U32s(lengths))
            .put("riverRegimes", Value::U8s(regimes))
            .put(
                "lakeDepth",
                Value::F32s(if rerouted {
                    lakes.depth.clone()
                } else {
                    Vec::new()
                }),
            )
            .num("maxDischarge", result.max_discharge)
            .put(
                "waterBodies",
                given(Value::List(
                    result
                        .on_mesh
                        .lakes
                        .bodies
                        .iter()
                        .map(forms::water_body)
                        .collect(),
                )),
            )
            .put("waterLevel", Value::F32s(level_out))
            .put("waterSurface", Value::U8s(surface_out))
            .put(
                "riverGraph",
                given(
                    result
                        .graph
                        .as_ref()
                        .map_or(Value::Null, forms::river_graph),
                ),
            )
            .put(
                "coast",
                given(result.coast.as_ref().map_or(Value::Null, |c| {
                    ObjBuilder::new()
                        .put(
                            "reaches",
                            Value::List(c.reaches.iter().map(forms::coast_reach).collect()),
                        )
                        .put("nodes", Value::I32s(c.nodes.clone()))
                        .build()
                })),
            )
            .put(
                "sedimentBasins",
                given(Value::List(
                    result
                        .sediment_basins
                        .iter()
                        .map(forms::sediment_basin)
                        .collect(),
                )),
            )
            .put(
                "iceThickness",
                Value::F32s(match (rerouted, &result.ice) {
                    (true, Some(ice)) => ice.clone(),
                    _ => Vec::new(),
                }),
            )
            .put("climate", v2_data)
            .put("render", render)
            .build();
        Ok(body)
    }

    /// The ecology step (the runtime's `handleEcologyRun`) under its
    /// sliders (`EcologyParams`): the physics on the climate and the
    /// hydrology when it ran, kept while only the sliders move; the body
    /// of its `ecologyData`.
    pub fn ecology(&mut self, params: &Value) -> Result<Value, EraError> {
        let params = ecology_params(params)?;
        let (sim, coupled, stages) = self.staged()?;
        let Stages {
            elevation,
            pixel_triangles: tri,
            climate,
            hydrology,
            ecology,
        } = stages;
        let raster = elevation
            .as_deref()
            .ok_or_else(|| wrong("the world has no render yet"))?;
        let climate = climate
            .as_ref()
            .ok_or_else(|| wrong("the world has no climate yet"))?;
        let (width, height) = (sim.width as usize, sim.height as usize);
        routed(coupled);
        if ecology.is_none() {
            let om = hydrology.as_ref().map(|h| &h.on_mesh);
            let land = om.map_or(&climate.land, |o| &o.land);
            let world = ecology_inputs_of(
                sim,
                &coupled.mesh,
                om,
                hydrology.as_ref().map(|h| (h.max_discharge, &h.oases[..])),
            );
            let mut base = prepare_ecology(&mut coupled.mesh, &world.inputs(&coupled.z, land, om));
            triangles_of(tri, &mut coupled.mesh, width, height);
            base.raster = tri.take();
            let dry = hydrology.as_ref().map(|h| &h.on_mesh.raster.dry_basin[..]);
            *ecology = Some(Ecology {
                base,
                pixel_land: pixel_land_of(raster, dry),
                params: None,
            });
        }
        let eco = ecology.as_mut().unwrap();
        let fields = apply_ecology(&eco.base, &mut coupled.mesh, &params);
        let given: Vec<Option<&[f32]>> = fields.iter().map(|f| Some(&f[..])).collect();
        let grid = sim.domain.grid(width, height);
        if eco.base.raster.is_none() {
            eco.base.raster = tri.take();
        }
        let rasters = ecology_rasters(
            &mut eco.base,
            &mut coupled.mesh,
            &given,
            &eco.pixel_land,
            &grid,
        );
        // The pixels' triangles are the runtime's one cache, the base's
        // and the stages' alike.
        *tri = eco.base.raster.take();
        eco.params = Some(params);
        let list = |fields: Vec<Option<Vec<f32>>>, fine: bool| {
            Value::List(
                fields
                    .into_iter()
                    .enumerate()
                    .filter_map(|(k, f)| f.map(|f| (k, f)))
                    .map(|(k, f)| {
                        let data = if fine {
                            Value::U8s(encode_fine_field(&f))
                        } else {
                            Value::F32s(f)
                        };
                        ObjBuilder::new()
                            .put("id", Value::Str(ECOLOGY_FIELD_IDS[k].into()))
                            .put("data", data)
                            .build()
                    })
                    .collect(),
            )
        };
        Ok(ObjBuilder::new()
            .num("resX", rasters.res_x as f64)
            .num("resY", rasters.res_y as f64)
            .put("fields", list(rasters.fields, false))
            .put(
                "fine",
                ObjBuilder::new()
                    .num("resX", rasters.fine_res_x as f64)
                    .num("resY", rasters.fine_res_y as f64)
                    .put("fields", list(rasters.fine, true))
                    .build(),
            )
            .build())
    }

    /// One month of a seasonal field on the last ecology run's physics and
    /// sliders (the runtime's `handleEcologyMonth`): the body of its
    /// `ecologyMonthData`, empty data when there is no such month.
    pub fn ecology_month(&mut self, field: &str, month: u32) -> Result<Value, EraError> {
        let id = field_of(field).ok_or_else(|| wrong("no such ecology field"))?;
        let (sim, coupled, stages) = self.staged()?;
        let (width, height) = (sim.width as usize, sim.height as usize);
        let tri = &mut stages.pixel_triangles;
        let data = match stages.ecology.as_mut() {
            Some(eco) if eco.params.is_some() && is_seasonal_ecology_field(id) => {
                let weight = eco.params.as_ref().unwrap().weights[id.index()].unwrap_or(1.0);
                ecology_month(&eco.base, id, month as usize, weight).map(|nodes| {
                    eco.base.raster = tri.take();
                    let fine = ecology_fine(
                        &mut eco.base,
                        &mut coupled.mesh,
                        &nodes,
                        &eco.pixel_land,
                        width,
                        height,
                        id == EcologyField::Fish,
                    );
                    *tri = eco.base.raster.take();
                    fine
                })
            }
            _ => None,
        };
        let (res_x, res_y) = if data.is_some() {
            (width, height)
        } else {
            (0, 0)
        };
        Ok(ObjBuilder::new()
            .put("field", Value::Str(field.into()))
            .num("month", month)
            .num("resX", res_x as f64)
            .num("resY", res_y as f64)
            .put(
                "data",
                Value::U8s(data.map_or_else(Vec::new, |d| encode_fine_field(&d))),
            )
            .build())
    }

    /// The climate's cells as the save holds them (the runtime's
    /// `climatePayload`, `ClimateCellValues`), or null before the climate
    /// ran.
    pub fn climate_payload(&mut self) -> Result<Value, EraError> {
        let Some(c) = &self.stages.climate else {
            return Ok(Value::Null);
        };
        let v = climate_cell_values(&c.cells);
        Ok(ObjBuilder::new()
            .num("cells", v.cells as f64)
            .num("spacingM", v.spacing_m)
            .put("seaLevelTemperature", Value::F32s(v.sea_level_temperature))
            .put("precipitation", Value::F32s(v.precipitation))
            .put("seasonalAmplitude", Value::F32s(v.seasonal_amplitude))
            .put("monsoonIndex", Value::F32s(v.monsoon_index))
            .build())
    }

    /// The land fields per node of the terrain mesh as the save holds them
    /// (the runtime's `landPayload`): the biome (the hydrology's when it
    /// ran, else the climate's), the Köppen class, and of the hydrology the
    /// water table, the discharge in m³/s and the water body per node,
    /// null before it ran. Null when no climate is at the mesh's nodes.
    pub fn land_payload(&mut self) -> Result<Value, EraError> {
        let Era::Plates { coupled, .. } = &self.era else {
            return Ok(Value::Null);
        };
        let Some(climate) = self.stages.climate.as_ref() else {
            return Ok(Value::Null);
        };
        let om = self
            .stages
            .hydrology
            .as_ref()
            .filter(|h| h.current)
            .map(|h| &h.on_mesh);
        if om.is_none() && !climate.current {
            return Ok(Value::Null);
        }
        let land = om.map_or(&climate.land, |o| &o.land);
        let count = coupled.mesh.alive_vertices as usize;
        let null_or = |v: Option<Value>| v.unwrap_or(Value::Null);
        let unit = discharge_to_m3s(1.0, coupled.mesh.domain.metres_per_unit);
        let biome = om.and_then(|o| o.biome.as_ref()).unwrap_or(&land.biome);
        Ok(ObjBuilder::new()
            .num("count", count as f64)
            .put("biome", Value::U8s(biome[..count].to_vec()))
            .put("koppen", Value::U8s(land.koppen[..count].to_vec()))
            .put(
                "waterTable",
                null_or(
                    om.and_then(|o| o.water_table.as_ref())
                        .map(|w| Value::F32s(w[..count].to_vec())),
                ),
            )
            .put(
                "discharge",
                null_or(om.map(|o| {
                    Value::F32s(
                        o.discharge[..count]
                            .iter()
                            .map(|&d| (d as f64 * unit) as f32)
                            .collect(),
                    )
                })),
            )
            .put(
                "lakeBody",
                null_or(om.map(|o| Value::I32s(o.lakes.body[..count].to_vec()))),
            )
            .build())
    }
}

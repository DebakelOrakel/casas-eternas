//! `pipeline/worldStages.ts`: what a stage of the generator computes, as
//! functions of their inputs — the climate chain, the climate at the
//! terrain's nodes, the climate step's refinement, the hydrology's route
//! and its features, the ecology's inputs. The runtime holds the state and
//! posts; the TypeScript port
//! (`client/src/generator/pipeline/worldStages.ts`, git history) explains
//! each step. Not ported: the refinement's progress callback, which the
//! boundary to TypeScript adds.

use crate::climate::biomes::{biome, classify_points};
use crate::climate::climate_chart::{
    RefinedClimateChart, WeatherChart, refined_chart, weather_chart,
};
use crate::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use crate::climate::climate_mesh::ClimateTerrain;
use crate::climate::climate_points::{
    ClimateCells, PointClimate, climate_at_points, climate_cells_from_refined,
    climate_cells_from_weather, mesh_points,
};
use crate::climate::precipitation::OCEAN_PRECIP;
use crate::climate::refinement::{
    AnnualFields, RefinedClimate, annual_from_months, refine_climate, refined_annual_wind,
};
use crate::climate::weather::{WeatherMesh, WeatherParams, compute_weather};
use crate::climate::wind::CellVectors;
use crate::core::domain::{Domain, DomainGrid};
use crate::core::world_time::{world_age_ma, world_epoch};
use crate::crust::raft_field::compute_craton_oldness_field;
use crate::ecology::ecology_field::EcologyInputs;
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::mesh::mesh_erosion::MeshRouting;
use crate::mesh::mesh_hydrology::{MeshSubstrate, RasterWaterFields, water_fields_from_mesh};
use crate::mesh::mesh_raster::{
    TriangleRaster, land_bilinear_at_nodes, nearest_cell_at_nodes, rasterise_node_field,
    rasterise_node_part, triangle_raster,
};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use crate::planet::planet_forcing::{DEFAULT_PLANET_FORCING, PlanetForcing};
use crate::surface::coast_graph::{CoastGraph, CoastGraphInputs, build_coast_graph};
use crate::surface::cover::cover_field;
use crate::surface::glacial::{MeshIceInputs, compute_ice_on_mesh};
use crate::surface::hydrogeology::{HydrogeologyInputs, SpringFeature, compute_hydrogeology};
use crate::surface::hydrology::{
    CANONICAL_RIVER_DENSITY, ClimateMonths, LakeFields, accumulate_discharge_on,
    accumulate_regime_inputs_on, channel_threshold, compute_lakes_on, density_to_critical_area,
    mark_subglacial, riparian_precipitation_on, watersheds_on,
};
use crate::surface::river_course::{RiverCourseOptions, compute_river_courses};
use crate::surface::river_graph::{RiverGraph, RiverGraphInputs, build_river_graph};
use crate::surface::sediment_basins::{SedimentBasin, SedimentBasinInputs, find_sediment_basins};
use crate::surface::surface_tune_params::SURFACE_TUNING;
use crate::tectonics::plate_simulation_types::PlateSimulation;
use crate::tectonics::terrain_features::{FeatureKind, TerrainFeature};
use crate::tectonics::volcanoes::{Volcano, ecology_volcanoes};

use super::coupled_epoch::CoupledTerrain;

/// One climate pass, v1 or v2: the weather on the climate's field mesh,
/// the cells every reader samples and the chart the screen paints.
pub struct ClimateChain<'a> {
    pub terrain: ClimateTerrain<'a>,
    pub weather: WeatherMesh,
    pub cells: ClimateCells,
    pub chart: WeatherChart,
}

pub fn climate_chain<'a>(
    sh: &mut SharedFieldMesh,
    elevation: &'a [f32],
    params: &WeatherParams,
    dry_land: Option<Vec<u8>>,
) -> ClimateChain<'a> {
    let (width, height) = (
        sh.mesh.domain.width as usize,
        sh.mesh.domain.height as usize,
    );
    let terrain = ClimateTerrain::with_dry_land(sh, elevation, width, height, dry_land);
    let weather = compute_weather(sh, &terrain, params);
    let cells = climate_cells_from_weather(&terrain, &weather);
    let chart = weather_chart(sh, &terrain, &weather);
    ClimateChain {
        terrain,
        weather,
        cells,
        chart,
    }
}

/// A climate at the nodes of one terrain mesh, and the biomes and Köppen
/// classes there; `dry` the terminal basins' dry floors it counted as land.
#[derive(Clone, Debug)]
pub struct LandClimate {
    pub land: Vec<u8>,
    pub dry: Option<Vec<u8>>,
    pub climate: PointClimate,
    pub biome: Vec<u8>,
    pub koppen: Vec<u8>,
}

pub fn land_climate_of(
    sh: &mut SharedFieldMesh,
    cells: &ClimateCells,
    mesh: &PeriodicTriangulation,
    z: &[f32],
    dry: Option<&[u8]>,
) -> LandClimate {
    let points = mesh_points(mesh, z, dry);
    let at_nodes = climate_at_points(sh, cells, &points, false);
    let classes = classify_points(&at_nodes, &points, &mesh.domain, None);
    LandClimate {
        land: points.land,
        dry: dry.map(|d| d.to_vec()),
        climate: at_nodes,
        biome: classes.biome,
        koppen: classes.koppen,
    }
}

/// The world raster's land: above the sea, or a terminal basin's dry floor.
pub fn pixel_land_of(elevation: &[f32], dry_basin: Option<&[u8]>) -> Vec<u8> {
    (0..elevation.len())
        .map(|i| u8::from(elevation[i] as f64 > SEA_LEVEL || dry_basin.is_some_and(|d| d[i] == 1)))
        .collect()
}

/// The pixels' triangles of a mesh, made on the first ask and kept.
pub fn triangles_of<'c>(
    cache: &'c mut Option<TriangleRaster>,
    mesh: &mut PeriodicTriangulation,
    width: usize,
    height: usize,
) -> &'c TriangleRaster {
    if cache
        .as_ref()
        .is_none_or(|p| p.width != width || p.height != height)
    {
        *cache = Some(triangle_raster(mesh, width, height));
    }
    cache.as_ref().unwrap()
}

/// A node field of the land on the world raster.
#[allow(clippy::too_many_arguments)]
pub fn land_raster<T: Copy + Into<f64>>(
    mesh: &mut PeriodicTriangulation,
    land: &LandClimate,
    field: &[T],
    pixel_land: &[u8],
    width: usize,
    height: usize,
    outside: f64,
    nearest: bool,
    plan: &TriangleRaster,
) -> Vec<f32> {
    rasterise_node_part(
        mesh,
        field,
        &land.land,
        Some(pixel_land),
        outside,
        width,
        height,
        nearest,
        Some(plan),
    )
}

/// A biome or a Köppen class per node on the world raster.
#[allow(clippy::too_many_arguments)]
pub fn id_raster(
    mesh: &mut PeriodicTriangulation,
    land: &LandClimate,
    ids: &[u8],
    pixel_land: &[u8],
    width: usize,
    height: usize,
    sea: f64,
    plan: &TriangleRaster,
) -> Vec<u8> {
    land_raster(mesh, land, ids, pixel_land, width, height, sea, true, plan)
        .iter()
        .map(|&v| v as u8)
        .collect()
}

/// The coast type per shore node on the raster's own shore pixels.
pub fn coast_type_raster(
    mesh: &mut PeriodicTriangulation,
    node_type: &[u8],
    elevation: &[f32],
    grid: &DomainGrid,
    plan: &TriangleRaster,
) -> Vec<u8> {
    let (width, height) = (grid.res_x, grid.res_y);
    let mut shore_pixel = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            let p = y * width + x;
            if elevation[p] as f64 <= SEA_LEVEL {
                continue;
            }
            'around: for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    if elevation[grid.neighbour(x as i64, y as i64, dx, dy)] as f64 <= SEA_LEVEL {
                        shore_pixel[p] = 1;
                        break 'around;
                    }
                }
            }
        }
    }
    let typed: Vec<u8> = node_type.iter().map(|&t| u8::from(t > 0)).collect();
    rasterise_node_part(
        mesh,
        node_type,
        &typed,
        Some(&shore_pixel),
        0.0,
        width,
        height,
        true,
        Some(plan),
    )
    .iter()
    .map(|&v| v as u8)
    .collect()
}

/// The largest of a node field over the land nodes in each cell of the
/// climate's chart.
pub fn chart_max_of_nodes(mesh: &PeriodicTriangulation, field: &[f32], z: &[f32]) -> Vec<f32> {
    let grid = mesh.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y);
    let mut out = vec![0f32; CLIMATE_RES_X * CLIMATE_RES_Y];
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 || z[v] as f64 <= SEA_LEVEL {
            continue;
        }
        let c = grid.cell_at(mesh.vx[v], mesh.vy[v]);
        if field[v] > out[c] {
            out[c] = field[v];
        }
    }
    out
}

/// The current fold-mountain belts.
pub fn collect_orogens(features: &[TerrainFeature]) -> Vec<(f64, f64)> {
    features
        .iter()
        .filter(|f| {
            f.kind == FeatureKind::Range
                && !f.volcanic.unwrap_or(false)
                && !f.subsides
                && f.thickness > 3.0
                && f.plate_b >= 0
        })
        .map(|f| (f.x, f.y))
        .collect()
}

/// The climate step's refinement and what is read of it.
pub struct RefinedStep<'a> {
    pub refined: RefinedClimate,
    pub terrain: ClimateTerrain<'a>,
    pub chart: RefinedClimateChart,
    pub cells: ClimateCells,
    pub annual: AnnualFields,
    pub annual_wind: Vec<f32>,
    pub mesh_wind: CellVectors,
    pub mesh_temperature: Vec<f64>,
}

pub fn refined_climate_of<'a>(
    sh: &mut SharedFieldMesh,
    elevation: &'a [f32],
    params: &WeatherParams,
    mesh_temperature: &[f64],
    mesh_wind: &CellVectors,
    restored: Option<RefinedClimate>,
) -> RefinedStep<'a> {
    let (width, height) = (
        sh.mesh.domain.width as usize,
        sh.mesh.domain.height as usize,
    );
    let r = restored
        .unwrap_or_else(|| refine_climate(sh, elevation, params, mesh_temperature, mesh_wind));
    let terrain = ClimateTerrain::new(sh, elevation, width, height, None);
    let chart = refined_chart(sh, &r, &terrain);
    let cells = climate_cells_from_refined(&r, &terrain);
    let n = CLIMATE_RES_X * CLIMATE_RES_Y;
    let annual = annual_from_months(chart.months, &chart.temperature, &chart.precipitation, n);
    let mut annual_wind = vec![0f32; n * 2];
    for m in 0..chart.months {
        for i in 0..n * 2 {
            annual_wind[i] = (annual_wind[i] as f64
                + chart.wind[m * n * 2 + i] as f64 / chart.months as f64)
                as f32;
        }
    }
    let mesh_wind = refined_annual_wind(&r);
    let mesh_annual = annual_from_months(r.months, &r.temperature, &r.precipitation, r.cells);
    RefinedStep {
        terrain,
        chart,
        cells,
        annual,
        annual_wind,
        mesh_wind,
        mesh_temperature: mesh_annual.temperature.iter().map(|&t| t as f64).collect(),
        refined: r,
    }
}

/// The hydrology on the mesh: the discharge and the lakes under the
/// climate at its nodes, and their raster recovery.
pub struct MeshHydrology {
    pub discharge: Vec<f32>,
    pub lakes: LakeFields,
    pub land: LandClimate,
    pub biome: Option<Vec<u8>>,
    pub ecology_biome: Option<Vec<u8>>,
    pub water_table: Option<Vec<f32>>,
    pub raster: RasterWaterFields,
}

/// What the hydrology reads of the terrain mesh.
pub struct MeshTerrainRef<'a> {
    pub z: &'a [f32],
    pub routing: &'a MeshRouting,
    pub areas: &'a [f32],
}

pub fn hydrology_on_mesh(
    mesh: &mut PeriodicTriangulation,
    t: &MeshTerrainRef<'_>,
    elevation_raster: &[f32],
    width: usize,
    height: usize,
    land: LandClimate,
) -> MeshHydrology {
    let (discharge, lakes) = {
        let sub = MeshSubstrate {
            mesh,
            routing: t.routing,
            areas: t.areas,
        };
        let discharge = accumulate_discharge_on(
            &sub,
            t.z,
            &land.climate.precipitation,
            Some(&land.climate.temperature),
        );
        let lakes = compute_lakes_on(
            &sub,
            &discharge,
            t.z,
            &land.climate.temperature,
            SURFACE_TUNING.min_lake_basin_relief_m,
        );
        (discharge, lakes)
    };
    let raster = water_fields_from_mesh(
        mesh,
        &lakes.body,
        &lakes.bodies,
        elevation_raster,
        width,
        height,
    );
    MeshHydrology {
        discharge,
        lakes,
        land,
        biome: None,
        ecology_biome: None,
        water_table: None,
        raster,
    }
}

/// The climate the hydrology starts from: its controls, its cells,
/// whether it is the step's refinement, and its climate at this mesh's
/// nodes when it has one.
pub struct HydrologyClimate<'a> {
    pub params: &'a WeatherParams,
    pub cells: &'a ClimateCells,
    pub refined: bool,
    pub land: Option<LandClimate>,
}

/// What the route calls with the climate v2: the mesh, the chain, its land
/// and the dry floors' raster.
pub type OnClimate<'c, 'a> =
    dyn FnMut(&mut PeriodicTriangulation, &ClimateChain<'a>, &LandClimate, &[u8]) + 'c;

/// The hydrology's route: the lakes and the discharge on the mesh, and
/// unless the climate is the refinement the climate v2 on the current
/// terrain with the hydrology once more under it. `on_climate` gets the v2
/// chain, its land and the dry floors' raster where TypeScript's callback
/// does, before the second hydrology (it may move the mesh's walk).
/// Returns the v2 chain when it ran.
#[allow(clippy::too_many_arguments)]
pub fn route_hydrology<'a>(
    sh: &mut SharedFieldMesh,
    mesh: &mut PeriodicTriangulation,
    t: &MeshTerrainRef<'_>,
    terrain: &'a [f32],
    elevation: &[f32],
    width: usize,
    height: usize,
    weather: HydrologyClimate<'_>,
    on_climate: &mut OnClimate<'_, 'a>,
) -> (MeshHydrology, Option<(ClimateChain<'a>, Vec<u8>)>) {
    let land = match weather.land {
        Some(l) => l,
        None => land_climate_of(sh, weather.cells, mesh, t.z, None),
    };
    let on_mesh = hydrology_on_mesh(mesh, t, elevation, width, height, land);
    if weather.refined {
        return (on_mesh, None);
    }
    let dry_raster = on_mesh.raster.dry_basin.clone();
    let chain = climate_chain(sh, terrain, weather.params, Some(dry_raster.clone()));
    let land = land_climate_of(sh, &chain.cells, mesh, t.z, Some(&on_mesh.lakes.dry_basin));
    on_climate(mesh, &chain, &land, &dry_raster);
    let on_mesh = hydrology_on_mesh(mesh, t, elevation, width, height, land);
    (on_mesh, Some((chain, dry_raster)))
}

pub struct HydrologyFeatures {
    pub graph: RiverGraph,
    pub coast: CoastGraph,
    pub sediment_basins: Vec<SedimentBasin>,
    pub oases: Vec<SpringFeature>,
    pub ice: Vec<f32>,
    pub precipitation_effective: Vec<f32>,
    pub watersheds: Vec<u16>,
    pub discharge: Vec<f32>,
    pub coast_type: Vec<u8>,
    pub biomes: Vec<u8>,
}

/// The hydrology's features on a route, per node, and their rasters; sets
/// the route's biomes and water table. `sim` is the world (the forcing's
/// hardness, the cratons, the world's age, the climate's mesh), `terrain`
/// the coupled terrain the mesh is (its column, its last epoch's ice and
/// start), `plan` the pixels' triangles of its mesh, made where a raster
/// is first drawn.
#[allow(clippy::too_many_arguments)]
pub fn hydrology_features(
    sim: &mut PlateSimulation,
    planet: Option<PlanetForcing>,
    terrain: &mut CoupledTerrain,
    om: &mut MeshHydrology,
    max_discharge: f64,
    threshold: f64,
    raster: &[f32],
    elevation: &[f32],
    dry_basin: Option<&[u8]>,
    cells: &ClimateCells,
    width: usize,
    height: usize,
    plan: &mut Option<TriangleRaster>,
) -> HydrologyFeatures {
    let domain = sim.domain.clone();
    let CoupledTerrain {
        mesh,
        z,
        routing,
        areas,
        sediment_flux,
        pre_erosion_z,
        column,
        ice: coupled_ice,
        ..
    } = terrain;
    let routing = routing
        .as_ref()
        .expect("the hydrology reads a routed terrain");
    let z: &[f32] = z;
    let pixel_land = pixel_land_of(raster, dry_basin);
    let land = &om.land;
    let points_dry = land.dry.clone();
    let slots = mesh.vertex_slots();

    let precip_eff = {
        let sub = MeshSubstrate {
            mesh,
            routing,
            areas,
        };
        riparian_precipitation_on(
            &sub,
            z,
            &om.discharge,
            threshold,
            max_discharge,
            &om.lakes.depth,
            Some(&om.lakes.frozen),
            &land.climate.precipitation,
        )
    };
    let mut node_biome = {
        let points = mesh_points(mesh, z, points_dry.as_deref());
        classify_points(&land.climate, &points, &domain, Some(&precip_eff)).biome
    };
    let precipitation_effective = {
        let p = triangles_of(plan, mesh, width, height);
        land_raster(
            mesh,
            land,
            &precip_eff,
            &pixel_land,
            width,
            height,
            OCEAN_PRECIP,
            false,
            p,
        )
    };
    for v in 0..node_biome.len() {
        if land.land[v] == 0 {
            continue;
        }
        if om.lakes.salt_flat[v] != 0 {
            node_biome[v] = biome::SALT_FLAT;
        }
        if om.lakes.frozen[v] != 0 {
            node_biome[v] = biome::GLACIER;
        }
    }
    let ecology_biome = node_biome.clone();
    let forcing = crate::pipeline::erosion_forcing::coarse_forcing_fields(sim, &sim.domain);
    let node_hardness =
        nearest_cell_at_nodes(&forcing.hardness, CLIMATE_RES_X, CLIMATE_RES_Y, mesh);
    let plants_from_ma = planet.unwrap_or(DEFAULT_PLANET_FORCING).land_plants_from_ma;
    let cover = cover_field(
        &land.biome,
        world_age_ma(sim.archean_epochs, sim.epoch) >= plants_from_ma,
    );
    let months = land.climate.months.as_ref().map(|m| ClimateMonths {
        temperature: &m.temperature,
        precipitation: &m.precipitation,
        count: m.count,
    });
    let (graph, ground) = {
        let sub = MeshSubstrate {
            mesh,
            routing,
            areas,
        };
        let regime = accumulate_regime_inputs_on(
            &sub,
            z,
            &land.climate.temperature,
            &land.climate.precipitation,
            Some(&land.climate.monsoon_index),
            months.as_ref(),
        );
        let critical = density_to_critical_area(CANONICAL_RIVER_DENSITY, &domain);
        let mut graph = build_river_graph(&RiverGraphInputs {
            substrate: &sub,
            discharge: &om.discharge,
            elevation: z,
            threshold,
            max_discharge,
            bodies: &om.lakes.bodies,
            body: &om.lakes.body,
            lake_depth: &om.lakes.depth,
            sediment_flux: (sediment_flux.len() == slots).then_some(&sediment_flux[..]),
            biomes: Some(&node_biome),
            regime: Some(&regime),
            critical_area: Some(critical),
        });
        let ground = compute_hydrogeology(
            &HydrogeologyInputs {
                sub: &sub,
                elevation: z,
                column: Some(column),
                hardness: Some(&node_hardness),
                precipitation: &land.climate.precipitation,
                temperature: &land.climate.temperature,
                monsoon_index: Some(&land.climate.monsoon_index),
                cover: &cover,
                regime: &regime,
                discharge: &om.discharge,
                cell_m: domain.metres_around / width as f64,
            },
            &mut graph,
        );
        (graph, ground)
    };
    om.water_table = Some(ground.water_table_depth_m.clone());
    let oases: Vec<SpringFeature> = ground.springs.iter().filter(|s| s.oasis).cloned().collect();
    let mut graph = graph;
    graph.courses = Some(compute_river_courses(
        &graph,
        &RiverCourseOptions {
            cell_m: domain.metres_around / width as f64,
            seed: sim.warp_seed as u32,
            domain: &domain,
            min_width_m: None,
            max_points_per_reach: None,
            steps: None,
        },
    ));
    let windy = {
        let points = mesh_points(mesh, z, points_dry.as_deref());
        climate_at_points(&mut sim.meshes.shared, cells, &points, true)
    };
    let coast = build_coast_graph(
        mesh,
        &CoastGraphInputs {
            z,
            wind_e: windy.wind_e.as_ref().unwrap(),
            wind_s: windy.wind_s.as_ref().unwrap(),
            hardness: Some(&node_hardness),
            graph: Some(&graph),
        },
    );
    let sediment_basins = if pre_erosion_z.len() == z.len() {
        let craton = compute_craton_oldness_field(
            &sim.rafts,
            world_epoch(sim.archean_epochs, sim.epoch),
            sim.archean_epochs,
            CLIMATE_RES_X,
            CLIMATE_RES_Y,
            &sim.domain,
        );
        let craton_nodes = nearest_cell_at_nodes(&craton, CLIMATE_RES_X, CLIMATE_RES_Y, mesh);
        let sub = MeshSubstrate {
            mesh,
            routing,
            areas,
        };
        find_sediment_basins(&SedimentBasinInputs {
            mesh,
            before: pre_erosion_z,
            after: z,
            substrate: &sub,
            graph: Some(&graph),
            craton_age: Some(&craton_nodes),
            hardness: Some(&node_hardness),
        })
        .basins
    } else {
        Vec::new()
    };
    let shed = {
        let sub = MeshSubstrate {
            mesh,
            routing,
            areas,
        };
        watersheds_on(&sub, z, 12_168.0)
    };
    let watersheds: Vec<u16> = {
        let p = triangles_of(plan, mesh, width, height);
        land_raster(mesh, land, &shed, &pixel_land, width, height, 0.0, true, p)
            .iter()
            .map(|&v| v as u16)
            .collect()
    };
    let discharge = {
        let p = triangles_of(plan, mesh, width, height);
        land_raster(
            mesh,
            land,
            &om.discharge,
            &pixel_land,
            width,
            height,
            0.0,
            true,
            p,
        )
    };
    let coast_type = {
        let grid = sim.domain.grid(width, height);
        let p = triangles_of(plan, mesh, width, height);
        coast_type_raster(mesh, &coast.coast_type, elevation, &grid, p)
    };
    let node_ice = if coupled_ice.len() == slots {
        coupled_ice.clone()
    } else {
        compute_ice_on_mesh(
            mesh,
            &MeshIceInputs {
                z,
                sea_level_temperature: &land.climate.sea_level_temperature,
                precipitation: &land.climate.precipitation,
                seasonal_amplitude: &land.climate.seasonal_amplitude,
                cell_m: domain.metres_per_unit,
            },
        )
        .thickness
    };
    mark_subglacial(&mut om.lakes, &node_ice, areas);
    let mut ice = rasterise_node_field(mesh, &node_ice, width, height);
    for c in 0..ice.len() {
        if elevation[c] <= 0.0 || (ice[c] as f64) < SURFACE_TUNING.ice_min_thickness_m {
            ice[c] = 0.0;
        }
    }
    for v in 0..node_biome.len() {
        if land.land[v] != 0
            && z[v] as f64 > SEA_LEVEL
            && node_ice[v] as f64 >= SURFACE_TUNING.ice_min_thickness_m
        {
            node_biome[v] = biome::GLACIER;
        }
    }
    let biomes = {
        let p = triangles_of(plan, mesh, width, height);
        id_raster(
            mesh,
            land,
            &node_biome,
            &pixel_land,
            width,
            height,
            biome::OCEAN as f64,
            p,
        )
    };
    om.ecology_biome = Some(ecology_biome);
    om.biome = Some(node_biome);
    HydrologyFeatures {
        graph,
        coast,
        sediment_basins,
        oases,
        ice,
        precipitation_effective,
        watersheds,
        discharge,
        coast_type,
        biomes,
    }
}

/// The lake depths per node with frozen basins zeroed.
pub fn liquid_lake_depth(lakes: &LakeFields) -> Vec<f32> {
    lakes
        .depth
        .iter()
        .zip(&lakes.frozen)
        .map(|(&d, &f)| if f != 0 { 0.0 } else { d })
        .collect()
}

/// The ecology's inputs that are made here: the liquid lakes, the
/// volcanoes, the collision belts, the oases and the cratons' age at the
/// nodes. `EcologyWorldInputs::inputs` adds the rest.
pub struct EcologyWorldInputs {
    pub lake_depth: Option<Vec<f32>>,
    pub volcanoes: Vec<Volcano>,
    pub orogen_points: Vec<(f64, f64)>,
    pub oases: Vec<(f64, f64)>,
    pub craton_age: Vec<f32>,
    pub warp_seed: u32,
    pub max_discharge: f64,
}

pub fn ecology_inputs_of(
    sim: &PlateSimulation,
    mesh: &PeriodicTriangulation,
    om: Option<&MeshHydrology>,
    hydrology: Option<(f64, &[SpringFeature])>,
) -> EcologyWorldInputs {
    let craton = compute_craton_oldness_field(
        &sim.rafts,
        world_epoch(sim.archean_epochs, sim.epoch),
        sim.archean_epochs,
        CLIMATE_RES_X,
        CLIMATE_RES_Y,
        &sim.domain,
    );
    let mut orogen_points = collect_orogens(&sim.features);
    orogen_points.extend(sim.sutures.iter().map(|s| (s.x, s.y)));
    EcologyWorldInputs {
        lake_depth: om.map(|o| liquid_lake_depth(&o.lakes)),
        volcanoes: ecology_volcanoes(&sim.features),
        orogen_points,
        oases: hydrology.map_or_else(Vec::new, |(_, o)| o.iter().map(|s| (s.x, s.y)).collect()),
        craton_age: land_bilinear_at_nodes(
            &craton,
            &sim.domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y),
            mesh,
        ),
        warp_seed: sim.warp_seed as u32,
        max_discharge: hydrology.map_or(0.0, |(m, _)| m),
    }
}

impl EcologyWorldInputs {
    /// The step's inputs on the terrain's heights and the climate at its
    /// nodes (the hydrology's when it ran on this mesh).
    pub fn inputs<'a>(
        &'a self,
        z: &'a [f32],
        land: &'a LandClimate,
        om: Option<&'a MeshHydrology>,
    ) -> EcologyInputs<'a> {
        EcologyInputs {
            z,
            land: &land.land,
            climate: &land.climate,
            biomes: om
                .and_then(|o| o.ecology_biome.as_deref())
                .unwrap_or(&land.biome),
            discharge: om.map(|o| &o.discharge[..]),
            max_discharge: self.max_discharge,
            lake_depth: self.lake_depth.as_deref(),
            salt_flat: om.map(|o| &o.lakes.salt_flat[..]),
            water_table: om.and_then(|o| o.water_table.as_deref()),
            oases: &self.oases,
            volcanoes: &self.volcanoes,
            orogen_points: &self.orogen_points,
            craton_age: &self.craton_age,
            warp_seed: self.warp_seed,
        }
    }
}

/// The hydrology's channel criterion.
pub fn hydrology_threshold(domain: &Domain, mean_runoff: f64) -> f64 {
    channel_threshold(
        density_to_critical_area(CANONICAL_RIVER_DENSITY, domain),
        mean_runoff,
    )
}

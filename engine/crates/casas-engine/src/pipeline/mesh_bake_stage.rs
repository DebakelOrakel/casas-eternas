//! `pipeline/meshBakeStage.ts`: the global bake of one level — the save's
//! mesh refined to the level's budget, eroded for a short transient with
//! the bake's policy (no uplift, the coastline pinned to the parent's),
//! and the level's waters derived on it. The TypeScript port
//! (`client/src/generator/pipeline/meshBakeStage.ts`, git history) explains
//! the policy. The progress callback is not ported yet: the boundary to
//! TypeScript adds it.

use crate::climate::climate_points::{
    ClimateCellValues, climate_at_points, climate_cells_from_saved, mean_land_runoff, mesh_points,
};
use crate::core::det_math::det_pow;
use crate::core::domain::Domain;
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::fields::field_mesh::SharedFieldMesh;
use crate::mesh::mesh_erosion::{MeshErosionOptions, MeshPipeline, MeshRouting, run_mesh_erosion};
use crate::mesh::mesh_hydrology::{MeshSubstrate, mesh_areas};
use crate::mesh::mesh_refine::{RefineLevelOptions, refine_mesh_level};
use crate::mesh::mesh_sampler::create_mesh_sampler;
use crate::mesh::mesh_serial::{SerializedMesh, decode_mesh};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use crate::surface::amplify::BAKE_ENGINE_OVERRIDES;
use crate::surface::erosion_engine::ErosionSolverParams;
use crate::surface::erosion_forcing_fields::{
    CoarseForcingInputs, ErosionControls, assemble_node_forcing,
};
use crate::surface::hydrology::{
    CANONICAL_RIVER_DENSITY, WaterBody, accumulate_discharge_on, accumulate_regime_inputs_on,
    channel_threshold, compute_lakes_on, density_to_critical_area, max_discharge_over_land,
};
use crate::surface::river_course::{RiverCourseOptions, compute_river_courses};
use crate::surface::river_graph::{
    RiverGraph, RiverGraphInputs, RiverPolylines, build_river_graph, river_polylines_from_graph,
};
use crate::surface::surface_tune_params::SURFACE_TUNING;

pub struct MeshBakeInputs<'a> {
    /// The save's mesh and its heights.
    pub mesh: &'a SerializedMesh,
    pub z: &'a [f32],
    pub width: usize,
    pub height: usize,
    pub detail_seed: u32,
    pub litho_seed: u32,
    pub controls: ErosionControls,
    pub uplift: Option<&'a [f32]>,
    pub erodibility: Option<&'a [f32]>,
    pub forcing_res_x: usize,
    pub forcing_res_y: usize,
    /// The save's climate per cell of its field mesh; None: uniform water
    /// and no hydrology.
    pub climate: Option<&'a ClimateCellValues>,
}

#[derive(Clone, Copy, Debug)]
pub struct MeshBakeOptions {
    pub level: u32,
    pub budget: f64,
    pub rounds: u32,
    pub pool: Option<MeshPipeline>,
}

pub struct MeshLevel {
    pub level: u32,
    pub mesh: PeriodicTriangulation,
    pub z: Vec<f32>,
    pub routing: MeshRouting,
    pub discharge: Vec<f32>,
    pub water_bodies: Vec<WaterBody>,
    pub graph: Option<RiverGraph>,
    pub rivers: Option<RiverPolylines>,
    pub inserted: usize,
}

/// The level's budget by its number: 4 at level 0, each level a quarter of
/// the one before.
pub fn level_budget(level: u32) -> f64 {
    4.0 / det_pow(4.0, level as f64)
}

/// The bake of one level. `climate_mesh` is the world's climate field
/// mesh (`climateMesh` in TypeScript, which keeps it per domain).
pub fn bake_mesh_level(
    inputs: &MeshBakeInputs<'_>,
    options: &MeshBakeOptions,
    climate_mesh: &mut SharedFieldMesh,
) -> Result<MeshLevel, String> {
    let (width, height) = (inputs.width, inputs.height);
    let domain = Domain::torus(width as f64, height as f64);
    let parent = decode_mesh(&domain, inputs.mesh)?;
    // The coastline the level keeps: the parent's, sampled where each node
    // stands.
    let mut parent_sampler =
        create_mesh_sampler(decode_mesh(&domain, inputs.mesh)?, inputs.z, None);
    let refined = refine_mesh_level(
        parent,
        inputs.z,
        &RefineLevelOptions {
            budget: options.budget,
            seed: inputs.detail_seed,
            level: options.level,
            width,
            height,
            max_rounds: None,
        },
    );
    let mut mesh = refined.mesh;
    let areas = mesh_areas(&mut mesh);
    let cells = match inputs.climate {
        Some(c) => Some(climate_cells_from_saved(climate_mesh, c.clone())?),
        None => None,
    };
    let water_nodes = cells.as_ref().map(|cells| {
        climate_at_points(
            climate_mesh,
            cells,
            &mesh_points(&mesh, &refined.z, None),
            false,
        )
        .precipitation
    });
    let coarse = CoarseForcingInputs {
        uplift: inputs.uplift,
        hardness: inputs.erodibility,
        forcing_res_x: inputs.forcing_res_x.max(1),
        forcing_res_y: inputs.forcing_res_y.max(1),
        water: None,
        water_res_x: 1,
        water_res_y: 1,
        water_nodes: water_nodes.as_deref(),
        litho_seed: inputs.litho_seed,
    };
    let slots = mesh.vertex_slots();
    let assembled = assemble_node_forcing(
        &coarse,
        &mesh.vx,
        &mesh.vy,
        &mesh.v_alive,
        slots,
        &refined.z,
        &areas,
        &domain,
        &inputs.controls,
        None,
    );
    // Every node pinned to the parent surface's land/sea status where it
    // stands.
    let mut status_mask = vec![0u8; slots];
    for (v, s) in status_mask.iter_mut().enumerate() {
        if mesh.v_alive[v] != 0 {
            *s = if parent_sampler.height_at(mesh.vx[v], mesh.vy[v]) > SEA_LEVEL {
                1
            } else {
                2
            };
        }
    }
    let mut forcing = assembled.forcing();
    forcing.status_mask = Some(&status_mask);
    let params = ErosionSolverParams {
        uplift_dt: BAKE_ENGINE_OVERRIDES.uplift_dt,
        ..assembled.params
    };
    let result = run_mesh_erosion(
        &mut mesh,
        &refined.z,
        &forcing,
        &MeshErosionOptions {
            age: options.rounds,
            routing_every: None,
            params: Some(params),
            pool: options.pool,
            frozen: None,
        },
    );
    let z = result.z;
    let water = match &cells {
        Some(cells) => {
            let at = climate_at_points(climate_mesh, cells, &mesh_points(&mesh, &z, None), false);
            let climate = LevelClimate {
                precipitation: &at.precipitation,
                temperature: &at.temperature,
                monsoon_index: Some(&at.monsoon_index),
                mean_runoff: mean_land_runoff(climate_mesh, cells),
            };
            let w = level_hydrology(
                &mesh,
                &z,
                &result.routing,
                &areas,
                &result.sediment_flux,
                &climate,
                &LevelSpec {
                    width,
                    budget: options.budget,
                    detail_seed: inputs.detail_seed,
                },
            );
            (w.discharge, w.water_bodies, Some(w.graph), Some(w.rivers))
        }
        None => (vec![0f32; slots], Vec::new(), None, None),
    };
    Ok(MeshLevel {
        level: options.level,
        mesh,
        z,
        routing: result.routing,
        discharge: water.0,
        water_bodies: water.1,
        graph: water.2,
        rivers: water.3,
        inserted: refined.inserted,
    })
}

/// The climate a level's waters are derived from, per node of the level,
/// and the world's mean land rain.
pub struct LevelClimate<'a> {
    pub precipitation: &'a [f32],
    pub temperature: &'a [f32],
    pub monsoon_index: Option<&'a [f32]>,
    pub mean_runoff: f64,
}

/// What `level_hydrology` reads of the level.
#[derive(Clone, Copy, Debug)]
pub struct LevelSpec {
    /// The world's width in cells.
    pub width: usize,
    pub budget: f64,
    pub detail_seed: u32,
}

pub struct LevelWaters {
    pub discharge: Vec<f32>,
    pub water_bodies: Vec<WaterBody>,
    pub graph: RiverGraph,
    pub rivers: RiverPolylines,
}

/// A level's waters from its terrain: the discharge, the lakes, the
/// channel criterion and the river graph with its courses.
pub fn level_hydrology(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    routing: &MeshRouting,
    areas: &[f32],
    sediment_flux: &[f32],
    climate: &LevelClimate<'_>,
    level: &LevelSpec,
) -> LevelWaters {
    let sub = MeshSubstrate {
        mesh,
        routing,
        areas,
    };
    let discharge =
        accumulate_discharge_on(&sub, z, climate.precipitation, Some(climate.temperature));
    let lakes = compute_lakes_on(
        &sub,
        &discharge,
        z,
        climate.temperature,
        SURFACE_TUNING.min_lake_basin_relief_m,
    );
    let critical = density_to_critical_area(CANONICAL_RIVER_DENSITY, &mesh.domain);
    let threshold = channel_threshold(critical, climate.mean_runoff);
    let max_discharge = max_discharge_over_land(&discharge, z);
    let regime = accumulate_regime_inputs_on(
        &sub,
        z,
        climate.temperature,
        climate.precipitation,
        climate.monsoon_index,
        None,
    );
    let mut graph = build_river_graph(&RiverGraphInputs {
        substrate: &sub,
        discharge: &discharge,
        elevation: z,
        threshold,
        max_discharge,
        bodies: &lakes.bodies,
        body: &lakes.body,
        lake_depth: &lakes.depth,
        sediment_flux: Some(sediment_flux),
        biomes: None,
        regime: Some(&regime),
        critical_area: Some(critical),
    });
    graph.courses = Some(compute_river_courses(
        &graph,
        &RiverCourseOptions {
            cell_m: (mesh.domain.metres_around / level.width as f64) * level.budget,
            seed: level.detail_seed,
            domain: &mesh.domain,
            min_width_m: None,
            max_points_per_reach: None,
            steps: None,
        },
    ));
    let rivers = river_polylines_from_graph(&graph, max_discharge, None);
    LevelWaters {
        discharge,
        water_bodies: lakes.bodies,
        graph,
        rivers,
    }
}

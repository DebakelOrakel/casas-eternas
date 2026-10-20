//! `pipeline/coupledEpoch.ts`: the coupled epoch — erosion inside every
//! tectonic epoch, on the mesh, whose nodes move with their plates. Per
//! epoch: plate membership, the tectonic step, the motion, the rebuild and
//! the remesh, the baseline swap, the epoch's climate, the ice, the cover,
//! the forcing with the folds and the force balances, the erosion and the
//! column's ledger, the coast, the flexure, the sea level, the routing on
//! the terrain as the epoch leaves it and the lakes' ages. The TypeScript
//! file explains every step and its measurements.
//!
//! Not ported: the phases' timing (a clock is not portable to the WASM
//! build), the pool's worker factory (`leaf_workers` names the TypeScript
//! pool's stencil workers, whose grouping the solver's tallies follow), and
//! the reuse of the epoch's engine index for its last routing (time only).

use crate::climate::biomes::classify_points;
use crate::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use crate::climate::climate_mesh::ClimateTerrain;
use crate::climate::climate_points::{
    ClimatePoints, climate_at_points, climate_cells_from_weather, mesh_points,
};
use crate::climate::weather::{
    WeatherMesh, WeatherParams, compute_weather, default_weather_params,
};
use crate::core::det_math::{det_exp, det_pow};
use crate::core::domain::Domain;
use crate::core::js;
use crate::core::world_time::{TECTONIC_MA_PER_EPOCH, world_age_ma, world_epoch};
use crate::crust::raft_field::{
    BlobIndex, build_blob_index, compute_craton_oldness_field, raft_field_indexed,
};
use crate::crust::raft_lifecycle::{RAFT_CARRY_REACH, carrier_plate_at, raft_host_plates};
use crate::crust::raft_types::Raft;
use crate::elevation::dynamic_topography::dynamic_topography_at;
use crate::elevation::elevation_field::{
    BaselineTerm, build_feature_buckets, raft_baseline_at, uplift_deck_at, warped_sample_point,
};
use crate::elevation::elevation_sampler::{SynthesisSources, synthesis_sampler};
use crate::elevation::elevation_scale::{ELEVATION_METERS, margin_parameter};
use crate::fields::field_mesh::SharedFieldMesh;
use crate::fields::field_operators::{SolveOptions, smooth_gaussian};
use crate::mantle::mantle_field::MantleMesh;
use crate::mesh::mesh_build::{DensityTarget, MESH_Z, build_mesh, triangulate_points};
use crate::mesh::mesh_column::{
    COLUMN_DEPTH, MESH_COLUMN, SedimentColumn, add_column_field, column_volume_m3, create_column,
    cut, decode_column, deposit, encode_column, erodibility_over, open_layer, permute_column,
};
use crate::mesh::mesh_density::MESH_TUNING;
use crate::mesh::mesh_erosion::{MeshErosionOptions, MeshPipeline, MeshRouting, run_mesh_erosion};
use crate::mesh::mesh_hydrology::{MeshSubstrate, mesh_routing};
use crate::mesh::mesh_neighbourhood::{mean_within, mesh_star, neighbourhoods};
use crate::mesh::mesh_raster::rasterise_node_field;
use crate::mesh::mesh_serial::{SerializedMesh, compact_mesh, decode_mesh, encode_mesh, permute};
use crate::mesh::mesh_state::{FieldKind, MeshState};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use crate::mesh::remesh::{RefineOptions, coarsen, refine};
use crate::planet::planet_forcing::DEFAULT_PLANET_FORCING;
use crate::surface::coastal::{CoastalInputs, compute_coastal};
use crate::surface::cover::{COVER_TUNING, cover_field};
use crate::surface::erosion_engine::{ErosionForcing, ITERATION_YEARS};
use crate::surface::erosion_forcing_fields::{
    CoarseForcingInputs, ErosionControls, assemble_node_forcing, erosion_litho_seed,
    scale_engine_params_for_dt, upsample_at,
};
use crate::surface::glacial::{MeshIceInputs, compute_ice_on_mesh, glacial_erosion_on_mesh};
use crate::surface::hydrology::{WaterKind, accumulate_discharge_on, compute_lakes_on};
use crate::surface::surface_tune_params::SURFACE_TUNING;
use crate::tectonics::flexure::{
    elastic_thickness_km, flexural_response, flexural_rigidity_m4, node_load_spreader,
};
use crate::tectonics::folds::fold_factor_at;
use crate::tectonics::ocean_age::ocean_age_at;
use crate::tectonics::plate_motion::advance_point_by_motion;
use crate::tectonics::plate_simulation::step_epoch_coupled;
use crate::tectonics::plate_simulation_types::{
    ClimateEpochRecord, LakeAgeRecord, PlateSimulation, SimEvent,
};
use crate::tectonics::tectonics_tune_params::TECTONICS_TUNING;
use crate::tectonics::trench::trench_depression;

use super::erosion_forcing::coarse_forcing_fields;

/// The epoch's weather, kept for the epochs between two climate runs.
pub struct EpochWeather {
    pub epoch: f64,
    pub params: WeatherParams,
    pub terrain: ClimateTerrain<'static>,
    pub mesh: WeatherMesh,
}

/// The terrain of the history (`CoupledTerrain` in TypeScript, which
/// explains each field).
pub struct CoupledTerrain {
    pub mesh: PeriodicTriangulation,
    pub z: Vec<f32>,
    pub baseline: Vec<f32>,
    pub routing: Option<MeshRouting>,
    pub areas: Vec<f32>,
    pub sediment_flux: Vec<f32>,
    pub weather: Option<EpochWeather>,
    pub pre_erosion_z: Vec<f32>,
    pub column: SedimentColumn,
    pub ice: Vec<f32>,
}

/// The ice's density, kg/m³.
const ICE_DENSITY: f64 = 917.0;
const MESH_ICE: &str = "ice";

/// The ice's part of an epoch's load change at a node, metres of rock.
pub fn ice_load_change_m(ice_now_m: f64, ice_previous_m: f64) -> f64 {
    (ice_now_m - ice_previous_m) * (ICE_DENSITY / TECTONICS_TUNING.flexure_crust_density)
}

/// The epoch's options (`CoupledEpochOptions` in TypeScript).
#[derive(Clone, Copy, Debug)]
pub struct CoupledEpochOptions {
    pub weather: Option<WeatherParams>,
    pub iterations_per_epoch: u32,
    pub budget: Option<f64>,
    pub climate_every: Option<f64>,
    pub remesh_every: Option<f64>,
    pub uplift_scale: Option<f64>,
    pub controls: ErosionControls,
    /// The TypeScript pool's stencil workers when the epoch runs on the
    /// pool's scheme, None for the single solver.
    pub leaf_workers: Option<usize>,
}

/// The history's interim setting (`HISTORY_DEFAULTS`).
pub struct HistoryDefaults {
    pub iterations_per_epoch: u32,
    pub budget: f64,
    pub uplift_scale: f64,
    pub climate_every: f64,
    pub remesh_every: f64,
    pub render_every: f64,
    pub routing_every: u32,
}

pub const HISTORY_DEFAULTS: HistoryDefaults = HistoryDefaults {
    iterations_per_epoch: 4,
    budget: 4.0,
    uplift_scale: 1.0,
    climate_every: 3.0,
    remesh_every: 3.0,
    render_every: 3.0,
    routing_every: 1,
};

const CLIMATE_HISTORY_CAP: usize = 512;
const LAKE_MATCH_M: f64 = 46_800.0;
const LAKE_MATCH_LEVEL_M: f64 = 300.0;

/// What an epoch did (`CoupledEpochStats` in TypeScript, less its timing).
#[derive(Clone, Debug)]
pub struct CoupledEpochStats {
    pub deposited_m3: f64,
    pub re_eroded_m3: f64,
    pub ice_coast_column_m3: f64,
    pub column_volume_m3: f64,
    pub rebound_max_m: f64,
    pub subsidence_max_m: f64,
    pub mean_land_temp_c: f64,
    pub ice_volume_km3: f64,
    pub sea_level_m: f64,
    pub lakes: usize,
    pub oldest_lake_ma: f64,
    pub mean_land_cover: f64,
    pub scree_m3: f64,
    pub solifluction_share: f64,
    pub folded_share: f64,
    pub ice_area_share: f64,
    pub glacial_cut_m3: f64,
    pub till_m3: f64,
    pub ela_mean_m: f64,
    pub shore_nodes: usize,
    pub coast_cut_m3: f64,
    pub coast_deposit_m3: f64,
    pub coast_export_m3: f64,
    pub ice_load_m3: f64,
    pub ice_weight_m3: f64,
    pub uplift_load_m3: f64,
    pub events: Vec<SimEvent>,
    pub nodes_before: usize,
    pub nodes_after: usize,
    pub removed: usize,
    pub inserted: usize,
    pub land_cells: f64,
    pub land_volume: f64,
    pub eroded_flux_m3: f64,
    pub exported_flux_m3: f64,
}

/// The parts of a simulation the baseline reads.
struct BaselineParts<'a> {
    rafts: &'a [Raft],
    ocean_age: &'a [f64],
    mantle: &'a [f64],
    domain: &'a Domain,
    warp_seed: f64,
}

/// The baseline before the sea level.
#[allow(clippy::too_many_arguments)]
fn solid_baseline_at(
    p: &BaselineParts,
    shared: &mut SharedFieldMesh,
    mantle: &mut MantleMesh,
    x: f64,
    y: f64,
    blobs: &BlobIndex,
    trench: Option<BaselineTerm>,
) -> f64 {
    raft_baseline_at(
        x,
        y,
        p.rafts,
        Some((shared, p.ocean_age)),
        p.domain,
        p.warp_seed,
        Some(blobs),
        trench,
    ) + dynamic_topography_at(p.mantle, &mantle.sampler, &mut mantle.mesh, x, y)
}

fn epoch_ma_of(sim: &PlateSimulation) -> f64 {
    if sim.epoch_ma == 0.0 || sim.epoch_ma.is_nan() {
        TECTONIC_MA_PER_EPOCH
    } else {
        sim.epoch_ma
    }
}

/// The craton oldness on the climate's chart, the sea's −1 as 0.
fn craton_field(sim: &PlateSimulation, domain: &Domain) -> Vec<f32> {
    let mut craton = compute_craton_oldness_field(
        &sim.rafts,
        world_epoch(sim.archean_epochs, sim.epoch),
        sim.archean_epochs,
        CLIMATE_RES_X,
        CLIMATE_RES_Y,
        domain,
    );
    for c in craton.iter_mut() {
        if *c < 0.0 {
            *c = 0.0;
        }
    }
    craton
}

/// The plate's rigidity per cell of the flexure's mesh (the shared one).
fn plate_rigidity(
    sim: &mut PlateSimulation,
    domain: &Domain,
    blobs_rafts: &[Raft],
    craton: &[f32],
) -> Vec<f64> {
    let blobs = build_blob_index(blobs_rafts, domain, 1.0);
    let climate_grid = domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y);
    let epoch_ma = epoch_ma_of(sim);
    let shared = &mut sim.meshes.shared;
    let n = shared.mesh.count;
    let mut rigidity = vec![0.0; n];
    for c in 0..n {
        let (x, y) = (shared.mesh.x[c], shared.mesh.y[c]);
        let continental = raft_field_indexed(x, y, &blobs) > 0.5;
        let oldness = upsample_at(craton, &climate_grid, x, y);
        let age_ma = ocean_age_at(shared, &sim.ocean_age, x, y) * epoch_ma;
        rigidity[c] = flexural_rigidity_m4(elastic_thickness_km(continental, oldness, age_ma));
    }
    rigidity
}

/// The plate's deflection under the synthesis's uplift deck, metres per
/// cell of the shared mesh; None without features.
fn deck_deflection(sim: &mut PlateSimulation) -> Option<Vec<f64>> {
    if sim.features.is_empty() {
        return None;
    }
    let domain = sim.domain.clone();
    let buckets = build_feature_buckets(&sim.features, &domain);
    let mut near = Vec::new();
    let n = sim.meshes.shared.mesh.count;
    let mut load_m = vec![0.0; n];
    for c in 0..n {
        let fm = &sim.meshes.shared.mesh;
        let w = warped_sample_point(fm.x[c], fm.y[c], &domain, sim.warp_seed);
        load_m[c] =
            js::max(0.0, uplift_deck_at(w.x, w.y, &buckets, &domain, &mut near)) * ELEVATION_METERS;
    }
    drop(buckets);
    let craton = craton_field(sim, &domain);
    let rafts = sim.rafts.clone();
    let rigidity = plate_rigidity(sim, &domain, &rafts, &craton);
    let mut w = vec![0.0; n];
    flexural_response(
        &sim.meshes.shared.mesh,
        &load_m,
        &rigidity,
        &mut w,
        SolveOptions::default(),
    );
    Some(w)
}

fn mesh_areas_of(mesh: &mut PeriodicTriangulation) -> Vec<f32> {
    (0..mesh.vertex_slots())
        .map(|v| {
            if mesh.v_alive[v] != 0 {
                mesh.voronoi_area(v) as f32
            } else {
                0.0
            }
        })
        .collect()
}

/// The baselines of every node of `mesh` with the sea level.
fn baselines(sim: &mut PlateSimulation, mesh: &PeriodicTriangulation) -> Vec<f32> {
    let domain = sim.domain.clone();
    let blobs = build_blob_index(&sim.rafts, &domain, 1.0);
    let trench = trench_depression(&sim.seeds, &sim.motions, &sim.ages, &sim.rafts, &domain);
    let trench_ref = trench.as_ref().map(|f| f as BaselineTerm);
    let parts = BaselineParts {
        rafts: &sim.rafts,
        ocean_age: &sim.ocean_age,
        mantle: &sim.mantle,
        domain: &domain,
        warp_seed: sim.warp_seed,
    };
    let sea = sim.eustatic_m / ELEVATION_METERS;
    (0..mesh.vertex_slots())
        .map(|v| {
            (solid_baseline_at(
                &parts,
                &mut sim.meshes.shared,
                &mut sim.meshes.mantle,
                mesh.vx[v],
                mesh.vy[v],
                &blobs,
                trench_ref,
            ) - sea) as f32
        })
        .collect()
}

/// The terrain at the start of the history: the mesh from the synthesis,
/// the baseline at every node.
pub fn create_coupled_terrain(sim: &mut PlateSimulation, budget: f64) -> CoupledTerrain {
    let deflection = deck_deflection(sim);
    let domain = sim.domain.clone();
    let built = {
        let sampler = synthesis_sampler(
            SynthesisSources {
                domain: &domain,
                rafts: &sim.rafts,
                features: &sim.features,
                ocean_age: &sim.ocean_age,
                mantle: &sim.mantle,
                warp_seed: sim.warp_seed,
            },
            &mut sim.meshes.shared,
            &mut sim.meshes.mantle,
            deflection.as_deref(),
        );
        build_mesh(&domain, &sampler, js::to_uint32(sim.warp_seed), budget, 24)
    };
    let (mut mesh, order) = compact_mesh(&built.mesh);
    let z = permute(built.state.get(MESH_Z), &order);
    let baseline = baselines(sim, &mesh);
    let areas = mesh_areas_of(&mut mesh);
    let slots = mesh.vertex_slots();
    CoupledTerrain {
        mesh,
        pre_erosion_z: z.clone(),
        z,
        baseline,
        routing: None,
        areas,
        sediment_flux: Vec::new(),
        weather: None,
        column: create_column(slots),
        ice: Vec::new(),
    }
}

/// The plateau's force balance: the regional mean land height per cell of
/// the shared mesh (the factor is 1 − h̄ / H at a point).
fn collapse_mean(
    shared: &mut SharedFieldMesh,
    mesh: &PeriodicTriangulation,
    z: &[f32],
    areas: &[f32],
) -> Vec<f64> {
    let n = shared.mesh.count;
    let mut sum = vec![0.0; n];
    let mut weight = vec![0.0; n];
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let h_m = js::max(0.0, z[v] as f64) * ELEVATION_METERS;
        let taps = shared
            .sampler
            .taps(&mut shared.mesh, mesh.vx[v], mesh.vy[v]);
        for k in 0..3 {
            let w = taps.weights[k] * areas[v] as f64;
            sum[taps.corners[k]] += w * h_m;
            weight[taps.corners[k]] += w;
        }
    }
    for c in 0..n {
        sum[c] = if weight[c] > 0.0 {
            sum[c] / weight[c]
        } else {
            0.0
        };
    }
    smooth_gaussian(&shared.mesh, &sum, TECTONICS_TUNING.collapse_smoothing_m)
}

/// The land's mean height within the wedge's radius of every node `rising`
/// admits, metres.
fn column_mean_height(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    rising: &[u8],
    unit_m: f64,
) -> Vec<f32> {
    let height_m: Vec<f32> = (0..mesh.vertex_slots())
        .map(|v| {
            if mesh.v_alive[v] != 0 {
                (js::max(0.0, z[v] as f64) * ELEVATION_METERS) as f32
            } else {
                0.0
            }
        })
        .collect();
    let star = mesh_star(mesh, unit_m);
    let nb = neighbourhoods(&star, mesh, TECTONICS_TUNING.wedge_radius_m, Some(rising));
    mean_within(&nb, &height_m)
}

/// The column's factor on a node's thickening over the epoch.
fn column_factor(h0: f64, d: f64) -> f64 {
    let h = TECTONICS_TUNING.wedge_height_m;
    if h0 >= h {
        return 0.0;
    }
    if d <= 1e-6 * h {
        return 1.0 - h0 / h;
    }
    ((h - h0) * (1.0 - det_exp(-d / h))) / d
}

/// Whether the epoch numbered `epoch` computes its climate.
pub fn climate_due_at(
    epoch: f64,
    cached: Option<&EpochWeather>,
    params: &WeatherParams,
    climate_every: f64,
) -> bool {
    match cached {
        None => true,
        Some(c) => c.params != *params || epoch - c.epoch >= climate_every,
    }
}

/// One epoch: tectonics, motion, rebuild and remesh, baseline swap,
/// climate, ice, erosion, coast, flexure, sea level, lakes.
pub fn step_coupled_epoch(
    sim: &mut PlateSimulation,
    terrain: &mut CoupledTerrain,
    options: &CoupledEpochOptions,
) -> CoupledEpochStats {
    let domain = terrain.mesh.domain.clone();
    let unit_m = domain.metres_per_unit;
    let climate_grid = domain.grid(CLIMATE_RES_X, CLIMATE_RES_Y);
    let mesh0 = &terrain.mesh;
    let nodes_before = mesh0.alive_vertices as usize;
    let slots0 = mesh0.vertex_slots();
    let raft_hosts = raft_host_plates(&sim.rafts, &sim.seeds, &domain);
    let mut host = vec![-1i64; slots0];
    {
        let host_blobs = build_blob_index(&sim.rafts, &domain, RAFT_CARRY_REACH);
        for v in 0..slots0 {
            if mesh0.v_alive[v] == 0 {
                continue;
            }
            host[v] = carrier_plate_at(
                mesh0.vx[v],
                mesh0.vy[v],
                &host_blobs,
                &raft_hosts,
                &sim.seeds,
                &domain,
            ) as i64;
        }
    }
    let (events, motions) = step_epoch_coupled(sim);
    let epoch_ma = epoch_ma_of(sim);

    let count = nodes_before;
    let mut xs = vec![0.0; count];
    let mut ys = vec![0.0; count];
    let mut h_moved = vec![0f32; count];
    let mut ice_moved = vec![0f32; count];
    let ice_before = terrain.ice.len() == slots0;
    let mut column_moved = vec![0f32; count * COLUMN_DEPTH];
    let mut k = 0;
    for v in 0..slots0 {
        if mesh0.v_alive[v] == 0 {
            continue;
        }
        let moved = advance_point_by_motion(
            mesh0.vx[v],
            mesh0.vy[v],
            &motions[host[v] as usize],
            epoch_ma,
            &domain,
        );
        xs[k] = moved.x;
        ys[k] = moved.y;
        h_moved[k] = (terrain.z[v] as f64 - terrain.baseline[v] as f64) as f32;
        if ice_before {
            ice_moved[k] = terrain.ice[v];
        }
        column_moved[k * COLUMN_DEPTH..(k + 1) * COLUMN_DEPTH]
            .copy_from_slice(&terrain.column.data[v * COLUMN_DEPTH..(v + 1) * COLUMN_DEPTH]);
        k += 1;
    }
    let (mut mesh1, mapping) =
        triangulate_points(&domain, &xs, &ys, MESH_TUNING.ocean_spacing_m / unit_m);
    let mut state = MeshState::new(mesh1.vertex_slots() * 2);
    {
        let h = state.add("h", FieldKind::Extensive, 1);
        for i in 0..count {
            h[mapping[i] as usize] = h_moved[i];
        }
    }
    {
        let ice = state.add(MESH_ICE, FieldKind::Extensive, 1);
        for i in 0..count {
            ice[mapping[i] as usize] = ice_moved[i];
        }
    }
    {
        let col = add_column_field(&mut state);
        for i in 0..count {
            let dst = mapping[i] as usize * COLUMN_DEPTH;
            col[dst..dst + COLUMN_DEPTH]
                .copy_from_slice(&column_moved[i * COLUMN_DEPTH..(i + 1) * COLUMN_DEPTH]);
        }
    }
    state.add(MESH_Z, FieldKind::Intensive, 1);

    let blobs = build_blob_index(&sim.rafts, &domain, 1.0);
    let trench = trench_depression(&sim.seeds, &sim.motions, &sim.ages, &sim.rafts, &domain);
    let trench_ref = trench.as_ref().map(|f| f as BaselineTerm);
    let parts = BaselineParts {
        rafts: &sim.rafts,
        ocean_age: &sim.ocean_age,
        mantle: &sim.mantle,
        domain: &domain,
        warp_seed: sim.warp_seed,
    };
    let sea = sim.eustatic_m / ELEVATION_METERS;
    let mut solid1 = vec![0.0; mesh1.vertex_slots()];
    for v in 0..mesh1.vertex_slots() {
        if mesh1.v_alive[v] == 0 {
            continue;
        }
        solid1[v] = solid_baseline_at(
            &parts,
            &mut sim.meshes.shared,
            &mut sim.meshes.mantle,
            mesh1.vx[v],
            mesh1.vy[v],
            &blobs,
            trench_ref,
        );
        let h = state.get("h")[v] as f64;
        state.get_mut(MESH_Z)[v] = (solid1[v] - sea + h) as f32;
    }
    let remesh_every = js::max(1.0, options.remesh_every.unwrap_or(1.0));
    let remesh_due = sim.epoch % remesh_every == 0.0;
    let (mut removed, mut inserted) = (0, 0);
    if remesh_due {
        let mut target = DensityTarget {
            budget: options.budget.unwrap_or(1.0),
        };
        removed = coarsen(&mut mesh1, &mut state, &mut target, 4).removed;
        let shared = &mut sim.meshes.shared;
        let mantle_mesh = &mut sim.meshes.mantle;
        let mut sample = |state: &mut MeshState,
                          mesh: &PeriodicTriangulation,
                          v: usize,
                          x: f64,
                          y: f64,
                          a: usize,
                          b: usize,
                          c: usize| {
            let margin = |px: f64, py: f64| margin_parameter(raft_field_indexed(px, py, &blobs));
            let t = margin(x, y);
            let t_parents = js::max(
                js::max(
                    margin(mesh.vx[a], mesh.vy[a]),
                    margin(mesh.vx[b], mesh.vy[b]),
                ),
                margin(mesh.vx[c], mesh.vy[c]),
            );
            let scale = if t_parents > 0.0 {
                js::min(1.0, js::max(0.0, t / t_parents))
            } else {
                0.0
            };
            let hv = &mut state.get_mut("h")[v];
            *hv = (*hv as f64 * scale) as f32;
            let hv = *hv as f64;
            let cv = state.get_mut(MESH_COLUMN);
            for j in 0..COLUMN_DEPTH {
                cv[v * COLUMN_DEPTH + j] = (cv[v * COLUMN_DEPTH + j] as f64 * scale) as f32;
            }
            if v >= solid1.len() {
                let grown = (v + 1).max(solid1.len() * 2);
                solid1.resize(grown, 0.0);
            }
            solid1[v] = solid_baseline_at(&parts, shared, mantle_mesh, x, y, &blobs, trench_ref);
            state.get_mut(MESH_Z)[v] = (solid1[v] - sea + hv) as f32;
        };
        let mut refine_options =
            RefineOptions::seeded((js::to_int32(sim.warp_seed) ^ js::to_int32(sim.epoch)) as u32);
        refine_options.sample = Some(&mut sample);
        inserted = refine(&mut mesh1, &mut state, &mut target, &mut refine_options).inserted;
    }
    let (mut mesh, order) = compact_mesh(&mesh1);
    let slots = mesh.vertex_slots();
    let h_canon = permute(state.get("h"), &order);
    let ice_previous = permute(state.get(MESH_ICE), &order);
    let mut column = SedimentColumn {
        data: permute_column(state.get(MESH_COLUMN), &order),
        epochs: terrain.column.epochs.clone(),
    };
    if column.data.len() < slots * COLUMN_DEPTH {
        column.data.resize(slots * COLUMN_DEPTH, 0.0);
    }
    open_layer(&mut column, sim.epoch, slots);
    let mut baseline = vec![0f32; slots];
    let mut z_canon = vec![0f32; slots];
    let mut solid = vec![0.0; slots];
    for v in 0..slots {
        solid[v] = solid1[order[v] as usize];
        baseline[v] = (solid[v] - sea) as f32;
        z_canon[v] = (baseline[v] as f64 + h_canon[v] as f64) as f32;
    }
    drop(blobs);
    drop(trench);

    // The climate of the epoch.
    let coarse_z = rasterise_node_field(&mut mesh, &z_canon, CLIMATE_RES_X, CLIMATE_RES_Y);
    let weather_params = options.weather.unwrap_or_else(default_weather_params);
    let climate_every = js::max(1.0, options.climate_every.unwrap_or(1.0));
    if climate_due_at(
        sim.epoch,
        terrain.weather.as_ref(),
        &weather_params,
        climate_every,
    ) {
        let climate_terrain =
            ClimateTerrain::owned(&sim.meshes.shared, coarse_z, CLIMATE_RES_X, CLIMATE_RES_Y);
        let wm = compute_weather(&mut sim.meshes.shared, &climate_terrain, &weather_params);
        terrain.weather = Some(EpochWeather {
            epoch: sim.epoch,
            params: weather_params,
            terrain: climate_terrain,
            mesh: wm,
        });
    }
    let weather = terrain.weather.as_ref().unwrap();
    let cells = climate_cells_from_weather(&weather.terrain, &weather.mesh);
    let nodes = mesh_points(&mesh, &z_canon, None);
    let at_nodes = climate_at_points(&mut sim.meshes.shared, &cells, &nodes, true);
    let (mut ocean_area_m2, mut ocean_depth_sum, mut land_temp_sum, mut land_climate_area) =
        (0.0, 0.0, 0.0, 0.0);
    {
        let area = &sim.meshes.shared.mesh.area;
        let wt = &weather.terrain;
        for i in 0..area.len() {
            if wt.land[i] == 0 {
                ocean_area_m2 += area[i];
                ocean_depth_sum -= area[i] * js::min(0.0, wt.z[i]);
            } else {
                land_temp_sum += area[i] * weather.mesh.temperature[i];
                land_climate_area += area[i];
            }
        }
    }
    // The land as the climate saw it, kept for the cover below.
    let land_at_climate = nodes.land;

    // The ice.
    let areas_now = mesh_areas_of(&mut mesh);
    let cell_m2_now = unit_m * unit_m;
    let craton_field_for_till = craton_field(sim, &domain);
    let ice = compute_ice_on_mesh(
        &mut mesh,
        &MeshIceInputs {
            z: &z_canon,
            sea_level_temperature: &at_nodes.sea_level_temperature,
            precipitation: &at_nodes.precipitation,
            seasonal_amplitude: &at_nodes.seasonal_amplitude,
            cell_m: unit_m,
        },
    );
    let glacial = glacial_erosion_on_mesh(&mut mesh, &z_canon, &ice, epoch_ma * 1e6, unit_m);
    let (mut ice_volume_m3, mut ice_coast_column_m3, mut ice_area, mut land_area_now, mut ela_sum) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let area_m2 = areas_now[v] as f64 * cell_m2_now;
        let a = areas_now[v] as f64;
        if z_canon[v] > 0.0 {
            land_area_now += a;
            ela_sum += ice.ela_m[v] as f64 * a;
        }
        if ice.thickness[v] > 0.0 {
            ice_volume_m3 += ice.thickness[v] as f64 * area_m2;
            ice_area += a;
        }
        let cut_m = glacial.cut_m[v] as f64;
        if cut_m > 0.0 {
            ice_coast_column_m3 -= cut(&mut column, v, cut_m) * area_m2;
            z_canon[v] = (z_canon[v] as f64 - cut_m / ELEVATION_METERS) as f32;
        }
        let till_m = glacial.till_m[v] as f64;
        if till_m > 0.0 {
            let temp_c = at_nodes.temperature[v] as f64;
            let precip_here = js::max(0.0, at_nodes.precipitation[v] as f64);
            let craton_here = upsample_at(
                &craton_field_for_till,
                &climate_grid,
                mesh.vx[v],
                mesh.vy[v],
            );
            ice_coast_column_m3 += till_m * area_m2;
            let coarse = SURFACE_TUNING.glacial_till_coarse;
            deposit(
                &mut column,
                v,
                till_m * coarse,
                craton_here,
                1.0,
                temp_c,
                precip_here,
                true,
            );
            deposit(
                &mut column,
                v,
                till_m * (1.0 - coarse),
                craton_here,
                1.0,
                temp_c,
                precip_here,
                false,
            );
            z_canon[v] = (z_canon[v] as f64 + till_m / ELEVATION_METERS) as f32;
        }
    }
    let ice_area_share = if land_area_now > 0.0 {
        ice_area / land_area_now
    } else {
        0.0
    };
    let ela_mean_m = if land_area_now > 0.0 {
        ela_sum / land_area_now
    } else {
        0.0
    };
    let ocean_mean_depth_m = if ocean_area_m2 > 0.0 {
        (ocean_depth_sum / ocean_area_m2) * ELEVATION_METERS
    } else {
        0.0
    };
    let sea_level_m = if ocean_area_m2 > 0.0 {
        js::max(
            -ocean_mean_depth_m,
            -(ice_volume_m3 * (ICE_DENSITY / 1000.0)) / ocean_area_m2,
        )
    } else {
        0.0
    };
    let mean_land_temp_c = if land_climate_area > 0.0 {
        land_temp_sum / land_climate_area
    } else {
        0.0
    };

    // The cover.
    let plants_from_ma = weather_params
        .planet
        .unwrap_or(DEFAULT_PLANET_FORCING)
        .land_plants_from_ma;
    let plants_present = world_age_ma(sim.archean_epochs, sim.epoch) >= plants_from_ma;
    // The biomes on the land the climate saw, at the heights the ice left:
    // TypeScript's points hold zCanon itself, which the ice's cut and till
    // moved since, and the treeline reads the height.
    let cover_biomes = {
        let points = ClimatePoints {
            land: land_at_climate,
            ..mesh_points(&mesh, &z_canon, None)
        };
        classify_points(&at_nodes, &points, &domain, None).biome
    };
    let cover = cover_field(&cover_biomes, plants_present);

    // The forcing.
    let coarse = coarse_forcing_fields(sim, &domain);
    let areas = mesh_areas_of(&mut mesh);
    let mut assembled = assemble_node_forcing(
        &CoarseForcingInputs {
            uplift: Some(&coarse.uplift),
            hardness: Some(&coarse.hardness),
            forcing_res_x: CLIMATE_RES_X,
            forcing_res_y: CLIMATE_RES_Y,
            water: None,
            water_res_x: 1,
            water_res_y: 1,
            water_nodes: Some(&at_nodes.precipitation),
            litho_seed: erosion_litho_seed(sim.warp_seed),
        },
        &mesh.vx,
        &mesh.vy,
        &mesh.v_alive,
        slots,
        &z_canon,
        &areas,
        &domain,
        &options.controls,
        None,
    );
    let craton_field = &craton_field_for_till;
    let feature_buckets = build_feature_buckets(&sim.features, &domain);
    let collapse = collapse_mean(&mut sim.meshes.shared, &mesh, &z_canon, &areas);
    let rising: Vec<u8> = (0..slots)
        .map(|v| u8::from(mesh.v_alive[v] != 0 && assembled.uplift[v] > 0.0 && z_canon[v] > 0.0))
        .collect();
    let column_mean = column_mean_height(&mut mesh, &z_canon, &rising, unit_m);
    let iterations = options.iterations_per_epoch;
    let dt_scale = (epoch_ma * 1e6 / iterations as f64) / ITERATION_YEARS;
    let mut scaled = scale_engine_params_for_dt(
        &crate::surface::erosion_engine::ErosionSolverParams {
            eps_m: 0.0,
            ..assembled.params
        },
        dt_scale,
    );
    scaled.uplift_dt *= options.uplift_scale.unwrap_or(1.0);
    let epoch_uplift_m = scaled.uplift_dt * iterations as f64 * ELEVATION_METERS;
    let mut folded_area = 0.0;
    let mut craton_age = vec![0f32; slots];
    let mut rock_hard = vec![0f32; slots];
    let mut slope_scale = vec![0f32; slots];
    let mut diff_scale = vec![0f32; slots];
    let layers = column.epochs.len();
    let (mut cover_sum, mut cover_area, mut solifluction_area) = (0.0, 0.0, 0.0);
    let mut near = Vec::new();
    let collapse_h = TECTONICS_TUNING.collapse_height_m;
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let (x, y) = (mesh.vx[v], mesh.vy[v]);
        craton_age[v] = upsample_at(craton_field, &climate_grid, x, y) as f32;
        rock_hard[v] = upsample_at(&coarse.hardness, &climate_grid, x, y) as f32;
        let c = if z_canon[v] > 0.0 {
            cover[v] as f64
        } else {
            0.0
        };
        if assembled.uplift[v] > 0.0 {
            let fold = fold_factor_at(
                &feature_buckets,
                x,
                y,
                &domain,
                (areas[v] as f64).sqrt(),
                &mut near,
            );
            if fold != 1.0 {
                assembled.uplift[v] = (assembled.uplift[v] as f64 * fold) as f32;
                if z_canon[v] > 0.0 {
                    folded_area += areas[v] as f64;
                }
            }
            let shared = &mut sim.meshes.shared;
            let factor = js::max(
                0.0,
                1.0 - shared.sampler.sample(&mut shared.mesh, &collapse, x, y) / collapse_h,
            );
            assembled.uplift[v] = (assembled.uplift[v] as f64 * factor) as f32;
            if rising[v] != 0 {
                let f = column_factor(
                    column_mean[v] as f64,
                    assembled.uplift[v] as f64 * epoch_uplift_m,
                );
                assembled.uplift[v] = (assembled.uplift[v] as f64 * f) as f32;
            }
        }
        let bedrock_k = assembled.erodibility[v] as f64;
        let k = erodibility_over(&column.data, v, layers, bedrock_k);
        assembled.erodibility[v] = if ice.thickness[v] > 0.0 {
            0.0
        } else {
            (k * (1.0 - COVER_TUNING.erodibility_drop * c)) as f32
        };
        slope_scale[v] = (det_pow(k, -SURFACE_TUNING.mass_wasting_litho_exponent)
            * (1.0 + COVER_TUNING.critical_slope_rise * c)) as f32;
        let temp_c = at_nodes.temperature[v] as f64;
        let cold = js::min(
            1.0,
            js::max(
                0.0,
                (SURFACE_TUNING.solifluction_below_c - temp_c) / SURFACE_TUNING.solifluction_span_c,
            ),
        );
        diff_scale[v] = (1.0 + (SURFACE_TUNING.solifluction_boost - 1.0) * cold) as f32;
        if z_canon[v] > 0.0 {
            cover_sum += c * areas[v] as f64;
            cover_area += areas[v] as f64;
            if cold > 0.0 {
                solifluction_area += areas[v] as f64;
            }
        }
    }
    drop(feature_buckets);
    let share = |a: f64| {
        if cover_area > 0.0 {
            a / cover_area
        } else {
            0.0
        }
    };
    let mean_land_cover = share(cover_sum);
    let solifluction_share = share(solifluction_area);
    let folded_share = share(folded_area);

    // The erosion.
    let routing_every = HISTORY_DEFAULTS.routing_every;
    let result = {
        let forcing = ErosionForcing {
            uplift: &assembled.uplift,
            erodibility: &assembled.erodibility,
            coast_mask: Some(&assembled.coast_mask),
            accumulation_weights: Some(&assembled.accumulation_weights),
            status_mask: None,
            pinned_z: None,
            craton_age: Some(&craton_age),
            rock_hard: Some(&rock_hard),
            slope_scale: Some(&slope_scale),
            diff_scale: Some(&diff_scale),
        };
        run_mesh_erosion(
            &mut mesh,
            &z_canon,
            &forcing,
            &MeshErosionOptions {
                age: iterations,
                routing_every: Some(routing_every),
                params: Some(scaled),
                pool: options.leaf_workers.map(|w| MeshPipeline {
                    pipeline_depth: routing_every,
                    synchronous: true,
                    stencil_workers: w,
                }),
                frozen: None,
            },
        )
    };
    let mut result = result;
    let cell_m2 = unit_m * unit_m;
    let (mut deposited_m3, mut re_eroded_m3, mut scree_m3) = (0.0, 0.0, 0.0);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let area_m2 = areas[v] as f64 * cell_m2;
        if area_m2 <= 0.0 {
            continue;
        }
        let hill = result.hill_net_m3[v] as f64;
        let cut_m = (result.cut_m3[v] as f64 + if hill < 0.0 { -hill } else { 0.0 }) / area_m2;
        if cut_m > 0.0 {
            re_eroded_m3 += cut(&mut column, v, cut_m) * area_m2;
        }
        let temp_c = at_nodes.temperature[v] as f64;
        let precip = js::max(0.0, at_nodes.precipitation[v] as f64);
        if hill > 0.0 {
            scree_m3 += hill;
            deposit(
                &mut column,
                v,
                hill / area_m2,
                craton_age[v] as f64,
                rock_hard[v] as f64,
                temp_c,
                precip,
                true,
            );
        }
        let deposit_m3 = result.deposit_m3[v] as f64;
        if deposit_m3 > 0.0 {
            deposited_m3 += deposit_m3;
            let craton = result.deposit_craton[v] as f64 / deposit_m3;
            let hard = result.deposit_hard[v] as f64 / deposit_m3;
            let coarse_m3 = result.deposit_coarse_m3[v] as f64;
            deposit(
                &mut column,
                v,
                (deposit_m3 - coarse_m3) / area_m2,
                craton,
                hard,
                temp_c,
                precip,
                false,
            );
            deposit(
                &mut column,
                v,
                coarse_m3 / area_m2,
                craton,
                hard,
                temp_c,
                precip,
                true,
            );
        }
    }
    sim.sediment_export_m3 += result.exported_flux_m3;

    // The coast.
    let coastal = compute_coastal(
        &mut mesh,
        &CoastalInputs {
            z: &result.z,
            areas: &areas,
            wind_e: at_nodes.wind_e.as_ref().unwrap(),
            wind_s: at_nodes.wind_s.as_ref().unwrap(),
            cell_m: unit_m,
            hardness: &rock_hard,
            sediment_flux: &result.sediment_flux,
            iterations: iterations as f64,
            epoch_years: epoch_ma * 1e6,
        },
    );
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let coast_area_m2 = areas[v] as f64 * unit_m * unit_m;
        let cut_m = coastal.cut_m[v] as f64;
        if cut_m > 0.0 {
            ice_coast_column_m3 -= cut(&mut column, v, cut_m) * coast_area_m2;
            result.z[v] = (result.z[v] as f64 - cut_m / ELEVATION_METERS) as f32;
        }
        let dep_m = coastal.deposit_m[v] as f64;
        if dep_m > 0.0 {
            let temp_c = at_nodes.temperature[v] as f64;
            let precip_here = js::max(0.0, at_nodes.precipitation[v] as f64);
            ice_coast_column_m3 += dep_m * coast_area_m2;
            deposit(
                &mut column,
                v,
                dep_m,
                craton_age[v] as f64,
                rock_hard[v] as f64,
                temp_c,
                precip_here,
                true,
            );
            result.z[v] = (result.z[v] as f64 + dep_m / ELEVATION_METERS) as f32;
        }
    }

    // The flexure.
    let flex_cells = sim.meshes.shared.mesh.count;
    let mut load_m = vec![0.0; flex_cells];
    let mut spreader = node_load_spreader(&sim.meshes.shared);
    let (mut ice_load_m3, mut ice_weight_m3, mut uplift_load_m3) = (0.0, 0.0, 0.0);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let a = areas[v] as f64;
        let ice_m = ice_load_change_m(ice.thickness[v] as f64, ice_previous[v] as f64);
        ice_load_m3 += ice_m * a * cell_m2;
        ice_weight_m3 += ice_load_change_m(ice.thickness[v] as f64, 0.0) * a * cell_m2;
        let uplift_m3 = result.uplift_m3[v] as f64;
        uplift_load_m3 += uplift_m3;
        let dv = result.deposit_m3[v] as f64 - result.cut_m3[v] as f64
            + uplift_m3
            + (glacial.till_m[v] as f64 - glacial.cut_m[v] as f64 + coastal.deposit_m[v] as f64
                - coastal.cut_m[v] as f64
                + ice_m)
                * a
                * cell_m2;
        if dv == 0.0 {
            continue;
        }
        spreader.spread(
            &mut sim.meshes.shared,
            mesh.vx[v],
            mesh.vy[v],
            a * cell_m2,
            dv,
            &mut load_m,
        );
    }
    for c in 0..flex_cells {
        load_m[c] /= sim.meshes.shared.mesh.area[c];
    }
    let rafts = sim.rafts.clone();
    let rigidity = plate_rigidity(sim, &domain, &rafts, craton_field);
    let mut deflection = vec![0.0; flex_cells];
    flexural_response(
        &sim.meshes.shared.mesh,
        &load_m,
        &rigidity,
        &mut deflection,
        SolveOptions::default(),
    );
    let (mut rebound_max_m, mut subsidence_max_m) = (0.0, 0.0);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let shared = &mut sim.meshes.shared;
        let w_m = shared
            .sampler
            .sample(&mut shared.mesh, &deflection, mesh.vx[v], mesh.vy[v]);
        if w_m > rebound_max_m {
            rebound_max_m = w_m;
        }
        if -w_m > subsidence_max_m {
            subsidence_max_m = -w_m;
        }
        result.z[v] = (result.z[v] as f64 + w_m / ELEVATION_METERS) as f32;
    }

    // The sea level's change.
    let sea_shift = -(sea_level_m - sim.eustatic_m) / ELEVATION_METERS;
    sim.eustatic_m = sea_level_m;
    if sea_shift != 0.0 {
        for v in 0..slots {
            if mesh.v_alive[v] == 0 {
                continue;
            }
            result.z[v] = (result.z[v] as f64 + sea_shift) as f32;
            baseline[v] = (solid[v] - sim.eustatic_m / ELEVATION_METERS) as f32;
        }
    }

    // The routing on the terrain as the epoch leaves it, and the lakes.
    let routing = mesh_routing(&mut mesh, &result.z, &scaled);
    let lakes = {
        let points = mesh_points(&mesh, &result.z, None);
        let after = climate_at_points(&mut sim.meshes.shared, &cells, &points, false);
        let sub = MeshSubstrate {
            mesh: &mesh,
            routing: &routing,
            areas: &areas,
        };
        let discharge = accumulate_discharge_on(
            &sub,
            &result.z,
            &after.precipitation,
            Some(&after.temperature),
        );
        compute_lakes_on(
            &sub,
            &discharge,
            &result.z,
            &after.temperature,
            SURFACE_TUNING.min_lake_basin_relief_m,
        )
    };
    let mut ages: Vec<LakeAgeRecord> = Vec::new();
    let mut oldest_lake_ma = 0.0;
    let match_units = LAKE_MATCH_M / sim.domain.metres_per_unit;
    for body in &lakes.bodies {
        if body.kind == WaterKind::Dry {
            continue;
        }
        let mut age_ma = epoch_ma;
        let mut best_sq = match_units * match_units;
        for p in &sim.lake_ages {
            if (p.level - body.level).abs() * ELEVATION_METERS > LAKE_MATCH_LEVEL_M {
                continue;
            }
            let d_sq = domain.distance_sq(p.x, p.y, body.seed_x, body.seed_y);
            if d_sq >= best_sq {
                continue;
            }
            best_sq = d_sq;
            age_ma = p.age_ma + epoch_ma;
        }
        if age_ma > oldest_lake_ma {
            oldest_lake_ma = age_ma;
        }
        ages.push(LakeAgeRecord {
            x: body.seed_x,
            y: body.seed_y,
            level: body.level,
            age_ma,
        });
    }
    sim.lake_ages = ages;
    let ice_volume_km3 = ice_volume_m3 / 1e9;
    sim.climate_history.push(ClimateEpochRecord {
        epoch: sim.epoch,
        mean_land_temp_c,
        ice_volume_km3,
        sea_level_m,
    });
    if sim.climate_history.len() > CLIMATE_HISTORY_CAP {
        let excess = sim.climate_history.len() - CLIMATE_HISTORY_CAP;
        sim.climate_history.drain(..excess);
    }
    let (mut land_cells, mut land_volume) = (0.0, 0.0);
    for v in 0..slots {
        if mesh.v_alive[v] == 0 || result.z[v] <= 0.0 {
            continue;
        }
        land_cells += areas[v] as f64;
        land_volume += result.z[v] as f64 * areas[v] as f64;
    }
    let area_m2: Vec<f64> = areas.iter().map(|&a| a as f64 * cell_m2).collect();
    let column_volume = column_volume_m3(&column, &mesh, &area_m2);
    let stats = CoupledEpochStats {
        events,
        nodes_before,
        nodes_after: mesh.alive_vertices as usize,
        removed,
        inserted,
        land_cells,
        land_volume,
        eroded_flux_m3: result.eroded_flux_m3,
        exported_flux_m3: result.exported_flux_m3,
        deposited_m3,
        re_eroded_m3,
        ice_coast_column_m3,
        column_volume_m3: column_volume,
        rebound_max_m,
        subsidence_max_m,
        mean_land_temp_c,
        ice_volume_km3,
        sea_level_m,
        lakes: sim.lake_ages.len(),
        oldest_lake_ma,
        mean_land_cover,
        scree_m3,
        solifluction_share,
        folded_share,
        ice_area_share,
        glacial_cut_m3: glacial.cut_m3,
        till_m3: glacial.till_m3,
        ela_mean_m,
        shore_nodes: coastal.shore_nodes,
        coast_cut_m3: coastal.eroded_m3,
        coast_deposit_m3: coastal.deposited_m3,
        coast_export_m3: coastal.exported_m3,
        ice_load_m3,
        ice_weight_m3,
        uplift_load_m3,
    };
    terrain.mesh = mesh;
    terrain.column = column;
    terrain.ice = ice.thickness;
    terrain.z = result.z;
    terrain.baseline = baseline;
    terrain.routing = Some(routing);
    terrain.areas = areas;
    terrain.sediment_flux = result.sediment_flux;
    terrain.pre_erosion_z = z_canon;
    stats
}

/// The terrain's bytes for a save or a harness hash.
pub struct CoupledTerrainBytes {
    pub nodes: Vec<f32>,
    pub connectivity: Vec<u8>,
    pub z: Vec<f32>,
    pub column: Vec<u8>,
    pub ice: Vec<f32>,
}

pub fn encode_coupled_terrain(terrain: &CoupledTerrain) -> CoupledTerrainBytes {
    let order: Vec<i32> = (0..terrain.mesh.alive_vertices as i32).collect();
    let serial = encode_mesh(&terrain.mesh, &order);
    let count = serial.count;
    CoupledTerrainBytes {
        z: terrain.z[..count].to_vec(),
        column: encode_column(&terrain.column, count),
        ice: if terrain.ice.len() >= count {
            terrain.ice[..count].to_vec()
        } else {
            Vec::new()
        },
        nodes: serial.nodes,
        connectivity: serial.connectivity,
    }
}

/// What a save gives back of a terrain, the last epoch's per-node fields
/// among them when it has them.
pub struct SavedTerrain<'a> {
    pub nodes: &'a [f32],
    pub connectivity: &'a [u8],
    pub z: &'a [f32],
    pub column: Option<&'a [u8]>,
    pub ice: Option<&'a [f32]>,
    pub sediment_flux: Option<&'a [f32]>,
    pub pre_erosion_z: Option<&'a [f32]>,
}

/// A terrain restored from its bytes: the baseline evaluated again from
/// the simulation.
pub fn decode_coupled_terrain(
    sim: &mut PlateSimulation,
    bytes: &SavedTerrain,
) -> Result<CoupledTerrain, String> {
    let count = bytes.z.len();
    let mut mesh = decode_mesh(
        &sim.domain,
        &SerializedMesh {
            count,
            nodes: bytes.nodes.to_vec(),
            connectivity: bytes.connectivity.to_vec(),
        },
    )?;
    let baseline = baselines(sim, &mesh);
    let slots = mesh.vertex_slots();
    let column = match bytes.column {
        Some(c) => decode_column(c, count, slots)?,
        None => create_column(slots),
    };
    let per_node = |values: Option<&[f32]>| values.filter(|v| v.len() == count).map(|v| v.to_vec());
    let areas = mesh_areas_of(&mut mesh);
    Ok(CoupledTerrain {
        mesh,
        z: bytes.z.to_vec(),
        baseline,
        routing: None,
        areas,
        sediment_flux: per_node(bytes.sediment_flux).unwrap_or_default(),
        pre_erosion_z: per_node(bytes.pre_erosion_z).unwrap_or_else(|| bytes.z.to_vec()),
        column,
        ice: per_node(bytes.ice).unwrap_or_default(),
        weather: None,
    })
}

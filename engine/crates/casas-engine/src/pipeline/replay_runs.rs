//! `pipeline/replayRuns.ts`: a world's runs made again — the Archean's
//! steps, the hand-over and the coupled epochs as direct calls from run
//! parameters, the one loop the screen, a loaded world and the level-1 job
//! make the same world with; and the state between two epochs as a
//! snapshot, restored as a load restores it.
//!
//! The world's field meshes are handed from the state a restore replaces
//! to the restored one: TypeScript keeps them per domain for the process,
//! their walks' state with them. Not ported: the cancellation callback and
//! the pool's worker factory (`leaf_workers`, as in coupled_epoch.rs).

use crate::archean::archean_state::create_archean_simulation;
use crate::archean::archean_step::{archean_step, default_archean_params};
use crate::archean::finalize_archean::finalize_archean;
use crate::climate::weather::WeatherParams;
use crate::core::domain::Domain;
use crate::core::world_time::TECTONIC_MA_PER_EPOCH;
use crate::fields::field_mesh::SavedField;
use crate::mantle::mantle_field::saved_mantle;
use crate::mesh::mesh_hydrology::mesh_routing;
use crate::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use crate::surface::erosion_forcing_fields::ErosionControls;
use crate::tectonics::ocean_age::saved_ocean_age;
use crate::tectonics::plate_simulation::{
    deserialize_plate_simulation, serialize_plate_simulation,
};
use crate::tectonics::plate_simulation_types::{
    PlateSimulation, PlateSimulationSnapshot, WorldMeshes, world_meshes,
};

use super::coupled_epoch::{
    CoupledEpochOptions, CoupledTerrain, CoupledTerrainBytes, HISTORY_DEFAULTS, SavedTerrain,
    climate_due_at, create_coupled_terrain, decode_coupled_terrain, encode_coupled_terrain,
    step_coupled_epoch,
};

#[derive(Clone, Copy, Debug)]
pub struct GenesisRun {
    pub epochs: u32,
    pub diffusion: f64,
    pub land_share: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct TectonicsRun {
    pub epochs: u32,
    pub controls: ErosionControls,
    pub weather: WeatherParams,
    /// The run continued a world loaded from a save.
    pub restored: bool,
}

#[derive(Clone, Debug)]
pub struct ReplayPlan {
    pub seed: String,
    pub width: f64,
    pub height: f64,
    pub sphere: bool,
    pub genesis: Vec<GenesisRun>,
    pub tectonics: Vec<TectonicsRun>,
}

/// The world's state between two epochs, as values.
pub struct ReplaySnapshot {
    pub state: PlateSimulationSnapshot,
    pub ocean_age: SavedField,
    pub mantle: SavedField,
    pub lattice_accumulated: Vec<f32>,
    pub lattice_locked_epochs: Vec<i16>,
    pub lattice_last_class_code: Vec<i8>,
    pub mesh: CoupledTerrainBytes,
}

pub fn snapshot_of(sim: &PlateSimulation, terrain: &CoupledTerrain) -> ReplaySnapshot {
    ReplaySnapshot {
        state: serialize_plate_simulation(sim),
        ocean_age: saved_ocean_age(&sim.meshes.ocean, &sim.meshes.shared, &sim.ocean_age),
        mantle: saved_mantle(&sim.meshes.mantle, &sim.mantle),
        lattice_accumulated: sim.lattice_accumulated.clone(),
        lattice_locked_epochs: sim.lattice_locked_epochs.clone(),
        lattice_last_class_code: sim.lattice_last_class_code.clone(),
        mesh: encode_coupled_terrain(terrain),
    }
}

/// The state back, as a loaded world is restored: no weather cache, the
/// ice kept, the routing derived. `meshes`: the world's field meshes.
pub fn restore_snapshot(
    snapshot: &ReplaySnapshot,
    domain: Domain,
    meshes: WorldMeshes,
) -> Result<(PlateSimulation, CoupledTerrain), String> {
    let mut sim = deserialize_plate_simulation(
        &snapshot.state,
        &snapshot.ocean_age,
        Some(&snapshot.mantle),
        domain,
        meshes,
    )?;
    if snapshot.lattice_accumulated.len() == sim.lattice_accumulated.len() {
        sim.lattice_accumulated
            .copy_from_slice(&snapshot.lattice_accumulated);
        sim.lattice_locked_epochs
            .copy_from_slice(&snapshot.lattice_locked_epochs);
        sim.lattice_last_class_code
            .copy_from_slice(&snapshot.lattice_last_class_code);
    }
    let m = &snapshot.mesh;
    let mut terrain = decode_coupled_terrain(
        &mut sim,
        &SavedTerrain {
            nodes: &m.nodes,
            connectivity: &m.connectivity,
            z: &m.z,
            column: Some(&m.column),
            ice: Some(&m.ice),
            sediment_flux: None,
            pre_erosion_z: None,
        },
    )?;
    terrain.routing = Some(mesh_routing(
        &mut terrain.mesh,
        &terrain.z,
        &DEFAULT_SOLVER_PARAMS,
    ));
    Ok((sim, terrain))
}

/// Where a replay stands: the tectonics run and the epochs done in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayPosition {
    pub run: usize,
    pub epoch: u32,
}

/// Called between two epochs where a checkpoint taken now restores to the
/// same bytes (`snapshot_of` takes it).
pub type OnCheckpoint<'a> = &'a mut dyn FnMut(ReplayPosition, &PlateSimulation, &CoupledTerrain);

pub struct ReplayOptions<'a> {
    pub budget: f64,
    pub leaf_workers: Option<usize>,
    pub on_epoch: Option<&'a mut dyn FnMut(u32, u32)>,
    pub resume: Option<(ReplayPosition, &'a ReplaySnapshot)>,
    pub on_checkpoint: Option<OnCheckpoint<'a>>,
}

fn domain_of(plan: &ReplayPlan) -> Domain {
    if plan.sphere {
        Domain::sphere(plan.width, plan.height)
    } else {
        Domain::torus(plan.width, plan.height)
    }
}

pub fn replay_runs(
    plan: &ReplayPlan,
    options: &mut ReplayOptions,
) -> Result<(PlateSimulation, CoupledTerrain), String> {
    let domain = domain_of(plan);
    let (mut sim, mut terrain, start) = match options.resume {
        Some((position, snapshot)) => {
            let (sim, terrain) = restore_snapshot(snapshot, domain.clone(), world_meshes(&domain))?;
            (sim, terrain, position)
        }
        None => {
            let mut archean = create_archean_simulation(&plan.seed, domain.clone());
            let mut params = default_archean_params();
            for run in &plan.genesis {
                params.diffusion = run.diffusion;
                params.land_share = run.land_share;
                for _ in 0..run.epochs {
                    archean_step(&mut archean, &params);
                }
            }
            let mut sim = finalize_archean(archean);
            sim.epoch_ma = TECTONIC_MA_PER_EPOCH;
            let terrain = create_coupled_terrain(&mut sim, options.budget);
            (sim, terrain, ReplayPosition { run: 0, epoch: 0 })
        }
    };
    let total: u32 = plan.tectonics.iter().map(|r| r.epochs).sum();
    let mut done: u32 = plan.tectonics[..start.run]
        .iter()
        .map(|r| r.epochs)
        .sum::<u32>()
        + start.epoch;
    for r in start.run..plan.tectonics.len() {
        let run = &plan.tectonics[r];
        let mut epoch = if r == start.run { start.epoch } else { 0 };
        if run.restored && epoch == 0 {
            let snapshot = snapshot_of(&sim, &terrain);
            let meshes = sim.meshes;
            (sim, terrain) = restore_snapshot(&snapshot, domain.clone(), meshes)?;
        }
        while epoch < run.epochs {
            let fresh = climate_due_at(
                sim.epoch + 1.0,
                terrain.weather.as_ref(),
                &run.weather,
                HISTORY_DEFAULTS.climate_every,
            );
            if fresh
                && done > 0
                && let Some(cb) = options.on_checkpoint.as_mut()
            {
                cb(ReplayPosition { run: r, epoch }, &sim, &terrain);
            }
            step_coupled_epoch(
                &mut sim,
                &mut terrain,
                &CoupledEpochOptions {
                    weather: Some(run.weather),
                    iterations_per_epoch: HISTORY_DEFAULTS.iterations_per_epoch,
                    budget: Some(options.budget),
                    climate_every: Some(HISTORY_DEFAULTS.climate_every),
                    remesh_every: Some(HISTORY_DEFAULTS.remesh_every),
                    uplift_scale: Some(HISTORY_DEFAULTS.uplift_scale),
                    controls: run.controls,
                    leaf_workers: options.leaf_workers,
                },
            );
            done += 1;
            if let Some(cb) = options.on_epoch.as_mut() {
                cb(done, total);
            }
            epoch += 1;
        }
    }
    Ok((sim, terrain))
}

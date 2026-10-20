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

/// A replay one epoch at a time, for a caller that reports, checkpoints
/// or stops between two (the job worker through the boundary):
/// `replay_runs` is its loop.
pub struct Replay {
    plan: ReplayPlan,
    domain: Domain,
    budget: f64,
    leaf_workers: Option<usize>,
    /// The world; None only inside a restored run's start.
    world: Option<(PlateSimulation, CoupledTerrain)>,
    position: ReplayPosition,
    /// Whether the run at `position` has had its start (a restored run's
    /// restore).
    entered: bool,
    done: u32,
    total: u32,
}

impl Replay {
    /// The Archean, the hand-over and the history's terrain, or the state
    /// a checkpoint holds.
    pub fn start(
        plan: ReplayPlan,
        budget: f64,
        leaf_workers: Option<usize>,
        resume: Option<(ReplayPosition, &ReplaySnapshot)>,
    ) -> Result<Replay, String> {
        let domain = domain_of(&plan);
        let (sim, terrain, position) = match resume {
            Some((position, snapshot)) => {
                let (sim, terrain) =
                    restore_snapshot(snapshot, domain.clone(), world_meshes(&domain))?;
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
                let terrain = create_coupled_terrain(&mut sim, budget);
                (sim, terrain, ReplayPosition { run: 0, epoch: 0 })
            }
        };
        let total: u32 = plan.tectonics.iter().map(|r| r.epochs).sum();
        let done = plan.tectonics[..position.run]
            .iter()
            .map(|r| r.epochs)
            .sum::<u32>()
            + position.epoch;
        Ok(Replay {
            plan,
            domain,
            budget,
            leaf_workers,
            world: Some((sim, terrain)),
            position,
            entered: false,
            done,
            total,
        })
    }

    /// The epochs done and their total.
    pub fn done(&self) -> u32 {
        self.done
    }

    pub fn total(&self) -> u32 {
        self.total
    }

    /// Moves to the next epoch to run, starting each run on the way: the
    /// run's index, or None past the last.
    fn ready(&mut self) -> Result<Option<usize>, String> {
        loop {
            let r = self.position.run;
            let Some(run) = self.plan.tectonics.get(r) else {
                return Ok(None);
            };
            if !self.entered {
                self.entered = true;
                if run.restored && self.position.epoch == 0 {
                    let (sim, terrain) = self.world.take().expect("the replay's world");
                    let snapshot = snapshot_of(&sim, &terrain);
                    self.world = Some(restore_snapshot(
                        &snapshot,
                        self.domain.clone(),
                        sim.meshes,
                    )?);
                }
            }
            if self.position.epoch < run.epochs {
                return Ok(Some(r));
            }
            self.position = ReplayPosition {
                run: r + 1,
                epoch: 0,
            };
            self.entered = false;
        }
    }

    /// Where a checkpoint taken now restores to the same bytes: before an
    /// epoch that computes its climate anyway, after the first. None
    /// elsewhere and past the last epoch.
    pub fn checkpoint_due(&mut self) -> Result<Option<ReplayPosition>, String> {
        let Some(r) = self.ready()? else {
            return Ok(None);
        };
        let weather = self.plan.tectonics[r].weather;
        let (sim, terrain) = self.world();
        let fresh = climate_due_at(
            sim.epoch + 1.0,
            terrain.weather.as_ref(),
            &weather,
            HISTORY_DEFAULTS.climate_every,
        );
        Ok((fresh && self.done > 0).then_some(self.position))
    }

    /// The state now, as a checkpoint holds it.
    pub fn snapshot(&mut self) -> ReplaySnapshot {
        let (sim, terrain) = self.world();
        snapshot_of(sim, terrain)
    }

    fn world(&mut self) -> (&mut PlateSimulation, &mut CoupledTerrain) {
        let (sim, terrain) = self.world.as_mut().expect("the replay's world");
        (sim, terrain)
    }

    /// The next epoch; false past the last.
    pub fn step(&mut self) -> Result<bool, String> {
        let Some(r) = self.ready()? else {
            return Ok(false);
        };
        let run = self.plan.tectonics[r];
        let (budget, leaf_workers) = (self.budget, self.leaf_workers);
        let (sim, terrain) = self.world();
        step_coupled_epoch(
            sim,
            terrain,
            &CoupledEpochOptions {
                weather: Some(run.weather),
                iterations_per_epoch: HISTORY_DEFAULTS.iterations_per_epoch,
                budget: Some(budget),
                climate_every: Some(HISTORY_DEFAULTS.climate_every),
                remesh_every: Some(HISTORY_DEFAULTS.remesh_every),
                uplift_scale: Some(HISTORY_DEFAULTS.uplift_scale),
                controls: run.controls,
                leaf_workers,
            },
        );
        self.done += 1;
        self.position.epoch += 1;
        Ok(true)
    }

    /// The world the replay made.
    pub fn into_world(self) -> (PlateSimulation, CoupledTerrain) {
        self.world.expect("the replay's world")
    }
}

pub fn replay_runs(
    plan: &ReplayPlan,
    options: &mut ReplayOptions,
) -> Result<(PlateSimulation, CoupledTerrain), String> {
    let mut replay = Replay::start(
        plan.clone(),
        options.budget,
        options.leaf_workers,
        options.resume,
    )?;
    loop {
        if let Some(position) = replay.checkpoint_due()?
            && let Some(cb) = options.on_checkpoint.as_mut()
        {
            let (sim, terrain) = replay.world();
            cb(position, sim, terrain);
        }
        if !replay.step()? {
            break;
        }
        if let Some(cb) = options.on_epoch.as_mut() {
            cb(replay.done, replay.total);
        }
    }
    Ok(replay.into_world())
}

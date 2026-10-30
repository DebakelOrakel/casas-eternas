//! The engine's surface to TypeScript (docs/decisions/rust-engine.md,
//! fork 6). A world is an object here: its state — the Archean or the
//! plates, the coupled terrain, the field meshes with their walks — stays
//! in the engine, and only what TypeScript shows, saves or posts crosses,
//! as plain data (`value::Value`, in the TypeScript types' shapes,
//! `forms`). `casas-generator-node` (napi) and `casas-generator-wasm`
//! (wasm-bindgen) wrap these methods one for one.

pub mod formats;
pub mod forms;
pub mod pipeline;
pub mod preview;
pub mod read;
pub mod replay;
mod stages;
pub mod tiles;
pub mod value;

use casas_generator::archean::archean_snapshot::{deserialize_archean, serialize_archean};
use casas_generator::archean::archean_state::{ArcheanSimulation, create_archean_simulation};
use casas_generator::archean::archean_step::{ArcheanParams, archean_step, default_archean_params};
use casas_generator::archean::finalize_archean::finalize_archean;
use casas_generator::core::domain::Domain;
use casas_generator::core::world_time::{TECTONIC_MA_PER_EPOCH, world_epoch};
use casas_generator::crust::raft_field::{compute_craton_oldness_field, stabilised_fraction};
use casas_generator::elevation::elevation_raster::{RasterSources, elevation_raster};
use casas_generator::mantle::mantle_field::{
    MANTLE_RES_X, MANTLE_RES_Y, rasterise_mantle, saved_mantle,
};
use casas_generator::mesh::lattice::bootstrap_lattice;
use casas_generator::mesh::mesh_hydrology::mesh_routing;
use casas_generator::mesh::mesh_raster::rasterise_node_field;
use casas_generator::mesh::mesh_serial::{SerializedMesh, compact_mesh, decode_mesh, encode_mesh};
use casas_generator::pipeline::coupled_epoch::{
    CoupledEpochOptions, CoupledTerrain, HISTORY_DEFAULTS, SavedTerrain, create_coupled_terrain,
    decode_coupled_terrain, step_coupled_epoch,
};
use casas_generator::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_generator::surface::erosion_forcing_fields::ErosionControls;
use casas_generator::tectonics::ocean_age::{create_ocean_age_field, saved_ocean_age};
use casas_generator::tectonics::plate_simulation::{
    deserialize_plate_simulation, serialize_plate_simulation,
};
use casas_generator::tectonics::plate_simulation_types::{PlateSimulation, world_meshes};
use casas_generator::tectonics::plumes::find_plume_sites;
use casas_generator::tectonics::volcanoes::collect_volcanoes;

pub use value::Value;

/// The engine's crate version.
pub fn version() -> &'static str {
    casas_generator::ENGINE_VERSION
}

/// The erosion's coarse forcing of a save's snapshot on the climate's
/// chart, `{ uplift, hardness }` (docs/decisions/rust-engine.md, fork 7b):
/// what the world layer reads out of a save for the tile bakes and the
/// terrain's id, as `World::forcing` gives it of a live world. No world is
/// made for it.
pub fn forcing_of_snapshot(shape: Shape, snapshot: &Value) -> Result<Value, EraError> {
    let snap = read::snapshot(snapshot)?;
    let domain = domain_of(shape, snap.width, snap.height);
    let f = casas_generator::pipeline::erosion_forcing::coarse_forcing_of_snapshot(&snap, &domain);
    Ok(value::ObjBuilder::new()
        .put("uplift", Value::F32s(f.uplift))
        .put("hardness", Value::F32s(f.hardness))
        .build())
}

/// The volcanoes the map marks of a save's snapshot: hotspots, flood
/// basalts and the active arcs, thinned (`collect_volcanoes`) — for a
/// reader of a save (the incubator), as `World::render` gives them of a
/// live world. Display only.
pub fn volcanoes_of_snapshot(snapshot: &Value) -> Result<Value, EraError> {
    let snap = read::snapshot(snapshot)?;
    Ok(Value::List(
        collect_volcanoes(&snap.features)
            .iter()
            .map(forms::volcano)
            .collect(),
    ))
}

/// The sea-level temperature per row of the climate's chart, °C, the
/// offset included (`sea_level_temperature_band`): the band of the map's
/// temperature scale. `planet` none is the default planet. Display only.
pub fn sea_level_temperature_band(
    offset_c: f64,
    contrast: f64,
    planet: Option<&Value>,
    shape: Shape,
) -> Result<Value, EraError> {
    let planet = match planet {
        Some(p) => read::planet(p)?,
        None => casas_generator::planet::planet_forcing::DEFAULT_PLANET_FORCING,
    };
    Ok(Value::F32s(
        casas_generator::climate::temperature::sea_level_temperature_band(
            offset_c,
            contrast,
            &planet,
            shape == Shape::Sphere,
        ),
    ))
}

/// The bootstrap mesh of a domain at one spacing (`bootstrap_lattice`) in
/// its canonical form (`compact_mesh`), as the save's codec holds it:
/// `{ count, nodes, connectivity }`. A small mesh for a check of the save
/// format (the client's harness:roundtrip).
pub fn bootstrap_mesh(shape: Shape, width: f64, height: f64, spacing: f64) -> Value {
    let domain = domain_of(shape, width, height);
    let (mesh, _) = compact_mesh(&bootstrap_lattice(&domain, spacing));
    let order: Vec<i32> = (0..mesh.alive_vertices as i32).collect();
    let serial = encode_mesh(&mesh, &order);
    value::ObjBuilder::new()
        .num("count", serial.count as f64)
        .put("nodes", Value::F32s(serial.nodes))
        .put("connectivity", Value::U8s(serial.connectivity))
        .build()
}

/// The check names and their violation counts, in the engine's order.
fn invariant_counts(checks: Vec<(&'static str, usize)>) -> Value {
    checks
        .into_iter()
        .fold(value::ObjBuilder::new(), |out, (name, n)| {
            out.num(name, n as f64)
        })
        .build()
}

/// The invariants of a river graph on the mesh (`river_graph_invariants`),
/// `{ check: violations }`: the graph as a level and a save keep it
/// (`formats::river_graph_parts`, its `json` as a string; `positions` may
/// be absent, the checks do not read them), `elevation` per cell of the
/// graph. For the harnesses.
pub fn river_graph_invariants(parts: &Value, elevation: &Value) -> Result<Value, EraError> {
    let f = read::Fields::of(parts, "the river graph's parts")?;
    let need = |k: &str| {
        f.get(k)
            .ok_or_else(|| wrong(&format!("the river graph's parts have no {k}")))
    };
    let Value::Str(json) = need("json")? else {
        return Err(wrong("the river graph's JSON is not a string"));
    };
    let Value::I32s(cells) = need("cells")? else {
        return Err(wrong("the river graph's cells are not an Int32Array"));
    };
    let positions = match f.get("positions") {
        Some(p) => read::f32s(p, "the river graph's positions")?.to_vec(),
        None => vec![0.0; cells.len() * 2],
    };
    let graph = formats::river_graph_of_parts(
        &formats::parse_json(json)?,
        cells.clone(),
        read::f32s(need("coursePoints")?, "the river graph's course points")?,
        &positions,
    )?;
    let graph = read::river_graph(&graph)?;
    let elevation = read::f32s(elevation, "the elevation")?;
    if graph.nodes.iter().any(|n| n.cell >= elevation.len()) {
        return Err(wrong("a river node's cell is outside the elevation"));
    }
    Ok(invariant_counts(
        casas_generator::surface::river_graph::river_graph_invariants(&graph, elevation),
    ))
}

/// The invariants of a coast graph (`coast_graph_invariants`), `{ check:
/// violations }`: the mesh as the save's codec holds it (`{ count, nodes,
/// connectivity }`) on the world's domain, its heights per node, and the
/// coast as the save holds it (`{ reaches, nodes }`). For the harnesses.
pub fn coast_graph_invariants(
    shape: Shape,
    width: f64,
    height: f64,
    mesh: &Value,
    z: &Value,
    coast: &Value,
) -> Result<Value, EraError> {
    let m = read::Fields::of(mesh, "the mesh")?;
    let need = |k: &str| {
        m.get(k)
            .ok_or_else(|| wrong(&format!("the mesh has no {k}")))
    };
    let mesh = decode_mesh(
        &domain_of(shape, width, height),
        &SerializedMesh {
            count: m.num("count")? as usize,
            nodes: read::f32s(need("nodes")?, "the mesh's nodes")?.to_vec(),
            connectivity: read::u8s(need("connectivity")?, "the mesh's connectivity")?.to_vec(),
        },
    )?;
    let coast = read::coast_graph(coast, mesh.vertex_slots())?;
    let z = read::f32s(z, "the heights")?;
    if z.len() < mesh.vertex_slots() {
        return Err(wrong("the heights are fewer than the mesh's nodes"));
    }
    Ok(invariant_counts(
        casas_generator::surface::coast_graph::coast_graph_invariants(&coast, &mesh, z),
    ))
}

/// The seed of a world's fine detail field (the world layer's
/// `detailSeed` until 2026-10-22, fork 7b): the coastline-warp seed of its
/// seed text, salted as every reader of the field family salts it.
pub(crate) fn detail_seed(seed: &str) -> u32 {
    casas_generator::archean::archean_state::coastal_warp_seed(seed)
        ^ casas_generator::elevation::ridged_noise::FINE_DETAIL_SEED_SALT
}

/// The seed of a world's lithology lattice (the world layer's `lithoSeed`
/// until 2026-10-22).
pub(crate) fn litho_seed(seed: &str) -> u32 {
    casas_generator::surface::erosion_forcing_fields::erosion_litho_seed(
        casas_generator::archean::archean_state::coastal_warp_seed(seed) as f64,
    )
}

/// The world's shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Shape {
    Torus,
    Sphere,
}

/// What a call could not do: asked of a world in the wrong era, or given
/// data its reader could not read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EraError(pub String);

impl std::fmt::Display for EraError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for EraError {
    fn from(s: String) -> Self {
        EraError(s)
    }
}

pub(crate) fn wrong(what: &str) -> EraError {
    EraError(what.to_string())
}

enum Era {
    Archean(Box<ArcheanSimulation>),
    Plates {
        sim: Box<PlateSimulation>,
        coupled: Box<CoupledTerrain>,
    },
    /// Between two eras, for the hand-over's move only.
    Moving,
}

/// A render's extras after the hand-over (`World::render`, and the
/// hydrology's render): the craton age on the mantle's chart raster and the
/// volcanoes the map marks.
pub(crate) fn plates_extras(sim: &PlateSimulation) -> Vec<(&'static str, Value)> {
    let craton_age = compute_craton_oldness_field(
        &sim.rafts,
        world_epoch(sim.archean_epochs, sim.epoch),
        sim.archean_epochs,
        MANTLE_RES_X,
        MANTLE_RES_Y,
        &sim.domain,
    );
    let volcanoes = collect_volcanoes(&sim.features);
    vec![
        ("cratonAge", Value::F32s(craton_age)),
        (
            "volcanoes",
            Value::List(volcanoes.iter().map(forms::volcano).collect()),
        ),
    ]
}

pub(crate) fn domain_of(shape: Shape, width: f64, height: f64) -> Domain {
    match shape {
        Shape::Torus => Domain::torus(width, height),
        Shape::Sphere => Domain::sphere(width, height),
    }
}

/// The history's controls (the runtime's `historyControls`):
/// `{ alluvium, rockContrast, weather: { temperatureOffset,
/// temperatureContrast, humidity, equatorOffset, planet? } }`.
fn epoch_options(controls: &Value) -> Result<CoupledEpochOptions, EraError> {
    let c = read::Fields::of(controls, "the controls")?;
    let weather = read::weather(
        c.get("weather")
            .ok_or_else(|| wrong("the controls have no weather"))?,
    )?;
    Ok(CoupledEpochOptions {
        weather: Some(weather),
        iterations_per_epoch: HISTORY_DEFAULTS.iterations_per_epoch,
        budget: Some(HISTORY_DEFAULTS.budget),
        climate_every: Some(HISTORY_DEFAULTS.climate_every),
        remesh_every: Some(HISTORY_DEFAULTS.remesh_every),
        uplift_scale: Some(HISTORY_DEFAULTS.uplift_scale),
        controls: ErosionControls {
            alluvium: Some(c.num("alluvium")?),
            rock_contrast: Some(c.num("rockContrast")?),
        },
        leaf_workers: None,
    })
}

/// A world in the engine.
pub struct World {
    era: Era,
    archean_params: ArcheanParams,
    stages: stages::Stages,
}

impl World {
    /// A new world in its Archean (`createArcheanSimulation` in
    /// TypeScript), with the Archean's controls: the mantle's diffusion
    /// and the land share it aims at.
    pub fn genesis(
        seed: &str,
        width: u32,
        height: u32,
        shape: Shape,
        diffusion: f64,
        land_share: f64,
    ) -> World {
        let domain = domain_of(shape, width as f64, height as f64);
        let archean_params = ArcheanParams {
            diffusion,
            land_share,
            ..default_archean_params()
        };
        World {
            era: Era::Archean(Box::new(create_archean_simulation(seed, domain))),
            archean_params,
            stages: Default::default(),
        }
    }

    fn archean(&self) -> Result<&ArcheanSimulation, EraError> {
        match &self.era {
            Era::Archean(a) => Ok(a),
            _ => Err(wrong("the world is past its Archean")),
        }
    }

    fn plates(&mut self) -> Result<(&mut PlateSimulation, &mut CoupledTerrain), EraError> {
        match &mut self.era {
            Era::Plates { sim, coupled } => Ok((sim, coupled)),
            _ => Err(wrong("the world has no plates yet")),
        }
    }

    /// One Archean step.
    pub fn archean_step(&mut self) -> Result<(), EraError> {
        match &mut self.era {
            Era::Archean(a) => {
                archean_step(a, &self.archean_params);
                Ok(())
            }
            _ => Err(wrong("the world is past its Archean")),
        }
    }

    /// The Archean's controls from the next step on (the runtime's
    /// `handleGenesisStart`): the mantle's diffusion and the land share.
    pub fn set_archean_controls(&mut self, diffusion: f64, land_share: f64) {
        self.archean_params.diffusion = diffusion;
        self.archean_params.land_share = land_share;
    }

    /// The Archean's epoch.
    pub fn archean_epoch(&self) -> Result<f64, EraError> {
        Ok(self.archean()?.epoch)
    }

    /// The mantle's buoyancy per cell of its field mesh, in either era.
    pub fn mantle(&self) -> Vec<f64> {
        match &self.era {
            Era::Archean(a) => a.mantle.clone(),
            Era::Plates { sim, .. } => sim.mantle.clone(),
            Era::Moving => Vec::new(),
        }
    }

    /// The rafts' count, in either era.
    pub fn raft_count(&self) -> u32 {
        match &self.era {
            Era::Archean(a) => a.rafts.len() as u32,
            Era::Plates { sim, .. } => sim.rafts.len() as u32,
            Era::Moving => 0,
        }
    }

    /// The hand-over (the runtime's `handleGenesisFinalize`): the plates
    /// from the Archean, the epoch's length, and the history's terrain
    /// from the synthesis at the hand-over.
    pub fn finalize(&mut self) -> Result<(), EraError> {
        let Era::Archean(a) = std::mem::replace(&mut self.era, Era::Moving) else {
            return Err(wrong("the world is past its Archean"));
        };
        let mut sim = Box::new(finalize_archean(*a));
        sim.epoch_ma = TECTONIC_MA_PER_EPOCH;
        let coupled = Box::new(create_coupled_terrain(&mut sim, HISTORY_DEFAULTS.budget));
        self.era = Era::Plates { sim, coupled };
        self.stages.handed_over();
        Ok(())
    }

    /// One coupled epoch at the history's settings (the runtime's
    /// tectonics loop) under its controls; its events, as `SimEvent`s.
    pub fn epoch(&mut self, controls: &Value) -> Result<Value, EraError> {
        let options = epoch_options(controls)?;
        let (sim, coupled) = self.plates()?;
        // Refused, not run: an epoch without plates panics, and a panic in
        // the WASM build leaves the world unusable (no render after it).
        if sim.seeds.is_empty() {
            return Err(wrong("the world has no plates to move"));
        }
        // As the runtime's start sets it, for a world restored from a save
        // written before the epoch had a length.
        sim.epoch_ma = TECTONIC_MA_PER_EPOCH;
        let stats = step_coupled_epoch(sim, coupled, &options);
        self.stages.epoched();
        Ok(Value::List(stats.events.iter().map(forms::event).collect()))
    }

    /// The plate simulation as the save holds it
    /// (`serializePlateSimulation`).
    pub fn snapshot(&mut self) -> Result<Value, EraError> {
        let (sim, _) = self.plates()?;
        Ok(forms::snapshot(&serialize_plate_simulation(sim)))
    }

    /// The field meshes' values as the save holds them: the mantle's and
    /// the ocean age's (`SavedField`). In the Archean, the ocean age is the
    /// field the hand-over starts from: 0 in each cell.
    pub fn saved_fields(&mut self) -> Result<(Value, Value), EraError> {
        if let Era::Archean(a) = &self.era {
            let m = &a.meshes;
            let mantle = saved_mantle(&m.mantle, &a.mantle);
            let ocean =
                saved_ocean_age(&m.ocean, &m.shared, &create_ocean_age_field(0.0, &m.shared));
            return Ok((forms::saved_field(&mantle), forms::saved_field(&ocean)));
        }
        let (sim, _) = self.plates()?;
        let mantle = saved_mantle(&sim.meshes.mantle, &sim.mantle);
        let ocean = saved_ocean_age(&sim.meshes.ocean, &sim.meshes.shared, &sim.ocean_age);
        Ok((forms::saved_field(&mantle), forms::saved_field(&ocean)))
    }

    /// The detection lattice's state as the save holds it
    /// (`LatticeState`): `{ accumulated, lockedEpochs, lastClassCode }`.
    pub fn lattice(&mut self) -> Result<Value, EraError> {
        let (sim, _) = self.plates()?;
        Ok(value::ObjBuilder::new()
            .put("accumulated", Value::F32s(sim.lattice_accumulated.clone()))
            .put(
                "lockedEpochs",
                Value::I16s(sim.lattice_locked_epochs.clone()),
            )
            .put(
                "lastClassCode",
                Value::I8s(sim.lattice_last_class_code.clone()),
            )
            .build())
    }

    /// The erosion's coarse forcing on the climate's chart, `{ uplift,
    /// hardness }`: what a reader of the save derives from its snapshot
    /// (`forcing_of_snapshot`) for the tile bakes.
    pub fn forcing(&mut self) -> Result<Value, EraError> {
        let (sim, _) = self.plates()?;
        let f = casas_generator::pipeline::erosion_forcing::coarse_forcing_fields(sim, &sim.domain);
        Ok(value::ObjBuilder::new()
            .put("uplift", Value::F32s(f.uplift))
            .put("hardness", Value::F32s(f.hardness))
            .build())
    }

    /// The coupled terrain as the save's bytes.
    pub fn mesh_payload(&mut self) -> Result<Value, EraError> {
        let (_, coupled) = self.plates()?;
        Ok(forms::mesh_payload(coupled))
    }

    /// A render's rasters (the runtime's `renderArcheanAndPost` and
    /// `renderTerrain`), `{ elevations, mantle, cratonAge, … }`: the raw
    /// elevation on the world raster — the synthesis in the Archean, on a
    /// grid `scale` times coarser for the live preview; the terrain mesh's
    /// heights after the hand-over — then the mantle on its chart raster.
    /// Both move the meshes' walks, so the order is the render's.
    ///
    /// The display's extras come with it (nothing of them is saved): the
    /// craton age on the mantle's chart raster (`compute_craton_oldness_field`,
    /// 0..1, −1 off the crust); in the Archean the plume sites
    /// (`hotspots`, `find_plume_sites`) and the stabilised share of the
    /// crust (`stabilisedFraction`); after the hand-over the volcanoes the
    /// map marks (`volcanoes`, `collect_volcanoes`).
    pub fn render(&mut self, scale: u32) -> Result<Value, EraError> {
        let stabilisation_epochs = self.archean_params.stabilisation_epochs;
        let (elevations, mantle, extras) = match &mut self.era {
            Era::Archean(a) => {
                let sources = RasterSources {
                    domain: &a.domain,
                    rafts: &a.rafts,
                    features: &[],
                    mantle: &a.mantle,
                    warp_seed: a.warp_seed,
                };
                let elevations =
                    elevation_raster(&sources, None, &mut a.meshes.mantle, scale as usize);
                let mantle = rasterise_mantle(&mut a.meshes.mantle, &a.mantle);
                // In the Archean, its own epoch is the era's length.
                let craton_age = compute_craton_oldness_field(
                    &a.rafts,
                    a.epoch,
                    a.epoch,
                    MANTLE_RES_X,
                    MANTLE_RES_Y,
                    &a.domain,
                );
                let hotspots = find_plume_sites(&a.mantle, &a.meshes.mantle, &a.domain, 0.0, &[]);
                let extras = vec![
                    ("cratonAge", Value::F32s(craton_age)),
                    (
                        "hotspots",
                        Value::List(hotspots.iter().map(forms::plume).collect()),
                    ),
                    (
                        "stabilisedFraction",
                        Value::Num(stabilised_fraction(&a.rafts, a.epoch, stabilisation_epochs)),
                    ),
                ];
                (elevations, mantle, extras)
            }
            Era::Plates { sim, coupled } => {
                let elevations = rasterise_node_field(
                    &mut coupled.mesh,
                    &coupled.z,
                    sim.width as usize,
                    sim.height as usize,
                );
                let mantle = rasterise_mantle(&mut sim.meshes.mantle, &sim.mantle);
                (elevations, mantle, plates_extras(sim))
            }
            Era::Moving => return Err(wrong("the world is between its eras")),
        };
        self.stages.rendered(elevations.clone());
        let mut out = value::ObjBuilder::new()
            .put("elevations", Value::F32s(elevations))
            .put("mantle", Value::F32s(mantle));
        for (key, v) in extras {
            out = out.put(key, v);
        }
        Ok(out.build())
    }

    /// The Archean as the save holds it: `{ snapshot, mantle, streak }`
    /// (the runtime's `serializeWorld` in the Archean).
    pub fn archean_save(&self) -> Result<Value, EraError> {
        let a = self.archean()?;
        let snap = serialize_archean(a);
        let snapshot = value::ObjBuilder::new()
            .num("width", snap.width)
            .num("height", snap.height)
            .num("epoch", snap.epoch)
            .num("warpSeed", snap.warp_seed)
            .opt_num("nucleationCredit", snap.nucleation_credit)
            .put(
                "rafts",
                Value::List(snap.rafts.iter().map(forms::raft).collect()),
            )
            .num("rngState", snap.rng_state)
            .build();
        Ok(value::ObjBuilder::new()
            .put("snapshot", snapshot)
            .put(
                "mantle",
                forms::saved_field(&saved_mantle(&a.meshes.mantle, &a.mantle)),
            )
            .put("streak", Value::I16s(a.upwelling_streak.clone()))
            .build())
    }

    /// A world restored in its Archean (the runtime's `restoreWorld` of an
    /// Archean save), with the Archean's controls.
    pub fn restore_archean(
        shape: Shape,
        snapshot: &Value,
        mantle: Option<&Value>,
        streak: &[i16],
        diffusion: f64,
        land_share: f64,
    ) -> Result<World, EraError> {
        let snap = read::archean_snapshot(snapshot)?;
        let domain = domain_of(shape, snap.width, snap.height);
        let mantle = mantle.map(read::saved_field).transpose()?;
        let meshes = world_meshes(&domain);
        let a = deserialize_archean(&snap, mantle.as_ref(), streak.to_vec(), domain, meshes)?;
        Ok(World {
            era: Era::Archean(Box::new(a)),
            archean_params: ArcheanParams {
                diffusion,
                land_share,
                ..default_archean_params()
            },
            stages: Default::default(),
        })
    }

    /// A world restored with its plates (the runtime's `restoreWorld` of a
    /// tectonic save): the simulation, the detection lattice's state where
    /// its size fits, and the history's terrain from the mesh payload —
    /// routed — or, without one, from the synthesis.
    /// The world a replay ended on, its terrain routed.
    pub(crate) fn replayed(sim: PlateSimulation, mut coupled: CoupledTerrain) -> World {
        if coupled.routing.is_none() {
            coupled.routing = Some(mesh_routing(
                &mut coupled.mesh,
                &coupled.z,
                &DEFAULT_SOLVER_PARAMS,
            ));
        }
        World {
            era: Era::Plates {
                sim: Box::new(sim),
                coupled: Box::new(coupled),
            },
            archean_params: default_archean_params(),
            stages: Default::default(),
        }
    }

    pub fn restore_plates(
        shape: Shape,
        snapshot: &Value,
        ocean_age: &Value,
        mantle: Option<&Value>,
        lattice: Option<&Value>,
        mesh: Option<&Value>,
    ) -> Result<World, EraError> {
        let snap = read::snapshot(snapshot)?;
        let domain = domain_of(shape, snap.width, snap.height);
        let ocean_age = read::saved_field(ocean_age)?;
        let mantle = mantle.map(read::saved_field).transpose()?;
        let meshes = world_meshes(&domain);
        let mut sim = Box::new(deserialize_plate_simulation(
            &snap,
            &ocean_age,
            mantle.as_ref(),
            domain,
            meshes,
        )?);
        if let Some(l) = lattice {
            let l = read::Fields::of(l, "the lattice")?;
            let get = |k: &str| l.get(k).ok_or_else(|| format!("the lattice has no {k}"));
            if let (Value::F32s(acc), Value::I16s(lock), Value::I8s(cls)) = (
                get("accumulated")?,
                get("lockedEpochs")?,
                get("lastClassCode")?,
            ) {
                if acc.len() == sim.lattice_accumulated.len() {
                    sim.lattice_accumulated.copy_from_slice(acc);
                    sim.lattice_locked_epochs.copy_from_slice(lock);
                    sim.lattice_last_class_code.copy_from_slice(cls);
                }
            } else {
                return Err(wrong(
                    "the lattice's arrays are not Float32, Int16 and Int8",
                ));
            }
        }
        let coupled = match mesh {
            Some(m) => {
                let f = read::Fields::of(m, "the mesh")?;
                let opt = |k: &str| f.get(k).map(|v| read::f32s(v, k)).transpose();
                let bytes = SavedTerrain {
                    nodes: read::f32s(
                        f.get("nodes")
                            .ok_or_else(|| wrong("the mesh has no nodes"))?,
                        "nodes",
                    )?,
                    connectivity: read::u8s(
                        f.get("connectivity")
                            .ok_or_else(|| wrong("the mesh has no connectivity"))?,
                        "connectivity",
                    )?,
                    z: read::f32s(f.get("z").ok_or_else(|| wrong("the mesh has no z"))?, "z")?,
                    column: f
                        .get("column")
                        .map(|v| read::u8s(v, "column"))
                        .transpose()?,
                    ice: opt("ice")?,
                    sediment_flux: opt("sedimentFlux")?,
                    pre_erosion_z: opt("preErosionZ")?,
                };
                let mut coupled = decode_coupled_terrain(&mut sim, &bytes)?;
                let routing = mesh_routing(&mut coupled.mesh, &coupled.z, &DEFAULT_SOLVER_PARAMS);
                coupled.routing = Some(routing);
                coupled
            }
            None => create_coupled_terrain(&mut sim, HISTORY_DEFAULTS.budget),
        };
        Ok(World {
            era: Era::Plates {
                sim,
                coupled: Box::new(coupled),
            },
            archean_params: default_archean_params(),
            stages: Default::default(),
        })
    }
}

#[cfg(test)]
mod seed_tests {
    /// The seeds as the world layer derived them until 2026-10-22
    /// (world/query.ts), for a real world's seed, a plain one and one
    /// with non-ASCII letters.
    #[test]
    fn seeds_are_the_world_layers() {
        for (seed, detail, litho) in [
            ("78923710", 1_671_205_072, 855_447_874),
            ("replay", 3_509_536_448, 2_152_648_530),
            ("räuber-öl", 1_132_283_730, 303_877_824),
        ] {
            assert_eq!(super::detail_seed(seed), detail, "detail seed of {seed}");
            assert_eq!(super::litho_seed(seed), litho, "litho seed of {seed}");
        }
    }
}

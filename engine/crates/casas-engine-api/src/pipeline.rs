//! The numbers the pipeline versions are derived from, under TypeScript's
//! names (docs/decisions/rust-engine.md, fork 7a): the world layer hashes
//! them (`world/worldTuning.ts`, `world/meshArtifacts.ts`,
//! `world/meshTileArtifacts.ts`). The tuning objects serialise themselves,
//! so a field added to one is in the versions without a list to extend;
//! the loose constants are the tables the engine keeps for the keys
//! (`amplify_constants`, `tile_constants`, `cube_constants`) and the few
//! named here. `make engine` writes them to `engine/dist/constants.json`.

use casas_engine::archean::archean_step::default_archean_params;
use casas_engine::archean::crust_nucleation::default_nucleation_params;
use casas_engine::climate::climate_tune_params::CLIMATE_TUNING;
use casas_engine::crust::crust_tune_params::{MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR};
use casas_engine::elevation::elevation_tune_params::ELEVATION_TUNING;
use casas_engine::elevation::erodibility_field::DEFAULT_ERODIBILITY_FIELD_PARAMS;
use casas_engine::mantle::mantle_tune_params::MANTLE_TUNING;
use casas_engine::mesh::mesh_column::COLUMN_TUNING;
use casas_engine::mesh::mesh_density::MESH_TUNING;
use casas_engine::mesh::mesh_erosion::DEFAULT_ROUTING_EVERY;
use casas_engine::mesh::mesh_tile::{TILE_SPECS, tile_constants};
use casas_engine::mesh::mesh_tile_cube::cube_constants;
use casas_engine::pipeline::coupled_epoch::HISTORY_DEFAULTS;
use casas_engine::pipeline::mesh_bake_stage::level_budget;
use casas_engine::surface::amplify::amplify_constants;
use casas_engine::surface::cover::{COVER_TUNING, cover_by_biome};
use casas_engine::surface::erosion_engine::{
    DEFAULT_SOLVER_PARAMS, DIFFUSION_PAIR_CAP, EPSILON_FLOOD_STEP,
};
use casas_engine::surface::erosion_forcing_fields::{LITHO_LATTICE_X, LITHO_LATTICE_Y};
use casas_engine::surface::river_course::RIVER_COURSE_MODEL_VERSION;
use casas_engine::surface::surface_tune_params::SURFACE_TUNING;
use casas_engine::tectonics::tectonics_tune_params::TECTONICS_TUNING;
use serde_json::{Map, Value, json};

fn object<K: Into<String>>(pairs: impl IntoIterator<Item = (K, f64)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .map(|(k, v)| (k.into(), json!(v)))
            .collect::<Map<_, _>>(),
    )
}

/// `{ tuning, amplify, bake, tiles, levelBudget }`: the history's tuning
/// by group (`worldTuning`'s groups, nested as TypeScript's objects), the
/// amplification's table, the bake's loose constants (`MESH_BAKE_CONSTANTS`
/// past the tuning), each tile level's cube and tile constants, and each
/// level's budget.
pub fn constants() -> Value {
    let tuning = json!({
        "archean": default_archean_params(),
        "nucleation": default_nucleation_params(),
        "climate": CLIMATE_TUNING,
        "crust": { "MERGE_OVERLAP_FACTOR": MERGE_OVERLAP_FACTOR, "RAFT_CONNECT_FACTOR": RAFT_CONNECT_FACTOR },
        "erodibility": DEFAULT_ERODIBILITY_FIELD_PARAMS,
        "elevation": ELEVATION_TUNING,
        "mantle": MANTLE_TUNING,
        "column": COLUMN_TUNING,
        "mesh": MESH_TUNING,
        "history": HISTORY_DEFAULTS,
        "cover": COVER_TUNING,
        "engine": DEFAULT_SOLVER_PARAMS,
        "surface": SURFACE_TUNING,
        "tectonics": TECTONICS_TUNING,
    });
    let mut bake = vec![
        ("lithoLatticeX".to_string(), LITHO_LATTICE_X),
        ("lithoLatticeY".to_string(), LITHO_LATTICE_Y),
        ("engineDiffusionPairCap".to_string(), DIFFUSION_PAIR_CAP),
        ("engineEpsilonFloodStep".to_string(), EPSILON_FLOOD_STEP),
        ("routingEvery".to_string(), DEFAULT_ROUTING_EVERY as f64),
        (
            "riverCourseModel".to_string(),
            RIVER_COURSE_MODEL_VERSION as f64,
        ),
    ];
    bake.extend(
        (0..=u8::MAX).filter_map(|id| cover_by_biome(id).map(|c| (format!("cover{id}"), c))),
    );
    let tiles = TILE_SPECS
        .iter()
        .map(|spec| {
            let mut pairs: Vec<(String, f64)> = cube_constants(spec.level)
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            pairs.extend(tile_constants(spec));
            (spec.level.to_string(), object(pairs))
        })
        .collect::<Map<_, _>>();
    json!({
        "tuning": tuning,
        "amplify": object(amplify_constants()),
        "bake": object(bake),
        "tiles": tiles,
        "levelBudget": object((0..=3u32).map(|l| (l.to_string(), level_budget(l)))),
    })
}

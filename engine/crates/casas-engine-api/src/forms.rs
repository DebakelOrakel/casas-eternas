//! The engine's state as the TypeScript types the world layer writes and
//! the screen reads (`PlateSimulationSnapshot`, `SimEvent`, `SavedField`,
//! the mesh payload), as value trees. Keys and shapes are the TypeScript
//! types'; their order is the TypeScript serializer's.

use casas_engine::crust::raft_types::{Raft, Suture};
use casas_engine::fields::field_mesh::SavedField;
use casas_engine::mesh::mesh_column::encode_column;
use casas_engine::mesh::mesh_serial::encode_mesh;
use casas_engine::pipeline::coupled_epoch::CoupledTerrain;
use casas_engine::tectonics::plate_motion::PlateMotion;
use casas_engine::tectonics::plate_simulation_types::{
    PlateSimulationSnapshot, SimEvent, SimEventType,
};
use casas_engine::tectonics::plumes::Plume;
use casas_engine::tectonics::terrain_features::{FeatureKind, MovesWith, TerrainFeature};

use crate::value::{ObjBuilder, Value};

fn motion(m: &PlateMotion) -> Value {
    match m {
        PlateMotion::Rigid(r) => ObjBuilder::new()
            .num("driftX", r.drift_x)
            .num("driftY", r.drift_y)
            .num("spin", r.spin)
            .num("centroidX", r.centroid_x)
            .num("centroidY", r.centroid_y)
            .build(),
        PlateMotion::Euler(e) => ObjBuilder::new()
            .num("poleX", e.pole_x)
            .num("poleY", e.pole_y)
            .num("poleZ", e.pole_z)
            .num("rate", e.rate)
            .build(),
    }
}

pub fn raft(r: &Raft) -> Value {
    let blobs = r
        .blobs
        .iter()
        .map(|b| {
            ObjBuilder::new()
                .num("x", b.x)
                .num("y", b.y)
                .num("radius", b.radius)
                .opt_num("birthEpoch", b.birth_epoch)
                .build()
        })
        .collect();
    ObjBuilder::new()
        .num("id", r.id)
        .put("name", Value::str_or_null(&r.name))
        .put("blobs", Value::List(blobs))
        .opt_num("noMergeUntilEpoch", r.no_merge_until_epoch)
        .build()
}

fn feature(f: &TerrainFeature) -> Value {
    ObjBuilder::new()
        .num("x", f.x)
        .num("y", f.y)
        .num("thickness", f.thickness)
        .num("tangentX", f.tangent_x)
        .num("tangentY", f.tangent_y)
        .put(
            "kind",
            Value::Str(
                match f.kind {
                    FeatureKind::Range => "range",
                    FeatureKind::Trench => "trench",
                }
                .into(),
            ),
        )
        .num("plateA", f.plate_a)
        .num("plateB", f.plate_b)
        .put(
            "movesWithPlate",
            match f.moves_with {
                MovesWith::Plate(p) => Value::num(p),
                MovesWith::Both => Value::Str("both".into()),
            },
        )
        .put("subsides", Value::Bool(f.subsides))
        .num("epochsSinceDeposit", f.epochs_since_deposit)
        .opt("volcanic", f.volcanic.map(Value::Bool))
        .opt_num("shorteningKmPerMyr", f.shortening_km_per_myr)
        .build()
}

fn plume(p: &Plume) -> Value {
    ObjBuilder::new()
        .num("x", p.x)
        .num("y", p.y)
        .num("id", p.id as f64)
        .num("birthEpoch", p.birth_epoch)
        .build()
}

fn suture(s: &Suture) -> Value {
    ObjBuilder::new()
        .num("x", s.x)
        .num("y", s.y)
        .num("tangentX", s.tangent_x)
        .num("tangentY", s.tangent_y)
        .num("epoch", s.epoch)
        .build()
}

/// `serializePlateSimulation`'s object, its keys in its order.
pub fn snapshot(s: &PlateSimulationSnapshot) -> Value {
    let list = |v: Vec<Value>| Value::List(v);
    ObjBuilder::new()
        .num("width", s.width)
        .num("height", s.height)
        .num("initialPlateCount", s.initial_plate_count)
        .put(
            "seeds",
            list(
                s.seeds
                    .iter()
                    .map(|p| ObjBuilder::new().num("x", p.x).num("y", p.y).build())
                    .collect(),
            ),
        )
        .put("motions", list(s.motions.iter().map(motion).collect()))
        .put("ages", Value::nums(&s.ages))
        .put("rafts", list(s.rafts.iter().map(raft).collect()))
        .put("features", list(s.features.iter().map(feature).collect()))
        .num("epoch", s.epoch)
        .opt_num("archeanEpochs", s.archean_epochs)
        .opt_num("epochMa", s.epoch_ma)
        .opt_num("sedimentExportM3", s.sediment_export_m3)
        .opt_num("eustaticM", s.eustatic_m)
        .opt(
            "climateHistory",
            s.climate_history.as_ref().map(|h| {
                list(
                    h.iter()
                        .map(|r| {
                            ObjBuilder::new()
                                .num("epoch", r.epoch)
                                .num("meanLandTempC", r.mean_land_temp_c)
                                .num("iceVolumeKm3", r.ice_volume_km3)
                                .num("seaLevelM", r.sea_level_m)
                                .build()
                        })
                        .collect(),
                )
            }),
        )
        .opt(
            "lakeAges",
            s.lake_ages.as_ref().map(|a| {
                list(
                    a.iter()
                        .map(|r| {
                            ObjBuilder::new()
                                .num("x", r.x)
                                .num("y", r.y)
                                .num("level", r.level)
                                .num("ageMa", r.age_ma)
                                .build()
                        })
                        .collect(),
                )
            }),
        )
        .num("warpSeed", s.warp_seed)
        .put("supercontinentActive", Value::Bool(s.supercontinent_active))
        .num(
            "continentalRiftCooldownUntil",
            s.continental_rift_cooldown_until,
        )
        .opt(
            "hotspots",
            s.hotspots
                .as_ref()
                .map(|h| list(h.iter().map(plume).collect())),
        )
        .opt(
            "sutures",
            s.sutures
                .as_ref()
                .map(|h| list(h.iter().map(suture).collect())),
        )
        .num("rngState", s.rng_state)
        .build()
}

fn event_type(t: SimEventType) -> &'static str {
    match t {
        SimEventType::ContinentCollided => "continent_collided",
        SimEventType::ContinentBrokeUp => "continent_broke_up",
        SimEventType::SupercontinentFormed => "supercontinent_formed",
        SimEventType::OceanicCreated => "oceanic_created",
        SimEventType::OceanicSubducted => "oceanic_subducted",
    }
}

/// A `SimEvent`.
pub fn event(e: &SimEvent) -> Value {
    let s = |v: &Option<String>| v.as_ref().map(|s| Value::Str(s.clone()));
    ObjBuilder::new()
        .put("type", Value::Str(event_type(e.kind).into()))
        .opt("name", s(&e.name))
        .opt("nameA", s(&e.name_a))
        .opt("nameB", s(&e.name_b))
        .opt_num("x", e.x)
        .opt_num("y", e.y)
        .opt_num("dirX", e.dir_x)
        .opt_num("dirY", e.dir_y)
        .opt_num("plateIndex", e.plate_index.map(|i| i as f64))
        .opt_num("otherPlateIndex", e.other_plate_index.map(|i| i as f64))
        .build()
}

/// A field mesh's values as the save holds them (`SavedField`).
pub fn saved_field(f: &SavedField) -> Value {
    ObjBuilder::new()
        .put("values", Value::F64s(f.values.clone()))
        .num("cells", f.cells as f64)
        .num("spacingM", f.spacing_m)
        .build()
}

/// The coupled terrain as the save's bytes (the runtime's
/// `serializeMeshTerrain` over the coupled terrain): the mesh's codec,
/// the heights, the column, and what the last epoch left.
pub fn mesh_payload(t: &CoupledTerrain) -> Value {
    let order: Vec<i32> = (0..t.mesh.alive_vertices as i32).collect();
    let serial = encode_mesh(&t.mesh, &order);
    let count = serial.count;
    let z = t.z[..count].to_vec();
    let per_node = |values: &[f32], fallback: &[f32]| -> Vec<f32> {
        if values.len() >= count {
            values[..count].to_vec()
        } else {
            fallback.to_vec()
        }
    };
    let zeros = vec![0f32; count];
    ObjBuilder::new()
        .num("count", count as f64)
        .put("nodes", Value::F32s(serial.nodes))
        .put("connectivity", Value::U8s(serial.connectivity))
        .put("z", Value::F32s(z.clone()))
        .put("column", Value::U8s(encode_column(&t.column, count)))
        .put(
            "sedimentFlux",
            Value::F32s(per_node(&t.sediment_flux, &zeros)),
        )
        .put("preErosionZ", Value::F32s(per_node(&t.pre_erosion_z, &z)))
        .opt(
            "ice",
            (t.ice.len() >= count).then(|| Value::F32s(t.ice[..count].to_vec())),
        )
        .build()
}

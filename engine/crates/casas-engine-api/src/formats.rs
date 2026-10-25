//! The formats of what the engine's results become on a disk
//! (docs/decisions/rust-engine.md, fork 7b, "the seam"): a level's and a
//! tile's files as the artifact store keeps them, and the river graph as a
//! level and a save hold it. Written here, so their bytes are the
//! engine's; the world layer moves the files and writes their meta.
//!
//! The JSON in them is `JSON.stringify`'s, byte for byte (`js_json`): the
//! world layer wrote these files until 2026-10-22, and an artifact keeps
//! its bytes under its key.

use std::borrow::Cow;
use std::fmt::Write as _;

use crate::value::{ObjBuilder, Value};
use crate::{EraError, wrong};

/// A level's files (`world/meshArtifacts.ts`, `MESH_LEVEL_FILES`).
pub const LEVEL_NODES: &str = "meshNodes.f32";
pub const LEVEL_CONNECTIVITY: &str = "meshConnectivity.bin";
pub const LEVEL_Z: &str = "meshZ.f32";
pub const LEVEL_WATER_BODIES: &str = "waterBodies.json";
pub const LEVEL_RIVER_GRAPH: &str = "riverGraph.json";
pub const LEVEL_RIVER_GRAPH_CELLS: &str = "riverGraphCells.i32";
pub const LEVEL_RIVER_GRAPH_POSITIONS: &str = "riverGraphPositions.f32";
pub const LEVEL_RIVER_COURSE_POINTS: &str = "riverCoursePoints.f32";
pub const LEVEL_RIVER_POINTS: &str = "rivers.f32";
pub const LEVEL_RIVER_LENGTHS: &str = "riverLengths.u32";
pub const LEVEL_RIVER_REGIMES: &str = "riverRegimes.u8";
// The land fields (`forms::LevelLand`, docs/decisions/level-waters.md):
// a byte or a 16-bit code a node (`land_codes`), the features' points.
pub const LEVEL_LAND: &str = "land.json";
pub const LEVEL_LAND_MASK: &str = "landMask.u8";
pub const LEVEL_BIOME: &str = "biome.u8";
pub const LEVEL_ECOLOGY_BIOME: &str = "ecologyBiome.u8";
pub const LEVEL_KOPPEN: &str = "koppen.u8";
pub const LEVEL_SALT_FLAT: &str = "saltFlat.u8";
pub const LEVEL_DISCHARGE: &str = "discharge.u16";
pub const LEVEL_LAKE_DEPTH: &str = "lakeDepth.u16";
pub const LEVEL_WATER_TABLE: &str = "waterTable.u16";
pub const LEVEL_CRATON_AGE: &str = "cratonAge.u16";
pub const LEVEL_OASES: &str = "oases.f64";
pub const LEVEL_VOLCANOES: &str = "volcanoes.f64";
pub const LEVEL_OROGEN_POINTS: &str = "orogenPoints.f64";
// The ecology's fields after an ecology run: their ids in
// `ecology.json`, each a byte a node in `eco.<id>.u8`, as the screen's fine
// fields are coded (`encode_fine_field`).
pub const LEVEL_ECOLOGY: &str = "ecology.json";
fn level_ecology_file(id: &str) -> String {
    format!("eco.{id}.u8")
}

/// The land fields' 16-bit codes (docs/decisions/level-waters.md, fork
/// 3), set from the ranges measured on Morvane (2026-10-25): its discharge
/// per node 2.7 … 2.2 · 10⁷, its lakes to 0.46 deep (elevation units), its
/// water table to 6 146 m, its craton age −1 … 0.76.
pub mod land_codes {
    use casas_engine::core::det_math::{det_exp, det_log};
    use std::f64::consts::LN_10;

    /// The discharge: 0 for none, else logarithmic over 10^LOG_MIN …
    /// 10^LOG_MAX, a step 0.046 % of the value. By the engine's own log
    /// and exp, so the native build and WASM write the same codes.
    pub const DISCHARGE_LOG_MIN: f64 = -3.0;
    pub const DISCHARGE_LOG_MAX: f64 = 10.0;
    /// The lake depth, elevation units (1 = ELEVATION_METERS): linear over
    /// 0 … LAKE_DEPTH_MAX, a step 14 cm.
    pub const LAKE_DEPTH_MAX: f64 = 1.0;
    /// The water table's depth, metres: a step WATER_TABLE_STEP_M, so to
    /// 16 383.5 m; the top code is the field's −1 (under water).
    pub const WATER_TABLE_STEP_M: f64 = 0.25;
    /// The craton age (the oldness's share, −1 at sea): linear over −1 … 1.
    pub const CRATON_AGE_MIN: f64 = -1.0;
    pub const CRATON_AGE_MAX: f64 = 1.0;

    const TOP: f64 = 65535.0;

    fn linear(v: f64, min: f64, max: f64) -> u16 {
        (((v - min) / (max - min)) * TOP).round().clamp(0.0, TOP) as u16
    }

    pub fn discharge(v: f32) -> u16 {
        let v = v as f64;
        if v.is_nan() || v <= 0.0 {
            return 0;
        }
        let t = (det_log(v) / LN_10 - DISCHARGE_LOG_MIN) / (DISCHARGE_LOG_MAX - DISCHARGE_LOG_MIN);
        1 + (t * (TOP - 1.0)).round().clamp(0.0, TOP - 1.0) as u16
    }
    pub fn discharge_of(c: u16) -> f32 {
        if c == 0 {
            return 0.0;
        }
        let t = (c - 1) as f64 / (TOP - 1.0);
        det_exp((DISCHARGE_LOG_MIN + t * (DISCHARGE_LOG_MAX - DISCHARGE_LOG_MIN)) * LN_10) as f32
    }
    pub fn lake_depth(v: f32) -> u16 {
        linear(v as f64, 0.0, LAKE_DEPTH_MAX)
    }
    pub fn lake_depth_of(c: u16) -> f32 {
        (c as f64 / TOP * LAKE_DEPTH_MAX) as f32
    }
    pub fn water_table(v: f32) -> u16 {
        if v < 0.0 {
            return TOP as u16;
        }
        (v as f64 / WATER_TABLE_STEP_M)
            .round()
            .clamp(0.0, TOP - 1.0) as u16
    }
    pub fn water_table_of(c: u16) -> f32 {
        if c == TOP as u16 {
            return -1.0;
        }
        (c as f64 * WATER_TABLE_STEP_M) as f32
    }
    pub fn craton_age(v: f32) -> u16 {
        linear(v as f64, CRATON_AGE_MIN, CRATON_AGE_MAX)
    }
    pub fn craton_age_of(c: u16) -> f32 {
        (CRATON_AGE_MIN + c as f64 / TOP * (CRATON_AGE_MAX - CRATON_AGE_MIN)) as f32
    }
}

/// A tile's files (`world/meshTileArtifacts.ts`, `MESH_TILE_FILES`).
pub const TILE_NODES: &str = "tileNodes.f32";
pub const TILE_TRIANGLES: &str = "tileTriangles.u32";
pub const TILE_Z: &str = "tileZ.f32";
pub const TILE_ROLE: &str = "tileRole.u8";
pub const TILE_OUTFLOW: &str = "tileOutflow.f32";

/// A value as `JSON.stringify` writes it: the keys in their order, a
/// number as JavaScript's `String(n)` (`ryu_js`), a non-finite one as
/// `null`, a typed array as an object of its indices.
pub fn js_json(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v);
    out
}

fn write_number(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(ryu_js::Buffer::new().format(x));
    } else {
        out.push_str("null");
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_indexed<T: Copy + Into<f64>>(out: &mut String, a: &[T]) {
    out.push('{');
    for (i, x) in a.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "\"{i}\":");
        write_number(out, (*x).into());
    }
    out.push('}');
}

fn write_json(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(x) => write_number(out, *x),
        Value::Str(s) => write_string(out, s),
        Value::List(l) => {
            out.push('[');
            for (i, x) in l.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, x);
            }
            out.push(']');
        }
        Value::Obj(fields) => {
            out.push('{');
            for (i, (k, x)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_json(out, x);
            }
            out.push('}');
        }
        Value::F64s(a) => write_indexed(out, a),
        Value::F32s(a) => write_indexed(out, a),
        Value::I32s(a) => write_indexed(out, a),
        Value::I16s(a) => write_indexed(out, a),
        Value::I8s(a) => write_indexed(out, a),
        Value::U32s(a) => write_indexed(out, a),
        Value::U16s(a) => write_indexed(out, a),
        Value::U8s(a) => write_indexed(out, a),
    }
}

/// A typed array's bytes, little-endian, as `new Uint8Array(a.buffer)`
/// gives them on every platform the engine runs on.
fn bytes(v: &Value) -> Result<Vec<u8>, EraError> {
    Ok(match v {
        Value::F32s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::F64s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::I32s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::U32s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::I16s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::U16s(a) => a.iter().flat_map(|x| x.to_le_bytes()).collect(),
        Value::I8s(a) => a.iter().map(|&x| x as u8).collect(),
        Value::U8s(a) => a.clone(),
        _ => return Err(wrong("a file's array is not a typed array")),
    })
}

fn field<'a>(v: &'a Value, key: &str, what: &str) -> Result<&'a Value, EraError> {
    match v {
        Value::Obj(fields) => fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, x)| x)
            .ok_or_else(|| EraError(format!("{what} has no {key}"))),
        _ => Err(EraError(format!("{what} is not an object"))),
    }
}

fn given<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Obj(fields) => fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, x)| x)
            .filter(|x| !matches!(x, Value::Null)),
        _ => None,
    }
}

/// A river graph as a level and a save keep it (`serializeRiverGraph`):
/// `{ json, cells, coursePoints, positions? }` — the graph's JSON without
/// its cells and their positions, each course's lines and oxbows as
/// `[offset, points]` into `coursePoints`; the cells; every course's
/// points, its lines then its oxbows, course by course; for a graph on the
/// mesh, every cell's position, x and y.
pub fn river_graph_parts(graph: &Value) -> Result<Value, EraError> {
    let Value::Obj(fields) = graph else {
        return Err(wrong("the river graph is not an object"));
    };
    let mut points: Vec<f32> = Vec::new();
    let mut describe = |line: &Value| -> Result<Value, EraError> {
        let Value::F32s(l) = line else {
            return Err(wrong("a course's line is not a Float32Array"));
        };
        let d = Value::List(vec![
            Value::num((points.len() / 2) as f64),
            Value::num((l.len() / 2) as f64),
        ]);
        points.extend_from_slice(l);
        Ok(d)
    };
    let mut rest: Vec<(Cow<'static, str>, Value)> = Vec::new();
    let mut courses: Option<Value> = None;
    for (k, v) in fields {
        match k.as_ref() {
            "cells" | "cellX" | "cellY" => {}
            "courses" => {
                let Value::List(list) = v else {
                    return Err(wrong("the river graph's courses are not a list"));
                };
                let mut out = Vec::with_capacity(list.len());
                for c in list {
                    let Value::Obj(cf) = c else {
                        return Err(wrong("a river course is not an object"));
                    };
                    let lines = field(c, "lines", "a river course")?;
                    let oxbows = field(c, "oxbows", "a river course")?;
                    let (Value::List(lines), Value::List(oxbows)) = (lines, oxbows) else {
                        return Err(wrong("a course's lines are not a list"));
                    };
                    let lines =
                        Value::List(lines.iter().map(&mut describe).collect::<Result<_, _>>()?);
                    let oxbows =
                        Value::List(oxbows.iter().map(&mut describe).collect::<Result<_, _>>()?);
                    out.push(Value::Obj(
                        cf.iter()
                            .map(|(ck, cv)| {
                                let cv = match ck.as_ref() {
                                    "lines" => lines.clone(),
                                    "oxbows" => oxbows.clone(),
                                    _ => cv.clone(),
                                };
                                (ck.clone(), cv)
                            })
                            .collect(),
                    ));
                }
                courses = Some(Value::List(out));
            }
            _ => rest.push((k.clone(), v.clone())),
        }
    }
    if let Some(c) = courses {
        rest.push((Cow::Borrowed("courses"), c));
    }
    let on_mesh =
        matches!(field(graph, "substrate", "the river graph")?, Value::Str(s) if s == "mesh");
    let positions = if on_mesh {
        let (Value::F32s(x), Value::F32s(y)) = (
            field(graph, "cellX", "the river graph")?,
            field(graph, "cellY", "the river graph")?,
        ) else {
            return Err(wrong("the river graph's positions are not Float32Arrays"));
        };
        Some(Value::F32s(
            x.iter().zip(y).flat_map(|(&a, &b)| [a, b]).collect(),
        ))
    } else {
        None
    };
    Ok(ObjBuilder::new()
        .put("json", Value::Str(js_json(&Value::Obj(rest))))
        .put("cells", field(graph, "cells", "the river graph")?.clone())
        .put("coursePoints", Value::F32s(points))
        .opt("positions", positions)
        .build())
}

/// A level's files (`writeMeshLevelArtifact`), `{ name: bytes }` in the
/// order the world layer writes them: the mesh, the heights, the water
/// bodies, the river graph's four when there is one, the river lines'
/// three when there are.
pub fn level_files(artifact: &Value) -> Result<Value, EraError> {
    let what = "the level";
    let mut files = ObjBuilder::new()
        .put(
            LEVEL_NODES,
            Value::U8s(bytes(field(artifact, "nodes", what)?)?),
        )
        .put(
            LEVEL_CONNECTIVITY,
            Value::U8s(bytes(field(artifact, "connectivity", what)?)?),
        )
        .put(LEVEL_Z, Value::U8s(bytes(field(artifact, "z", what)?)?))
        .put(
            LEVEL_WATER_BODIES,
            Value::U8s(js_json(field(artifact, "waterBodies", what)?).into_bytes()),
        );
    if let Some(graph) = given(artifact, "graph") {
        let parts = river_graph_parts(graph)?;
        let Value::Str(json) = field(&parts, "json", "the river graph's parts")? else {
            return Err(wrong("the river graph's JSON is not a string"));
        };
        files = files
            .put(LEVEL_RIVER_GRAPH, Value::U8s(json.clone().into_bytes()))
            .put(
                LEVEL_RIVER_GRAPH_CELLS,
                Value::U8s(bytes(field(&parts, "cells", "the river graph's parts")?)?),
            )
            .put(
                LEVEL_RIVER_GRAPH_POSITIONS,
                Value::U8s(match given(&parts, "positions") {
                    Some(p) => bytes(p)?,
                    None => Vec::new(),
                }),
            )
            .put(
                LEVEL_RIVER_COURSE_POINTS,
                Value::U8s(bytes(field(
                    &parts,
                    "coursePoints",
                    "the river graph's parts",
                )?)?),
            );
    }
    if let Some(rivers) = given(artifact, "rivers") {
        files = files
            .put(
                LEVEL_RIVER_POINTS,
                Value::U8s(bytes(field(rivers, "points", "the river lines")?)?),
            )
            .put(
                LEVEL_RIVER_LENGTHS,
                Value::U8s(bytes(field(rivers, "lengths", "the river lines")?)?),
            )
            .put(
                LEVEL_RIVER_REGIMES,
                Value::U8s(bytes(field(rivers, "regimes", "the river lines")?)?),
            );
    }
    if let Some(land) = given(artifact, "land") {
        files = level_land_files(files, land)?;
    }
    Ok(files.build())
}

/// The land fields' files (`forms::LevelLand`): the bytes as they are,
/// the measures in their 16-bit codes (`land_codes`), the points as
/// doubles, the maximum discharge in `land.json`.
fn level_land_files(files: ObjBuilder, land: &Value) -> Result<ObjBuilder, EraError> {
    let what = "the level's land";
    let u8s = |k: &str| -> Result<Vec<u8>, EraError> {
        match field(land, k, what)? {
            Value::U8s(a) => Ok(a.clone()),
            _ => Err(EraError(format!("{what}'s {k} is not bytes"))),
        }
    };
    let coded = |v: &Value, k: &str, code: fn(f32) -> u16| -> Result<Vec<u8>, EraError> {
        match v {
            Value::F32s(a) => Ok(a.iter().flat_map(|&x| code(x).to_le_bytes()).collect()),
            _ => Err(EraError(format!("{what}'s {k} is not Float32s"))),
        }
    };
    let measure = |k: &str, code: fn(f32) -> u16| coded(field(land, k, what)?, k, code);
    let Value::Num(max_discharge) = field(land, "maxDischarge", what)? else {
        return Err(wrong("the level's land has no maximum discharge"));
    };
    let meta = ObjBuilder::new()
        .num("maxDischarge", *max_discharge)
        .build();
    let mut files = files
        .put(LEVEL_LAND, Value::U8s(js_json(&meta).into_bytes()))
        .put(LEVEL_LAND_MASK, Value::U8s(u8s("land")?))
        .put(LEVEL_BIOME, Value::U8s(u8s("biome")?))
        .put(LEVEL_ECOLOGY_BIOME, Value::U8s(u8s("ecologyBiome")?))
        .put(LEVEL_KOPPEN, Value::U8s(u8s("koppen")?))
        .put(LEVEL_SALT_FLAT, Value::U8s(u8s("saltFlat")?))
        .put(
            LEVEL_DISCHARGE,
            Value::U8s(measure("discharge", land_codes::discharge)?),
        )
        .put(
            LEVEL_LAKE_DEPTH,
            Value::U8s(measure("lakeDepth", land_codes::lake_depth)?),
        )
        .put(
            LEVEL_CRATON_AGE,
            Value::U8s(measure("cratonAge", land_codes::craton_age)?),
        )
        .put(LEVEL_OASES, Value::U8s(bytes(field(land, "oases", what)?)?))
        .put(
            LEVEL_VOLCANOES,
            Value::U8s(bytes(field(land, "volcanoes", what)?)?),
        )
        .put(
            LEVEL_OROGEN_POINTS,
            Value::U8s(bytes(field(land, "orogenPoints", what)?)?),
        );
    if let Some(Value::Obj(fields)) = given(land, "ecology")
        && !fields.is_empty()
    {
        let ids = Value::List(
            fields
                .iter()
                .map(|(id, _)| Value::Str(id.to_string()))
                .collect(),
        );
        files = files.put(LEVEL_ECOLOGY, Value::U8s(js_json(&ids).into_bytes()));
        for (id, codes) in fields {
            files = files.put_owned(level_ecology_file(id), Value::U8s(bytes(codes)?));
        }
    }
    if let Some(table) = given(land, "waterTable") {
        files = files.put(
            LEVEL_WATER_TABLE,
            Value::U8s(coded(table, "waterTable", land_codes::water_table)?),
        );
    }
    Ok(files)
}

/// A tile's files (`writeMeshTileArtifact`), `{ name: bytes }`.
pub fn tile_files(artifact: &Value) -> Result<Value, EraError> {
    let what = "the tile";
    Ok(ObjBuilder::new()
        .put(
            TILE_NODES,
            Value::U8s(bytes(field(artifact, "nodes", what)?)?),
        )
        .put(
            TILE_TRIANGLES,
            Value::U8s(bytes(field(artifact, "triangles", what)?)?),
        )
        .put(TILE_Z, Value::U8s(bytes(field(artifact, "z", what)?)?))
        .put(
            TILE_ROLE,
            Value::U8s(bytes(field(artifact, "role", what)?)?),
        )
        .put(
            TILE_OUTFLOW,
            Value::U8s(bytes(field(artifact, "outflow", what)?)?),
        )
        .build())
}

// ---- Reading ----------------------------------------------------------

/// JSON read as `JSON.parse` reads it, into a `Value`: the keys in their
/// order (a `serde_json::Map` sorts them), every number a double, rounded
/// correctly (`float_roundtrip`).
pub fn parse_json(text: &str) -> Result<Value, EraError> {
    serde_json::from_str::<Ordered>(text)
        .map(|o| o.0)
        .map_err(|e| EraError(format!("not JSON: {e}")))
}

struct Ordered(Value);

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_any(OrderedVisitor).map(Ordered)
    }
}

struct OrderedVisitor;

impl<'de> serde::de::Visitor<'de> for OrderedVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E>(self, b: bool) -> Result<Value, E> {
        Ok(Value::Bool(b))
    }
    fn visit_i64<E>(self, x: i64) -> Result<Value, E> {
        Ok(Value::Num(x as f64))
    }
    fn visit_u64<E>(self, x: u64) -> Result<Value, E> {
        Ok(Value::Num(x as f64))
    }
    fn visit_f64<E>(self, x: f64) -> Result<Value, E> {
        Ok(Value::Num(x))
    }
    fn visit_str<E>(self, s: &str) -> Result<Value, E> {
        Ok(Value::Str(s.to_string()))
    }
    fn visit_string<E>(self, s: String) -> Result<Value, E> {
        Ok(Value::Str(s))
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(Ordered(v)) = seq.next_element()? {
            out.push(v);
        }
        Ok(Value::List(out))
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut out: Vec<(Cow<'static, str>, Value)> = Vec::new();
        while let Some((k, Ordered(v))) = map.next_entry::<String, Ordered>()? {
            out.push((Cow::Owned(k), v));
        }
        Ok(Value::Obj(out))
    }
}

fn file<'a>(files: &'a Value, name: &str) -> Result<&'a [u8], EraError> {
    match field(files, name, "the files")? {
        Value::U8s(b) => Ok(b),
        _ => Err(EraError(format!("{name} is not bytes"))),
    }
}

fn optional_file<'a>(files: &'a Value, name: &str) -> Option<&'a [u8]> {
    match given(files, name) {
        Some(Value::U8s(b)) => Some(b),
        _ => None,
    }
}

/// A file's words, little-endian; `kind` names them for a file that is
/// not whole ones.
fn words<const N: usize, T>(
    b: &[u8],
    name: &str,
    kind: &str,
    word: fn([u8; N]) -> T,
) -> Result<Vec<T>, EraError> {
    let (chunks, rest) = b.as_chunks::<N>();
    if !rest.is_empty() {
        return Err(EraError(format!("{name} is not whole {kind}")));
    }
    Ok(chunks.iter().map(|&c| word(c)).collect())
}

fn f32s_of(b: &[u8], name: &str) -> Result<Vec<f32>, EraError> {
    words(b, name, "Float32s", f32::from_le_bytes)
}

fn i32s_of(b: &[u8], name: &str) -> Result<Vec<i32>, EraError> {
    words(b, name, "Int32s", i32::from_le_bytes)
}

fn u32s_of(b: &[u8], name: &str) -> Result<Vec<u32>, EraError> {
    words(b, name, "Uint32s", u32::from_le_bytes)
}

fn json_of(b: &[u8], name: &str) -> Result<Value, EraError> {
    let text = std::str::from_utf8(b).map_err(|_| EraError(format!("{name} is not UTF-8")))?;
    parse_json(text)
}

/// A river graph from its parts (`river_graph_parts`' inverse): the
/// cells' positions back from `positions`, every course's lines and
/// oxbows back from `coursePoints`; in the key order the engine gives a
/// graph (`forms::river_graph`), so that its parts come out the same.
pub fn river_graph_of_parts(
    json: &Value,
    cells: Vec<i32>,
    course_points: &[f32],
    positions: &[f32],
) -> Result<Value, EraError> {
    let Value::Obj(fields) = json else {
        return Err(wrong("the river graph is not an object"));
    };
    if !matches!(field(json, "substrate", "the river graph")?, Value::Str(s) if s == "mesh") {
        return Err(wrong("the river graph is not on the mesh"));
    }
    if positions.len() != cells.len() * 2 {
        return Err(wrong("the river graph's positions are not its cells'"));
    }
    let slice = |d: &Value| -> Result<Value, EraError> {
        let Value::List(d) = d else {
            return Err(wrong("a course's line is not [offset, points]"));
        };
        let (Some(Value::Num(start)), Some(Value::Num(count))) = (d.first(), d.get(1)) else {
            return Err(wrong("a course's line is not [offset, points]"));
        };
        let (start, end) = (*start as usize * 2, (*start + *count) as usize * 2);
        course_points
            .get(start..end)
            .map(|p| Value::F32s(p.to_vec()))
            .ok_or_else(|| wrong("a course's line is outside its points"))
    };
    let lines = |v: &Value| -> Result<Value, EraError> {
        let Value::List(l) = v else {
            return Err(wrong("a course's lines are not a list"));
        };
        Ok(Value::List(l.iter().map(slice).collect::<Result<_, _>>()?))
    };
    let mut cells = Some(cells);
    let mut out: Vec<(Cow<'static, str>, Value)> = Vec::new();
    for (k, v) in fields {
        match k.as_ref() {
            "courses" => {
                let Value::List(list) = v else {
                    return Err(wrong("the river graph's courses are not a list"));
                };
                let mut courses = Vec::with_capacity(list.len());
                for c in list {
                    let Value::Obj(cf) = c else {
                        return Err(wrong("a river course is not an object"));
                    };
                    courses.push(Value::Obj(
                        cf.iter()
                            .map(|(ck, cv)| {
                                Ok((
                                    ck.clone(),
                                    match ck.as_ref() {
                                        "lines" | "oxbows" => lines(cv)?,
                                        _ => cv.clone(),
                                    },
                                ))
                            })
                            .collect::<Result<_, EraError>>()?,
                    ));
                }
                out.push((k.clone(), Value::List(courses)));
            }
            _ => out.push((k.clone(), v.clone())),
        }
        if k == "reaches"
            && let Some(cells) = cells.take()
        {
            out.push((Cow::Borrowed("cells"), Value::I32s(cells)));
            out.push((
                Cow::Borrowed("cellX"),
                Value::F32s(positions.iter().step_by(2).copied().collect()),
            ));
            out.push((
                Cow::Borrowed("cellY"),
                Value::F32s(positions.iter().skip(1).step_by(2).copied().collect()),
            ));
        }
    }
    if cells.is_some() {
        return Err(wrong("the river graph has no reaches"));
    }
    Ok(Value::Obj(out))
}

/// A level's arrays and waters from its files (`level_files`' inverse):
/// `{ nodes, connectivity, z, waterBodies, graph, rivers }`, the graph and
/// the river lines null where the level has none. The level's number and
/// node count are its meta's, the world layer's.
pub fn level_of_files(files: &Value) -> Result<Value, EraError> {
    let graph = match optional_file(files, LEVEL_RIVER_GRAPH) {
        Some(json) => river_graph_of_parts(
            &json_of(json, LEVEL_RIVER_GRAPH)?,
            i32s_of(
                file(files, LEVEL_RIVER_GRAPH_CELLS)?,
                LEVEL_RIVER_GRAPH_CELLS,
            )?,
            &f32s_of(
                optional_file(files, LEVEL_RIVER_COURSE_POINTS).unwrap_or(&[]),
                LEVEL_RIVER_COURSE_POINTS,
            )?,
            &f32s_of(
                file(files, LEVEL_RIVER_GRAPH_POSITIONS)?,
                LEVEL_RIVER_GRAPH_POSITIONS,
            )?,
        )?,
        None => Value::Null,
    };
    let rivers = match (
        optional_file(files, LEVEL_RIVER_POINTS),
        optional_file(files, LEVEL_RIVER_LENGTHS),
        optional_file(files, LEVEL_RIVER_REGIMES),
    ) {
        (Some(points), Some(lengths), Some(regimes)) => ObjBuilder::new()
            .put("points", Value::F32s(f32s_of(points, LEVEL_RIVER_POINTS)?))
            .put(
                "lengths",
                Value::U32s(u32s_of(lengths, LEVEL_RIVER_LENGTHS)?),
            )
            .put("regimes", Value::U8s(regimes.to_vec()))
            .build(),
        _ => Value::Null,
    };
    Ok(ObjBuilder::new()
        .put(
            "nodes",
            Value::F32s(f32s_of(file(files, LEVEL_NODES)?, LEVEL_NODES)?),
        )
        .put(
            "connectivity",
            Value::U8s(file(files, LEVEL_CONNECTIVITY)?.to_vec()),
        )
        .put("z", Value::F32s(f32s_of(file(files, LEVEL_Z)?, LEVEL_Z)?))
        .put(
            "waterBodies",
            json_of(file(files, LEVEL_WATER_BODIES)?, LEVEL_WATER_BODIES)?,
        )
        .put("graph", graph)
        .put("rivers", rivers)
        .put(
            "land",
            match optional_file(files, LEVEL_LAND) {
                Some(meta) => level_land_of(files, &json_of(meta, LEVEL_LAND)?)?,
                None => Value::Null,
            },
        )
        .build())
}

/// The land fields from their files (`level_land_files`' inverse), the
/// measures decoded, in the keys' order of `forms::LevelLand`.
fn level_land_of(files: &Value, meta: &Value) -> Result<Value, EraError> {
    let decoded = |name: &str, of: fn(u16) -> f32| -> Result<Value, EraError> {
        let codes = words(file(files, name)?, name, "Uint16s", u16::from_le_bytes)?;
        Ok(Value::F32s(codes.into_iter().map(of).collect()))
    };
    let doubles = |name: &str| -> Result<Value, EraError> {
        Ok(Value::F64s(words(
            file(files, name)?,
            name,
            "Float64s",
            f64::from_le_bytes,
        )?))
    };
    let Value::Num(max_discharge) = field(meta, "maxDischarge", LEVEL_LAND)? else {
        return Err(EraError(format!("{LEVEL_LAND} has no maximum discharge")));
    };
    Ok(ObjBuilder::new()
        .put("land", Value::U8s(file(files, LEVEL_LAND_MASK)?.to_vec()))
        .put("biome", Value::U8s(file(files, LEVEL_BIOME)?.to_vec()))
        .put(
            "ecologyBiome",
            Value::U8s(file(files, LEVEL_ECOLOGY_BIOME)?.to_vec()),
        )
        .put("koppen", Value::U8s(file(files, LEVEL_KOPPEN)?.to_vec()))
        .put(
            "discharge",
            decoded(LEVEL_DISCHARGE, land_codes::discharge_of)?,
        )
        .put(
            "lakeDepth",
            decoded(LEVEL_LAKE_DEPTH, land_codes::lake_depth_of)?,
        )
        .put(
            "saltFlat",
            Value::U8s(file(files, LEVEL_SALT_FLAT)?.to_vec()),
        )
        .put(
            "waterTable",
            match optional_file(files, LEVEL_WATER_TABLE) {
                Some(_) => decoded(LEVEL_WATER_TABLE, land_codes::water_table_of)?,
                None => Value::Null,
            },
        )
        .put(
            "cratonAge",
            decoded(LEVEL_CRATON_AGE, land_codes::craton_age_of)?,
        )
        .put("oases", doubles(LEVEL_OASES)?)
        .put("volcanoes", doubles(LEVEL_VOLCANOES)?)
        .put("orogenPoints", doubles(LEVEL_OROGEN_POINTS)?)
        .num("maxDischarge", *max_discharge)
        .put("ecology", level_ecology_of(files)?)
        .build())
}

/// The ecology's fields from their files, the bytes as they are; none
/// without `ecology.json`.
fn level_ecology_of(files: &Value) -> Result<Value, EraError> {
    let Some(list) = optional_file(files, LEVEL_ECOLOGY) else {
        return Ok(Value::Obj(Vec::new()));
    };
    let Value::List(ids) = json_of(list, LEVEL_ECOLOGY)? else {
        return Err(EraError(format!("{LEVEL_ECOLOGY} is not a list")));
    };
    let mut fields = Vec::new();
    for id in ids {
        let Value::Str(id) = id else {
            return Err(EraError(format!(
                "{LEVEL_ECOLOGY} names a field by no string"
            )));
        };
        let codes = file(files, &level_ecology_file(&id))?.to_vec();
        fields.push((Cow::Owned(id), Value::U8s(codes)));
    }
    Ok(Value::Obj(fields))
}

/// A tile's arrays from its files (`tile_files`' inverse): `{ nodes,
/// triangles, z, role, outflow }`. The tile and its node count are its
/// meta's, the world layer's.
pub fn tile_of_files(files: &Value) -> Result<Value, EraError> {
    Ok(ObjBuilder::new()
        .put(
            "nodes",
            Value::F32s(f32s_of(file(files, TILE_NODES)?, TILE_NODES)?),
        )
        .put(
            "triangles",
            Value::U32s(u32s_of(file(files, TILE_TRIANGLES)?, TILE_TRIANGLES)?),
        )
        .put("z", Value::F32s(f32s_of(file(files, TILE_Z)?, TILE_Z)?))
        .put("role", Value::U8s(file(files, TILE_ROLE)?.to_vec()))
        .put(
            "outflow",
            Value::F32s(f32s_of(file(files, TILE_OUTFLOW)?, TILE_OUTFLOW)?),
        )
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_is_javascripts() {
        let v = ObjBuilder::new()
            .num("a", 1.0)
            .num("b", -0.0)
            .num("c", 0.1)
            .num("d", 1e21)
            .num("e", 1.5e-7)
            .num("f", f64::NAN)
            .put("g", Value::Str("x\"\n\u{1}".into()))
            .put("h", Value::F32s(vec![0.5, 2.0]))
            .put("i", Value::List(vec![Value::Bool(true), Value::Null]))
            .num("j", 0.1f32 as f64)
            .build();
        assert_eq!(
            js_json(&v),
            r#"{"a":1,"b":0,"c":0.1,"d":1e+21,"e":1.5e-7,"f":null,"g":"x\"\n\u0001","h":{"0":0.5,"1":2},"i":[true,null],"j":0.10000000149011612}"#
        );
    }
}

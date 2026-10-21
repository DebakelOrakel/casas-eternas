//! The tile levels through the boundary, as the job worker calls them:
//! the plan from level 1's artifact (`planOf`) and the bake of one tile
//! on its parent (`bakeTile`). A `TileBaker` holds level 1 decoded with
//! its sampler and the climate's field mesh for every tile a worker bakes,
//! as the worker's cache holds them, their walks with them.

use casas_engine::climate::climate_mesh::climate_cell_m;
use casas_engine::climate::climate_points::{
    ClimateCellValues, climate_cells_from_saved, mean_land_runoff,
};
use casas_engine::core::domain::Domain;
use casas_engine::fields::field_mesh::{SharedFieldMesh, shared_field_mesh};
use casas_engine::mesh::mesh_erosion::MeshPipeline;
use casas_engine::mesh::mesh_hydrology::mesh_routing;
use casas_engine::mesh::mesh_sampler::{MeshSampler, create_mesh_sampler};
use casas_engine::mesh::mesh_serial::{SerializedMesh, decode_mesh};
use casas_engine::mesh::mesh_tile::{SiteKind, TILE_ROLE_HALO, TileId, TileParent, TilePiece};
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::mesh::tile_layout::tile_parent_on;
use casas_engine::pipeline::mesh_tile_bake::{
    BakedTile, TileBakeInputs, TileBakeOptions, UpstreamTile, bake_mesh_tile,
};
use casas_engine::pipeline::tile_plan::{TilePlanInput, plan_tiles};
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::surface::river_graph::RiverGraph;

use crate::value::ObjBuilder;
use crate::{EraError, Shape, Value, domain_of, read, wrong};

fn tile(t: &TileId) -> Value {
    ObjBuilder::new()
        .num("level", t.level)
        .num("x", t.x as f64)
        .num("y", t.y as f64)
        .build()
}

/// A level's mesh from its artifact (`meshLevelMesh`): `{ count, nodes,
/// connectivity }` on the world's domain.
fn level_mesh(artifact: &read::Fields, domain: &Domain) -> Result<PeriodicTriangulation, EraError> {
    let need = |k: &str| {
        artifact
            .get(k)
            .ok_or_else(|| wrong(&format!("the level has no {k}")))
    };
    Ok(decode_mesh(
        domain,
        &SerializedMesh {
            count: artifact.num("count")? as usize,
            nodes: read::f32s(need("nodes")?, "nodes")?.to_vec(),
            connectivity: read::u8s(need("connectivity")?, "connectivity")?.to_vec(),
        },
    )?)
}

/// The tile levels' plan (the job worker's `planOf`) from level 1's
/// artifact (`MeshLevelArtifact`), decoded and routed on its own, and
/// each level's tiles with land or shelf (`{ [level]: [[x, y], …] }`):
/// `[{ tile, parents, upstream }]` (`PlannedTile`), coarse to fine.
pub fn plan(
    artifact: &Value,
    width: u32,
    height: u32,
    shape: Shape,
    land_tiles: &Value,
) -> Result<Value, EraError> {
    let a = read::Fields::of(artifact, "the level")?;
    let domain = domain_of(shape, width as f64, height as f64);
    let mut mesh = level_mesh(&a, &domain)?;
    let z = read::f32s(a.get("z").ok_or_else(|| wrong("the level has no z"))?, "z")?;
    let routing = mesh_routing(&mut mesh, z, &DEFAULT_SOLVER_PARAMS);
    let land = read::Fields::of(land_tiles, "the land tiles")?;
    let mut levels: Vec<u32> = land
        .keys()
        .map(|k| {
            k.parse::<u32>()
                .map_err(|_| wrong(&format!("no tile level {k}")))
        })
        .collect::<Result<_, _>>()?;
    levels.sort_unstable();
    let mut tiles_of = std::collections::HashMap::new();
    for &level in &levels {
        let list = land.list(&level.to_string())?;
        let tiles = list
            .iter()
            .map(|xy| match xy {
                Value::List(p) if p.len() == 2 => match (&p[0], &p[1]) {
                    (Value::Num(x), Value::Num(y)) => Ok(TileId {
                        level,
                        x: *x as usize,
                        y: *y as usize,
                    }),
                    _ => Err(wrong("a land tile is not [x, y]")),
                },
                _ => Err(wrong("a land tile is not [x, y]")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        tiles_of.insert(level, tiles);
    }
    let planned = plan_tiles(&TilePlanInput {
        mesh: &mesh,
        z,
        routing: &routing,
        width: width as usize,
        height: height as usize,
        levels: &levels,
        land_tiles: &|level| tiles_of.get(&level).cloned().unwrap_or_default(),
    });
    Ok(Value::List(
        planned
            .iter()
            .map(|p| {
                ObjBuilder::new()
                    .put("tile", tile(&p.tile))
                    .put("parents", Value::List(p.parents.iter().map(tile).collect()))
                    .put(
                        "upstream",
                        Value::List(p.upstream.iter().map(tile).collect()),
                    )
                    .build()
            })
            .collect(),
    ))
}

/// What the bake reads of the save (`tileBakeInputs` less the parent and
/// the upstream).
struct SaveInputs {
    width: usize,
    height: usize,
    detail_seed: u32,
    litho_seed: u32,
    controls: ErosionControls,
    uplift: Option<Vec<f32>>,
    erodibility: Option<Vec<f32>>,
    forcing_res_x: usize,
    forcing_res_y: usize,
    climate: Option<ClimateCellValues>,
    mean_land_water: f64,
}

/// A worker's tile bakes on one world's level 1.
pub struct TileBaker {
    domain: Domain,
    /// Level 1's sampler (its mesh and heights); out while a tile bakes.
    level1: Option<MeshSampler>,
    graph: Option<RiverGraph>,
    climate_mesh: SharedFieldMesh,
    save: SaveInputs,
    leaf_workers: Option<usize>,
}

impl TileBaker {
    /// Level 1's artifact (`MeshLevelArtifact`) and the save's inputs as
    /// the bake reads them: `{ width, height, shape, detailSeed,
    /// lithoSeed, controls: { alluvium?, rockContrast? }, uplift?,
    /// erodibility?, forcingResX, forcingResY, climate? }` (the save's
    /// `ClimateCellValues`). `leaf_workers`: the engine pool's threads.
    pub fn open(
        artifact: &Value,
        inputs: &Value,
        leaf_workers: Option<u32>,
    ) -> Result<TileBaker, EraError> {
        let i = read::Fields::of(inputs, "the bake's inputs")?;
        let shape = match i.opt_str("shape")?.as_deref() {
            Some("sphere") => Shape::Sphere,
            _ => Shape::Torus,
        };
        let (width, height) = (i.num("width")?, i.num("height")?);
        let domain = domain_of(shape, width, height);
        let a = read::Fields::of(artifact, "the level")?;
        let mesh = level_mesh(&a, &domain)?;
        let z = read::f32s(a.get("z").ok_or_else(|| wrong("the level has no z"))?, "z")?;
        let graph = a.get("graph").map(read::river_graph).transpose()?;
        let climate_mesh = shared_field_mesh(&domain, climate_cell_m(&domain));
        let climate = i
            .get("climate")
            .map(read::climate_cell_values)
            .transpose()?;
        let mean_land_water = match &climate {
            Some(c) => mean_land_runoff(
                &climate_mesh,
                &climate_cells_from_saved(&climate_mesh, c.clone())?,
            ),
            None => 0.0,
        };
        let c = read::Fields::of(
            i.get("controls")
                .ok_or_else(|| wrong("the bake's inputs have no controls"))?,
            "the controls",
        )?;
        let field = |k: &str| -> Result<Option<Vec<f32>>, EraError> {
            Ok(i.get(k)
                .map(|v| read::f32s(v, k).map(|a| a.to_vec()))
                .transpose()?)
        };
        let save = SaveInputs {
            width: width as usize,
            height: height as usize,
            detail_seed: i.num("detailSeed")? as u32,
            litho_seed: i.num("lithoSeed")? as u32,
            controls: ErosionControls {
                alluvium: c.opt_num("alluvium")?,
                rock_contrast: c.opt_num("rockContrast")?,
            },
            uplift: field("uplift")?,
            erodibility: field("erodibility")?,
            forcing_res_x: i.num("forcingResX")? as usize,
            forcing_res_y: i.num("forcingResY")? as usize,
            climate,
            mean_land_water,
        };
        Ok(TileBaker {
            level1: Some(create_mesh_sampler(mesh, z, None)),
            domain,
            graph,
            climate_mesh,
            save,
            leaf_workers: leaf_workers.map(|w| w as usize),
        })
    }

    /// One tile (`TileId`) on its parent: level 1 for a level-2 tile, the
    /// level above's tiles it overlaps for a level-3 tile (`pieces`:
    /// `[{ tile, count, nodes, z }]`, each as its artifact holds it); with
    /// the outflow of the tiles upstream (`[{ tile, count, nodes,
    /// outflow }]`) and the bake's rounds. The tile as its artifact holds
    /// it (`bakedTileToArtifact`'s `MeshTileArtifact`).
    pub fn bake(
        &mut self,
        id: &Value,
        pieces: Option<&Value>,
        upstream: &Value,
        rounds: u32,
    ) -> Result<Value, EraError> {
        let id = read::tile_id(id)?;
        let level1 = self
            .level1
            .take()
            .ok_or_else(|| wrong("the baker lost its level"))?;
        let mut parent = if id.level == 2 {
            TileParent::new(level1, None, None)
        } else {
            let Some(pieces) = pieces else {
                self.level1 = Some(level1);
                return Err(wrong("a tile past level 2 needs the level above's tiles"));
            };
            let pieces = list_of(pieces, "the parent's tiles", |f| {
                Ok(TilePiece {
                    tile: read::tile_id(f.get("tile").ok_or("a parent tile has no tile")?)?,
                    count: f.num("count")? as usize,
                    nodes: read::f32s(
                        f.get("nodes").ok_or("a parent tile has no nodes")?,
                        "nodes",
                    )?
                    .to_vec(),
                    z: read::f32s(f.get("z").ok_or("a parent tile has no z")?, "z")?.to_vec(),
                })
            })?;
            let (patch, patch_z, region) = tile_parent_on(&pieces, &self.domain);
            TileParent::new(
                create_mesh_sampler(patch, &patch_z, Some(region)),
                None,
                Some(level1),
            )
        };
        let result = (|| {
            let upstream = list_of(upstream, "the upstream tiles", |f| {
                Ok(UpstreamTile {
                    tile: read::tile_id(f.get("tile").ok_or("an upstream tile has no tile")?)?,
                    count: f.num("count")? as usize,
                    nodes: read::f32s(
                        f.get("nodes").ok_or("an upstream tile has no nodes")?,
                        "nodes",
                    )?
                    .to_vec(),
                    outflow: read::f32s(
                        f.get("outflow").ok_or("an upstream tile has no outflow")?,
                        "outflow",
                    )?
                    .to_vec(),
                })
            })?;
            let s = &self.save;
            let inputs = TileBakeInputs {
                parent_graph: self.graph.as_ref(),
                width: s.width,
                height: s.height,
                detail_seed: s.detail_seed,
                litho_seed: s.litho_seed,
                controls: s.controls,
                uplift: s.uplift.as_deref(),
                erodibility: s.erodibility.as_deref(),
                forcing_res_x: s.forcing_res_x,
                forcing_res_y: s.forcing_res_y,
                climate: s.climate.as_ref(),
                mean_land_water: s.mean_land_water,
                upstream: &upstream,
            };
            let options = TileBakeOptions {
                rounds,
                pool: self.leaf_workers.map(|w| MeshPipeline {
                    pipeline_depth: 1,
                    synchronous: true,
                    stencil_workers: w,
                }),
            };
            bake_mesh_tile(&mut parent, &inputs, &id, &options, &mut self.climate_mesh)
                .map_err(EraError::from)
        })();
        // Level 1 back, its walks as the bake left them.
        self.level1 = Some(match parent.macro_level {
            Some(m) => m,
            None => parent.sampler,
        });
        Ok(mesh_tile_artifact(&result?))
    }
}

/// A list of objects read one by one.
fn list_of<T>(
    v: &Value,
    what: &'static str,
    read_one: impl Fn(&read::Fields) -> Result<T, String>,
) -> Result<Vec<T>, EraError> {
    match v {
        Value::List(items) => items
            .iter()
            .map(|item| Ok(read_one(&read::Fields::of(item, what)?)?))
            .collect(),
        _ => Err(wrong(&format!("{what} are not an array"))),
    }
}

/// A baked tile as its artifact holds it (`bakedTileToArtifact`): the
/// nodes inside the halo — cells from the tile's corner on the torus,
/// world points on the sphere — the triangles among them, the heights,
/// the roles and the outflow.
fn mesh_tile_artifact(baked: &BakedTile) -> Value {
    let t = &baked.tile;
    let mesh = &t.mesh;
    let sphere = t.site.kind() == SiteKind::Cube;
    let slots = mesh.vertex_slots();
    let mut index = vec![-1i64; slots];
    let mut count = 0usize;
    for (v, slot) in index.iter_mut().enumerate() {
        if mesh.v_alive[v] != 0 && t.role[v] != TILE_ROLE_HALO {
            *slot = count as i64;
            count += 1;
        }
    }
    let mut nodes = vec![0f32; count * 2];
    let mut z = vec![0f32; count];
    let mut roles = vec![0u8; count];
    let mut outflow = vec![0f32; count];
    for (v, &i) in index.iter().enumerate() {
        if i < 0 {
            continue;
        }
        let i = i as usize;
        nodes[2 * i] = if sphere {
            t.world_x[v] as f32
        } else {
            (mesh.vx[v] - t.halo) as f32
        };
        nodes[2 * i + 1] = if sphere {
            t.world_y[v] as f32
        } else {
            (mesh.vy[v] - t.halo) as f32
        };
        z[i] = baked.z[v];
        roles[i] = t.role[v];
        outflow[i] = baked.outflow[v];
    }
    let mut triangles = Vec::new();
    for k in 0..mesh.tri_slots() {
        if mesh.t_alive[k] == 0 {
            continue;
        }
        let corner = |c: usize| index[mesh.tris[3 * k + c] as usize];
        let (a, b, c) = (corner(0), corner(1), corner(2));
        if a >= 0 && b >= 0 && c >= 0 {
            triangles.extend([a as u32, b as u32, c as u32]);
        }
    }
    ObjBuilder::new()
        .put("tile", tile(&t.tile))
        .num("count", count as f64)
        .put("nodes", Value::F32s(nodes))
        .put("triangles", Value::U32s(triangles))
        .put("z", Value::F32s(z))
        .put("role", Value::U8s(roles))
        .put("outflow", Value::F32s(outflow))
        .build()
}

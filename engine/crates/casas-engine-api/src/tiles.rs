//! The tile levels through the boundary, as the job worker calls them:
//! the plan from level 1's artifact (`planOf`) and the bake of one tile
//! on its parent (`bakeTile`). A `TileBaker` holds level 1 decoded with
//! its sampler and the climate's field mesh for every tile a worker bakes,
//! as the worker's cache holds them, their walks with them.

use casas_engine::climate::climate_field::{CLIMATE_RES_X, CLIMATE_RES_Y};
use casas_engine::climate::climate_mesh::climate_cell_m;
use casas_engine::climate::climate_points::{
    ClimateCellValues, climate_cells_from_saved, mean_land_runoff,
};
use casas_engine::core::domain::Domain;
use casas_engine::elevation::elevation_scale::SHELF_BREAK;
use casas_engine::fields::field_mesh::{SharedFieldMesh, shared_field_mesh};
use casas_engine::mesh::mesh_erosion::MeshPipeline;
use casas_engine::mesh::mesh_hydrology::mesh_routing;
use casas_engine::mesh::mesh_raster::rasterise_node_field;
use casas_engine::mesh::mesh_sampler::{MeshSampler, create_mesh_sampler};
use casas_engine::mesh::mesh_serial::{SerializedMesh, decode_mesh};
use casas_engine::mesh::mesh_tile::{
    SiteKind, TILE_ROLE_HALO, TILE_SPECS, TileId, TileParent, TilePiece, TileSpec, tile_corner,
    tile_grid,
};
use casas_engine::mesh::mesh_tile_cube::cube_tile_samples;
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::mesh::tile_layout::tile_parent_on;
use casas_engine::pipeline::erosion_forcing::coarse_forcing_of_snapshot;
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

/// What the bake and the plan read of a world's save (fork 7b: the engine
/// derives what the world layer derived until 2026-10-22): `{ seed, width,
/// height, shape?, controls: { alluvium?, rockContrast? }, snapshot?,
/// climate?, mesh? }` — the seed text and the recipe's controls, and the
/// save's own payloads as it holds them: the snapshot (`state.json`), the
/// climate per cell of its field mesh (`ClimateCellValues`), the mesh
/// (`{ count, nodes, connectivity, z }`).
fn save_of(save: &Value) -> Result<(read::Fields<'_>, Domain, f64, f64, String), EraError> {
    let s = read::Fields::of(save, "the save")?;
    let shape = match s.opt_str("shape")?.as_deref() {
        Some("sphere") => Shape::Sphere,
        _ => Shape::Torus,
    };
    let (width, height) = (s.num("width")?, s.num("height")?);
    let seed = s
        .opt_str("seed")?
        .ok_or_else(|| wrong("the save has no seed"))?;
    Ok((s, domain_of(shape, width, height), width, height, seed))
}

/// The save's terrain on the world raster (the world layer's `elevation`
/// view: its mesh's heights rasterised).
fn save_elevations(
    save: &read::Fields,
    domain: &Domain,
    width: usize,
    height: usize,
) -> Result<Vec<f32>, EraError> {
    let m = read::Fields::of(
        save.get("mesh")
            .ok_or_else(|| wrong("the save has no mesh"))?,
        "the save's mesh",
    )?;
    let need = |k: &str| {
        m.get(k)
            .ok_or_else(|| wrong(&format!("the save's mesh has no {k}")))
    };
    let mut mesh = decode_mesh(
        domain,
        &SerializedMesh {
            count: m.num("count")? as usize,
            nodes: read::f32s(need("nodes")?, "nodes")?.to_vec(),
            connectivity: read::u8s(need("connectivity")?, "connectivity")?.to_vec(),
        },
    )?;
    let z = read::f32s(need("z")?, "z")?;
    Ok(rasterise_node_field(&mut mesh, z, width, height))
}

/// A level's tiles that hold land or shelf: every tile with a cell of the
/// save's raster above the shelf break (the job worker's `landTiles`). What
/// a refine plan computes past level 1; the deep ocean has no relief to
/// refine.
fn land_tiles(elevations: &[f32], width: usize, height: usize, spec: &TileSpec) -> Vec<TileId> {
    let (cols, rows) = tile_grid(width as f64, height as f64, spec);
    let cells = spec.cells as usize;
    let mut out = Vec::new();
    for ty in 0..rows {
        for tx in 0..cols {
            let tile = TileId {
                level: spec.level,
                x: tx,
                y: ty,
            };
            let (cx, cy) = tile_corner(&tile, spec);
            let (cx, cy) = (cx as usize, cy as usize);
            let found = (0..cells).any(|dy| {
                let y = (cy + dy) % height;
                (0..cells)
                    .any(|dx| f64::from(elevations[y * width + (cx + dx) % width]) > SHELF_BREAK)
            });
            if found {
                out.push(tile);
            }
        }
    }
    out
}

/// The sphere's land tiles (`land_tiles`' rule on the cube atlas, the job
/// worker's `cubeLandTiles`): every tile with a sample of the save's raster
/// above the shelf break, the samples a grid of cells × cells over it.
fn cube_land_tiles(
    elevations: &[f32],
    domain: &Domain,
    width: usize,
    height: usize,
    spec: &TileSpec,
) -> Vec<TileId> {
    let mut out = Vec::new();
    cube_tile_samples(
        domain,
        spec.level,
        spec.cells as usize,
        &mut |tile, xs, ys| {
            for k in 0..xs.len() {
                let x = (xs[k].floor() as usize).min(width - 1);
                let y = (ys[k].floor().max(0.0) as usize).min(height - 1);
                if f64::from(elevations[y * width + x]) > SHELF_BREAK {
                    out.push(tile);
                    return;
                }
            }
        },
    );
    out
}

/// The tile levels' plan (the job worker's `planOf`) from level 1's
/// artifact (`MeshLevelArtifact`), decoded and routed on its own, and the
/// save (`save_of`), whose raster says which tiles hold land:
/// `[{ tile, parents, upstream }]` (`PlannedTile`), coarse to fine.
pub fn plan(artifact: &Value, save: &Value) -> Result<Value, EraError> {
    let (s, domain, width, height, _) = save_of(save)?;
    let (width, height) = (width as usize, height as usize);
    let a = read::Fields::of(artifact, "the level")?;
    let mut mesh = level_mesh(&a, &domain)?;
    let z = read::f32s(a.get("z").ok_or_else(|| wrong("the level has no z"))?, "z")?;
    let routing = mesh_routing(&mut mesh, z, &DEFAULT_SOLVER_PARAMS);
    let elevations = save_elevations(&s, &domain, width, height)?;
    let sphere = domain.is_sphere();
    let levels: Vec<u32> = TILE_SPECS.iter().map(|spec| spec.level).collect();
    let tiles_of: std::collections::HashMap<u32, Vec<TileId>> = TILE_SPECS
        .iter()
        .map(|spec| {
            let land = if sphere {
                cube_land_tiles(&elevations, &domain, width, height, spec)
            } else {
                land_tiles(&elevations, width, height, spec)
            };
            (spec.level, land)
        })
        .collect();
    let planned = plan_tiles(&TilePlanInput {
        mesh: &mesh,
        z,
        routing: &routing,
        width,
        height,
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
    /// Level 1's artifact (`MeshLevelArtifact`) and the world's save
    /// (`save_of`): the bake's seeds from its seed text, its forcing from
    /// its snapshot, its climate as the save holds it. `leaf_workers`: the
    /// engine pool's threads.
    pub fn open(
        artifact: &Value,
        save: &Value,
        leaf_workers: Option<u32>,
    ) -> Result<TileBaker, EraError> {
        let (i, domain, width, height, seed) = save_of(save)?;
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
        // The erosion's coarse forcing of the snapshot, on the climate's
        // chart; without a snapshot none (neutral forcing).
        let forcing = i
            .get("snapshot")
            .map(read::snapshot)
            .transpose()?
            .map(|snap| coarse_forcing_of_snapshot(&snap, &domain));
        let (forcing_res_x, forcing_res_y) = match forcing {
            Some(_) => (CLIMATE_RES_X, CLIMATE_RES_Y),
            None => (0, 0),
        };
        let (uplift, erodibility) = match forcing {
            Some(f) => (Some(f.uplift), Some(f.hardness)),
            None => (None, None),
        };
        let save = SaveInputs {
            width: width as usize,
            height: height as usize,
            detail_seed: crate::detail_seed(&seed),
            litho_seed: crate::litho_seed(&seed),
            controls: ErosionControls {
                alluvium: c.opt_num("alluvium")?,
                rock_contrast: c.opt_num("rockContrast")?,
            },
            uplift,
            erodibility,
            forcing_res_x,
            forcing_res_y,
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

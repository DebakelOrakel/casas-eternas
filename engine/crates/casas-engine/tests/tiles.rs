//! The module test of the tiles (mesh/cube_atlas, mesh/mesh_tile,
//! mesh/mesh_tile_cube, mesh/tile_layout, pipeline/tile_plan,
//! pipeline/mesh_tile_bake) against the TypeScript engine
//! (docs/decisions/rust-engine.md, fork 5). The fixture is written by
//! `engine/scripts/tilesFixture.mjs`; the scenarios below are that
//! script's, step for step.

mod fixture;

use std::collections::HashMap;

use casas_engine::climate::climate_mesh::{ClimateMesh, climate_cell_m};
use casas_engine::climate::climate_points::{
    ClimateCellValues, climate_at_points, climate_cells_from_saved, mean_land_runoff, mesh_points,
};
use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::fields::field_mesh::shared_field_mesh;
use casas_engine::mesh::cube_atlas::{
    CubeAtlas, IDENTITY, project, rotation_about, side_ends, side_point, unproject,
};
use casas_engine::mesh::mesh_build::{FieldSampler, MESH_Z, build_mesh};
use casas_engine::mesh::mesh_erosion::{MeshPipeline, MeshRouting};
use casas_engine::mesh::mesh_hydrology::{mesh_areas, mesh_routing};
use casas_engine::mesh::mesh_sampler::create_mesh_sampler;
use casas_engine::mesh::mesh_serial::{compact_mesh, permute};
use casas_engine::mesh::mesh_tile::{
    SiteKind, TILE_ROLE_HALO, TileId, TileParent, TilePiece, hash01, tile_constants, tile_corner,
    tile_spec,
};
use casas_engine::mesh::mesh_tile_cube::{cube_atlas_of, cube_constants, cube_tile_samples};
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;
use casas_engine::mesh::tile_layout::{parent_tiles_on, tile_at_on, tile_grid_on, tile_parent_on};
use casas_engine::pipeline::mesh_bake_stage::{LevelClimate, LevelSpec, level_hydrology};
use casas_engine::pipeline::mesh_tile_bake::{
    BakedTile, TileBakeInputs, TileBakeOptions, UpstreamTile, bake_mesh_tile,
};
use casas_engine::pipeline::tile_plan::{PlannedTile, TilePlanInput, plan_tiles};
use casas_engine::surface::erosion_engine::DEFAULT_SOLVER_PARAMS;
use casas_engine::surface::erosion_forcing_fields::ErosionControls;
use casas_engine::surface::river_graph::RiverReachKind;

const FIXTURE: &str = include_str!("fixtures/tiles.txt");

struct Hash(u32);

impl Hash {
    fn new() -> Self {
        Hash(0x811c_9dc5)
    }
    fn add(&mut self, v: f64) {
        let b = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.0 = (self.0 ^ b as u32).wrapping_mul(0x0100_0193);
        self.0 = (self.0 ^ (b >> 32) as u32).wrapping_mul(0x0100_0193);
    }
    fn flag(&mut self, b: bool) {
        self.add(f64::from(u8::from(b)));
    }
    fn add_all<T: Copy + Into<f64>>(&mut self, a: &[T]) {
        for &v in a {
            self.add(v.into());
        }
    }
    fn named(&mut self, o: &[(impl AsRef<str>, f64)]) {
        for (k, v) in o {
            for c in k.as_ref().encode_utf16() {
                self.add(c as f64);
            }
            self.add(*v);
        }
    }
    fn tile(&mut self, t: &TileId) {
        self.add(t.level as f64);
        self.add(t.x as f64);
        self.add(t.y as f64);
    }
    fn mesh(&mut self, m: &PeriodicTriangulation) {
        self.add_all(&m.vx[..m.vertex_slots()]);
        self.add_all(&m.vy[..m.vertex_slots()]);
        self.add_all(&m.tris[..3 * m.tri_slots()]);
    }
    fn baked(&mut self, b: &BakedTile) {
        let t = &b.tile;
        self.tile(&t.tile);
        self.add(t.origin_x);
        self.add(t.origin_y);
        self.add(t.halo);
        self.mesh(&t.mesh);
        self.add_all(&t.z);
        self.add_all(&t.role);
        self.add_all(&t.world_x);
        self.add_all(&t.world_y);
        self.add_all(&b.z);
        self.add_all(&b.routing.flow_target);
        self.add_all(&b.routing.accumulation);
        self.add_all(&b.routing.pop_order);
        self.add(b.routing.popped_count as f64);
        self.add(b.inflows as f64);
        self.add(b.inflow_discharge);
        self.add(b.upstream_inflow);
        self.add(b.upstream_nodes as f64);
        self.add_all(&b.outflow);
        self.add(b.eroded_flux_m3);
    }
    fn check(&self, name: &str) {
        let want = FIXTURE
            .lines()
            .find(|l| l.split_whitespace().next() == Some(name))
            .unwrap_or_else(|| panic!("no {name} in the fixture"));
        fixture::check("tiles.txt", &format!("{name} {:08x}", self.0), want, name);
    }
}

#[test]
fn the_cube_atlas_is_the_typescript_engine_s() {
    let mut h = Hash::new();
    for (n, r) in [(3, IDENTITY), (5, rotation_about(0.48, 0.6, 0.64, 0.7))] {
        let atlas = CubeAtlas::new(n, r);
        for index in (0..atlas.tile_count()).step_by(7) {
            let t = atlas.tile_of_index(index);
            for p in atlas.corners(&t) {
                h.add_all(&p);
            }
            h.add_all(&atlas.centre(&t));
            for s in 0..4 {
                let (nb, side) = atlas.neighbour(&t, s);
                h.add(atlas.index_of(&nb) as f64);
                h.add(side as f64);
                let (a, b, reversed) = side_ends(&atlas, &t, s);
                h.add_all(&a);
                h.add_all(&b);
                h.flag(reversed);
                h.add_all(&side_point(&atlas, &a, &b, 0.37));
            }
            for c in atlas.corner_neighbours(&t) {
                h.add(atlas.index_of(&c) as f64);
            }
            let fr = atlas.frame(&t, 160.0);
            h.add_all(&fr.centre);
            h.add_all(&fr.e1);
            h.add_all(&fr.e2);
            let q = unproject(&fr, 3.5, -2.25);
            h.add_all(&q);
            let at = project(&fr, &q);
            h.flag(at.is_some());
            let (x, y) = at.unwrap_or((0.0, 0.0));
            h.add(x);
            h.add(y);
            if let Some((s, u)) = atlas.face_tangents(t.face, &atlas.to_cube(&q)) {
                h.add(s);
                h.add(u);
            }
            h.add_all(&atlas.face_point(t.face, 0.1, -0.3));
            h.add(atlas.index_of(&atlas.tile_at(&q)) as f64);
        }
    }
    for k in 0..50i64 {
        h.add(hash01(
            k * 37 - 400,
            k * k,
            k % 7 + 64,
            (k as u64 * 2_654_435_761) as u32,
        ));
    }
    for level in [2, 3] {
        h.named(&tile_constants(tile_spec(level)));
        h.named(&cube_constants(level));
    }
    h.check("atlas");
}

fn height_at(x: f64, y: f64) -> f64 {
    0.09 * det_sin(x * 0.006) * det_cos(y * 0.008)
        + 0.05 * det_sin(x * 0.019 + y * 0.011)
        + 0.03 * det_cos(x * 0.043 - y * 0.027)
        - 0.02
        - 0.06 * (det_sin(x * 0.011 + 2.0) * det_cos(y * 0.013 + 1.0) - 0.6).max(0.0)
}

struct Analytic;

impl FieldSampler for Analytic {
    fn height_at(&self, x: f64, y: f64) -> f64 {
        height_at(x, y)
    }
}

/// `bakedTileToArtifact`'s inside nodes: (count, nodes, z, outflow).
fn artifact(b: &BakedTile) -> Artifact {
    let t = &b.tile;
    let sphere = t.site.kind() == SiteKind::Cube;
    let (mut nodes, mut z, mut outflow) = (Vec::new(), Vec::new(), Vec::new());
    for v in 0..t.mesh.vertex_slots() {
        if t.mesh.v_alive[v] == 0 || t.role[v] == TILE_ROLE_HALO {
            continue;
        }
        if sphere {
            nodes.push(t.world_x[v] as f32);
            nodes.push(t.world_y[v] as f32);
        } else {
            nodes.push((t.mesh.vx[v] - t.halo) as f32);
            nodes.push((t.mesh.vy[v] - t.halo) as f32);
        }
        z.push(b.z[v]);
        outflow.push(b.outflow[v]);
    }
    (z.len(), nodes, z, outflow)
}

/// `bakedTileToArtifact`'s inside nodes: count, nodes, z, outflow.
type Artifact = (usize, Vec<f32>, Vec<f32>, Vec<f32>);

const W: usize = 1024;
const H: usize = 512;

fn run(name: &str, world: Domain) {
    let built = build_mesh(&world, &Analytic, 7, 2.0, 24);
    let (mut level1, order) = compact_mesh(&built.mesh);
    let z1 = permute(built.state.get(MESH_Z), &order);
    let routing = mesh_routing(&mut level1, &z1, &DEFAULT_SOLVER_PARAMS);
    let mut sh = shared_field_mesh(&world, climate_cell_m(&world));
    let nc = sh.mesh.count;
    let mut climate = ClimateCellValues {
        cells: nc,
        spacing_m: ClimateMesh::new(&sh.mesh).cell_m,
        sea_level_temperature: vec![0.0; nc],
        precipitation: vec![0.0; nc],
        seasonal_amplitude: vec![0.0; nc],
        monsoon_index: vec![0.0; nc],
    };
    for i in 0..nc {
        let (x, y) = (sh.mesh.x[i], sh.mesh.y[i]);
        let lat = (y / H as f64 - 0.5).abs() * 2.0;
        let land = height_at(x, y) > 0.0;
        climate.sea_level_temperature[i] = (28.0 - 40.0 * lat + 3.0 * det_sin(x * 0.02)) as f32;
        climate.precipitation[i] = if land {
            (300.0 + 900.0 * (1.0 + det_sin(x * 0.009 + y * 0.005))) as f32
        } else {
            -1.0
        };
        climate.seasonal_amplitude[i] = (4.0 + 14.0 * lat) as f32;
        climate.monsoon_index[i] = if land {
            (0.7 * det_cos(x * 0.004)) as f32
        } else {
            -1.0
        };
    }
    let cells = climate_cells_from_saved(&sh, climate.clone()).unwrap();
    let at = climate_at_points(&mut sh, &cells, &mesh_points(&level1, &z1, None), false);
    let mean_land_water = mean_land_runoff(&sh, &cells);
    let areas = mesh_areas(&mut level1);
    let zeros = vec![0f32; level1.vertex_slots()];
    let water = level_hydrology(
        &level1,
        &z1,
        &routing,
        &areas,
        &zeros,
        &LevelClimate {
            precipitation: &at.precipitation,
            temperature: &at.temperature,
            monsoon_index: Some(&at.monsoon_index),
            mean_runoff: mean_land_water,
        },
        &LevelSpec {
            width: W,
            budget: 2.0,
            detail_seed: 4242,
        },
    );

    // The layout and the plan.
    let mut h = Hash::new();
    for level in [2, 3] {
        let (cols, rows) = tile_grid_on(&world, level);
        h.add(cols as f64);
        h.add(rows as f64);
        for k in 0..40 {
            let k = k as f64;
            let t = tile_at_on(
                level,
                (k * 97.31) % W as f64,
                (k * 53.77) % H as f64,
                &world,
            );
            h.tile(&t);
            if level == 3 {
                for p in parent_tiles_on(&t, tile_spec(2), &world) {
                    h.tile(&p);
                }
            }
        }
    }
    let land_tiles = |level: u32| -> Vec<TileId> {
        let spec = tile_spec(level);
        let mut out = Vec::new();
        if world.is_sphere() {
            let n = cube_atlas_of(&world, level).n;
            let limit = if level == 2 { 14 } else { 6 };
            cube_tile_samples(&world, level, 1, &mut |t, xs, ys| {
                if t.x < n && t.y >= 4 && height_at(xs[0], ys[0]) > 0.0 && out.len() < limit {
                    out.push(t);
                }
            });
            return out;
        }
        let (x0, x1, y0, y1) = if level == 2 {
            (18, 26, 8, 14)
        } else {
            (40, 46, 20, 24)
        };
        for y in y0..y1 {
            for x in x0..x1 {
                let t = TileId { level, x, y };
                let c = tile_corner(&t, spec);
                if height_at(c.0 + spec.cells / 2.0, c.1 + spec.cells / 2.0) > 0.0 {
                    out.push(t);
                }
            }
        }
        out
    };
    let plan = plan_tiles(&TilePlanInput {
        mesh: &level1,
        z: &z1,
        routing: &routing,
        width: W,
        height: H,
        levels: &[2, 3],
        land_tiles: &land_tiles,
    });
    let plan_hash = |h: &mut Hash, plan: &[PlannedTile]| {
        for p in plan {
            h.tile(&p.tile);
            h.add(p.parents.len() as f64);
            for t in &p.parents {
                h.tile(t);
            }
            h.add(p.upstream.len() as f64);
            for t in &p.upstream {
                h.tile(t);
            }
        }
    };
    plan_hash(&mut h, &plan);
    // A drainage that jumps between tiles at random, for the cuts.
    let n1 = level1.vertex_slots();
    let jumps = MeshRouting {
        flow_target: (0..n1)
            .map(|v| {
                if v % 11 == 0 {
                    -1
                } else {
                    ((v * 7919 + 13) % n1) as i32
                }
            })
            .collect(),
        accumulation: (0..n1).map(|v| (v % 97) as f32 + 0.5).collect(),
        filled: z1.clone(),
        pop_order: Vec::new(),
        popped_count: 0,
    };
    let cyclic = plan_tiles(&TilePlanInput {
        mesh: &level1,
        z: &z1,
        routing: &jumps,
        width: W,
        height: H,
        levels: &[2, 3],
        land_tiles: &land_tiles,
    });
    plan_hash(&mut h, &cyclic);
    h.check(&format!("{name}_plan"));

    // Level 2.
    let graph = water.graph;
    let mut l3 = plan.iter().find(|p| p.tile.level == 3).unwrap();
    for p in plan.iter().filter(|p| p.tile.level == 3) {
        if p.parents.len() > l3.parents.len() {
            l3 = p;
        }
    }
    let mut river_tile = None;
    let mut river_q = -1.0;
    for r in &graph.reaches {
        if r.kind != RiverReachKind::River {
            continue;
        }
        for i in 1..r.cell_count {
            let k = r.cell_start + i;
            let a = tile_at_on(
                2,
                graph.cell_x[k - 1] as f64,
                graph.cell_y[k - 1] as f64,
                &world,
            );
            let b = tile_at_on(2, graph.cell_x[k] as f64, graph.cell_y[k] as f64, &world);
            if (a.x != b.x || a.y != b.y) && r.discharge_out > river_q {
                river_q = r.discharge_out;
                river_tile = Some(b);
            }
        }
    }
    let with_upstream = plan
        .iter()
        .find(|p| p.tile.level == 2 && !p.upstream.is_empty())
        .unwrap();
    let base = TileBakeInputs {
        parent_graph: Some(&graph),
        width: W,
        height: H,
        detail_seed: 4242,
        litho_seed: 99,
        controls: ErosionControls {
            alluvium: Some(60.0),
            rock_contrast: Some(35.0),
        },
        uplift: None,
        erodibility: None,
        forcing_res_x: 0,
        forcing_res_y: 0,
        climate: Some(&climate),
        mean_land_water,
        upstream: &[],
    };
    let single = |rounds| TileBakeOptions { rounds, pool: None };
    let mut parent2 = TileParent::new(create_mesh_sampler(level1, &z1, None), None, None);
    let mut artifacts: HashMap<(usize, usize), Artifact> = HashMap::new();
    let mut h = Hash::new();
    for t in l3.parents.iter().chain(&with_upstream.upstream) {
        if artifacts.contains_key(&(t.x, t.y)) {
            continue;
        }
        let baked = bake_mesh_tile(&mut parent2, &base, t, &single(2), &mut sh).unwrap();
        h.baked(&baked);
        artifacts.insert((t.x, t.y), artifact(&baked));
    }
    let river = bake_mesh_tile(
        &mut parent2,
        &base,
        &river_tile.unwrap(),
        &single(2),
        &mut sh,
    )
    .unwrap();
    h.baked(&river);
    assert!(river.inflows > 0, "{name}: no river enters the river tile");
    let upstream: Vec<UpstreamTile> = with_upstream
        .upstream
        .iter()
        .map(|t| {
            let a = &artifacts[&(t.x, t.y)];
            UpstreamTile {
                tile: *t,
                count: a.0,
                nodes: a.1.clone(),
                outflow: a.3.clone(),
            }
        })
        .collect();
    let pool = TileBakeOptions {
        rounds: 6,
        pool: Some(MeshPipeline {
            pipeline_depth: 4,
            synchronous: true,
            stencil_workers: 2,
        }),
    };
    let baked = bake_mesh_tile(
        &mut parent2,
        &TileBakeInputs {
            upstream: &upstream,
            ..base
        },
        &with_upstream.tile,
        &pool,
        &mut sh,
    )
    .unwrap();
    h.baked(&baked);
    assert!(baked.upstream_nodes > 0, "{name}: no water from upstream");
    h.check(&format!("{name}_level2"));

    // Level 3 on its patchwork.
    let mut h = Hash::new();
    let pieces: Vec<TilePiece> = l3
        .parents
        .iter()
        .map(|t| {
            let a = &artifacts[&(t.x, t.y)];
            TilePiece {
                tile: *t,
                count: a.0,
                nodes: a.1.clone(),
                z: a.2.clone(),
            }
        })
        .collect();
    let (patch, patch_z, region) = tile_parent_on(&pieces, &world);
    // The patchwork's heights and region, not its triangulation (the
    // fixture says why).
    h.add_all(&patch_z);
    for v in [
        region.x,
        region.y,
        region.width,
        region.height,
        region.nodes,
    ] {
        h.add(v);
    }
    let macro_sampler = parent2.sampler;
    let mut parent3 = TileParent::new(
        create_mesh_sampler(patch, &patch_z, Some(region)),
        None,
        Some(macro_sampler),
    );
    let b3 = bake_mesh_tile(&mut parent3, &base, &l3.tile, &single(2), &mut sh).unwrap();
    h.baked(&b3);
    h.check(&format!("{name}_level3"));
}

#[test]
fn the_tiles_on_the_torus_are_the_typescript_engine_s() {
    run("torus", Domain::torus(W as f64, H as f64));
}

#[test]
fn the_tiles_on_the_sphere_are_the_typescript_engine_s() {
    run("sphere", Domain::sphere(W as f64, H as f64));
}

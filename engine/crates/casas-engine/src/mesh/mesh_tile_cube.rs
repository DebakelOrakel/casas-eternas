//! A fine level's tile on the sphere — the cube atlas's tile as a TileSite,
//! its frame the tile's gnomonic plane, its edge row from each side's
//! canonical end, its placement a jittered grid in face angles; the
//! patchwork parent on the sphere.
//! `client/src/generator/mesh/meshTileCube.ts` explains each rule.

use std::collections::{BTreeMap, HashMap};
use std::f64::consts::{PI, SQRT_2};

use crate::core::det_math::{det_atan, det_cos, det_hypot, det_hypot3};
use crate::core::domain::Domain;
use crate::core::js;
use crate::surface::amplify::RIDGE_GLOBE_OFFSET;

use super::cube_atlas::{
    CubeAtlas, CubeTileId, IDENTITY, Mat3, TileFrame, Vec3, project, rotation_about, side_ends,
    side_point, unproject,
};
use super::hilbert::hilbert_order;
use super::lattice::bootstrap_lattice;
use super::mesh_sampler::DenseRegion;
use super::mesh_tile::{
    CLEAR_FRACTION, EDGE_JITTER, EDGE_SALT_ROW, JITTER, LEVEL_SALT, PATCH_LATTICE_CELLS, SiteKind,
    TileId, TileOptions, TileParent, TilePiece, TileSite, TileSpec, far_first, hash01, point_key,
    step_of, tile_spec,
};
use super::periodic_delaunay::PeriodicTriangulation;

/// Each level's cube rotation: (axis, angle).
fn level_rotation_spec(level: u32) -> ([f64; 3], f64) {
    match level {
        2 => ([0.0, 0.0, 1.0], 0.0),
        3 => ([0.48, 0.6, 0.64], 0.7),
        _ => panic!("level {level} has no cube rotation"),
    }
}

const FACE_SALT: i64 = 4096;

/// Every number of the cube atlas that shapes a level's tile, in the
/// TypeScript order.
pub fn cube_constants(level: u32) -> Vec<(&'static str, f64)> {
    let (axis, angle) = level_rotation_spec(level);
    vec![
        ("cubeAxisX", axis[0]),
        ("cubeAxisY", axis[1]),
        ("cubeAxisZ", axis[2]),
        ("cubeAngle", angle),
        ("cubeFaceSalt", FACE_SALT as f64),
        ("cubeEdgeModel", 1.0),
        ("cubeGlobeSynthesis", 1.0),
        ("cubeRidgeGlobeOffset", RIDGE_GLOBE_OFFSET),
        ("cubeFrameFill", 1.0),
    ]
}

fn level_rotation(level: u32) -> Mat3 {
    let (axis, angle) = level_rotation_spec(level);
    if angle == 0.0 {
        return IDENTITY;
    }
    let l = det_hypot3(axis[0], axis[1], axis[2]);
    rotation_about(axis[0] / l, axis[1] / l, axis[2] / l, angle)
}

fn assert_sphere(world: &Domain) {
    assert!(world.is_sphere(), "a cube tile needs a sphere world");
}

/// A level's atlas on a world of this width.
pub fn cube_atlas_of(world: &Domain, level: u32) -> CubeAtlas {
    let spec = tile_spec(level);
    let n = js::max(1.0, js::round(world.width / 4.0 / spec.cells)) as usize;
    CubeAtlas::new(n, level_rotation(level))
}

pub fn cube_tile_of(atlas: &CubeAtlas, tile: &TileId) -> CubeTileId {
    CubeTileId {
        face: tile.x / atlas.n,
        i: tile.x % atlas.n,
        j: tile.y,
    }
}

fn tile_id_of(atlas: &CubeAtlas, level: u32, t: &CubeTileId) -> TileId {
    TileId {
        level,
        x: t.face * atlas.n + t.i,
        y: t.j,
    }
}

pub fn cube_tile_grid(world: &Domain, level: u32) -> (usize, usize) {
    let n = cube_atlas_of(world, level).n;
    (6 * n, n)
}

/// A world point as a unit direction.
pub fn direction_of(world: &Domain, x: f64, y: f64) -> Vec3 {
    assert_sphere(world);
    let f = world.globe_frame(x, y);
    let l = det_hypot3(f.px, f.py, f.pz);
    [f.px / l, f.py / l, f.pz / l]
}

/// A unit direction as a world point.
pub fn world_point_of(world: &Domain, p: &Vec3) -> (f64, f64) {
    assert_sphere(world);
    let at = world.globe_locate(p[0], p[1], p[2]);
    (at.x, at.y)
}

pub fn cube_tile_at(level: u32, x: f64, y: f64, world: &Domain) -> TileId {
    let atlas = cube_atlas_of(world, level);
    let t = atlas.tile_at(&direction_of(world, x, y));
    tile_id_of(&atlas, level, &t)
}

/// A tile's frame: its plane and the square its halo fits in.
#[derive(Clone, Debug)]
pub struct CubeFrame {
    pub atlas: CubeAtlas,
    pub cube: CubeTileId,
    pub frame: TileFrame,
    pub half: f64,
    pub side: f64,
    pub corners: [(f64, f64); 4],
}

pub fn cube_frame_of(world: &Domain, tile: &TileId, halo: f64) -> CubeFrame {
    let atlas = cube_atlas_of(world, tile.level);
    let cube = cube_tile_of(&atlas, tile);
    let frame = atlas.frame(&cube, world.radius());
    let mut at = (0.0, 0.0);
    let plane = atlas.corners(&cube).map(|p| {
        if let Some(q) = project(&frame, &p) {
            at = q;
        }
        at
    });
    let mut extent: f64 = 0.0;
    for (x, y) in plane {
        extent = js::max(extent, js::max(x.abs(), y.abs()));
    }
    let half = (extent + halo).ceil();
    CubeFrame {
        atlas,
        cube,
        frame,
        half,
        side: 2.0 * half,
        corners: plane.map(|(x, y)| (x + half, y + half)),
    }
}

/// The parent's nodes as unit directions, made once per parent.
fn directions_of(parent: &TileParent) -> &[f64] {
    parent.directions.get_or_init(|| {
        let mesh = parent.mesh();
        let mut xyz = vec![0.0; mesh.vertex_slots() * 3];
        for v in 0..mesh.vertex_slots() {
            if mesh.v_alive[v] == 0 {
                continue;
            }
            let p = direction_of(&mesh.domain, mesh.vx[v], mesh.vy[v]);
            xyz[3 * v..3 * v + 3].copy_from_slice(&p);
        }
        xyz
    })
}

struct Line {
    ax: f64,
    ay: f64,
    nx: f64,
    ny: f64,
    clear: f64,
}

/// The sphere's site.
pub struct CubeSite {
    world: Domain,
    tile: TileId,
    spec: &'static TileSpec,
    halo: f64,
    g: CubeFrame,
    lines: [Line; 4],
    own: usize,
    seed: u32,
}

pub fn cube_site(parent: &TileParent, tile: &TileId, options: &TileOptions) -> CubeSite {
    let world = parent.mesh().domain.clone();
    let spec = tile_spec(tile.level);
    let halo = options.halo.unwrap_or(spec.halo);
    let g = cube_frame_of(&world, tile, halo);
    let steps = spec.edge_steps as f64;
    let lines = [0, 1, 2, 3].map(|s| {
        let (ax, ay) = g.corners[(s + 3) % 4];
        let (bx, by) = g.corners[s];
        let length = det_hypot(bx - ax, by - ay);
        Line {
            ax,
            ay,
            nx: -(by - ay) / length,
            ny: (bx - ax) / length,
            clear: CLEAR_FRACTION * (length / steps),
        }
    });
    let own = g.atlas.index_of(&g.cube);
    CubeSite {
        world,
        tile: *tile,
        spec,
        halo,
        g,
        lines,
        own,
        seed: options.seed,
    }
}

impl CubeSite {
    fn distance(&self, s: usize, x: f64, y: f64) -> f64 {
        let l = &self.lines[s];
        (x - l.ax) * l.nx + (y - l.ay) * l.ny
    }

    fn near_tile(&self, x: f64, y: f64) -> bool {
        (0..4).all(|s| self.distance(s, x, y) > -self.halo)
    }

    fn to_frame(&self, p: &Vec3) -> Option<(f64, f64)> {
        let (x, y) = project(&self.g.frame, p)?;
        let (x, y) = (x + self.g.half, y + self.g.half);
        (x >= 0.0 && y >= 0.0 && x < self.g.side && y < self.g.side).then_some((x, y))
    }

    /// The frame and its geometry.
    pub fn geometry(&self) -> &CubeFrame {
        &self.g
    }
}

impl TileSite for CubeSite {
    fn kind(&self) -> SiteKind {
        SiteKind::Cube
    }
    fn tile(&self) -> TileId {
        self.tile
    }
    fn spec(&self) -> &'static TileSpec {
        self.spec
    }
    fn halo(&self) -> f64 {
        self.halo
    }
    fn side(&self) -> f64 {
        self.g.side
    }
    fn origin(&self) -> (f64, f64) {
        (f64::NAN, f64::NAN)
    }
    fn local_domain(&self) -> Domain {
        Domain::torus_with(self.g.side, self.g.side, 0.0, self.world.metres_per_unit)
    }
    fn inside(&self, x: f64, y: f64) -> bool {
        (0..4).all(|s| self.distance(s, x, y) > 0.0)
    }
    fn in_clear(&self, x: f64, y: f64) -> bool {
        (0..4).any(|s| self.distance(s, x, y).abs() < self.lines[s].clear)
    }

    fn edge_row(&self, emit: &mut dyn FnMut(f64, f64, f64, f64)) {
        let atlas = &self.g.atlas;
        let steps = self.spec.edge_steps;
        let half = self.g.half;
        let mut local = (0.0, 0.0);
        for s in 0..4 {
            let (a, b, reversed) = side_ends(atlas, &self.g.cube, s);
            let (across, across_side) = atlas.neighbour(&self.g.cube, s);
            let theirs = atlas.index_of(&across);
            let line = if self.own < theirs {
                self.own * 4 + s
            } else {
                theirs * 4 + across_side
            };
            for m in 0..steps {
                let k = if reversed { steps - m } else { m };
                let offset = if k == 0 || k == steps {
                    0.0
                } else {
                    EDGE_JITTER
                        * (2.0
                            * hash01(
                                line as i64,
                                k as i64,
                                EDGE_SALT_ROW + LEVEL_SALT * self.spec.level as i64,
                                self.seed,
                            )
                            - 1.0)
                };
                let f = if k == 0 {
                    0.0
                } else if k == steps {
                    1.0
                } else {
                    (k as f64 + offset) / steps as f64
                };
                let p = side_point(atlas, &a, &b, f);
                if let Some(q) = project(&self.g.frame, &p) {
                    local = q;
                }
                let (wx, wy) = world_point_of(&self.world, &p);
                emit(local.0 + half, local.1 + half, wx, wy);
            }
        }
    }

    fn parent_nodes(&self, parent: &TileParent, emit: &mut dyn FnMut(f64, f64, usize)) {
        let xyz = directions_of(parent);
        let mesh = parent.mesh();
        let frame = &self.g.frame;
        let reach = det_cos(js::min(
            PI / 2.0,
            (self.g.half * SQRT_2 * 1.01) / frame.radius,
        ));
        let c = frame.centre;
        for v in 0..mesh.vertex_slots() {
            if mesh.v_alive[v] == 0 {
                continue;
            }
            let p = [xyz[3 * v], xyz[3 * v + 1], xyz[3 * v + 2]];
            if p[0] * c[0] + p[1] * c[1] + p[2] * c[2] < reach {
                continue;
            }
            let Some((x, y)) = self.to_frame(&p) else {
                continue;
            };
            if !self.near_tile(x, y) || self.in_clear(x, y) {
                continue;
            }
            emit(x, y, v);
        }
    }

    fn placement(&self, level: u32, s: f64, emit: &mut dyn FnMut(f64, f64, f64, f64)) {
        let atlas = &self.g.atlas;
        let frame = &self.g.frame;
        let (half, side) = (self.g.half, self.g.side);
        let m = js::max(1.0, js::round((PI / 2.0) * frame.radius / s));
        let delta = PI / 2.0 / m;
        let m = m as i64;
        let salt = 2 * level as i64 + LEVEL_SALT * self.spec.level as i64;
        let square: Vec<Vec3> = [(0.0, 0.0), (side, 0.0), (side, side), (0.0, side)]
            .iter()
            .map(|&(x, y)| atlas.to_cube(&unproject(frame, x - half, y - half)))
            .collect();
        for face in 0..6 {
            let (mut xi_min, mut xi_max) = (f64::INFINITY, f64::NEG_INFINITY);
            let (mut eta_min, mut eta_max) = (f64::INFINITY, f64::NEG_INFINITY);
            let mut behind = false;
            for q in &square {
                let Some((t0, t1)) = atlas.face_tangents(face, q) else {
                    behind = true;
                    break;
                };
                let xi = det_atan(t0);
                let eta = det_atan(t1);
                xi_min = js::min(xi_min, xi);
                xi_max = js::max(xi_max, xi);
                eta_min = js::min(eta_min, eta);
                eta_max = js::max(eta_max, eta);
            }
            if behind {
                continue;
            }
            let i0 = 0.max(((xi_min + PI / 4.0) / delta).floor() as i64);
            let i1 = (m - 1).min(((xi_max + PI / 4.0) / delta).floor() as i64);
            let j0 = 0.max(((eta_min + PI / 4.0) / delta).floor() as i64);
            let j1 = (m - 1).min(((eta_max + PI / 4.0) / delta).floor() as i64);
            let face_salt = salt + FACE_SALT * face as i64;
            for j in j0..=j1 {
                for i in i0..=i1 {
                    let xi = -PI / 4.0
                        + (i as f64
                            + 0.5
                            + JITTER * (2.0 * hash01(i, j, face_salt, self.seed) - 1.0))
                            * delta;
                    let eta = -PI / 4.0
                        + (j as f64
                            + 0.5
                            + JITTER * (2.0 * hash01(i, j, face_salt + 1, self.seed) - 1.0))
                            * delta;
                    let p = atlas.face_point(face, xi, eta);
                    let Some((x, y)) = self.to_frame(&p) else {
                        continue;
                    };
                    if !self.near_tile(x, y) || self.in_clear(x, y) {
                        continue;
                    }
                    let (wx, wy) = world_point_of(&self.world, &p);
                    emit(x, y, wx, wy);
                }
            }
        }
    }

    fn fill(&self, emit: &mut dyn FnMut(f64, f64, f64, f64)) -> bool {
        let s = step_of(self.spec.placement_levels[0], self.spec);
        let (half, side) = (self.g.half, self.g.side);
        let mut y = s / 2.0;
        while y < side {
            let mut x = s / 2.0;
            while x < side {
                if !self.near_tile(x, y) {
                    let (wx, wy) =
                        world_point_of(&self.world, &unproject(&self.g.frame, x - half, y - half));
                    emit(x, y, wx, wy);
                }
                x += s;
            }
            y += s;
        }
        true
    }

    fn world_point(&self, x: f64, y: f64, placed_x: f64, placed_y: f64) -> (f64, f64) {
        if placed_x.is_nan() {
            return world_point_of(
                &self.world,
                &unproject(&self.g.frame, x - self.g.half, y - self.g.half),
            );
        }
        (placed_x, placed_y)
    }
}

/// A world point into a cube tile's frame, or None off it.
pub fn cube_to_frame(world: &Domain, g: &CubeFrame, x: f64, y: f64) -> Option<(f64, f64)> {
    let (px, py) = project(&g.frame, &direction_of(world, x, y))?;
    let (px, py) = (px + g.half, py + g.half);
    (px >= 0.0 && py >= 0.0 && px < g.side && py < g.side).then_some((px, py))
}

/// The tiles of the level above that a tile with its halo overlaps.
pub fn cube_parent_tiles_of(tile: &TileId, parent_spec: &TileSpec, world: &Domain) -> Vec<TileId> {
    let spec = tile_spec(tile.level);
    let g = cube_frame_of(world, tile, spec.halo);
    let (frame, half, side) = (&g.frame, g.half, g.side);
    let atlas = cube_atlas_of(world, parent_spec.level);
    let mut candidates: BTreeMap<usize, CubeTileId> = BTreeMap::new();
    let mut add_around = |t: CubeTileId| {
        candidates.insert(atlas.index_of(&t), t);
        for s in 0..4 {
            let n = atlas.neighbour(&t, s).0;
            candidates.insert(atlas.index_of(&n), n);
        }
        for n in atlas.corner_neighbours(&t) {
            candidates.insert(atlas.index_of(&n), n);
        }
    };
    for (x, y) in [
        (0.0, 0.0),
        (side, 0.0),
        (side, side),
        (0.0, side),
        (half, half),
    ] {
        add_around(atlas.tile_at(&unproject(frame, x - half, y - half)));
    }
    let square = [(0.0, 0.0), (side, 0.0), (side, side), (0.0, side)];
    let mut out = Vec::new();
    for t in candidates.values() {
        let mut quad = Vec::with_capacity(4);
        let mut behind = false;
        for p in atlas.corners(t) {
            match project(frame, &p) {
                Some((x, y)) => quad.push((x + half, y + half)),
                None => {
                    behind = true;
                    break;
                }
            }
        }
        if behind || !convex_overlap(&square, &quad) {
            continue;
        }
        out.push(tile_id_of(&atlas, parent_spec.level, t));
    }
    out
}

/// Whether two convex polygons overlap; touching counts as apart.
fn convex_overlap(a: &[(f64, f64)], b: &[(f64, f64)]) -> bool {
    for poly in [a, b] {
        for k in 0..poly.len() {
            let (x0, y0) = poly[k];
            let (x1, y1) = poly[(k + 1) % poly.len()];
            let nx = -(y1 - y0);
            let ny = x1 - x0;
            let range = |p: &[(f64, f64)]| {
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for &(x, y) in p {
                    let d = x * nx + y * ny;
                    lo = js::min(lo, d);
                    hi = js::max(hi, d);
                }
                (lo, hi)
            };
            let (a_min, a_max) = range(a);
            let (b_min, b_max) = range(b);
            if a_max <= b_min || b_max <= a_min {
                return false;
            }
        }
    }
    true
}

/// What `cube_tile_samples` hands each tile: its id and the samples' x
/// and y.
pub type TileVisit<'a> = dyn FnMut(TileId, &[f64], &[f64]) + 'a;

/// Every tile of a level on the sphere, with `per_side`² sample points
/// inside it as world points.
pub fn cube_tile_samples(world: &Domain, level: u32, per_side: usize, visit: &mut TileVisit<'_>) {
    let atlas = cube_atlas_of(world, level);
    for index in 0..atlas.tile_count() {
        let cube = atlas.tile_of_index(index);
        let c = atlas.corners(&cube);
        let mut xs = Vec::with_capacity(per_side * per_side);
        let mut ys = Vec::with_capacity(per_side * per_side);
        for b in 0..per_side {
            for a in 0..per_side {
                let u = (a as f64 + 0.5) / per_side as f64;
                let v = (b as f64 + 0.5) / per_side as f64;
                let p = [0, 1, 2].map(|k| {
                    (1.0 - u) * (1.0 - v) * c[0][k]
                        + u * (1.0 - v) * c[1][k]
                        + u * v * c[2][k]
                        + (1.0 - u) * v * c[3][k]
                });
                let (x, y) = world_point_of(world, &p);
                xs.push(x);
                ys.push(y);
            }
        }
        visit(tile_id_of(&atlas, level, &cube), &xs, &ys);
    }
}

/// The patchwork parent on the sphere: the pieces' world points, a node on
/// a shared edge row once, triangulated on the world's sphere.
pub fn cube_tile_parent_from_tiles(
    pieces: &[TilePiece],
    world: &Domain,
) -> (PeriodicTriangulation, Vec<f32>, DenseRegion) {
    let (width, height) = (world.width, world.height);
    let mut seen: HashMap<(u64, u64), usize> = HashMap::new();
    let (mut xs, mut ys, mut zs) = (Vec::new(), Vec::new(), Vec::new());
    for piece in pieces {
        for i in 0..piece.count {
            let x = piece.nodes[2 * i] as f64;
            let y = piece.nodes[2 * i + 1] as f64;
            let key = point_key(x, y);
            if seen.contains_key(&key) {
                continue;
            }
            seen.insert(key, xs.len());
            xs.push(x);
            ys.push(y);
            zs.push(piece.z[i]);
        }
    }
    let order = hilbert_order(&xs, &ys, xs.len(), width, height);
    let ox: Vec<f64> = order.iter().map(|&o| xs[o as usize]).collect();
    let oy: Vec<f64> = order.iter().map(|&o| ys[o as usize]).collect();
    let mut mesh = bootstrap_lattice(world, PATCH_LATTICE_CELLS);
    let lattice_count = mesh.vertex_slots();
    let mut mapping = vec![0usize; xs.len()];
    let mut again = Vec::new();
    for n in 0..xs.len() {
        mapping[n] = mesh.insert(ox[n], oy[n], None);
        if mapping[n] < lattice_count {
            again.push(n);
        }
    }
    let region = chart_bounds(&xs, &ys, world);
    let cx = world.wrap_x(region.0 + region.2 / 2.0);
    let cy = region.1 + region.3 / 2.0;
    let away: Vec<f64> = (0..lattice_count)
        .map(|v| world.distance_sq(mesh.vx[v], mesh.vy[v], cx, cy))
        .collect();
    for v in far_first(&away) {
        if mesh.v_alive[v] != 0 {
            mesh.remove(v);
        }
    }
    for &n in &again {
        mapping[n] = mesh.insert(ox[n], oy[n], None);
    }
    let mut z = vec![0f32; mesh.vertex_slots()];
    for n in 0..xs.len() {
        z[mapping[n]] = zs[order[n] as usize];
    }
    let nodes = xs.len() as f64;
    (
        mesh,
        z,
        DenseRegion {
            x: region.0,
            y: region.1,
            width: region.2,
            height: region.3,
            nodes,
        },
    )
}

/// The chart rectangle around world points, east-west from the first; the
/// whole width where they straddle a pole.
fn chart_bounds(xs: &[f64], ys: &[f64], world: &Domain) -> (f64, f64, f64, f64) {
    let width = world.width;
    let (mut min_x, mut max_x) = (0.0, 0.0);
    let (mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..xs.len() {
        let dx = world.wrap_x(xs[i] - xs[0] + width / 2.0) - width / 2.0;
        min_x = js::min(min_x, dx);
        max_x = js::max(max_x, dx);
        min_y = js::min(min_y, ys[i]);
        max_y = js::max(max_y, ys[i]);
    }
    if max_x - min_x > width / 2.0 {
        return (0.0, min_y, width, max_y - min_y);
    }
    (
        world.wrap_x(xs[0] + min_x),
        min_y,
        max_x - min_x,
        max_y - min_y,
    )
}

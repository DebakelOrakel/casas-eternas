//! `mesh/meshTile.ts`: a tile of a fine level — the tile's nodes and
//! their triangulation with the heights before erosion, as a function of
//! the parent level, the tile's id and the seed. The seam rule (the edge
//! line, the clear strip, the jittered row, the placement by position) is
//! explained in the TypeScript file. The torus's site is here; the
//! sphere's is mesh/mesh_tile_cube.rs.

use std::cell::OnceCell;
use std::collections::HashMap;

use crate::core::domain::{Domain, DomainGrid};
use crate::core::js;
use crate::elevation::elevation_scale::ELEVATION_METERS;
use crate::surface::amplify::local_relief_at;

use super::hilbert::hilbert_order;
use super::lattice::hex_lattice;
use super::mesh_density::target_spacing_m;
use super::mesh_refine::{LevelSynthesis, SynthesisLevel, level_synthesis};
use super::mesh_relief::relief_at;
use super::mesh_sampler::{DenseRegion, MeshSampler};
use super::mesh_serial::{compact_mesh, permute};
use super::periodic_delaunay::PeriodicTriangulation;

/// A level's tile (`TileSpec` in TypeScript, which explains each field).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TileSpec {
    pub level: u32,
    pub cells: f64,
    pub offset: f64,
    pub budget: f64,
    pub halo: f64,
    pub edge_steps: usize,
    pub placement_levels: &'static [u32],
    pub quantum: f64,
}

pub const TILE_SPECS: [TileSpec; 2] = [
    TileSpec {
        level: 2,
        cells: 16.0,
        offset: 0.0,
        budget: 1.0 / 4.0,
        halo: 1.0,
        edge_steps: 256,
        placement_levels: &[3, 4, 5, 6, 7, 8],
        quantum: 1.0 / 262_144.0,
    },
    TileSpec {
        level: 3,
        cells: 8.0,
        offset: 4.0,
        budget: 1.0 / 16.0,
        halo: 1.0,
        edge_steps: 512,
        placement_levels: &[4, 5, 6, 7, 8, 9],
        quantum: 1.0 / 1_048_576.0,
    },
];

/// The spec of a tile level; a level without tiles is a caller's error.
pub fn tile_spec(level: u32) -> &'static TileSpec {
    TILE_SPECS
        .iter()
        .find(|s| s.level == level)
        .unwrap_or_else(|| panic!("level {level} has no tiles"))
}

pub const ACCEPT: f64 = 1.25;
pub const JITTER: f64 = 0.25;
pub const EDGE_JITTER: f64 = 0.25;
pub const CLEAR_FRACTION: f64 = 0.8;
pub const EDGE_SALT_ROW: i64 = 101;
pub const EDGE_SALT_COL: i64 = 102;
pub const LEVEL_SALT: i64 = 64;

fn max_side(spec: &TileSpec) -> f64 {
    16_777_216.0 * spec.quantum
}

fn quantise(v: f64, spec: &TileSpec) -> f64 {
    js::round(v / spec.quantum) * spec.quantum
}

/// Every number that shapes a level's tile, in the TypeScript order.
pub fn tile_constants(spec: &TileSpec) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = vec![
        ("tileCells".into(), spec.cells),
        ("tileOffset".into(), spec.offset),
        ("tileHaloCells".into(), spec.halo),
        ("tileEdgeSteps".into(), spec.edge_steps as f64),
        ("tileBudget".into(), spec.budget),
        ("tileLevel".into(), spec.level as f64),
        ("tileQuantum".into(), spec.quantum),
        ("tileLevelSalt".into(), LEVEL_SALT as f64),
    ];
    for (i, &level) in spec.placement_levels.iter().enumerate() {
        out.push((format!("tilePlacement{i}"), level as f64));
    }
    out.extend([
        ("tileEdgeSaltRow".into(), EDGE_SALT_ROW as f64),
        ("tileEdgeSaltCol".into(), EDGE_SALT_COL as f64),
        ("tileAccept".into(), ACCEPT),
        ("tileJitter".into(), JITTER),
        ("tileEdgeJitter".into(), EDGE_JITTER),
        ("tileClearFraction".into(), CLEAR_FRACTION),
        ("tileInflowModel".into(), 1.0),
        ("tileLatticeNodes".into(), 1.0),
        ("tilePatchRounded".into(), 1.0),
    ]);
    out
}

pub const TILE_ROLE_NEW: u8 = 0;
pub const TILE_ROLE_PARENT: u8 = 1;
pub const TILE_ROLE_EDGE: u8 = 2;
pub const TILE_ROLE_HALO: u8 = 3;

/// A tile: its level and its column and row on that level's grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileId {
    pub level: u32,
    pub x: usize,
    pub y: usize,
}

/// A level's tile grid on a world whose macro raster is width × height.
pub fn tile_grid(width: f64, height: f64, spec: &TileSpec) -> (usize, usize) {
    (
        (width / spec.cells).floor() as usize,
        (height / spec.cells).floor() as usize,
    )
}

/// Where a tile starts on the macro grid.
pub fn tile_corner(tile: &TileId, spec: &TileSpec) -> (f64, f64) {
    (
        tile.x as f64 * spec.cells + spec.offset,
        tile.y as f64 * spec.cells + spec.offset,
    )
}

/// The parent level as a tile reads it: its sampler (its mesh and
/// heights), the discharge, and level 1's sampler for the relief — None
/// when the parent is level 1 itself, whose sampler is then the one.
pub struct TileParent {
    pub sampler: MeshSampler,
    pub discharge: Option<Vec<f32>>,
    pub macro_level: Option<MeshSampler>,
    /// The parent's nodes as unit directions, made once (a sphere tile's).
    pub(crate) directions: OnceCell<Vec<f64>>,
}

impl TileParent {
    pub fn new(
        sampler: MeshSampler,
        discharge: Option<Vec<f32>>,
        macro_level: Option<MeshSampler>,
    ) -> Self {
        TileParent {
            sampler,
            discharge,
            macro_level,
            directions: OnceCell::new(),
        }
    }

    pub fn mesh(&self) -> &PeriodicTriangulation {
        &self.sampler.mesh
    }

    pub fn z(&self) -> &[f32] {
        &self.sampler.z
    }

    pub fn macro_sampler(&mut self) -> &mut MeshSampler {
        match &mut self.macro_level {
            Some(m) => m,
            None => &mut self.sampler,
        }
    }
}

/// Distinct values in first-seen order (`[...new Set(list)]`).
fn unique(list: Vec<f64>) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::with_capacity(list.len());
    for v in list {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// The tiles of the level above that a tile with its halo overlaps.
pub fn parent_tiles_of(tile: &TileId, parent_spec: &TileSpec, world: &Domain) -> Vec<TileId> {
    let spec = tile_spec(tile.level);
    let corner = tile_corner(tile, spec);
    let (cols, rows) = tile_grid(world.width, world.height, parent_spec);
    let tiles = world.grid(cols, rows);
    let span = |start: f64, wrap: &dyn Fn(f64) -> f64| -> Vec<f64> {
        let first = ((start - spec.halo - parent_spec.offset) / parent_spec.cells).floor() as i64;
        let last = ((start + spec.cells + spec.halo - parent_spec.offset - 1e-9)
            / parent_spec.cells)
            .floor() as i64;
        unique((first..=last).map(|i| wrap(i as f64)).collect())
    };
    let ys = span(corner.1, &|j| tiles.wrap_row(j));
    let xs = span(corner.0, &|i| tiles.wrap_col(i));
    let mut out = Vec::new();
    for &y in &ys {
        for &x in &xs {
            out.push(TileId {
                level: parent_spec.level,
                x: x as usize,
                y: y as usize,
            });
        }
    }
    out
}

/// A tile's inside as a parent piece: nodes in cells from its corner on
/// the torus (world points on the sphere), and their heights.
#[derive(Clone, Debug)]
pub struct TilePiece {
    pub tile: TileId,
    pub count: usize,
    pub nodes: Vec<f32>,
    pub z: Vec<f32>,
}

/// The bootstrap lattice's spacing for a patchwork, in cells.
pub(crate) const PATCH_LATTICE_CELLS: f64 = 16.0;

/// A point's key as a JavaScript string key of it would be: −0 as 0.
pub(crate) fn point_key(x: f64, y: f64) -> (u64, u64) {
    ((x + 0.0).to_bits(), (y + 0.0).to_bits())
}

/// The lattice slots of a patchwork, farthest from (cx, cy) first by
/// `away`, ties by slot.
pub(crate) fn far_first(away: &[f64]) -> Vec<usize> {
    let mut lattice: Vec<usize> = (0..away.len()).collect();
    lattice.sort_by(|&a, &b| match away[b].partial_cmp(&away[a]) {
        Some(std::cmp::Ordering::Equal) | None => a.cmp(&b),
        Some(o) => o,
    });
    lattice
}

/// The patchwork parent's mesh on the torus, its heights, and the region
/// the pieces cover with their node count.
pub fn tile_parent_from_tiles(
    pieces: &[TilePiece],
    width: f64,
    height: f64,
) -> (PeriodicTriangulation, Vec<f32>, DenseRegion) {
    let world = Domain::torus(width, height);
    let mut seen: HashMap<(u64, u64), usize> = HashMap::new();
    let (mut xs, mut ys, mut zs) = (Vec::new(), Vec::new(), Vec::new());
    for piece in pieces {
        let corner = tile_corner(&piece.tile, tile_spec(piece.tile.level));
        for i in 0..piece.count {
            let x = js::fround(world.wrap_x(corner.0 + piece.nodes[2 * i] as f64));
            let y = js::fround(world.wrap_y(corner.1 + piece.nodes[2 * i + 1] as f64));
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
    let mut mesh = hex_lattice(&world, PATCH_LATTICE_CELLS);
    let lattice_count = mesh.vertex_slots();
    let mut mapping = vec![0usize; xs.len()];
    let mut again = Vec::new();
    for n in 0..xs.len() {
        mapping[n] = mesh.insert(ox[n], oy[n], None);
        if mapping[n] < lattice_count {
            again.push(n);
        }
    }
    let region = pieces_bounds(pieces, &world);
    let cx = region.0 + region.2 / 2.0;
    let cy = region.1 + region.3 / 2.0;
    let away: Vec<f64> = (0..lattice_count)
        .map(|v| {
            let d = mesh.domain.delta(mesh.vx[v], mesh.vy[v], cx, cy);
            d.x * d.x + d.y * d.y
        })
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

/// The square the pieces cover, from the first piece's corner: (x, y,
/// width, height).
fn pieces_bounds(pieces: &[TilePiece], world: &Domain) -> (f64, f64, f64, f64) {
    let (width, height) = (world.width, world.height);
    let first = tile_corner(&pieces[0].tile, tile_spec(pieces[0].tile.level));
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (0.0, 0.0, 0.0, 0.0);
    for piece in pieces {
        let spec = tile_spec(piece.tile.level);
        let corner = tile_corner(&piece.tile, spec);
        let dx = world.wrap_x(corner.0 - first.0 + width / 2.0) - width / 2.0;
        let dy = world.wrap_y(corner.1 - first.1 + height / 2.0) - height / 2.0;
        min_x = js::min(min_x, dx);
        min_y = js::min(min_y, dy);
        max_x = js::max(max_x, dx + spec.cells);
        max_y = js::max(max_y, dy + spec.cells);
    }
    (
        world.wrap_x(first.0 + min_x),
        world.wrap_y(first.1 + min_y),
        max_x - min_x,
        max_y - min_y,
    )
}

#[derive(Clone, Copy, Debug)]
pub struct TileOptions {
    pub seed: u32,
    pub width: usize,
    pub height: usize,
    pub halo: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiteKind {
    Torus,
    Cube,
}

/// Where a tile lies (`TileSite` in TypeScript): its local frame and the
/// rules that place its nodes, for one shape.
pub trait TileSite {
    fn kind(&self) -> SiteKind;
    fn tile(&self) -> TileId;
    fn spec(&self) -> &'static TileSpec;
    fn halo(&self) -> f64;
    fn side(&self) -> f64;
    /// The origin of a torus tile's frame (NaN on the sphere).
    fn origin(&self) -> (f64, f64);
    fn local_domain(&self) -> Domain;
    fn inside(&self, x: f64, y: f64) -> bool;
    fn in_clear(&self, x: f64, y: f64) -> bool;
    /// The edge line's nodes: local point and world point.
    fn edge_row(&self, emit: &mut dyn FnMut(f64, f64, f64, f64));
    /// The parent's nodes in the frame, the clear strip left out.
    fn parent_nodes(&self, parent: &TileParent, emit: &mut dyn FnMut(f64, f64, usize));
    /// A placement level's candidates: local point and world point.
    fn placement(&self, level: u32, s: f64, emit: &mut dyn FnMut(f64, f64, f64, f64));
    /// Frozen nodes for the frame's empty part; false for a site without.
    fn fill(&self, _emit: &mut dyn FnMut(f64, f64, f64, f64)) -> bool {
        false
    }
    /// A node's world point from its local point, or the world point it
    /// was placed at (NaN for a lattice node).
    fn world_point(&self, x: f64, y: f64, placed_x: f64, placed_y: f64) -> (f64, f64);
}

/// A tile's mesh, with its heights before erosion.
pub struct TileMesh {
    pub tile: TileId,
    pub origin_x: f64,
    pub origin_y: f64,
    pub halo: f64,
    pub mesh: PeriodicTriangulation,
    pub z: Vec<f32>,
    pub role: Vec<u8>,
    pub world_x: Vec<f64>,
    pub world_y: Vec<f64>,
    pub site: Box<dyn TileSite>,
}

/// The torus's site.
pub struct TorusSite {
    world: Domain,
    tile: TileId,
    spec: &'static TileSpec,
    halo: f64,
    side: f64,
    origin_x: f64,
    origin_y: f64,
    lo: f64,
    hi: f64,
    step: f64,
    clear: f64,
    width: f64,
    height: f64,
    seed: u32,
}

pub fn torus_site(parent: &TileParent, tile: &TileId, options: &TileOptions) -> TorusSite {
    let world = parent.mesh().domain.clone();
    let spec = tile_spec(tile.level);
    let halo = options.halo.unwrap_or(spec.halo);
    let side = spec.cells + 2.0 * halo;
    assert!(
        side < max_side(spec),
        "a tile's halo of {halo} cells is past the float32-exact frame"
    );
    let corner = tile_corner(tile, spec);
    let step = spec.cells / spec.edge_steps as f64;
    TorusSite {
        world,
        tile: *tile,
        spec,
        halo,
        side,
        origin_x: corner.0 - halo,
        origin_y: corner.1 - halo,
        lo: halo,
        hi: halo + spec.cells,
        step,
        clear: CLEAR_FRACTION * step,
        width: options.width as f64,
        height: options.height as f64,
        seed: options.seed,
    }
}

impl TorusSite {
    fn q(&self, v: f64) -> f64 {
        quantise(v, self.spec)
    }
    fn to_world(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.world.wrap_x(self.origin_x + x),
            self.world.wrap_y(self.origin_y + y),
        )
    }
}

impl TileSite for TorusSite {
    fn kind(&self) -> SiteKind {
        SiteKind::Torus
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
        self.side
    }
    fn origin(&self) -> (f64, f64) {
        (self.origin_x, self.origin_y)
    }
    fn local_domain(&self) -> Domain {
        Domain::torus(self.side, self.side)
    }
    fn inside(&self, x: f64, y: f64) -> bool {
        x > self.lo && x < self.hi && y > self.lo && y < self.hi
    }
    fn in_clear(&self, x: f64, y: f64) -> bool {
        let c = self.clear;
        (x - self.lo).abs() < c
            || (x - self.hi).abs() < c
            || (y - self.lo).abs() < c
            || (y - self.hi).abs() < c
    }

    fn edge_row(&self, emit: &mut dyn FnMut(f64, f64, f64, f64)) {
        let (cols, rows) = tile_grid(self.width, self.height, self.spec);
        let steps = self.spec.edge_steps;
        let tiles = self.world.grid(cols, rows);
        let edge_steps = self.world.grid(cols * steps, rows * steps);
        let level_salt = LEVEL_SALT * self.spec.level as i64;
        let along = |line: f64, first: usize, k: usize, salt: i64, by_row: bool| -> f64 {
            let i = (first * steps + k) as f64;
            let global = if by_row {
                edge_steps.wrap_col(i)
            } else {
                edge_steps.wrap_row(i)
            };
            let offset = if global % steps as f64 == 0.0 {
                0.0
            } else {
                EDGE_JITTER
                    * (2.0 * hash01(line as i64, global as i64, salt + level_salt, self.seed) - 1.0)
            };
            self.q((k as f64 + offset) * self.step)
        };
        let (tx, ty) = (self.tile.x, self.tile.y);
        let row_line = |t: usize| tiles.wrap_row(t as f64);
        let col_line = |t: usize| tiles.wrap_col(t as f64);
        let (lo, hi) = (self.lo, self.hi);
        let mut add = |x: f64, y: f64| {
            let (wx, wy) = self.to_world(x, y);
            emit(x, y, wx, wy);
        };
        for k in 0..steps {
            add(lo + along(row_line(ty), tx, k, EDGE_SALT_ROW, true), lo);
            add(
                hi,
                lo + along(col_line(tx + 1), ty, k, EDGE_SALT_COL, false),
            );
            add(
                lo + along(row_line(ty + 1), tx, k + 1, EDGE_SALT_ROW, true),
                hi,
            );
            add(
                lo,
                lo + along(col_line(tx), ty, k + 1, EDGE_SALT_COL, false),
            );
        }
    }

    fn parent_nodes(&self, parent: &TileParent, emit: &mut dyn FnMut(f64, f64, usize)) {
        let mesh = parent.mesh();
        for v in 0..mesh.vertex_slots() {
            if mesh.v_alive[v] == 0 {
                continue;
            }
            let x = self.world.wrap_x(self.q(mesh.vx[v]) - self.origin_x);
            let y = self.world.wrap_y(self.q(mesh.vy[v]) - self.origin_y);
            if x >= self.side || y >= self.side || self.in_clear(x, y) {
                continue;
            }
            emit(x, y, v);
        }
    }

    fn placement(&self, level: u32, s: f64, emit: &mut dyn FnMut(f64, f64, f64, f64)) {
        let cols = js::round(self.width / s) as usize;
        let rows = js::round(self.height / s) as usize;
        let lattice = self.world.grid(cols, rows);
        let i0 = (self.origin_x / s).floor() as i64;
        let j0 = (self.origin_y / s).floor() as i64;
        let i1 = ((self.origin_x + self.side) / s).ceil() as i64;
        let j1 = ((self.origin_y + self.side) / s).ceil() as i64;
        let salt = 2 * level as i64 + LEVEL_SALT * self.spec.level as i64;
        for j in j0..j1 {
            let jw = lattice.wrap_row(j as f64);
            for i in i0..i1 {
                let iw = lattice.wrap_col(i as f64);
                let jx = JITTER * (2.0 * hash01(iw as i64, jw as i64, salt, self.seed) - 1.0);
                let jy = JITTER * (2.0 * hash01(iw as i64, jw as i64, salt + 1, self.seed) - 1.0);
                let x = self
                    .world
                    .wrap_x(self.q((iw + 0.5 + jx) * s) - self.origin_x);
                let y = self
                    .world
                    .wrap_y(self.q((jw + 0.5 + jy) * s) - self.origin_y);
                if x < 0.0 || y < 0.0 || x >= self.side || y >= self.side || self.in_clear(x, y) {
                    continue;
                }
                let (wx, wy) = self.to_world(x, y);
                emit(x, y, wx, wy);
            }
        }
    }

    fn world_point(&self, x: f64, y: f64, _: f64, _: f64) -> (f64, f64) {
        self.to_world(x, y)
    }
}

pub fn build_tile_mesh(parent: &mut TileParent, tile: &TileId, options: &TileOptions) -> TileMesh {
    let site = torus_site(parent, tile, options);
    build_tile_mesh_on(Box::new(site), parent, options)
}

/// A tile's mesh on its site: the edge row, the parents, the new nodes
/// level by level, triangulated over the frame.
pub fn build_tile_mesh_on(
    site: Box<dyn TileSite>,
    parent: &mut TileParent,
    options: &TileOptions,
) -> TileMesh {
    let tile = site.tile();
    let spec = site.spec();
    let side = site.side();
    let mut surface = ParentSurface::new(parent, options, spec);
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut zs: Vec<f64> = Vec::new();
    let mut roles: Vec<u8> = Vec::new();
    let mut wxs: Vec<f64> = Vec::new();
    let mut wys: Vec<f64> = Vec::new();
    macro_rules! add {
        ($x:expr, $y:expr, $z:expr, $role:expr, $wx:expr, $wy:expr) => {{
            xs.push($x);
            ys.push($y);
            zs.push($z);
            roles.push($role);
            wxs.push($wx);
            wys.push($wy);
        }};
    }

    site.edge_row(&mut |x, y, wx, wy| {
        let z = surface.synthesised_at(parent, wx, wy);
        add!(x, y, z, TILE_ROLE_EDGE, wx, wy);
    });

    let levels = spec.placement_levels;
    let mut grid = PointGrid::new(
        side,
        if levels.is_empty() {
            1.0
        } else {
            step_of(levels[levels.len() - 1], spec) * 2.0
        },
    );

    {
        let p: &TileParent = parent;
        site.parent_nodes(p, &mut |x, y, v| {
            let role = if site.inside(x, y) {
                TILE_ROLE_PARENT
            } else {
                TILE_ROLE_HALO
            };
            add!(x, y, p.z()[v] as f64, role, p.mesh().vx[v], p.mesh().vy[v]);
            grid.add(x, y);
        });
    }

    for &level in levels {
        let s = step_of(level, spec);
        let mut accepted: Vec<f64> = Vec::new();
        site.placement(level, s, &mut |x, y, wx, wy| {
            if s * ACCEPT < surface.target_at(parent, wx, wy) {
                return;
            }
            if grid.near(x, y, s / 2.0) {
                return;
            }
            let z = surface.synthesised_at(parent, wx, wy);
            let role = if site.inside(x, y) {
                TILE_ROLE_NEW
            } else {
                TILE_ROLE_HALO
            };
            add!(x, y, z, role, wx, wy);
            accepted.push(x);
            accepted.push(y);
        });
        for a in accepted.as_chunks::<2>().0 {
            grid.add(a[0], a[1]);
        }
    }

    site.fill(&mut |x, y, wx, wy| {
        let z = parent.macro_sampler().height_at(wx, wy);
        add!(x, y, z, TILE_ROLE_HALO, wx, wy);
    });

    // The triangulation, the points inserted in Hilbert order.
    let count = xs.len();
    let domain = site.local_domain();
    let order = hilbert_order(&xs, &ys, count, side, side);
    let ox: Vec<f64> = order.iter().map(|&o| js::fround(xs[o as usize])).collect();
    let oy: Vec<f64> = order.iter().map(|&o| js::fround(ys[o as usize])).collect();
    let mut built = hex_lattice(&domain, step_of(levels[0], spec));
    let lattice_count = built.vertex_slots();
    let mut mapping = vec![0usize; count];
    let mut again = Vec::new();
    for n in 0..count {
        mapping[n] = built.insert(ox[n], oy[n], None);
        if mapping[n] < lattice_count {
            again.push(n);
        }
    }
    for v in 0..lattice_count {
        if built.v_alive[v] != 0 {
            built.remove(v);
        }
    }
    let survivors: Vec<usize> = (0..lattice_count)
        .filter(|&v| built.v_alive[v] != 0)
        .collect();
    for &n in &again {
        mapping[n] = built.insert(ox[n], oy[n], None);
    }
    let slots = built.vertex_slots();
    let mut slot_z = vec![0f32; slots];
    let mut slot_role = vec![0f32; slots];
    let mut slot_wx = vec![0f64; slots];
    let mut slot_wy = vec![0f64; slots];
    let mut slot_lattice = vec![0f32; slots];
    for &v in &survivors {
        slot_lattice[v] = 1.0;
        slot_wx[v] = f64::NAN;
        slot_wy[v] = f64::NAN;
    }
    for n in 0..count {
        let o = order[n] as usize;
        slot_z[mapping[n]] = zs[o] as f32;
        slot_role[mapping[n]] = roles[o] as f32;
        slot_wx[mapping[n]] = wxs[o];
        slot_wy[mapping[n]] = wys[o];
    }
    let (mesh, canonical) = compact_mesh(&built);
    let mut z = permute(&slot_z, &canonical);
    let mut role: Vec<u8> = permute(&slot_role, &canonical)
        .iter()
        .map(|&r| r as u8)
        .collect();
    let placed_x = permute(&slot_wx, &canonical);
    let placed_y = permute(&slot_wy, &canonical);
    let lattice = (!survivors.is_empty()).then(|| permute(&slot_lattice, &canonical));
    let n = mesh.vertex_slots();
    let mut world_x = vec![0f64; n];
    let mut world_y = vec![0f64; n];
    for v in 0..n {
        if mesh.v_alive[v] == 0 {
            continue;
        }
        let (ax, ay) = site.world_point(mesh.vx[v], mesh.vy[v], placed_x[v], placed_y[v]);
        world_x[v] = ax;
        world_y[v] = ay;
        if lattice.as_ref().is_some_and(|l| l[v] != 0.0) {
            z[v] = surface.synthesised_at(parent, ax, ay) as f32;
            role[v] = if site.inside(mesh.vx[v], mesh.vy[v]) {
                TILE_ROLE_NEW
            } else {
                TILE_ROLE_HALO
            };
        }
    }
    let (origin_x, origin_y) = site.origin();
    TileMesh {
        tile,
        origin_x,
        origin_y,
        halo: site.halo(),
        mesh,
        z,
        role,
        world_x,
        world_y,
        site,
    }
}

/// A tile's node as a world point.
pub fn tile_world_x(tile: &TileMesh, x: f64, world: &Domain) -> f64 {
    world.wrap_x(tile.origin_x + x)
}
pub fn tile_world_y(tile: &TileMesh, y: f64, world: &Domain) -> f64 {
    world.wrap_y(tile.origin_y + y)
}

pub fn step_of(level: u32, spec: &TileSpec) -> f64 {
    spec.cells / (1u64 << level) as f64
}

/// The parent surface at a world point: its height plus the level's
/// synthesis, and the density rule's target spacing in cells, memoised
/// as in TypeScript.
pub struct ParentSurface {
    width: usize,
    macro_grid: DomainGrid,
    cell_height: HashMap<i64, f64>,
    cell_relief: HashMap<i64, f64>,
    synthesis: LevelSynthesis,
    targets: HashMap<usize, f64>,
    unit_m: f64,
    budget: f64,
}

fn height_of_cell(
    cache: &mut HashMap<i64, f64>,
    m: &mut MeshSampler,
    width: usize,
    cx: f64,
    cy: f64,
) -> f64 {
    let key = (cy * width as f64 + cx) as i64;
    if let Some(&h) = cache.get(&key) {
        return h;
    }
    let h = m.height_at(cx, cy);
    cache.insert(key, h);
    h
}

impl ParentSurface {
    pub fn new(parent: &TileParent, options: &TileOptions, spec: &TileSpec) -> Self {
        let domain = &parent.mesh().domain;
        ParentSurface {
            width: options.width,
            macro_grid: domain.grid(options.width, options.height),
            cell_height: HashMap::new(),
            cell_relief: HashMap::new(),
            synthesis: level_synthesis(SynthesisLevel {
                seed: options.seed,
                level: spec.level,
                budget: spec.budget,
                width: options.width,
                height: options.height,
                sphere: domain.is_sphere().then(|| domain.clone()),
            }),
            targets: HashMap::new(),
            unit_m: domain.metres_per_unit,
            budget: spec.budget,
        }
    }

    pub fn synthesised_at(&mut self, parent: &mut TileParent, x: f64, y: f64) -> f64 {
        let base = parent.sampler.height_at(x, y);
        let m = parent.macro_sampler();
        let ParentSurface {
            width,
            macro_grid,
            cell_height,
            cell_relief,
            synthesis,
            ..
        } = self;
        let width = *width;
        let mut relief_of_cell = |cx: f64, cy: f64| -> f64 {
            let key = (cy * width as f64 + cx) as i64;
            if let Some(&r) = cell_relief.get(&key) {
                return r;
            }
            let r = local_relief_at(
                &mut |hx, hy| height_of_cell(cell_height, m, width, hx, hy),
                cx,
                cy,
                macro_grid,
            );
            cell_relief.insert(key, r);
            r
        };
        let mut relief_point = |x: f64, y: f64| -> f64 {
            let x0 = x.floor();
            let y0 = y.floor();
            let x1 = macro_grid.wrap_col(x0 + 1.0);
            let y1 = macro_grid.wrap_row(y0 + 1.0);
            let tx = x - x0;
            let ty = y - y0;
            let top = relief_of_cell(x0, y0) * (1.0 - tx) + relief_of_cell(x1, y0) * tx;
            let bottom = relief_of_cell(x0, y1) * (1.0 - tx) + relief_of_cell(x1, y1) * tx;
            top * (1.0 - ty) + bottom * ty
        };
        synthesis.at(x, y, base, &mut relief_point)
    }

    pub fn target_at(&mut self, parent: &mut TileParent, x: f64, y: f64) -> f64 {
        let t = parent.sampler.triangle_at(x, y);
        let mesh = &parent.sampler.mesh;
        let z = &parent.sampler.z;
        let bary = mesh.barycentric(t, x, y);
        let mut target_of_node = |v: usize| -> f64 {
            if let Some(&h) = self.targets.get(&v) {
                return h;
            }
            let (slope, curvature) = relief_at(mesh, z, v, self.unit_m, ELEVATION_METERS);
            let q = parent.discharge.as_ref().map_or(0.0, |d| d[v] as f64);
            let h = target_spacing_m(
                slope,
                q,
                curvature,
                0.0,
                z[v] as f64 * ELEVATION_METERS,
                0.0,
                self.budget,
            ) / self.unit_m;
            self.targets.insert(v, h);
            h
        };
        let a = mesh.tris[3 * t] as usize;
        let b = mesh.tris[3 * t + 1] as usize;
        let c = mesh.tris[3 * t + 2] as usize;
        bary[0] * target_of_node(a) + bary[1] * target_of_node(b) + bary[2] * target_of_node(c)
    }
}

/// A position hash in [0, 1): the global cell (i, j), a salt and the
/// seed, in 32-bit integer arithmetic as `Math.imul` does it.
pub fn hash01(i: i64, j: i64, salt: i64, seed: u32) -> f64 {
    let imul = |a: i64, b: u32| (a as u32).wrapping_mul(b);
    let mut h = seed ^ imul(i, 0x27d4_eb2d) ^ imul(j, 0x1656_67b1) ^ imul(salt, 0x9e37_79b1);
    h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h as f64 / 4_294_967_296.0
}

/// Points in buckets over the local square, for "is anything within r".
struct PointGrid {
    n: i64,
    size: f64,
    buckets: HashMap<i64, Vec<f64>>,
}

impl PointGrid {
    fn new(side: f64, size: f64) -> Self {
        PointGrid {
            n: (side / size).ceil() as i64,
            size,
            buckets: HashMap::new(),
        }
    }

    fn add(&mut self, x: f64, y: f64) {
        let key = (y / self.size).floor() as i64 * self.n + (x / self.size).floor() as i64;
        let b = self.buckets.entry(key).or_default();
        b.push(x);
        b.push(y);
    }

    fn near(&self, x: f64, y: f64, r: f64) -> bool {
        let r2 = r * r;
        let c0 = 0.max(((x - r) / self.size).floor() as i64);
        let c1 = (self.n - 1).min(((x + r) / self.size).floor() as i64);
        let d0 = 0.max(((y - r) / self.size).floor() as i64);
        let d1 = (self.n - 1).min(((y + r) / self.size).floor() as i64);
        for d in d0..=d1 {
            for c in c0..=c1 {
                let Some(bucket) = self.buckets.get(&(d * self.n + c)) else {
                    continue;
                };
                for p in bucket.as_chunks::<2>().0 {
                    let dx = p[0] - x;
                    let dy = p[1] - y;
                    if dx * dx + dy * dy < r2 {
                        return true;
                    }
                }
            }
        }
        false
    }
}

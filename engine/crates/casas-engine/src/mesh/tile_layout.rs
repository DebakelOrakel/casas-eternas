//! `mesh/tileLayout.ts`: the tiles by the world's shape — the torus's
//! square tiles (mesh_tile.rs) or the sphere's cube tiles
//! (mesh_tile_cube.rs), chosen by the world's Domain.

use crate::core::domain::Domain;

use super::mesh_sampler::DenseRegion;
use super::mesh_tile::{
    TileId, TileMesh, TileOptions, TileParent, TilePiece, TileSpec, build_tile_mesh,
    build_tile_mesh_on, parent_tiles_of, tile_grid, tile_parent_from_tiles, tile_spec,
};
use super::mesh_tile_cube::{
    cube_parent_tiles_of, cube_site, cube_tile_at, cube_tile_grid, cube_tile_parent_from_tiles,
};
use super::periodic_delaunay::PeriodicTriangulation;

/// A level's tile grid: (columns, rows).
pub fn tile_grid_on(world: &Domain, level: u32) -> (usize, usize) {
    if world.is_sphere() {
        cube_tile_grid(world, level)
    } else {
        tile_grid(world.width, world.height, tile_spec(level))
    }
}

/// The tile of `level` that holds a world point.
pub fn tile_at_on(level: u32, x: f64, y: f64, world: &Domain) -> TileId {
    if world.is_sphere() {
        return cube_tile_at(level, x, y, world);
    }
    let spec = tile_spec(level);
    let (cols, rows) = tile_grid(world.width, world.height, spec);
    let tiles = world.grid(cols, rows);
    let tx = tiles.wrap_col((world.wrap_x(x - spec.offset) / spec.cells).floor());
    let ty = tiles.wrap_row((world.wrap_y(y - spec.offset) / spec.cells).floor());
    TileId {
        level,
        x: tx as usize,
        y: ty as usize,
    }
}

/// The tiles of the level above that a tile with its halo overlaps.
pub fn parent_tiles_on(tile: &TileId, parent_spec: &TileSpec, world: &Domain) -> Vec<TileId> {
    if world.is_sphere() {
        cube_parent_tiles_of(tile, parent_spec, world)
    } else {
        parent_tiles_of(tile, parent_spec, world)
    }
}

/// A tile's mesh on its parent.
pub fn build_tile_mesh_on_world(
    parent: &mut TileParent,
    tile: &TileId,
    options: &TileOptions,
) -> TileMesh {
    if parent.mesh().domain.is_sphere() {
        let site = cube_site(parent, tile, options);
        build_tile_mesh_on(Box::new(site), parent, options)
    } else {
        build_tile_mesh(parent, tile, options)
    }
}

/// The patchwork parent of a tile of the level below.
pub fn tile_parent_on(
    pieces: &[TilePiece],
    world: &Domain,
) -> (PeriodicTriangulation, Vec<f32>, DenseRegion) {
    if world.is_sphere() {
        cube_tile_parent_from_tiles(pieces, world)
    } else {
        tile_parent_from_tiles(pieces, world.width, world.height)
    }
}

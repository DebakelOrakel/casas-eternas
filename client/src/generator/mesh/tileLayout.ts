import type { Domain } from '../core/domain'
import { buildTileMesh, buildTileMeshOn, parentTilesOf, tileGrid, tileParentFromTiles, tileSpec, type TileId, type TileMesh, type TileOptions, type TileParent, type TilePiece, type TileSpec } from './meshTile'
import { cubeParentTilesOf, cubeSite, cubeTileAt, cubeTileGrid, cubeTileParentFromTiles } from './meshTileCube'
import type { DenseRegion } from './meshSampler'
import type { PeriodicTriangulation } from './periodicDelaunay'

// THE TILES BY THE WORLD'S SHAPE (docs/decisions/sphere-tiles.md, fork 10):
// the torus's square tiles (meshTile.ts) or the sphere's cube tiles
// (meshTileCube.ts), chosen by the world's Domain. A tile's id is
// { level, x, y } on both; on the sphere x folds the face in.

// A level's tile grid: columns × rows of ids.
export function tileGridOn(world: Domain, level: number): { cols: number; rows: number } {
  return world.kind === 'sphere' ? cubeTileGrid(world, level) : tileGrid(world.width, world.height, tileSpec(level))
}

// The tile of `level` that holds a world point.
export function tileAtOn(level: number, x: number, y: number, world: Domain): TileId {
  if (world.kind === 'sphere') return cubeTileAt(level, x, y, world)
  const spec = tileSpec(level)
  const { cols, rows } = tileGrid(world.width, world.height, spec)
  const tiles = world.grid(cols, rows)
  const tx = tiles.wrapCol(Math.floor(world.wrapX(x - spec.offset) / spec.cells))
  const ty = tiles.wrapRow(Math.floor(world.wrapY(y - spec.offset) / spec.cells))
  return { level, x: tx, y: ty }
}

// The tiles of the level above that a tile with its halo overlaps.
export function parentTilesOn(tile: TileId, parentSpec: TileSpec, world: Domain): TileId[] {
  return world.kind === 'sphere' ? cubeParentTilesOf(tile, parentSpec, world) : parentTilesOf(tile, parentSpec, world)
}

// A tile's mesh on its parent.
export function buildTileMeshOnWorld(parent: TileParent, tile: TileId, options: TileOptions): TileMesh {
  return parent.mesh.domain.kind === 'sphere' ? buildTileMeshOn(cubeSite(parent, tile, options), parent, options) : buildTileMesh(parent, tile, options)
}

// The patchwork parent of a tile of the level below.
export function tileParentOn(pieces: TilePiece[], world: Domain): { mesh: PeriodicTriangulation; z: Float32Array; region: DenseRegion } {
  return world.kind === 'sphere' ? cubeTileParentFromTiles(pieces, world) : tileParentFromTiles(pieces, world.width, world.height)
}

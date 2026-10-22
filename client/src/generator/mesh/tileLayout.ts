import type { Domain } from '../core/domain'
import { parentTilesOf, tileGrid, tileSpec, type TileId, type TileSpec } from './meshTile'
import { cubeParentTilesOf, cubeTileAt, cubeTileGrid } from './meshTileCube'

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

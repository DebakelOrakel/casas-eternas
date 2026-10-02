import type { MeshSampler } from '../../generator/mesh/meshSampler'
import { tileCorner, tileSpec, type TileId } from '../../generator/mesh/meshTile'
import { createTileSampler, type TileSurfaceSampler } from '../../generator/mesh/tileSampler'
import { tileAt } from '../../generator/pipeline/tilePlan'
import type { ElevationSurface } from '../../map/elevationSurface'
import { artifactKey, type ArtifactStore } from '../../storage/ArtifactStore'
import { meshTileStage, readMeshTileArtifact } from '../../world/meshTileArtifacts'

// THE GROUND AT THE FINEST LEVEL THERE IS (the incubator's near view): the
// tiles of level 3, else of level 2, else level 1's global mesh, read from
// the artifact store as the view asks for them. Only the near patch reads
// this — it covers a few tiles; the far relief stays on level 1. A tile
// not loaded yet answers with the level below until it arrives, then
// `onLoaded` asks for the patch to be drawn again.

export interface TiledSurface {
  surface: ElevationSurface
  // The height in elevation units at (u, v), unclamped — for the colour.
  elevationAtUV(u: number, v: number): number
  // The finest level the view may read now (1 to 3): the screen picks it
  // from the patch's spacing, so a wide view does not ask for hundreds of
  // tiles.
  setLevel(level: number): void
}

export interface TiledSurfaceOptions {
  store: ArtifactStore
  worldUid: string
  worldId: string
  width: number
  height: number
  // Level 1, the ground everywhere.
  base: MeshSampler
  // The tiles the store holds, by stage (`L3:x,y`) → pipeline version.
  versions: Map<string, string>
  heightScale: number
  onLoaded: () => void
}

// Tiles kept at once, least recently used out. A level-3 tile is ~85 k
// nodes, a few MB as its sampler.
const KEPT_TILES = 48

export function createTiledSurface(options: TiledSurfaceOptions): TiledSurface {
  const { store, worldUid, worldId, width, height, base, versions, heightScale } = options
  const tiles = new Map<string, TileSurfaceSampler | 'loading' | 'missing'>()
  let level = 1

  function request(stage: string, tile: TileId): void {
    const version = versions.get(stage)
    if (!version) {
      tiles.set(stage, 'missing')
      return
    }
    tiles.set(stage, 'loading')
    void readMeshTileArtifact(store, artifactKey(worldUid, worldId, version, stage)).then((read) => {
      if (!read) {
        tiles.set(stage, 'missing')
        return
      }
      const a = read.artifact
      tiles.set(stage, createTileSampler(a.nodes, a.triangles, a.z, tileSpec(tile.level).cells))
      while (tiles.size > KEPT_TILES) tiles.delete(tiles.keys().next().value as string)
      options.onLoaded()
    })
  }

  // The height in elevation units at a world point: the finest tile there
  // that is loaded, else level 1.
  function elevationAt(x: number, y: number): number {
    for (let lv = level; lv >= 2; lv--) {
      const tile = tileAt(lv, x, y, width, height)
      const stage = meshTileStage(tile)
      const held = tiles.get(stage)
      if (held === undefined) {
        request(stage, tile)
        continue
      }
      if (held === 'loading' || held === 'missing') continue
      // Most recently used last.
      tiles.delete(stage)
      tiles.set(stage, held)
      const corner = tileCorner(tile, tileSpec(lv))
      const h = held.heightAt(wrap(x - corner.x, width), wrap(y - corner.y, height))
      if (Number.isFinite(h)) return h
    }
    return base.heightAt(x, y)
  }

  const elevationAtUV = (u: number, v: number): number => elevationAt(u * width - 0.5, v * height - 0.5)
  return {
    surface: {
      // As createMeshSurface: the texel convention, clamped at sea level.
      heightAtUV: (u, v) => Math.max(0, elevationAtUV(u, v)) * heightScale,
    },
    elevationAtUV,
    setLevel(next) {
      level = Math.max(1, Math.min(3, next))
    },
  }
}

const wrap = (v: number, n: number): number => ((v % n) + n) % n

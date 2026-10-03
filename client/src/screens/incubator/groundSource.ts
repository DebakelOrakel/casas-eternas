import type { MeshSampler } from '../../generator/mesh/meshSampler'
import { tileCorner, tileSpec, type TileId } from '../../generator/mesh/meshTile'
import { createTileSampler, type TileSurfaceSampler } from '../../generator/mesh/tileSampler'
import { tileAt } from '../../generator/pipeline/tilePlan'
import type { GroundSource } from '../../map/groundPaint'
import { meshTileStage, type MeshTileArtifact } from '../../world/meshTileArtifacts'

// THE GROUND AT THE FINEST LEVEL THERE IS, as the painter reads it
// (map/groundPaint.ts): the tiles of level 3, else of level 2, else level
// 1's global mesh — plus the save's material fields. A tile not held yet
// is asked for through `requestTile` and the level below answers until it
// arrives; the caller then paints again what read it.
//
// Lives in the incubator's worker (groundWorker.ts) and in the node look
// test alike: no DOM, no store — the artifacts come in as arrays.

export interface GridField {
  data: Float32Array
  resX: number
  resY: number
}

export interface GroundSourceOptions {
  width: number
  height: number
  metersPerCell: number
  elevationMeters: number
  // Level 1, the ground everywhere.
  base: MeshSampler
  // The tiles the store holds, by stage (`L3:x,y`); a tile not listed is
  // never asked for.
  stages: Set<string>
  requestTile(stage: string, tile: TileId): void
  fields: {
    biome: GridField | null
    // The save's elevation raster, to take the climate's own lapse back
    // out of the temperature (it is the cell's temperature AT its height).
    elevation: GridField | null
    temperature: GridField | null
    precipitation: GridField | null
    lakeDepth: GridField | null
  }
}

export interface TiledGroundSource extends GroundSource {
  addTile(stage: string, artifact: MeshTileArtifact): void
  markMissing(stage: string): void
  // The stages a paint since the last call read a missing tile for.
  takeWanted(): string[]
  // What the source holds and which levels answered since the last call.
  counts(): { held: number; loading: number; missing: number; answered: number[] }
}

// Tiles kept at once, least recently used out. A level-3 tile is up to
// ~85 k nodes, a few MB as its sampler; a level-2 tile a fifth of that.
// A view at 1 500 km reads 144 tiles of level 2 and 16 of level 3.
const KEPT_TILES = 320
// Cells inward from a tile's edge a point on it is read at (0.8 m).
const EDGE_NUDGE = 1e-4
// Level 1's typical node spacing, cells (~2 km).
const LEVEL1_SPACING_CELLS = 0.28
// The climate's lapse (climate/climateTuneParams lapseCPerKm), per metre.
const LAPSE_C_PER_M = 6.5 / 1000

const wrap = (v: number, n: number): number => ((v % n) + n) % n

export function createGroundSource(options: GroundSourceOptions): TiledGroundSource {
  const { width, height, base, stages, fields } = options
  const tiles = new Map<string, TileSurfaceSampler | 'loading' | 'missing'>()
  const wanted = new Set<string>()
  const answered = [0, 0, 0, 0]

  const nearest = (field: GridField | null, x: number, y: number, fallback: number): number => {
    if (!field) return fallback
    const gx = Math.min(field.resX - 1, Math.floor((wrap(x, width) / width) * field.resX))
    const gy = Math.min(field.resY - 1, Math.floor((wrap(y, height) / height) * field.resY))
    return field.data[gy * field.resX + gx]
  }
  // Bilinear, cell centres at (i + ½) of the field's grid, wrapped: for
  // the smooth fields (the climate's, 62 km a cell), whose nearest-cell
  // steps would paint the snow line in blocks.
  const bilinear = (field: GridField | null, x: number, y: number, fallback: number): number => {
    if (!field) return fallback
    const gx = (wrap(x, width) / width) * field.resX - 0.5
    const gy = (wrap(y, height) / height) * field.resY - 0.5
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const xa = wrap(x0, field.resX)
    const xb = wrap(x0 + 1, field.resX)
    const ya = wrap(y0, field.resY) * field.resX
    const yb = wrap(y0 + 1, field.resY) * field.resX
    const top = field.data[ya + xa] * (1 - fx) + field.data[ya + xb] * fx
    const bottom = field.data[yb + xa] * (1 - fx) + field.data[yb + xb] * fx
    return top * (1 - fy) + bottom * fy
  }

  // The temperature reduced to sea level per climate cell, the way the
  // classifier does it (climate/biomes.reduceTemperatureToSeaLevel: the
  // lapse over the elevation at the cell's centre), so the painter can
  // apply the lapse at its own, finer height.
  let seaTemperature: GridField | null = fields.temperature
  if (fields.temperature && fields.elevation) {
    const t = fields.temperature
    const e = fields.elevation
    const data = new Float32Array(t.data.length)
    for (let gy = 0; gy < t.resY; gy++) {
      const ey = Math.min(e.resY - 1, Math.floor(((gy + 0.5) / t.resY) * e.resY))
      for (let gx = 0; gx < t.resX; gx++) {
        const ex = Math.min(e.resX - 1, Math.floor(((gx + 0.5) / t.resX) * e.resX))
        const metres = Math.max(0, e.data[ey * e.resX + ex]) * options.elevationMeters
        data[gy * t.resX + gx] = t.data[gy * t.resX + gx] + LAPSE_C_PER_M * metres
      }
    }
    seaTemperature = { data, resX: t.resX, resY: t.resY }
  }

  // The finest tile loaded under a point, else level 1: the height, and
  // with `out` the normal too (out[0] the height, out[1..3] the normal).
  const surface = new Float64Array(5)
  const normal = new Float64Array(3)
  const lookup = (x: number, y: number, maxLevel: number, out: Float64Array | null): number => {
    for (let lv = Math.min(3, maxLevel); lv >= 2; lv--) {
      const tile = tileAt(lv, x, y, width, height)
      const stage = meshTileStage(tile)
      const held = tiles.get(stage)
      if (held === undefined) {
        if (!stages.has(stage)) {
          tiles.set(stage, 'missing')
          continue
        }
        tiles.set(stage, 'loading')
        wanted.add(stage)
        options.requestTile(stage, tile)
        continue
      }
      if (held === 'loading') {
        wanted.add(stage)
        continue
      }
      if (held === 'missing') continue
      const corner = tileCorner(tile, tileSpec(lv))
      const cells = tileSpec(lv).cells
      let lx = wrap(x - corner.x, width)
      let ly = wrap(y - corner.y, height)
      let hit = held.surfaceAt(lx, ly, surface)
      if (!hit) {
        // On a tile's edge the point can fall through both tiles'
        // tolerance: a hair inward answers, where the level below would
        // draw a line of its own heights along every seam (2026-10-03).
        lx = Math.min(cells - EDGE_NUDGE, Math.max(EDGE_NUDGE, lx))
        ly = Math.min(cells - EDGE_NUDGE, Math.max(EDGE_NUDGE, ly))
        hit = held.surfaceAt(lx, ly, surface)
      }
      if (hit) {
        answered[lv]++
        if (out) out.set(surface)
        return surface[0]
      }
    }
    answered[1]++
    const h = base.heightAt(x, y)
    if (out) {
      out[0] = h
      base.normalAt(x, y, normal)
      out[1] = normal[0]
      out[2] = normal[1]
      out[3] = normal[2]
      // The level's own spacing: its sampler does not say per triangle.
      out[4] = LEVEL1_SPACING_CELLS
    }
    return h
  }

  return {
    width,
    height,
    metersPerCell: options.metersPerCell,
    elevationMeters: options.elevationMeters,
    elevationAt: (x, y, maxLevel) => lookup(x, y, maxLevel, null),
    surfaceAt: (x, y, maxLevel, out) => lookup(x, y, maxLevel, out),
    biomeAt: (x, y) => nearest(fields.biome, x, y, 4),
    seaTemperatureAt: (x, y) => bilinear(seaTemperature, x, y, 12),
    precipitationAt: (x, y) => bilinear(fields.precipitation, x, y, 600),
    lakeDepthAt: (x, y) => Math.max(0, bilinear(fields.lakeDepth, x, y, 0)),
    addTile(stage, artifact) {
      tiles.delete(stage)
      tiles.set(stage, createTileSampler(artifact.nodes, artifact.triangles, artifact.z, tileSpec(artifact.tile.level).cells))
      // The oldest samplers out — never a tile still loading, and the
      // 'missing' marks (the sea's tiles, hundreds in a wide view) neither
      // count nor go: counted, they evicted every sampler as it arrived
      // (2026-10-03).
      let samplers = 0
      for (const t of tiles.values()) if (typeof t !== 'string') samplers++
      for (const [key, t] of tiles) {
        if (samplers <= KEPT_TILES) break
        if (typeof t === 'string') continue
        tiles.delete(key)
        samplers--
      }
    },
    markMissing(stage) {
      tiles.set(stage, 'missing')
    },
    takeWanted() {
      const list = [...wanted]
      wanted.clear()
      return list
    },
    counts() {
      let held = 0
      let loading = 0
      let missing = 0
      for (const t of tiles.values()) {
        if (t === 'loading') loading++
        else if (t === 'missing') missing++
        else held++
      }
      const out = { held, loading, missing, answered: answered.slice() }
      answered.fill(0)
      return out
    },
  }
}

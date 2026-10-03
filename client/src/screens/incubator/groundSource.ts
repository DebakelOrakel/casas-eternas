import type { MeshSampler } from '../../generator/mesh/meshSampler'
import { tileCorner, tileSpec, type TileId } from '../../generator/mesh/meshTile'
import { tileAt } from '../../generator/pipeline/tilePlan'
import type { GroundSource } from '../../map/groundPaint'
import { meshTileStage } from '../../world/meshTileArtifacts'
import { LEVEL1_GRID_LEVEL, level1Stage, rasterAt, type Raster } from './groundRaster'

// THE GROUND AT THE FINEST LEVEL THERE IS, as the painter reads it
// (map/groundPaint.ts): the rasters of level 3's tiles, else of level
// 2's, else level 1's (groundRaster.ts) — plus the save's material
// fields. A raster not held yet is asked for through `request` and the
// level below answers until it arrives; the caller then paints again
// what read it. A source with the level's mesh (`base`) answers level 1
// from the mesh where its raster is missing, so the first rings of a
// session need no raster at all.
//
// Lives in the incubator's workers (groundWorker.ts) and in the node look
// test alike: no DOM, no store.

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
  // Level 1's mesh, where this source holds it.
  base: MeshSampler | null
  // The tiles the store holds, by stage (`L3:x,y`); a tile not listed is
  // never asked for.
  stages: Set<string>
  // A raster this source wants: a tile's (its stage and id) or level
  // 1's over a level-2 tile's square (stage `L1:x,y`, the id on level
  // 2's grid).
  request(stage: string, tile: TileId): void
  // A source with the mesh makes a level-1 raster itself, at once, and
  // reads it from then on — 4 ms a tile against a microsecond per texel
  // located in the mesh (2026-10-03). Null leaves it to `request`.
  makeLevel1?(stage: string, tile: TileId): Raster | null
  fields: {
    biome: GridField | null
    // The save's elevation raster, to take the climate's own lapse back
    // out of the temperature (it is the cell's temperature AT its height).
    elevation: GridField | null
    temperature: GridField | null
    precipitation: GridField | null
    lakeDepth: GridField | null
    // The water level per world cell and the surface kind there
    // (hydrology.waterLevelField: 0 the sea, 1 a lake, 2 ice), on the
    // world raster.
    waterLevel: GridField | null
    waterSurface: GridField | null
  }
}

export interface RasterGroundSource extends GroundSource {
  setRaster(stage: string, raster: Raster): void
  dropRaster(stage: string): void
  markMissing(stage: string): void
  // The stages a paint since the last call read a missing raster for
  // (and the level below answered), and the ones it read.
  takeWanted(): string[]
  takeUsed(): string[]
  // What the source holds and which levels answered since the last call.
  counts(): { held: number; loading: number; missing: number; answered: number[] }
}

// A level's typical node spacing, cells (~2 km, ~500 m, ~150 m), for
// the painter's softening of the facets.
const NODE_SPACING_CELLS: Record<number, number> = { 0: 1, 1: 0.28, 2: 0.07, 3: 0.02 }
// The climate's lapse (climate/climateTuneParams lapseCPerKm), per metre.
const LAPSE_C_PER_M = 6.5 / 1000

const wrap = (v: number, n: number): number => ((v % n) + n) % n

export function createGroundSource(options: GroundSourceOptions): RasterGroundSource {
  const { width, height, base, stages, fields } = options
  const rasters = new Map<string, Raster | 'loading' | 'missing'>()
  const wanted = new Set<string>()
  const used = new Set<string>()
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

  // The raster of a stage, asked for when unknown; null while loading or
  // missing.
  const rasterOf = (stage: string, tile: TileId, listed: boolean): Raster | null => {
    const held = rasters.get(stage)
    if (held === undefined) {
      if (!listed) {
        rasters.set(stage, 'missing')
        return null
      }
      rasters.set(stage, 'loading')
      wanted.add(stage)
      options.request(stage, tile)
      return null
    }
    if (held === 'loading') {
      wanted.add(stage)
      return null
    }
    if (held === 'missing') return null
    return held
  }

  // The painter reads the surface as a normal (out[1..3], y up) and takes
  // dh/dx = −out[1]/out[2]; the rasters carry the slope, so it goes out
  // negated with out[2] = 1.
  const sample = new Float64Array(3)
  const normal = new Float64Array(3)
  const fromRaster = (raster: Raster, x: number, y: number, level: number, out: Float64Array | null): number => {
    rasterAt(raster, wrap(x - raster.cornerX, width), wrap(y - raster.cornerY, height), sample)
    if (out) {
      out[0] = sample[0]
      out[1] = -sample[1]
      out[2] = 1
      out[3] = -sample[2]
      out[4] = NODE_SPACING_CELLS[level]
    }
    return sample[0]
  }
  // LEVEL 0: the save's own elevation raster (7.8 km cells), for the
  // texels coarser than any level's nodes — the outermost rings, whose
  // level-1 rasters would be the whole world's 8 192 (2026-10-03). The
  // slope by central differences.
  const level0 = fields.elevation
  const fromLevel0 = (x: number, y: number, out: Float64Array | null): number => {
    const h = bilinear(level0, x, y, 0)
    if (out) {
      out[0] = h
      const step = 0.5
      out[1] = -((bilinear(level0, x + step, y, 0) - bilinear(level0, x - step, y, 0)) / (2 * step)) * (options.elevationMeters / options.metersPerCell)
      out[2] = 1
      out[3] = -((bilinear(level0, x, y + step, 0) - bilinear(level0, x, y - step, 0)) / (2 * step)) * (options.elevationMeters / options.metersPerCell)
      out[4] = 1
    }
    return h
  }
  // The raster last read per level: the next texel is almost always in
  // the same tile, and a tile's stage as a string per texel was a third
  // of a ring's paint (2026-10-03).
  const last: (Raster | null)[] = [null, null, null, null]
  const inLast = (lv: number, x: number, y: number): Raster | null => {
    const r = last[lv]
    if (!r) return null
    const lx = wrap(x - r.cornerX, width)
    const ly = wrap(y - r.cornerY, height)
    return lx <= r.cells && ly <= r.cells ? r : null
  }
  // The finest raster under a point, else level 1's mesh.
  const lookup = (x: number, y: number, maxLevel: number, out: Float64Array | null): number => {
    if (maxLevel <= 0) return fromLevel0(x, y, out)
    for (let lv = Math.min(3, maxLevel); lv >= 2; lv--) {
      let raster = inLast(lv, x, y)
      if (!raster) {
        const tile = tileAt(lv, x, y, width, height)
        const stage = meshTileStage(tile)
        raster = rasterOf(stage, tile, stages.has(stage))
        if (!raster) continue
        last[lv] = raster
        used.add(stage)
      }
      answered[lv]++
      return fromRaster(raster, x, y, lv, out)
    }
    answered[1]++
    let raster = inLast(1, x, y)
    if (!raster) {
      const tile = tileAt(LEVEL1_GRID_LEVEL, x, y, width, height)
      const stage = level1Stage(tile.x, tile.y)
      const id = { level: 1, x: tile.x, y: tile.y }
      if (options.makeLevel1 && !rasters.has(stage)) {
        const made = options.makeLevel1(stage, id)
        if (made) rasters.set(stage, made)
      }
      raster = rasterOf(stage, id, true)
      if (raster) {
        last[1] = raster
        used.add(stage)
      }
    }
    if (raster) return fromRaster(raster, x, y, 1, out)
    if (!base) return fromLevel0(x, y, out)
    const h = base.heightAt(x, y)
    if (out) {
      out[0] = h
      base.normalAt(x, y, normal)
      out[1] = normal[0]
      out[2] = normal[1]
      out[3] = normal[2]
      out[4] = NODE_SPACING_CELLS[1]
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
    waterLevelAt: (x, y) => nearest(fields.waterLevel, x, y, 0),
    waterSurfaceAt: (x, y) => nearest(fields.waterSurface, x, y, 0),
    setRaster(stage, raster) {
      rasters.set(stage, raster)
    },
    dropRaster(stage) {
      const held = rasters.get(stage)
      rasters.delete(stage)
      for (let lv = 0; lv < last.length; lv++) if (last[lv] === held) last[lv] = null
    },
    markMissing(stage) {
      rasters.set(stage, 'missing')
    },
    takeWanted() {
      const list = [...wanted]
      wanted.clear()
      return list
    },
    takeUsed() {
      const list = [...used]
      used.clear()
      // The next paint notes its own first reads.
      last.fill(null)
      return list
    },
    counts() {
      let held = 0
      let loading = 0
      let missing = 0
      for (const t of rasters.values()) {
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

// A tile's raster frame: its corner and side on the world grid (a
// level-1 raster's on level 2's grid).
export function tileFrame(tile: TileId): { cornerX: number; cornerY: number; cells: number } {
  const spec = tileSpec(tile.level === 1 ? LEVEL1_GRID_LEVEL : tile.level)
  const corner = tileCorner({ level: spec.level, x: tile.x, y: tile.y }, spec)
  return { cornerX: corner.x, cornerY: corner.y, cells: spec.cells }
}

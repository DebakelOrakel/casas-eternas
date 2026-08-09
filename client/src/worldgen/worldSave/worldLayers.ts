// The "baked layers" of a queryable world save (see
// docs/decisions/queryable-world-save.md). Every generated field is written into
// the save as a raster whose encoding is fully described by the manifest, so any
// consumer (the game server) can look a value up by sampling — with ZERO
// knowledge of the generation algorithms. This module is the algorithm-free
// contract: the layer specs, the quantiser (bake), and the sampler (lookup).

import { metersToElevation } from '../elevation/elevationScale'
import { sampleNearestWorld, downsampleMax } from '../core/field'

export { downsampleMax }

export type Dtype = 'u8' | 'u16' | 'f32'

// Deepest lake the u8 lakeDepth layer needs to represent, in elevation units.
const LAKE_DEPTH_RANGE = metersToElevation(3000)

// A field layer's on-disk encoding. `value = raw * scale + offset`. `landOnly`
// fields are only meaningful where the landMask is 1 (their ocean cells store 0).
//
// `fullRes` marks the layers written on the WORLD raster instead of the climate
// grid. It is a property of the source field, not of this format — every layer
// carries its own resX/resY in the manifest either way, so a consumer never has
// to know which is which. It exists so the writer picks the right dimensions
// from the spec rather than from a list of names kept in sync by hand.
export interface LayerSpec {
  name: string
  dtype: Dtype
  scale: number
  offset: number
  unit: string
  landOnly: boolean
  fullRes?: boolean
}

// Ecology fields (aggregate + the 13 resources) — all 0..~2 suitability/abundance.
const ECOLOGY_LAYERS: string[] = [
  'carryingCapacity', 'arable', 'fish', 'game', 'pasture',
  'timber', 'salt', 'toolStone', 'copper', 'tin', 'iron',
  'gold', 'silver', 'gems',
]

// The coarse (climate-grid) quantised layers. Elevation + oceanAge are carried
// separately as raw f32 (they double as the restore rasters — see the save doc).
export const WORLD_LAYERS: LayerSpec[] = [
  // Ranges are generous so real extremes never clip (greenhouse heat, Siberian
  // seasonality, very wet rainforest, gain/province-boosted ecology).
  { name: 'landMask', dtype: 'u8', scale: 1, offset: 0, unit: '', landOnly: false },
  { name: 'temperature', dtype: 'u8', scale: 90 / 255, offset: -35, unit: '°C', landOnly: false },
  { name: 'precipitation', dtype: 'u16', scale: 8000 / 65535, offset: 0, unit: 'mm/yr', landOnly: true },
  // The same field plus the riparian bonus — rivers and lakes moistening their
  // surroundings (see hydrology.computeRiparianBiomes). Stored beside the
  // climate's own precipitation rather than replacing it, because they answer
  // different questions: `precipitation` is what falls, this is what the ground
  // effectively gets, and only the second one classifies biomes.
  //
  // It is here so that BIOMES CAN BE RECLASSIFIED WITHOUT A DRAINAGE NETWORK.
  // The worldmap re-derives biomes on its amplified terrain; deriving the
  // riparian effect there would mean routing and accumulating flow over an
  // 8-million-cell raster on every load, to recover a field that is regional
  // anyway. 64 KB instead.
  { name: 'precipitationEffective', dtype: 'u16', scale: 8000 / 65535, offset: 0, unit: 'mm/yr', landOnly: true },
  // Full-res, unlike its climate neighbours: the classification is pointwise and
  // reads elevation, which exists at world resolution (see climate/biomes.ts's
  // computeBiomesFine). A 62 km biome cell could not say where a treeline is —
  // and a game whose unit of place is a ~1.5 km hex asks exactly that. 2 MB raw,
  // and it is a mostly-flat id field, so DEFLATE takes most of it back.
  { name: 'biome', dtype: 'u8', scale: 1, offset: 0, unit: 'biomeId', landOnly: false, fullRes: true },
  { name: 'seasonalAmplitude', dtype: 'u8', scale: 60 / 255, offset: 0, unit: '°C', landOnly: true },
  { name: 'monsoonIndex', dtype: 'u8', scale: 1 / 255, offset: 0, unit: '', landOnly: true },
  // Lake depth in elevation units. The range was 20 — off by nearly two orders
  // of magnitude, since a lake's depth is `filled - elevation` and the whole
  // elevation field only spans ±1. Measured over a real run: p50 0.004, p99
  // 0.096, max 0.232 (35 m / 860 m / 2090 m). At the old range that quantised
  // every lake on the map into three u8 steps. 0.333 (3000 m) keeps generous
  // headroom over the measured maximum at ~12 m per step. The encoding is
  // self-describing via the manifest, so this changes precision, not format.
  //
  // Full-res, and this one is not about precision but about EXTENT. It is
  // computed at 2048x1024 and used to be `downsampleMax`'d on the way out —
  // which is the right reduction for "is there a lake in this region" and the
  // wrong one for a layer that gets sampled per point: taking the maximum makes
  // a single lake cell claim its whole 62 km cell, so every lake in the save was
  // inflated to at least one coarse cell across. We were also throwing away
  // resolution we already had, for a field that is zero almost everywhere and
  // therefore nearly free once deflated.
  { name: 'lakeDepth', dtype: 'u8', scale: LAKE_DEPTH_RANGE / 255, offset: 0, unit: 'depth', landOnly: true, fullRes: true },
  ...ECOLOGY_LAYERS.map((name): LayerSpec => ({ name, dtype: 'u8', scale: 3 / 255, offset: 0, unit: '', landOnly: true })),
]

// Flow accumulation. Full-res like biome, but kept out of WORLD_LAYERS because
// the writer has to convert its unit first (see below).
//
// Rivers are the reason: at 256x128 a cell spans ~62 km, so a discharge field
// there could not say WHERE a river is, only that the region has one. At map
// resolution it answers the question a game server actually asks — is there a
// river at (x, y), and how big — by sampling, with no algorithm and no
// polylines (docs/decisions/queryable-world-save.md).
//
// Stored in CUBIC METRES PER SECOND rather than the hydrology's own unit
// (mm/yr summed over contributing cells). Converting costs the writer one
// multiply and saves the reader from having to know the cell area and the
// runoff coefficient — which is exactly the algorithm knowledge this format
// exists to avoid. It is the same figure the generator's hover readout shows.
//
// Stored UNTHRESHOLDED on purpose. Zeroing everything below our channel
// criterion would bake this generator's river-density setting into the data;
// keeping the raw field lets a consumer pick its own threshold, which is the
// same knob `densityToCriticalArea` turns here. Measured cost: 4 MB raw,
// 109 KB after the zip's DEFLATE, against 303 KB for the polylines it replaces.
//
// Linear u16 is enough because the range that matters is narrow: measured
// across channel cells it spans 26x (1.4 orders), not the six a naive reading
// of "river discharge" suggests. At 4 m3/s per step the ceiling is ~262,000 —
// above the Amazon's ~209,000 — so clipping needs a world unlike any measured,
// and even then it only flattens the top of the largest river.
export const DISCHARGE_LAYER: LayerSpec = {
  name: 'discharge', dtype: 'u16', scale: 4, offset: 0, unit: 'm3/s', landOnly: false, fullRes: true,
}


const maxCode = (dtype: Dtype): number => (dtype === 'u16' ? 65535 : 255)

function makeArray(dtype: Dtype, n: number): Uint8Array | Uint16Array | Float32Array {
  return dtype === 'f32' ? new Float32Array(n) : dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n)
}

// Quantise a source field into its layer's dtype (`value → raw`). Negative
// sentinels (ocean: OCEAN_PRECIP, OCEAN_AMPLITUDE, ECOLOGY_OCEAN, …) and
// out-of-range values clamp into range — consumers mask with landMask.
export function bakeLayer(field: Float32Array | Uint8Array, spec: LayerSpec): ArrayBuffer {
  const n = field.length
  if (spec.dtype === 'f32') return Float32Array.from(field).buffer as ArrayBuffer
  const out = makeArray(spec.dtype, n) as Uint8Array | Uint16Array
  const max = maxCode(spec.dtype)
  for (let i = 0; i < n; i++) {
    const raw = Math.round((field[i] - spec.offset) / spec.scale)
    out[i] = raw < 0 ? 0 : raw > max ? max : raw
  }
  return out.buffer as ArrayBuffer
}

// Read a typed layer buffer as its numeric field (raw → value). Used to sample.
export function decodeLayer(buffer: ArrayBuffer, spec: LayerSpec): Float32Array {
  const raw = spec.dtype === 'f32' ? new Float32Array(buffer) : spec.dtype === 'u16' ? new Uint16Array(buffer) : new Uint8Array(buffer)
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = spec.dtype === 'f32' ? raw[i] : raw[i] * spec.scale + spec.offset
  return out
}


// Nearest-cell sample of a decoded layer at a world coordinate (torus-wrapped).
// resX/resY come from the manifest — the sampler needs nothing else.
export function sampleAt(decoded: Float32Array, resX: number, resY: number, worldWidth: number, worldHeight: number, x: number, y: number): number {
  return sampleNearestWorld(decoded, resX, resY, x, y, worldWidth, worldHeight)
}

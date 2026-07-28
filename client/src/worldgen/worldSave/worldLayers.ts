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
export interface LayerSpec {
  name: string
  dtype: Dtype
  scale: number
  offset: number
  unit: string
  landOnly: boolean
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
  { name: 'biome', dtype: 'u8', scale: 1, offset: 0, unit: 'biomeId', landOnly: false },
  { name: 'seasonalAmplitude', dtype: 'u8', scale: 60 / 255, offset: 0, unit: '°C', landOnly: true },
  { name: 'monsoonIndex', dtype: 'u8', scale: 1 / 255, offset: 0, unit: '', landOnly: true },
  // Lake depth in elevation units. The range was 20 — off by nearly two orders
  // of magnitude, since a lake's depth is `filled - elevation` and the whole
  // elevation field only spans ±1. Measured over a real run: p50 0.004, p99
  // 0.096, max 0.232 (35 m / 860 m / 2090 m). At the old range that quantised
  // every lake on the map into three u8 steps. 0.333 (3000 m) keeps generous
  // headroom over the measured maximum at ~12 m per step. The encoding is
  // self-describing via the manifest, so this changes precision, not format.
  { name: 'lakeDepth', dtype: 'u8', scale: LAKE_DEPTH_RANGE / 255, offset: 0, unit: 'depth', landOnly: true },
  ...ECOLOGY_LAYERS.map((name): LayerSpec => ({ name, dtype: 'u8', scale: 3 / 255, offset: 0, unit: '', landOnly: true })),
]

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

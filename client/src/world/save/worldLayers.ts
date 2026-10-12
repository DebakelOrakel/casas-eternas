// The algorithm-free half of reading a world: a quantised raster's ENCODING
// (the quantiser, bake, and its inverse, decode) and the nearest-cell
// sampler world/query.ts answers every view with
// (docs/decisions/queryable-world-save.md).
//
// The save holds no raster layer any more (DEC-0036, the save step): the
// elevation and the lakes' depth are drawn from the terrain mesh, the
// erosion's coarse forcing from the snapshot, the climate and the land
// fields from their meshes' values — world/query.ts makes the rasters on
// open. What is left here serves the sample world and the views.

import { sampleNearestWorld } from '../../generator/core/field'

export type Dtype = 'u8' | 'u16' | 'f32'

// The Planet step's sample world (client/public/sample, written by
// scripts/sampleWorld.mjs, read by the screen): elevation as u16 over
// −1..1. An ENCODING, not a world field: the save's quantiser, not its field
// registry.
export const ELEVATION_ENCODING: Encoding = { dtype: 'u16', scale: 2 / 65535, offset: -1 }

// A raster's ON-DISK ENCODING, on top of what the field already is.
// `value = raw * scale + offset`.
export interface Encoding {
  dtype: Dtype
  scale: number
  offset: number
}

const maxCode = (dtype: Dtype): number => (dtype === 'u16' ? 65535 : 255)

function makeArray(dtype: Dtype, n: number): Uint8Array | Uint16Array | Float32Array {
  return dtype === 'f32' ? new Float32Array(n) : dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n)
}

// Quantise a source field into its encoding's dtype (`value → raw`).
// Out-of-range values clamp into range.
export function bakeLayer(field: Float32Array | Uint8Array, spec: Encoding): ArrayBuffer {
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

// Read a typed buffer as its numeric field (raw → value).
export function decodeLayer(buffer: ArrayBuffer, spec: Encoding): Float32Array {
  const raw = spec.dtype === 'f32' ? new Float32Array(buffer) : spec.dtype === 'u16' ? new Uint16Array(buffer) : new Uint8Array(buffer)
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = spec.dtype === 'f32' ? raw[i] : raw[i] * spec.scale + spec.offset
  return out
}

// Nearest-cell sample of a decoded raster at a world coordinate (torus-wrapped).
export function sampleAt(decoded: Float32Array, resX: number, resY: number, worldWidth: number, worldHeight: number, x: number, y: number): number {
  return sampleNearestWorld(decoded, resX, resY, x, y, worldWidth, worldHeight)
}

// The "baked layers" of a queryable world save (see
// docs/decisions/queryable-world-save.md). Every generated field is written into
// the save as a raster whose encoding is fully described by the manifest, so any
// consumer (the game server) can look a value up by sampling — with ZERO
// knowledge of the generation algorithms. This module is the algorithm-free
// contract: the layer specs, the quantiser (bake), and the sampler (lookup).

import { metersToElevation } from '../../generator/elevation/elevationScale'
import { sampleNearestWorld } from '../../generator/core/field'
import { fieldSpec } from './fieldSpec'
import type { FieldSpec } from './fieldSpec'

export type Dtype = 'u8' | 'u16' | 'f32'

// Deepest lake the u8 lakeDepth layer needs to represent, in elevation units.
const LAKE_DEPTH_RANGE = metersToElevation(3000)

// The lake layer's quantisation, exported because the amplification artifact
// stores its own lakeDepth raster and must quantise it the SAME way (it used
// to restate these numbers — BUG_BOUNTY 24).
export const LAKE_DEPTH_ENCODING: Encoding = { dtype: 'u8', scale: LAKE_DEPTH_RANGE / 255, offset: 0 }

// The Planet step's sample world (client/public/sample, written by
// scripts/sampleWorld.mjs, read by the screen): elevation as u16 over
// −1..1. An ENCODING, not a world field: the save's quantiser, not its field
// registry.
export const ELEVATION_ENCODING: Encoding = { dtype: 'u16', scale: 2 / 65535, offset: -1 }

// A field layer's ON-DISK ENCODING, on top of what the field already is.
// `value = raw * scale + offset`.
//
// The name, grid, unit and land-only flag come from `fieldSpec.ts` rather than
// being restated here, so the save cannot describe a field differently from the
// way the rest of the program does. What is left in this file is exactly the
// part that belongs to storage.
// Just the storage part — what the quantiser needs and nothing more. Kept
// separate because two callers legitimately have an encoding without a world
// field behind it: the amplification artifact quantises its own elevation, and
// the save reader rebuilds an encoding from the manifest it just parsed.
export interface Encoding {
  dtype: Dtype
  scale: number
  offset: number
}

export interface LayerSpec extends FieldSpec, Encoding {}

// One layer: the field's own truth plus how this format stores it.
const layer = (name: string, dtype: Dtype, scale: number, offset: number): LayerSpec =>
  ({ ...fieldSpec(name), dtype, scale, offset })

// The quantised raster layer left of the hydrology: the mesh lakes' depth
// drawn on the world raster (the save's own step moves it with the
// elevation; the discharge went per node in DEC-0036 phase 7b, below).
// Elevation is carried separately as raw f32 (it
// doubles as the restore raster — see the save doc); the ocean age and the
// mantle as their field meshes' values (oceanAge.f64, mantle.f64), the
// climate and the land fields as theirs (climate.json + climate/, mesh/
// biome.u8, mesh/koppen.u8, mesh/waterTable.f32 — climateFields.ts, phase
// 7: the climate-grid layers landMask, temperature, precipitation,
// precipitationEffective, seasonalAmplitude, monsoonIndex, koppen and
// waterTable and the world-grid biome went then).
export const WORLD_LAYERS: LayerSpec[] = [
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
  layer('lakeDepth', LAKE_DEPTH_ENCODING.dtype, LAKE_DEPTH_ENCODING.scale, LAKE_DEPTH_ENCODING.offset),
]

// The river discharge left the rasters in DEC-0036 phase 7b: it is saved
// per node of the mesh (mesh/discharge.f32, m³/s, climateFields.ts) — still
// in CUBIC METRES PER SECOND rather than the hydrology's own unit, so a
// reader needs neither the cell area nor the runoff coefficient, and still
// UNTHRESHOLDED, so a consumer picks its own channel criterion. The u16
// layer at 4 m³/s a step it replaces is refused
// (climateFields.refuseFormerHydrology).

// The erosion engine's coarse forcing fields, written whenever a tectonic
// world is saved — independent of the climate-gated layers above, because a
// bake erodes before it needs climate. Raw f32 rather than quantised: U's
// range is a per-world normalization with a negative (rift) tail and the
// hardness constants are still calibration placeholders, so a fixed
// quantisation range would bake today's calibration into the format for the
// sake of ~200 KB a save.
export const FORCING_LAYERS: LayerSpec[] = [
  layer('uplift', 'f32', 1, 0),
  layer('erodibility', 'f32', 1, 0),
]

const maxCode = (dtype: Dtype): number => (dtype === 'u16' ? 65535 : 255)

function makeArray(dtype: Dtype, n: number): Uint8Array | Uint16Array | Float32Array {
  return dtype === 'f32' ? new Float32Array(n) : dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n)
}

// Quantise a source field into its layer's dtype (`value → raw`). Negative
// sentinels (ocean: OCEAN_PRECIP, OCEAN_AMPLITUDE, ECOLOGY_OCEAN, …) and
// out-of-range values clamp into range — consumers mask with the land.
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

// Read a typed layer buffer as its numeric field (raw → value). Used to sample.
export function decodeLayer(buffer: ArrayBuffer, spec: Encoding): Float32Array {
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

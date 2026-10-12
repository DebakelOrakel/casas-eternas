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

// The quantised raster layers of the hydrology (DEC-0036 phase 7b moves
// them onto the mesh). Elevation is carried separately as raw f32 (it
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

// Flow accumulation. Full-res like lakeDepth, but kept out of WORLD_LAYERS because
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
export const DISCHARGE_LAYER: LayerSpec = layer('discharge', 'u16', 4, 0)

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

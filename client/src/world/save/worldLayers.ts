// The "baked layers" of a queryable world save (see
// docs/decisions/queryable-world-save.md). Every generated field is written into
// the save as a raster whose encoding is fully described by the manifest, so any
// consumer (the game server) can look a value up by sampling — with ZERO
// knowledge of the generation algorithms. This module is the algorithm-free
// contract: the layer specs, the quantiser (bake), and the sampler (lookup).

import { metersToElevation } from '../../generator/elevation/elevationScale'
import { sampleNearestWorld } from '../../generator/core/field'
import { ECOLOGY_FIELD_NAMES, REFINED_FIELDS, fieldSpec } from './fieldSpec'
import type { FieldSpec } from './fieldSpec'

export type Dtype = 'u8' | 'u16' | 'f32'

// Deepest lake the u8 lakeDepth layer needs to represent, in elevation units.
const LAKE_DEPTH_RANGE = metersToElevation(3000)

// The lake layer's quantisation, exported because the amplification artifact
// stores its own lakeDepth raster and must quantise it the SAME way (it used
// to restate these numbers — BUG_BOUNTY 24).
export const LAKE_DEPTH_ENCODING: Encoding = { dtype: 'u8', scale: LAKE_DEPTH_RANGE / 255, offset: 0 }

// The bake's ice-thickness raster (surface/iceFlow.ts), METRES of ice up to
// the model's cap of 4000 m — not an elevation-unit layer, and not in the
// save: it is recomputable from the save's terrain and climate.
export const ICE_THICKNESS_ENCODING: Encoding = { dtype: 'u16', scale: 4000 / 65535, offset: 0 }

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

// The coarse (climate-grid) quantised layers. Elevation + oceanAge are carried
// separately as raw f32 (they double as the restore rasters — see the save doc).
export const WORLD_LAYERS: LayerSpec[] = [
  // Ranges are generous so real extremes never clip (greenhouse heat, Siberian
  // seasonality, very wet rainforest, gain/province-boosted ecology).
  layer('landMask', 'u8', 1, 0),
  layer('temperature', 'u8', 90 / 255, -35),
  layer('precipitation', 'u16', 8000 / 65535, 0),
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
  layer('precipitationEffective', 'u16', 8000 / 65535, 0),
  // Full-res, unlike its climate neighbours: the classification is pointwise and
  // reads elevation, which exists at world resolution (see climate/biomes.ts's
  // computeBiomesFine). A 62 km biome cell could not say where a treeline is —
  // and a game whose unit of place is a ~1.5 km hex asks exactly that. 2 MB raw,
  // and it is a mostly-flat id field, so DEFLATE takes most of it back.
  layer('biome', 'u8', 1, 0),
  layer('seasonalAmplitude', 'u8', 60 / 255, 0),
  // SIGNED since the index gained its phase (climate/monsoon.ts): the sign says
  // which half of the year is the wet one, so the layer has to reach −1. The
  // manifest carries scale/offset per layer, so an older save still decodes with
  // the range it was written at — it simply has no phase to report. Half the
  // steps of the old encoding, at 0.0078 per step over a field whose consumers
  // compare it against thresholds like 0.35.
  layer('monsoonIndex', 'u8', 2 / 255, -1),
  layer('koppen', 'u8', 1, 0),
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
  // Metres to 1000, in 1.5 cm steps — a well is never deeper here.
  layer('waterTable', 'u16', 1000 / 65535, 0),
  ...ECOLOGY_FIELD_NAMES.map((name) => layer(name, 'u8', 3 / 255, 0)),
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

// The climate step's refinement (fieldSpec.REFINED_FIELDS), written when the
// session has one — formatVersion 6. Ranges are wide against what the model
// gives today (Astrakan: 998–1024 hPa, winds under 20 m/s, anomalies within
// ±8 °C, upwelling under 8) so the energy balance can grow them unclipped:
// 950–1100 hPa at 2.3 Pa a step, ±40 m/s at 1.2 mm/s, ±20 °C at 0.6 m°C.
export const REFINED_LAYERS: LayerSpec[] = REFINED_FIELDS.map((f) => {
  // Temperature in u16 for the wider range a month reaches. A month's rain
  // is a rate, and a monsoon month's runs far past the year's (Astrakan:
  // 15 700 mm/yr at the peak), so its range is 20 000, not 8000.
  if (f.name.startsWith('temperature.')) return layer(f.name, 'u16', 140 / 65535, -70)
  if (f.name.startsWith('precipitation.')) return layer(f.name, 'u16', 20000 / 65535, 0)
  if (f.name.startsWith('pressure.')) return layer(f.name, 'u16', 150 / 65535, 950)
  if (f.name.startsWith('wind')) return layer(f.name, 'u16', 80 / 65535, -40)
  if (f.name === 'currentU' || f.name === 'currentV') return layer(f.name, 'u16', 2 / 65535, -1)
  if (f.name === 'fog' || f.name === 'foehn' || f.name === 'rainVariability') return layer(f.name, 'u8', 1 / 255, 0)
  if (f.name === 'ensoPattern') return layer(f.name, 'u8', 2 / 255, -1)
  return layer(f.name, 'u16', 40 / 65535, -20)
})

const maxCode = (dtype: Dtype): number => (dtype === 'u16' ? 65535 : 255)

function makeArray(dtype: Dtype, n: number): Uint8Array | Uint16Array | Float32Array {
  return dtype === 'f32' ? new Float32Array(n) : dtype === 'u16' ? new Uint16Array(n) : new Uint8Array(n)
}

// Quantise a source field into its layer's dtype (`value → raw`). Negative
// sentinels (ocean: OCEAN_PRECIP, OCEAN_AMPLITUDE, ECOLOGY_OCEAN, …) and
// out-of-range values clamp into range — consumers mask with landMask.
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

// Put a land-only layer's ocean sentinel back, from the landMask layer.
//
// This is the other half of the contract bakeLayer states. A field that says −1
// over water is clamped into range on the way out, so it comes back saying
// whatever the bottom of its range is — for most layers 0, which is an ordinary
// value and not obviously wrong. The reader is supposed to mask with landMask;
// this is that masking, done ONCE here at the save boundary rather than by each
// consumer, so a field read from a save is the field the generator computed.
//
// It matters because one consumer tells land from ocean BY the sentinel:
// biomes.ts's sampleLandBilinear drops ocean corners by `v >= 0`, and it is the
// one that reclassifies a restored world. Without this it blended a fabricated 0
// into every coastal land cell — the same bug the 2026-08-09 interpolation work
// fixed for the live fields, reintroduced by the round trip.
//
// Copies rather than writes through: the decoded layers are cached and shared,
// and `worldId` hashes one of them.
export function restoreLandOnlySentinel(field: Float32Array, landMask: Float32Array, sentinel: number): Float32Array {
  const out = new Float32Array(field.length)
  for (let i = 0; i < field.length; i++) out[i] = landMask[i] > 0.5 ? field[i] : sentinel
  return out
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

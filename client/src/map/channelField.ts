import { MAP_WIDTH, METERS_PER_CELL } from '../worldgen/core/mapConfig'
import { elevationToMeters, metersToElevation } from '../worldgen/elevation/elevationScale'
// Worldgen's own width vocabulary — reading its units and pure values is what
// the map→worldgen boundary allows (see the root CLAUDE.md), the same import
// map/hexPorts.ts already makes.
import { RIVER_MAX_WIDTH, RIVER_MIN_WIDTH } from '../worldgen/surface/hydrology'

// WHERE THE WATER IS, as a field — step 1 of the near-field plan
// (docs/design/hex-world-view.md, agreed 2026-08-14).
//
// The near view underwhelms because below the raster's own cell size there is
// no ORGANISATION: the fine cascade is unsigned noise, so a hillside knows
// nothing about the river at its foot. This module supplies the missing
// ingredient — for any point on the world, how far the nearest channel is,
// how high its water surface sits, and how big it is — from which
// fineElevationSurface can shape a valley instead of sprinkling roughness.
//
// Derived, never serialized, and rebuilt per TIER: the polylines a bake
// lands are a different (finer) network than the macro ones, and a valley
// carved against the wrong network would sit next to the drawn river rather
// than under it.
//
// Three planes at a fixed 4096×2048 — the paper texture's resolution, and
// deliberately NOT the tier's: at 8K the transform would cost four times the
// memory to describe a shape whose own half-width is kilometres. One field
// pixel is 3.9 km; the sub-pixel accuracy that matters near a channel comes
// from seeding the transform with the EXACT distance from each pixel centre
// to the polyline, not from the pixel count.

export const CHANNEL_FIELD_RES_X = 4096
export const CHANNEL_FIELD_RES_Y = 2048

// The world is 2:1 in metres as well as in cells, so field pixels are square
// and the chamfer weights below are valid on both axes.
const PIXEL_METERS = (MAP_WIDTH * METERS_PER_CELL) / CHANNEL_FIELD_RES_X

// Distance is stored in u8 steps. 125 m resolution over a 31.9 km reach: the
// reach only has to cover the widest valley the profile can open (see
// fineElevationSurface's VALLEY_HALF_WIDTH_MAX_M), and beyond it the answer is
// simply "no channel near", which the sampler reports rather than extrapolates.
const DISTANCE_STEP_M = 125
const DISTANCE_MAX_BYTE = 255
export const CHANNEL_FIELD_REACH_M = DISTANCE_MAX_BYTE * DISTANCE_STEP_M

// Water-surface heights are stored as metres in a u16, offset so terminal
// basins below sea level fit. 1 m steps are invisible after the interpolation
// below and halve the plane against a Float32.
const HEIGHT_OFFSET_M = 2000
const HEIGHT_MAX_M = 65535 - HEIGHT_OFFSET_M

// Chamfer 3×3 weights (Borgefors): 2 % worse than the true Euclidean
// distance, which is a tenth of a pixel here.
const CHAMFER_AXIAL = 0.9619 * PIXEL_METERS
const CHAMFER_DIAGONAL = 1.3604 * PIXEL_METERS

export interface ChannelSample {
  // Metres to the nearest channel.
  distanceM: number
  // That channel's water surface, in elevation units — the floor no synthesis
  // may cut below.
  channelHeight: number
  // The polyline's stored width, normalized to 0..1 over the hydrology scale.
  // The stored width is √(discharge / maxDischarge) rescaled (see
  // hydrology.riverWidth), so this IS √discharge — which is also how valley
  // width scales with discharge, and why the profile keys on it directly
  // rather than on its square.
  widthFraction: number
}

export interface ChannelField {
  readonly resX: number
  readonly resY: number
  // How many field pixels a polyline actually touched — the honest measure of
  // how much of this field is data rather than transform.
  readonly seedCount: number
  // Fills `out` and returns false when the nearest channel is beyond the
  // field's reach, in which case `out` is untouched.
  sample(u: number, v: number, out: ChannelSample): boolean
}

export interface ChannelSourceRivers {
  // [cellX, cellY, width] triples, polylines concatenated — the hydrology
  // layer's own format (map/hexPorts.ts reads the same buffers).
  points: Float32Array
  lengths: Uint32Array
  // The raster those cell coordinates belong to.
  width: number
  height: number
}

const wrap = (i: number, n: number): number => ((i % n) + n) % n

// C1 across pixel boundaries. Plain bilinear leaves the interpolant's
// derivative discontinuous at every cell edge, and the valley profile turns
// that derivative into a slope — which would put a visible crease across the
// terrain every 3.9 km. Smoothstepping the fractional coordinate costs two
// multiplies and removes it.
const fade = (t: number): number => t * t * (3 - 2 * t)

// `elevation` must be the raster the polylines were extracted FROM — the
// water surface a valley may not be cut below is read at the channel's own
// cell, and the two grids are one tier's, so a mismatch is a caller bug rather
// than a resampling problem.
export function buildChannelField(rivers: ChannelSourceRivers, elevation: Float32Array): ChannelField | null {
  if (rivers.lengths.length === 0) return null
  const elevResX = rivers.width
  const elevResY = rivers.height
  if (elevation.length !== elevResX * elevResY) return null
  const resX = CHANNEL_FIELD_RES_X
  const resY = CHANNEL_FIELD_RES_Y
  const n = resX * resY
  const dist = new Float32Array(n).fill(Infinity)
  const height = new Uint16Array(n)
  const widthByte = new Uint8Array(n)

  const elevationAt = (cx: number, cy: number): number => {
    const x = cx - 0.5
    const y = cy - 0.5
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const x0w = wrap(x0, elevResX)
    const x1w = wrap(x0 + 1, elevResX)
    const y0w = wrap(y0, elevResY)
    const y1w = wrap(y0 + 1, elevResY)
    const top = elevation[y0w * elevResX + x0w] * (1 - fx) + elevation[y0w * elevResX + x1w] * fx
    const bottom = elevation[y1w * elevResX + x0w] * (1 - fx) + elevation[y1w * elevResX + x1w] * fx
    return top * (1 - fy) + bottom * fy
  }

  // --- seed the transform from the polylines --------------------------------
  //
  // River points sit one raster cell apart, which is 0.5–2 field pixels, so a
  // segment is walked rather than tested endpoint to endpoint (the same reason
  // hexPorts walks them). Each sample writes the EXACT distance into the 3×3
  // block around it: the chamfer can only ever add to what it starts from, so
  // a pixel seeded with its own true distance is what keeps a 300 m-scale
  // valley floor from quantising to the 3.9 km grid.
  let seedCount = 0
  const scaleX = resX / rivers.width
  const scaleY = resY / rivers.height
  const seed = (fx: number, fy: number, h: number, w: number): void => {
    const cx = Math.floor(fx)
    const cy = Math.floor(fy)
    for (let dy = -1; dy <= 1; dy++) {
      const py = wrap(cy + dy, resY)
      for (let dx = -1; dx <= 1; dx++) {
        const px = wrap(cx + dx, resX)
        const d = Math.hypot(cx + dx + 0.5 - fx, cy + dy + 0.5 - fy) * PIXEL_METERS
        const idx = py * resX + px
        if (d >= dist[idx]) continue
        if (dist[idx] === Infinity) seedCount++
        dist[idx] = d
        height[idx] = Math.max(0, Math.min(65535, Math.round(Math.min(HEIGHT_MAX_M, elevationToMeters(h)) + HEIGHT_OFFSET_M)))
        widthByte[idx] = Math.max(0, Math.min(255, Math.round(((w - RIVER_MIN_WIDTH) / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH)) * 255)))
      }
    }
  }

  let read = 0
  for (const length of rivers.lengths) {
    for (let i = 0; i < length; i++, read += 3) {
      const x = rivers.points[read]
      const y = rivers.points[read + 1]
      const w = rivers.points[read + 2]
      seed(x * scaleX, y * scaleY, elevationAt(x, y), w)
      if (i === 0) continue
      // The previous point, walked toward this one. Polylines never cross the
      // seam (extractRiverPolylines ends one that would), so a plain delta is
      // right here — a wrapped delta would invent a segment across the world.
      const px = rivers.points[read - 3]
      const py = rivers.points[read - 2]
      const pw = rivers.points[read - 1]
      const dx = (x - px) * scaleX
      const dy = (y - py) * scaleY
      const steps = Math.ceil(Math.hypot(dx, dy) * 2)
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        seed(px * scaleX + dx * t, py * scaleY + dy * t, elevationAt(px + (x - px) * t, py + (y - py) * t), pw + (w - pw) * t)
      }
    }
  }
  if (seedCount === 0) return null

  // --- chamfer, twice ------------------------------------------------------
  //
  // Both passes wrap, and the PAIR runs twice: one forward/backward sweep
  // cannot carry a distance the long way around a torus, so a river just west
  // of the seam would leave the eastern edge unaware of it. The second pair
  // costs 8 M pixel visits and removes the seam entirely (checked by the
  // scratchpad transect script).
  const relax = (offsets: readonly (readonly [number, number, number])[], reverse: boolean): void => {
    for (let yi = 0; yi < resY; yi++) {
      const y = reverse ? resY - 1 - yi : yi
      for (let xi = 0; xi < resX; xi++) {
        const x = reverse ? resX - 1 - xi : xi
        const idx = y * resX + x
        let best = dist[idx]
        let bestSrc = -1
        for (const [ox, oy, w] of offsets) {
          const nIdx = wrap(y + oy, resY) * resX + wrap(x + ox, resX)
          const cand = dist[nIdx] + w
          if (cand < best) {
            best = cand
            bestSrc = nIdx
          }
        }
        if (bestSrc < 0) continue
        dist[idx] = best
        height[idx] = height[bestSrc]
        widthByte[idx] = widthByte[bestSrc]
      }
    }
  }
  const forward = [
    [-1, -1, CHAMFER_DIAGONAL],
    [0, -1, CHAMFER_AXIAL],
    [1, -1, CHAMFER_DIAGONAL],
    [-1, 0, CHAMFER_AXIAL],
  ] as const
  const backward = [
    [1, 1, CHAMFER_DIAGONAL],
    [0, 1, CHAMFER_AXIAL],
    [-1, 1, CHAMFER_DIAGONAL],
    [1, 0, CHAMFER_AXIAL],
  ] as const
  for (let pass = 0; pass < 2; pass++) {
    relax(forward, false)
    relax(backward, true)
  }

  const distanceByte = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    distanceByte[i] = Math.min(DISTANCE_MAX_BYTE, Math.round(dist[i] / DISTANCE_STEP_M))
  }

  return {
    resX,
    resY,
    seedCount,
    sample(u: number, v: number, out: ChannelSample): boolean {
      const x = u * resX - 0.5
      const y = v * resY - 0.5
      const x0 = Math.floor(x)
      const y0 = Math.floor(y)
      const fx = fade(x - x0)
      const fy = fade(y - y0)
      const x0w = wrap(x0, resX)
      const x1w = wrap(x0 + 1, resX)
      const r0 = wrap(y0, resY) * resX
      const r1 = wrap(y0 + 1, resY) * resX
      const i00 = r0 + x0w
      const i10 = r0 + x1w
      const i01 = r1 + x0w
      const i11 = r1 + x1w
      const d00 = distanceByte[i00]
      const d10 = distanceByte[i10]
      const d01 = distanceByte[i01]
      const d11 = distanceByte[i11]
      // All four corners saturated: nothing within reach, and interpolating
      // the cap would claim a channel exactly at the reach distance.
      if (d00 === DISTANCE_MAX_BYTE && d10 === DISTANCE_MAX_BYTE && d01 === DISTANCE_MAX_BYTE && d11 === DISTANCE_MAX_BYTE) return false
      const mix = (a: number, b: number, c: number, d: number): number =>
        (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
      out.distanceM = mix(d00, d10, d01, d11) * DISTANCE_STEP_M
      out.channelHeight = metersToElevation(mix(height[i00], height[i10], height[i01], height[i11]) - HEIGHT_OFFSET_M)
      out.widthFraction = mix(widthByte[i00], widthByte[i10], widthByte[i01], widthByte[i11]) / 255
      return true
    },
  }
}

export function createChannelSample(): ChannelSample {
  return { distanceM: 0, channelHeight: 0, widthFraction: 0 }
}

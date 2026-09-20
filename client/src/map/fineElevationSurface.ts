import { fineDetailNoise } from '../generator/elevation/ridgedNoise'
import { metersToElevation } from '../generator/elevation/elevationScale'
import { createChannelSample } from './channelField'
import type { ChannelField } from './channelField'
import type { ElevationSurface } from './elevationSurface'

// The FINE height sampler — the "one shared fine-height seam" from
// docs/design/hex-world-view.md: macro raster (bilinear, toroidal) plus
// deterministic sub-cell detail, so near-ground views stop being silky-smooth
// 7.8 km lozenges.
//
// V2 (2026-08-14, step 1 of the near-field plan) makes the synthesis
// HYDROLOGY-AWARE. V1's cascade was unorganised noise: correct in amplitude,
// but a hillside knew nothing about the river at its foot, so the near view
// read as textured dough rather than as terrain. Given a ChannelField — how
// far the nearest channel is, how high its water sits, how big it is — three
// things become possible, and all three are what the eye actually reads as
// "landscape":
//
//   1. an ANALYTIC VALLEY, opened around every channel with a half-width and
//      a depth taken from the channel's own discharge;
//   2. the noise SUPPRESSED on the valley floor, because a floodplain is flat
//      and the raster's own smoothness there is not an error;
//   3. the roughness kept off the water: nothing may end up below the surface
//      of the channel it drains to.
//
// Plus a ridged blend at convex crests, which is the same trick the generator
// uses one scale up (see the ridge octave band work, 2026-08-07): |noise|
// folded is what makes a crest a crest rather than a bulge.
//
// The plan's fourth ingredient, the anisotropic warp, is NOT here — see the
// section below for the three constructions that were measured and what each
// one did.
//
// Everything here is RENDER-SIDE. It runs on whatever raster is in force,
// carves nothing into it, and is never serialized — so it needs no ALGO
// version and turns no artifact over.
//
// The noise source is worldgen's own fineDetailNoise (periodic across the
// torus, continuous at fractional coordinates), sampled as a FRACTAL CASCADE:
// fineDetailNoise's own octave table bottoms out at ~15.6 km wavelength — two
// raster cells, i.e. exactly the content the raster already carries — so on
// its own it adds nothing visible at a 4 km view. Each cascade step
// re-evaluates it on a 3× smaller periodic domain (frequencies ×3, torus seam
// preserved since the world period stays an integer multiple), pushing detail
// down to ~300 m wavelengths, with fractal amplitude falloff per step.
const DETAIL_FLOOR = metersToElevation(12)
const DETAIL_SLOPE_GAIN = metersToElevation(3500)
const DETAIL_CAP = metersToElevation(240)

// Cascade: domain divisor per step ×3 (each fineDetailNoise call spans two
// internal octaves, so steps of 3 still cover the band densely). The
// falloff is deliberately SHALLOW (H ≈ 0.45 — rough, young-terrain
// scaling): with a classic ~0.45-per-step falloff the sub-km band ended up
// carrying only ±3–7 m and the near view still read as polished
// (data-checked 2026-08-07); most of what the eye calls "detail" lives in
// exactly that band.
const CASCADE_SCALES = [2, 6, 18, 54]
const CASCADE_AMPLITUDES = [1, 0.6, 0.42, 0.3]
const CASCADE_NORM = CASCADE_AMPLITUDES.reduce((a, b) => a + b, 0)

// --- the valley profile ----------------------------------------------------
//
// Half-width and depth both scale with the channel's stored width, which IS
// √discharge (see ChannelSample.widthFraction) — the same exponent hydraulic
// geometry gives valley width, so the profile keys on it linearly rather than
// re-deriving a discharge.
//
// The half-width floor is set by what the distance field can resolve, not by
// what a stream would carve: at 3.9 km field pixels a 300 m valley would be
// pure interpolation. Anything narrower than this belongs to the amplification
// bake's own erosion, not to a synthesis.
//
// √widthFraction, not widthFraction: measured on a real 4K bake, the stored
// widths' quartiles are 0.067 / 0.087 / 0.120 — almost every channel on a
// world is a small fraction of its biggest river, so a linear mapping gave
// nine tenths of them the floor and the valley closed within 2 km of the
// water. Under the square root the same quartiles span 3.2–3.9 km and only
// the trunk rivers reach the ceiling, which is the spread the near view can
// actually see.
const VALLEY_HALF_WIDTH_MIN_M = 1200
const VALLEY_HALF_WIDTH_MAX_M = 9000
const VALLEY_DEPTH_MIN_M = 60
const VALLEY_DEPTH_MAX_M = 500

// THE DEPTH BUDGET, and the reason the profile is relative rather than
// absolute: the raster has ALREADY carved a valley here — that is what its
// erosion pass was for — and a second, absolute carve on top would double it.
// So the synthesis may only take a fraction of the height a point still stands
// ABOVE its channel's water surface. Two properties fall out of that shape,
// both of which an absolute depth would have had to enforce by hand: the carve
// vanishes AT the channel (where the ground is already at water level, so
// there is no residual to take), and no sample can ever end up below the water
// surface, since the carve is strictly less than the height above it.
// Scaled by the channel's size, and that scaling is where most of the
// "monotonic in discharge" actually comes from: a trunk river has had time to
// widen a floodplain, a headwater stream still sits in its own notch. Without
// it the profile is nearly size-blind, because a real world's discharges are
// so skewed that three quarters of its channels differ by a factor of two
// (measured 2026-08-14).
const VALLEY_BUDGET_MIN = 0.4
const VALLEY_BUDGET_MAX = 0.7

// How much of the nominal roughness survives on the valley floor. Not zero:
// a floodplain is flat, not polished.
const VALLEY_FLOOR_NOISE = 0.12

// --- the anisotropic warp: NOT HERE, and that is a measurement -------------
//
// The plan's third ingredient was to warp the cascade along the contours so
// the roughness runs with the land. Three constructions were built and
// measured against a real 4K bake on 2026-08-14, by DETRENDED slope reversals
// along the contour versus down the fall line (the finished height's own
// reversals measure the hillside, not the noise, so they say nothing). The
// isotropic reference is 0.954.
//
//   Displacement by a noise field — the usual reading of "domain warp".
//   0.964 against 0.961 without it: NO effect. Its own variation is
//   isotropic, so the strain it produces points nowhere in particular.
//
//   A three-tap directional low-pass, which does elongate: 0.954 → 1.12. But
//   only when it reaches the sub-kilometre band, and that is the band the
//   ridge fold lives in — crest curvature at local maxima came out at 0.92 m
//   against the 1.12 m the fold reaches without it. Restricted to the band
//   above, the anisotropy vanishes again (1.009 against 0.996) and the crests
//   only partly return. Elongation and crests compete for one octave.
//   Cost: +25 % per sample.
//
//   A shear proportional to height, which needs no extra noise at all: 1.036,
//   in the right direction but small, and it adds 20–25 % more reversals in
//   BOTH directions — on real terrain the axis field rotates fast enough that
//   the shear decorrelates the pattern instead of stretching it. (Built with
//   the sign inverted first, which compresses rather than stretches; that
//   "improved" crest curvature to 5.13 m, which is the fine band aliasing
//   into the sample spacing and not a crest at all. A measure that improves
//   because the pattern got smaller is measuring the wrong thing — and the
//   same trap made the noise-displacement warp look like a crest gain in the
//   first round of numbers.)
//
// So the ingredient is deferred rather than shipped weak: the valley profile
// and the ridge fold both measure strongly, and neither needs it. Reviving it
// means choosing the trade in the second construction — lineated texture for
// softer crests — which is a look decision, not a measurement.

// --- crests ----------------------------------------------------------------
//
// Convexity at which the cascade is fully ridge-folded, as the raster's own
// Laplacian: 90 m per cell² against a measured convex-half median of 61 m and
// p90 of 246 m on an amplified 4K world, so ordinary convex ground folds
// partly and only real crests fold fully. Worth the constant — measured in
// isolation (fold off against on, same seed), crest curvature at local maxima
// over 120 m goes 0.68 m → 1.12 m and the number of maxima rises a quarter.
//
// Stated PER CELL, so it has to be restated per tier or it stops meaning the
// same thing: the same terrain measured on 8K cells gives a convex-half
// median of 29 m, and against a fixed 90 the fold then barely engaged (crest
// curvature 1.00 m against v1's 0.95 — a tenth of the gain it has at 4K).
// The scaling is measured too, and it is 1/resolution rather than the
// 1/resolution² a smooth surface would give: terrain is fractal, and 61 → 29
// across a doubling is what that looks like.
const RIDGE_CURVATURE_REF_M = 90
const RIDGE_CURVATURE_REF_RES_X = 4096

export interface FineElevationOptions {
  elevation: Float32Array
  resX: number
  resY: number
  heightScale: number
  // The seed the whole cascade hangs off — the generator's warpSeed where the
  // manifest carries it, so the pattern matches the generator's own idea of
  // this world.
  seed: number
  // `bias` shifts the zero-mean cascade upward in units of the local
  // amplitude (noise spans roughly ±0.5, so bias 0.6 keeps every sample
  // strictly ABOVE the plain raster surface). The detail patch needs that:
  // the smooth relief mesh keeps rendering underneath it, and any sample
  // dipping below it would simply be occluded — half the detail swallowed.
  // Consumers that want the unbiased height truth pass 0.
  bias?: number
  // Where the water is. Null before a tier's rivers have landed (the macro
  // network is derived asynchronously at load), in which case this degrades
  // exactly to v1's cascade.
  channels?: ChannelField | null
}

export function createFineElevationSurface(options: FineElevationOptions): ElevationSurface {
  const { elevation, resX, resY, heightScale, seed, bias = 0, channels = null } = options
  const wrap = (i: number, n: number): number => ((i % n) + n) % n

  const baseAt = (u: number, v: number): number => {
    // -0.5: raster values sit at texel centers.
    const x = u * resX - 0.5
    const y = v * resY - 0.5
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const x0w = wrap(x0, resX)
    const x1w = wrap(x0 + 1, resX)
    const r0 = wrap(y0, resY) * resX
    const r1 = wrap(y0 + 1, resY) * resX
    const top = elevation[r0 + x0w] * (1 - fx) + elevation[r0 + x1w] * fx
    const bottom = elevation[r1 + x0w] * (1 - fx) + elevation[r1 + x1w] * fx
    return top * (1 - fy) + bottom * fy
  }

  const ridgeCurvatureRef = metersToElevation(RIDGE_CURVATURE_REF_M) * (RIDGE_CURVATURE_REF_RES_X / resX)

  const du = 1 / resX
  const dv = 1 / resY
  const channel = createChannelSample()

  return {
    heightAtUV(u: number, v: number): number {
      const base = baseAt(u, v)
      if (base <= 0) return 0

      // Gradient and curvature as central differences OF THE INTERPOLANT, one
      // cell apart, rather than from the four corner values of the containing
      // cell. Both are continuous in position that way, and they modulate
      // amplitude and direction — a piecewise-constant modulator would put a
      // step at every cell boundary, which is a 7.8 km grid of creases.
      const eE = baseAt(u + du, v)
      const eW = baseAt(u - du, v)
      const eS = baseAt(u, v + dv)
      const eN = baseAt(u, v - dv)
      const gx = (eE - eW) / 2
      const gy = (eS - eN) / 2
      const slope = Math.hypot(gx, gy)
      const curvature = eE + eW + eS + eN - 4 * base

      let carved = base
      let floorFactor = 1
      // How much room there is between this point and the water it drains to.
      // Infinite where no channel is near — then only sea level binds, which
      // is the rule v1 already had.
      let freeboard = Infinity

      if (channels && channels.sample(u, v, channel)) {
        const size = Math.sqrt(channel.widthFraction)
        const halfWidth = VALLEY_HALF_WIDTH_MIN_M + (VALLEY_HALF_WIDTH_MAX_M - VALLEY_HALF_WIDTH_MIN_M) * size
        const t = Math.min(1, channel.distanceM / halfWidth)
        const above = base - channel.channelHeight
        if (above > 0) {
          const depthCap = metersToElevation(VALLEY_DEPTH_MIN_M + (VALLEY_DEPTH_MAX_M - VALLEY_DEPTH_MIN_M) * size)
          // (1 - t²)² — 1 at the channel, 0 at the half-width, and with zero
          // slope at both ends so the valley meets the untouched land without
          // a crease.
          const profile = (1 - t * t) * (1 - t * t)
          const budget = VALLEY_BUDGET_MIN + (VALLEY_BUDGET_MAX - VALLEY_BUDGET_MIN) * size
          carved = base - Math.min(depthCap, budget * above) * profile
          // The carve is strictly less than `above`, so this stays positive —
          // and it is what stops the ROUGHNESS from doing what the carve
          // cannot: a 20 m bump on 10 m of freeboard would put ground below
          // the water surface just as surely.
          freeboard = carved - channel.channelHeight
        }
        floorFactor = VALLEY_FLOOR_NOISE + (1 - VALLEY_FLOOR_NOISE) * (t * t * (3 - 2 * t))
      }

      // `carved` is the clearance above SEA level, `freeboard` the clearance
      // above the nearest channel's water: whichever is tighter caps the
      // roughness, so no sample can be pushed under either.
      const amplitude = Math.min(DETAIL_CAP, DETAIL_FLOOR + DETAIL_SLOPE_GAIN * slope, carved, freeboard) * floorFactor
      const px = wrap(u * resX, resX)
      const py = wrap(v * resY, resY)

      // Convex ground gets the ridge fold. |n| turned inside out has a crease
      // where the smooth noise has a zero crossing, which is what a crest is.
      const ridgeWeight = Math.min(1, Math.max(0, -curvature / ridgeCurvatureRef))
      let detail = 0
      for (let i = 0; i < CASCADE_SCALES.length; i++) {
        const s = CASCADE_SCALES[i]
        const n = fineDetailNoise(px, py, resX / s, resY / s, (seed + i * 0x9e3779b9) >>> 0)
        const shaped = ridgeWeight > 0 ? n + (0.5 - 2 * Math.abs(n) - n) * ridgeWeight : n
        detail += shaped * CASCADE_AMPLITUDES[i]
      }
      return Math.max(0, carved + (detail / CASCADE_NORM + bias) * amplitude) * heightScale
    },
  }
}

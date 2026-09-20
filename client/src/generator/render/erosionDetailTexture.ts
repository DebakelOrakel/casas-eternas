import { fineDetailNoise } from '../elevation/ridgedNoise'
import { metersToElevation } from '../elevation/elevationScale'

// Render-only fine detail texture — the smallest honest slice of
// docs/design/resolution-strategy.md's option (A) ("ridged multifractal
// ... conditioned on the coarse field's own slope") buildable without that
// doc's "micro" tier, which needs an on-demand hex-region query system that
// doesn't exist in this branch yet (see docs/decisions/world-topology-torus.md
// and the project-branch-scope-worldgen memory note — the game screen is out
// of scope here). This does NOT add a second resolution tier or a query API;
// it adds one more, finer noise octave to the EXISTING 2048x1024 grid, at
// render time only.
//
// NOTE 2026-08-06: partially superseded. computeElevation now embeds a
// PHYSICAL plains micro-relief (fineValue / PLAIN_DETAIL_MAX — added for
// flatland river spread, which a display-only layer cannot influence), so
// the premise below ("plains get near-zero detail") no longer holds for the
// simulation field. This texture remains as an optional, purely cosmetic
// extra on top and stays off by default.
//
// Why plains specifically needed this: a flat, tectonically-quiet cell got
// near-zero detail from TWO separate places at the time of writing. computeElevation's
// ridged-multifractal term (elevationField.ts) is gated on `uplift > 0`, so
// anywhere with no nearby terrain feature gets none of it. And the v1 erosion
// pass (deleted with erosion-v2 P5) scaled its incision down on the plains
// specifically so mountains and plains would stop fighting over one
// relief/flatness trade-off
// — a deliberate, acknowledged compromise, but its side effect was that
// plains kept almost exactly their smooth metaball-baseline shape. This layer
// doesn't touch either of those systems; it just paints a little texture on
// top of what they produce, conditioned on the RESULT's own local slope so it
// reads as consistent with the terrain rather than a uniform noise blanket.
//
// Mutates a DISPLAY COPY only — never rawElevations (erosion.ts's own
// physically authoritative field, or anything saved/queried by climate,
// ecology, hydrology, or the server). See elevationMapImage.ts's own
// SimulationRenderResult.elevations vs .rawElevations split, which already
// exists for exactly this reason (today it separates the mountain-
// redistribution gamma curve from the physical field; this reuses the same
// seam rather than opening a new one).

// A little texture even on dead-flat ground — real plains are never
// perfectly flat (relict dunes, abandoned channels, soil creep) even with
// zero tectonic or fluvial history behind them.
const DETAIL_FLOOR_M = 4
// How much local slope (elevation units per pixel — the same dimensionless
// "rise over one ~7.8 km cell" quantity erosion.ts's own talus/stream-power
// code uses) adds on top of the floor. Sized so an already-steep mountain
// flank — which the uplift-gated ridged noise upstream already textures
// heavily — gets pushed toward the cap rather than doubled: this is meant to
// fill in what's structurally missing on LOW-relief ground, not stack a
// second layer of mountain detail on top of the first.
const DETAIL_SLOPE_GAIN_M = 900
const DETAIL_CAP_M = 45

const DETAIL_FLOOR = metersToElevation(DETAIL_FLOOR_M)
const DETAIL_SLOPE_GAIN = metersToElevation(DETAIL_SLOPE_GAIN_M)
const DETAIL_CAP = metersToElevation(DETAIL_CAP_M)

// NOTE on calibration: unlike almost every other tuning constant in this
// pipeline, these three were NOT calibrated against a measured distribution
// (no headless dump-and-diff pass, no percentile sweep) — this was written
// without a way to eyeball the running app. Treat DETAIL_FLOOR_M /
// DETAIL_SLOPE_GAIN_M / DETAIL_CAP_M as a starting point for the same
// by-eye tuning pass every other visual constant in this file's neighbors
// (ridgedNoise.ts, elevationField.ts) already went through, not as a
// finished number.

// `display` is the copy to paint onto (elevationMapImage.ts's `elevations`,
// AFTER redistribution if that ran — order doesn't matter much here since
// this only ADDS a small amount, but after keeps the two effects visually
// independent: redistribution reshapes existing relief, this adds new
// texture). `reference` is the terrain to read slope + land mask from
// (rawElevations — the pre-redistribution, physically meaningful field, so
// the texture amplitude doesn't get coupled to whatever the mountain-
// redistribution gamma curve happened to do to the SAME pixel it's about to
// paint over).
export function applyErosionDetailTexture(display: Float32Array, reference: Float32Array, width: number, height: number, warpSeed: number): void {
  const noiseSeed = (warpSeed ^ 0x9e3779b9) >>> 0
  for (let y = 0; y < height; y++) {
    const down = (y + 1) % height
    const row = y * width
    const downRow = down * width
    for (let x = 0; x < width; x++) {
      const i = row + x
      const e = reference[i]
      if (e <= 0) continue // ocean untouched
      const right = (x + 1) % width
      const dzdx = reference[row + right] - e
      const dzdy = reference[downRow + x] - e
      const slope = Math.hypot(dzdx, dzdy)
      // Amplitude additionally capped by the cell's own height above sea level,
      // so display-only texture can never flip a land pixel's sign: a delta
      // plain sits at just ~0.5-4 m graded freeboard (DELTA_FREEBOARD_NEAR/FAR,
      // erosion.ts), and the plain ±2 m floor amplitude was pushing single
      // pixels below zero there — ocean-colored speckle across every delta.
      // Capping at the smaller of reference/display height keeps the worst dip
      // at half the cell's height (noise spans ±0.5), always above water, and
      // fades the texture smoothly toward every coastline instead of clipping.
      const headroom = Math.min(e, display[i] > 0 ? display[i] : e)
      const amplitude = Math.min(DETAIL_CAP, DETAIL_FLOOR + DETAIL_SLOPE_GAIN * slope, headroom)
      display[i] += fineDetailNoise(x, y, width, height, noiseSeed) * amplitude
    }
  }
}

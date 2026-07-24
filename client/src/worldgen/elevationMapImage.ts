import { elevationToColor } from './elevationColor'
import { applyMountainRedistribution, computeRaftBaseline } from './elevationField'
import { getVelocityAt } from './plateMotion'
import type { PlateSimulation } from './plateSimulation'
import { rasterizeVoronoiPlates } from './voronoiRaster'
import { computePlateCentroids } from './plateGeometry'
import type { ContinentLabelPlacement } from './continentLabelRenderer'
import { computeRaftLabelPlacements } from './raftLabelLayout'
import type { ElevationRenderPool } from './elevationRenderPool'

// A per-plate velocity arrow, in world coordinates — the source data the
// main-thread overlay compositor strokes onto the map (see WorldGenScreen).
// Kept as plain geometry here (worker has no Canvas2D); nothing is drawn.
export interface PlateArrow {
  x: number
  y: number
  vx: number
  vy: number
}

// Whether to apply the mountain-accentuating gamma redistribution curve
// (applyMountainRedistribution) before coloring. Temporarily false
// (2026-07-23) to evaluate the raw new tectonic terrain — the redistribution
// reshapes elevations against the map's own peak and can mask what the
// ridge/trench/ridged-multifractal changes actually produce.
const ACCENTUATE_MOUNTAINS = false

// Event highlights (merge/rift/subduction markers) used to be baked into
// the raster here as red plate-territory tints and distance-field halos.
// They now live as main-thread overlay markers with proper geologic-line
// geometry, driven by the sim's events (see WorldGenScreen's event overlay
// and the raft SimEvent types) — so all of that baking machinery is gone.

export interface SimulationRenderResult {
  // Base color raster ONLY — elevation shading, no boundaries/arrows/labels/
  // event markers baked in. Those are now separate, individually toggleable
  // main-thread overlay layers composited on top (see WorldGenScreen); the
  // three overlay-source fields below are the data they draw from.
  buffer: Uint8Array
  // Full-resolution plate-boundary mask (1 where the pixel sits on a Voronoi
  // cell edge, else 0). Drawn as fine boundary lines by the compositor; kept
  // full-res regardless of the elevation preview scale so the lines stay
  // crisp. Uint8 rather than a bitset for a straightforward transfer + draw.
  boundaryMask: Uint8Array
  // Per-plate velocity arrows (world coords) for the motion overlay.
  plateArrows: PlateArrow[]
  // Per-raft continent-name label geometry (position/angle/fit size) for the
  // names overlay — computed from raft blobs, no text drawn here.
  raftLabels: ContinentLabelPlacement[]
  // Fraction of the map (by pixel count, computed from this same pass —
  // not from plate type counts) whose elevation is above sea level.
  // Plate type alone is a poor proxy for this: a continental plate's own
  // baseline can dip below zero near its jittered low end or a nearby
  // rift, and an oceanic plate can push well above zero at an island
  // arc/hotspot — actual rendered elevation is what should count as land.
  landFraction: number
  // Elevation exactly as the field query (or precomputedElevations, if
  // that path was taken) produced it, *before* applyMountainRedistribution's
  // cosmetic reshaping — the physically meaningful values a later erosion
  // pass (erosion.ts) needs to act on, not the display-squashed ones.
  rawElevations: Float32Array
  // The redistributed values actually used for elevationToColor — what a
  // debug 3D heightmap preview (see WorldGenScreen.ts) should displace
  // by, so the relief it shows matches what the 2D color map is already
  // showing (a white "snow-capped" pixel should also be the tallest
  // point in 3D) rather than the pre-redistribution physical field.
  elevations: Float32Array
}

export interface RenderSimulationOptions {
  // Skip the elevation field query (baseline blend + pool.renderElevations
  // — together the ~88%+~15% of a normal render's cost) and use this
  // array instead, e.g. the output of an erosion pass (erosion.ts) run
  // against a previous render's own rawElevations. Everything downstream
  // — redistribution, coloring, and the overlay-source passes — runs
  // exactly as it would on a freshly-queried field, since none of it
  // knows or cares where the elevation values came from.
  precomputedElevations?: Float32Array
  // Downscale factor for the expensive elevation-field query only (baseline
  // blend + pool.renderElevations): the field is sampled on a grid of
  // width/scale x height/scale and bilinearly upscaled back to full
  // resolution before coloring, so a live preview can render several times
  // faster at a slightly softer elevation shading. Must divide the map
  // dimensions evenly. Defaults to 1 (full resolution — no downscale, no
  // upscale). The boundary mask, arrows, and labels stay full resolution
  // regardless, so plate outlines and overlays remain crisp. Ignored when
  // precomputedElevations is supplied (that array is already the final
  // full-res field).
  elevationScale?: number
}

// Renders the simulation's current state into an RGBA buffer: elevation
// (from the stateless distance-field query) determines every pixel's
// color, except pixels right on a plate boundary — those stay a dark
// outline on top (see showBoundaries). Velocity arrows are drawn last, on
// top of both (see showArrows).
//
// Bilinear upscale of a low-res elevation grid back to full resolution,
// wrapping toroidally at both seams (the map wraps in both axes, so the
// last row/column interpolate against the first, not a clamped edge). Used
// to expand a downscaled live-preview elevation field (see
// RenderSimulationOptions.elevationScale) to the full raster the coloring
// pass and everything downstream expect.
function upscaleBilinearToroidal(src: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight)
  const fx = srcWidth / dstWidth
  const fy = srcHeight / dstHeight
  for (let y = 0; y < dstHeight; y++) {
    const sy = y * fy
    const y0 = Math.floor(sy)
    const ty = sy - y0
    const y0m = ((y0 % srcHeight) + srcHeight) % srcHeight
    const y1m = (y0m + 1) % srcHeight
    for (let x = 0; x < dstWidth; x++) {
      const sx = x * fx
      const x0 = Math.floor(sx)
      const tx = sx - x0
      const x0m = ((x0 % srcWidth) + srcWidth) % srcWidth
      const x1m = (x0m + 1) % srcWidth
      const v00 = src[y0m * srcWidth + x0m]
      const v10 = src[y0m * srcWidth + x1m]
      const v01 = src[y1m * srcWidth + x0m]
      const v11 = src[y1m * srcWidth + x1m]
      const top = v00 + (v10 - v00) * tx
      const bottom = v01 + (v11 - v01) * tx
      dst[y * dstWidth + x] = top + (bottom - top) * ty
    }
  }
  return dst
}

// Async, and takes a render pool, because the actual per-pixel elevation
// query — profiled at ~88% of total render time — is farmed out across
// a pool of nested workers (see elevationRenderPool.ts) rather than
// computed inline here. Everything else in this function (Voronoi
// rasterization, baseline blending, redistribution, coloring, boundary
// lines, arrows, labels) stays single-threaded — combined, profiling
// showed it's under 15% of total cost, not worth distributing too.
export async function renderSimulationImage(sim: PlateSimulation, pool: ElevationRenderPool, options: RenderSimulationOptions = {}): Promise<SimulationRenderResult> {
  const { precomputedElevations } = options
  const { width, height } = sim
  const cellIds = rasterizeVoronoiPlates(sim.seeds, width, height)
  const buffer = new Uint8Array(width * height * 4)

  let elevations: Float32Array
  if (precomputedElevations) {
    // Copied rather than used directly — applyMountainRedistribution
    // below mutates in place, and precomputedElevations may be a caller-
    // retained array (e.g. the worker's own cached "last raw elevations"
    // it plans to erode again from later) that shouldn't be silently
    // reshaped as a side effect of rendering it once.
    elevations = precomputedElevations.slice()
  } else {
    // The elevation field query runs on a (possibly coarser) render grid;
    // everything else stays at full world resolution. scale 1 == no
    // downscale/upscale, identical to before.
    const scale = Math.max(1, Math.floor(options.elevationScale ?? 1))
    const renderWidth = Math.floor(width / scale)
    const renderHeight = Math.floor(height / scale)
    const blendedBaselines = computeRaftBaseline(sim.rafts, sim.oceanAge, renderWidth, renderHeight, width, height, sim.warpSeed)
    const rendered = await pool.renderElevations(renderWidth, renderHeight, width, height, blendedBaselines, sim.features, sim.warpSeed)
    elevations = scale === 1 ? rendered : upscaleBilinearToroidal(rendered, renderWidth, renderHeight, width, height)
  }
  // Captured before redistribution reshapes elevations in place — see
  // SimulationRenderResult.rawElevations.
  const rawElevations = elevations.slice()
  // Normalizes against this map's own actual highest point — has to
  // happen after every pixel's raw elevation is known (i.e. after the
  // pool has finished, not per-pixel/per-slice as each one is computed)
  // — see applyMountainRedistribution's own comment for why.
  // Temporarily gated off (2026-07-23) while evaluating the new tectonic
  // ridge/trench/ridged-multifractal terrain by eye — flip back to true to
  // restore the mountain-accentuating gamma curve.
  if (ACCENTUATE_MOUNTAINS) applyMountainRedistribution(elevations)

  // Base color raster + the boundary mask, in one pass. The mask marks a
  // pixel whose right or down neighbor belongs to a different plate — the
  // same edge test the baked boundary used, but recorded rather than
  // painted, so the compositor can draw (or hide) the lines on the main
  // thread without a re-render.
  const boundaryMask = new Uint8Array(width * height)
  let landPixelCount = 0
  for (let y = 0; y < height; y++) {
    const downRow = (y + 1) % height
    for (let x = 0; x < width; x++) {
      const rightCol = (x + 1) % width
      const idx = y * width + x
      const plateIndex = cellIds[idx]
      if (plateIndex !== cellIds[y * width + rightCol] || plateIndex !== cellIds[downRow * width + x]) boundaryMask[idx] = 1
      const elevation = elevations[idx]
      if (elevation > 0) landPixelCount++
      const color = elevationToColor(elevation)
      const pixelIndex = idx * 4
      buffer[pixelIndex] = color[0]
      buffer[pixelIndex + 1] = color[1]
      buffer[pixelIndex + 2] = color[2]
      buffer[pixelIndex + 3] = 255
    }
  }

  // Overlay source data — always produced (cheap), toggled on the main
  // thread. Arrows anchor at plate centroids; labels come from raft blobs.
  const centroids = computePlateCentroids(cellIds, sim.seeds.length, width, height)
  const plateArrows: PlateArrow[] = centroids.map((centroid, i) => {
    const { vx, vy } = getVelocityAt(centroid, sim.motions[i], width, height)
    return { x: centroid.x, y: centroid.y, vx, vy }
  })
  const raftLabels = computeRaftLabelPlacements(sim.rafts, width, height)

  return { buffer, boundaryMask, plateArrows, raftLabels, landFraction: landPixelCount / (width * height), rawElevations, elevations }
}

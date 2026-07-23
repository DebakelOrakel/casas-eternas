import { drawPlateArrows } from './plateArrows'
import { elevationToColor } from './elevationColor'
import { applyMountainRedistribution, computeBlendedBaselines } from './elevationField'
import { computeAgedBaseElevations } from './plateBaseline'
import { getVelocityAt } from './plateMotion'
import type { PlateSimulation } from './plateSimulation'
import { rasterizeVoronoiPlates } from './voronoiRaster'
import { computePlateCentroids } from './plateGeometry'
import { computeContinentLabelPlacements } from './continentLabelLayout'
import type { ContinentLabelPlacement } from './continentLabelLayout'
import type { ElevationRenderPool } from './elevationRenderPool'

const BOUNDARY_COLOR: [number, number, number] = [15, 15, 15]

export interface SimulationRenderResult {
  buffer: Uint8Array
  // Fraction of the map (by pixel count, computed from this same pass —
  // not from plate type counts) whose elevation is above sea level.
  // Plate type alone is a poor proxy for this: a continental plate's own
  // baseline can dip below zero near its jittered low end or a nearby
  // rift, and an oceanic plate can push well above zero at an island
  // arc/hotspot — actual rendered elevation is what should count as land.
  landFraction: number
  // Geometry only — no pixels drawn yet, see computeContinentLabels.
  labelPlacements: ContinentLabelPlacement[]
}

export interface RenderSimulationOptions {
  // Dark outline at every plate boundary, so individual plates stay
  // visible as regions even once they're colored by height instead of by
  // plate identity. On by default — off just for debugging/comparison.
  showBoundaries?: boolean
  // Velocity arrow at each plate's centroid. On by default.
  showArrows?: boolean
  // Continent name label geometry (position/angle/available size) is
  // computed but NOT drawn here — this module only ever produces a raw
  // pixel buffer, with no font/text rendering available to it (see
  // continentLabelLayout.ts and WorldGenScreen.ts, which draws the actual
  // text on the main thread via Canvas2D once the buffer arrives). On by
  // default; set false to skip the extra geometry passes entirely.
  computeContinentLabels?: boolean
}

// Renders the simulation's current state into an RGBA buffer: elevation
// (from the stateless distance-field query) determines every pixel's
// color, except pixels right on a plate boundary — those stay a dark
// outline on top (see showBoundaries). Velocity arrows are drawn last, on
// top of both (see showArrows).
//
// Async, and takes a render pool, because the actual per-pixel elevation
// query — profiled at ~88% of total render time — is farmed out across
// a pool of nested workers (see elevationRenderPool.ts) rather than
// computed inline here. Everything else in this function (Voronoi
// rasterization, baseline blending, redistribution, coloring, boundary
// lines, arrows, labels) stays single-threaded — combined, profiling
// showed it's under 15% of total cost, not worth distributing too.
export async function renderSimulationImage(sim: PlateSimulation, pool: ElevationRenderPool, options: RenderSimulationOptions = {}): Promise<SimulationRenderResult> {
  const { showBoundaries = true, showArrows = true, computeContinentLabels = true } = options
  const { width, height } = sim
  const cellIds = rasterizeVoronoiPlates(sim.seeds, width, height)
  const agedBaseElevations = computeAgedBaseElevations(sim.baseElevations, sim.types, sim.ages)
  const blendedBaselines = computeBlendedBaselines(sim.seeds, agedBaseElevations, width, height)
  const buffer = new Uint8Array(width * height * 4)

  const elevations = await pool.renderElevations(width, height, blendedBaselines, sim.features)
  // Normalizes against this map's own actual highest point — has to
  // happen after every pixel's raw elevation is known (i.e. after the
  // pool has finished, not per-pixel/per-slice as each one is computed)
  // — see applyMountainRedistribution's own comment for why.
  applyMountainRedistribution(elevations)

  let landPixelCount = 0
  for (let y = 0; y < height; y++) {
    const downRow = (y + 1) % height
    for (let x = 0; x < width; x++) {
      const rightCol = (x + 1) % width
      const idx = y * width + x
      const plateIndex = cellIds[idx]
      const isBoundary = showBoundaries && (plateIndex !== cellIds[y * width + rightCol] || plateIndex !== cellIds[downRow * width + x])
      const elevation = elevations[idx]
      if (elevation > 0) landPixelCount++
      const color = isBoundary ? BOUNDARY_COLOR : elevationToColor(elevation)
      const pixelIndex = idx * 4
      buffer[pixelIndex] = color[0]
      buffer[pixelIndex + 1] = color[1]
      buffer[pixelIndex + 2] = color[2]
      buffer[pixelIndex + 3] = 255
    }
  }

  const centroids = showArrows || computeContinentLabels ? computePlateCentroids(cellIds, sim.seeds.length, width, height) : []

  if (showArrows) {
    const velocities = centroids.map((centroid, i) => getVelocityAt(centroid, sim.motions[i], width, height))
    drawPlateArrows(buffer, width, height, centroids, velocities)
  }

  const labelPlacements = computeContinentLabels
    ? computeContinentLabelPlacements(cellIds, sim.types, sim.continentNames, centroids, width, height)
    : []

  return { buffer, landFraction: landPixelCount / (width * height), labelPlacements }
}

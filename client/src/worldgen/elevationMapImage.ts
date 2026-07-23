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
import { toroidalDistanceSq } from './toroidal'

const BOUNDARY_COLOR: [number, number, number] = [15, 15, 15]

// A subducted oceanic plate no longer has any territory of its own to
// highlight (applyMerge splices it out of sim.seeds entirely) — tinting
// the survivor's plateIndex instead would flash the whole absorbing
// continent, which doesn't show where the subduction actually happened.
// This is a point highlight around the event's own boundary coordinate
// instead, sized similarly to a terrain feature's own falloff (see
// FEATURE_FALLOFF_RADIUS in terrainFeatures.ts) rather than plate-sized.
const LOCATION_HIGHLIGHT_RADIUS = 90
const LOCATION_HIGHLIGHT_RADIUS_SQ = LOCATION_HIGHLIGHT_RADIUS * LOCATION_HIGHLIGHT_RADIUS

export interface LocationHighlight {
  x: number
  y: number
  alpha: number
}

// A split's new plate starts as a single point sitting exactly on the
// old boundary between the two plates it rifted apart from — tracing
// just that one shared edge (not the new plate's whole boundary, which
// may later touch other neighbors too) and fading away from it in both
// directions reads as "here's the rift line" instead of a filled halo
// over a plate's whole territory, which is what a plain plateHighlights
// entry for the new plate would give. Bounded multi-source BFS in pixel
// space rather than a per-pixel distance check against every source
// pixel (as locationHighlights uses against a handful of fixed points)
// — this scales with the edge's own length, not with the edge length
// times every pixel in the map.
const BOUNDARY_HIGHLIGHT_RADIUS = 90

export interface BoundaryHighlight {
  plateIndexA: number
  plateIndexB: number
  alpha: number
}

// Distance (in pixels, 4-connected, toroidally wrapped) from every pixel
// to the nearest point where plateIndexA's Voronoi cell touches
// plateIndexB's — i.e. to the specific shared edge between just these
// two plates, not either plate's boundary with anything else. Infinity
// beyond maxRadius (never gets that far; BFS stops expanding once a
// frontier pixel's own distance already hits the cap).
function computeBoundaryDistanceField(cellIds: Uint16Array, width: number, height: number, plateIndexA: number, plateIndexB: number, maxRadius: number): Float32Array {
  const dist = new Float32Array(width * height).fill(Infinity)
  const queue: number[] = []

  const markSource = (idx: number): void => {
    if (dist[idx] === 0) return
    dist[idx] = 0
    queue.push(idx)
  }

  const isTargetPair = (a: number, b: number): boolean => (a === plateIndexA && b === plateIndexB) || (a === plateIndexB && b === plateIndexA)

  for (let y = 0; y < height; y++) {
    const downRow = (y + 1) % height
    for (let x = 0; x < width; x++) {
      const rightCol = (x + 1) % width
      const idx = y * width + x
      const rightIdx = y * width + rightCol
      const downIdx = downRow * width + x
      const p = cellIds[idx]
      const pRight = cellIds[rightIdx]
      const pDown = cellIds[downIdx]
      if (isTargetPair(p, pRight)) {
        markSource(idx)
        markSource(rightIdx)
      }
      if (isTargetPair(p, pDown)) {
        markSource(idx)
        markSource(downIdx)
      }
    }
  }

  let queueHead = 0
  while (queueHead < queue.length) {
    const idx = queue[queueHead++]
    const d = dist[idx]
    if (d >= maxRadius) continue
    const y = Math.floor(idx / width)
    const x = idx - y * width
    const neighbors = [y * width + ((x + 1) % width), y * width + ((x - 1 + width) % width), ((y + 1) % height) * width + x, ((y - 1 + height) % height) * width + x]
    for (const n of neighbors) {
      if (d + 1 < dist[n]) {
        dist[n] = d + 1
        queue.push(n)
      }
    }
  }

  return dist
}

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
  // Map of plateIndex -> opacity (0..1) for translucent event highlight overlays.
  plateHighlights?: Map<number, number>
  // Point-based highlights (see LOCATION_HIGHLIGHT_RADIUS) for events with
  // no surviving plate territory of their own to tint, e.g. subduction.
  locationHighlights?: LocationHighlight[]
  // Plate-pair highlights for the "red line at the new boundary"
  // treatment a split gets (see BOUNDARY_HIGHLIGHT_RADIUS) — distinct
  // from plateHighlights, which fills a plate's whole territory rather
  // than tracing just one specific edge.
  boundaryHighlights?: BoundaryHighlight[]
  // Skip the elevation field query (baseline blend + pool.renderElevations
  // — together the ~88%+~15% of a normal render's cost) and use this
  // array instead, e.g. the output of an erosion pass (erosion.ts) run
  // against a previous render's own rawElevations. Everything downstream
  // — redistribution, coloring, boundaries, highlights, arrows, labels —
  // runs exactly as it would on a freshly-queried field, since none of it
  // knows or cares where the elevation values came from.
  precomputedElevations?: Float32Array
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
  const { showBoundaries = true, showArrows = true, computeContinentLabels = true, plateHighlights, locationHighlights, boundaryHighlights, precomputedElevations } = options
  const { width, height } = sim
  const cellIds = rasterizeVoronoiPlates(sim.seeds, width, height)
  const buffer = new Uint8Array(width * height * 4)

  let boundaryHighlightField: Float32Array | null = null
  if (boundaryHighlights && boundaryHighlights.length > 0) {
    boundaryHighlightField = new Float32Array(width * height)
    for (const { plateIndexA, plateIndexB, alpha } of boundaryHighlights) {
      const distField = computeBoundaryDistanceField(cellIds, width, height, plateIndexA, plateIndexB, BOUNDARY_HIGHLIGHT_RADIUS)
      for (let i = 0; i < distField.length; i++) {
        if (distField[i] >= BOUNDARY_HIGHLIGHT_RADIUS) continue
        const falloff = (1 - distField[i] / BOUNDARY_HIGHLIGHT_RADIUS) * alpha
        if (falloff > boundaryHighlightField[i]) boundaryHighlightField[i] = falloff
      }
    }
  }

  let elevations: Float32Array
  if (precomputedElevations) {
    // Copied rather than used directly — applyMountainRedistribution
    // below mutates in place, and precomputedElevations may be a caller-
    // retained array (e.g. the worker's own cached "last raw elevations"
    // it plans to erode again from later) that shouldn't be silently
    // reshaped as a side effect of rendering it once.
    elevations = precomputedElevations.slice()
  } else {
    const agedBaseElevations = computeAgedBaseElevations(sim.baseElevations, sim.types, sim.ages)
    const blendedBaselines = computeBlendedBaselines(sim.seeds, agedBaseElevations, width, height, sim.warpSeed)
    elevations = await pool.renderElevations(width, height, blendedBaselines, sim.features, sim.warpSeed)
  }
  // Captured before redistribution reshapes elevations in place — see
  // SimulationRenderResult.rawElevations.
  const rawElevations = elevations.slice()
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
      let highlightStrength = 0
      if (!isBoundary && plateHighlights && plateHighlights.has(plateIndex)) {
        highlightStrength = plateHighlights.get(plateIndex)!
      }
      if (!isBoundary && locationHighlights) {
        for (const lh of locationHighlights) {
          const distSq = toroidalDistanceSq(x, y, lh.x, lh.y, width, height)
          if (distSq >= LOCATION_HIGHLIGHT_RADIUS_SQ) continue
          const falloff = 1 - Math.sqrt(distSq) / LOCATION_HIGHLIGHT_RADIUS
          highlightStrength = Math.max(highlightStrength, falloff * lh.alpha)
        }
      }
      // Not gated on !isBoundary like the other two — the whole point is
      // a red line right at the boundary itself, fading into ordinary
      // territory on both sides of it, not a halo that stops short of
      // the boundary pixels and leaves them dark.
      if (boundaryHighlightField && boundaryHighlightField[idx] > 0) {
        highlightStrength = Math.max(highlightStrength, boundaryHighlightField[idx])
      }

      if (highlightStrength > 0) {
        const highlightAlpha = highlightStrength * 0.45
        buffer[pixelIndex] = Math.round(color[0] * (1 - highlightAlpha) + 255 * highlightAlpha)
        buffer[pixelIndex + 1] = Math.round(color[1] * (1 - highlightAlpha) + 45 * highlightAlpha)
        buffer[pixelIndex + 2] = Math.round(color[2] * (1 - highlightAlpha) + 45 * highlightAlpha)
        buffer[pixelIndex + 3] = 255
      } else {
        buffer[pixelIndex] = color[0]
        buffer[pixelIndex + 1] = color[1]
        buffer[pixelIndex + 2] = color[2]
        buffer[pixelIndex + 3] = 255
      }
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

  return { buffer, landFraction: landPixelCount / (width * height), labelPlacements, rawElevations, elevations }
}

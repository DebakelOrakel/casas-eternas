import type { CrustState } from './crust'
import { generateElevationField } from './elevationField'
import type { PlateWorld } from './plates'

// Split out of worldgen.worker.ts so this pure pixel-generation logic can
// be imported by plain Node scripts (e.g. headless verification/analysis
// scripts) without pulling in that file's worker-global-scope code
// (`self`), which throws outside an actual Worker context.

// "Just a hint" of color, matching the white background/theme — these
// are the *targets* land/water tint blends toward, not the final colors:
// see faintColorForElevation, which blends only 8-22% of the way there.
const LAND_TINT_TARGET: [number, number, number] = [0.235, 0.549, 0.275]
const WATER_TINT_TARGET: [number, number, number] = [0.275, 0.51, 0.745]
const COASTLINE_COLOR: [number, number, number] = [0.05, 0.05, 0.05]
const MIN_TINT_AMOUNT = 0.08
const MAX_TINT_AMOUNT = 0.22
const LAND_HEIGHT_TINT_RANGE = 0.3
const WATER_DEPTH_TINT_RANGE = 0.3

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function faintColorForElevation(elevation: number): [number, number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
  const [target, range] = elevation >= 0 ? [LAND_TINT_TARGET, LAND_HEIGHT_TINT_RANGE] : [WATER_TINT_TARGET, WATER_DEPTH_TINT_RANGE]
  const normalized = clamp01(Math.abs(elevation) / range)
  const amount = MIN_TINT_AMOUNT + (MAX_TINT_AMOUNT - MIN_TINT_AMOUNT) * normalized
  return [lerp(1, target[0], amount), lerp(1, target[1], amount), lerp(1, target[2], amount)]
}

// Pronounced, saturated hypsometric-tint ramp used only for the
// post-erosion recolor (see overrideElevations below) — the live
// tectonics-phase preview deliberately keeps the faint colors above.
// Breakpoints calibrated against a real eroded elevation distribution
// (headless histogram check, not guessed): land is ~32% of the surface,
// spans roughly 0 to 0.40, with the 99th/99.9th percentiles landing
// around 0.30/0.35 — so the snow-cap stop is deliberately high, reached
// by only the top sliver of land ("the tallest mountains", not a broad
// band), and the ocean stops likewise span the actual -0.47 to 0 range
// rather than an arbitrary one.
interface ColorStop {
  elevation: number
  color: [number, number, number]
}

const OCEAN_COLOR_STOPS: ColorStop[] = [
  { elevation: -0.45, color: [0.02, 0.1, 0.35] }, // deep ocean
  { elevation: -0.15, color: [0.08, 0.35, 0.75] }, // mid-depth
  { elevation: 0, color: [0.35, 0.75, 0.95] }, // shallow, bright blue
]

const LAND_COLOR_STOPS: ColorStop[] = [
  { elevation: 0, color: [0.35, 0.8, 0.4] }, // coastal heights, bright green
  { elevation: 0.06, color: [0.15, 0.45, 0.15] }, // flatland, darker green
  { elevation: 0.14, color: [0.55, 0.42, 0.25] }, // transition, brown
  { elevation: 0.24, color: [0.55, 0.53, 0.52] }, // mountains, grey
  { elevation: 0.32, color: [0.97, 0.97, 1.0] }, // snow caps on the tallest peaks
]

function sampleColorStops(stops: ColorStop[], elevation: number): [number, number, number] {
  if (elevation <= stops[0].elevation) return stops[0].color
  const lastStop = stops[stops.length - 1]
  if (elevation >= lastStop.elevation) return lastStop.color
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (elevation <= b.elevation) {
      const t = (elevation - a.elevation) / (b.elevation - a.elevation)
      return [lerp(a.color[0], b.color[0], t), lerp(a.color[1], b.color[1], t), lerp(a.color[2], b.color[2], t)]
    }
  }
  return lastStop.color
}

function vividColorForElevation(elevation: number): [number, number, number] {
  return elevation >= 0 ? sampleColorStops(LAND_COLOR_STOPS, elevation) : sampleColorStops(OCEAN_COLOR_STOPS, elevation)
}

function crossesSeaLevel(elevations: Float32Array, isContinental: Uint8Array, a: number, b: number): boolean {
  const differs = elevations[a] >= 0 !== elevations[b] >= 0
  return differs && (isContinental[a] === 1 || isContinental[b] === 1)
}

// Equirectangular texture sampled by direct per-pixel query against the
// elevation field (via generateElevationField — u/v convention matches
// Babylon's own CreateSphere UVs, so it lines up with the render mesh's
// default UV mapping with no extra setup). Coastline detection is a
// level-set crossing between adjacent pixels: a pixel's neighbors are
// just its grid neighbors (wrap horizontally at the longitude seam,
// clamp vertically at the poles), no mesh adjacency needed.
//
// overrideElevations (same width*height length) lets a caller color from
// a *different* elevation source than the live continuous field — namely
// worldgen.worker.ts, once erosion has run: coloring from the original
// pre-erosion field would show a coastline/relief pattern that no longer
// matches the actual (now displaced) geometry. isContinental still comes
// from the internal generateElevationField call either way — plate
// assignment doesn't change from erosion, only elevation does. Presence
// of overrideElevations also switches the color ramp itself, from the
// live tectonics-phase preview's deliberately faint tint to the
// post-erosion vivid one (see vividColorForElevation) — the two phases
// want visually distinct treatments, not just different input data.
export function generateWorldTexture(
  world: PlateWorld,
  crust: CrustState,
  width: number,
  height: number,
  overrideElevations?: Float32Array,
): Uint8Array {
  const sampled = generateElevationField(world, crust, width, height)
  const elevations = overrideElevations ?? sampled.elevations
  const isContinental = sampled.isContinental
  const colorForElevation = overrideElevations ? vividColorForElevation : faintColorForElevation
  const texelCount = width * height
  const pixels = new Uint8Array(texelCount * 4)

  for (let y = 0; y < height; y++) {
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      const index = rowBase + x
      const left = rowBase + (x === 0 ? width - 1 : x - 1)
      const right = rowBase + (x === width - 1 ? 0 : x + 1)

      let isCoastline = crossesSeaLevel(elevations, isContinental, index, left) || crossesSeaLevel(elevations, isContinental, index, right)
      if (!isCoastline && y > 0) isCoastline = crossesSeaLevel(elevations, isContinental, index, index - width)
      if (!isCoastline && y < height - 1) isCoastline = crossesSeaLevel(elevations, isContinental, index, index + width)

      const [r, g, b] = isCoastline ? COASTLINE_COLOR : colorForElevation(elevations[index])
      const pixelBase = index * 4
      pixels[pixelBase] = Math.round(r * 255)
      pixels[pixelBase + 1] = Math.round(g * 255)
      pixels[pixelBase + 2] = Math.round(b * 255)
      pixels[pixelBase + 3] = 255
    }
  }

  return pixels
}

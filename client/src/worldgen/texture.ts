import { Vector3 } from '@babylonjs/core'
import { warpPoint } from './coastlineNoise'
import { buildTerrainFeatureIndex, elevationAt, type CrustState } from './crust'
import { nearestPlateIndex, type PlateWorld } from './plates'

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

function crossesSeaLevel(elevations: Float32Array, isContinental: Uint8Array, a: number, b: number): boolean {
  const differs = elevations[a] >= 0 !== elevations[b] >= 0
  return differs && (isContinental[a] === 1 || isContinental[b] === 1)
}

// Equirectangular texture sampled by direct per-pixel query against the
// elevation field — u/v convention matches Babylon's own CreateSphere UVs
// (u = longitude/2pi, v = polar angle from the +Y pole / pi), so it lines
// up with the render mesh's default UV mapping with no extra setup.
// Coastline detection is a level-set crossing between adjacent pixels: a
// pixel's neighbors are just its grid neighbors (wrap horizontally at the
// longitude seam, clamp vertically at the poles), no mesh adjacency
// needed.
export function generateWorldTexture(world: PlateWorld, crust: CrustState, width: number, height: number): Uint8Array {
  const featureIndex = buildTerrainFeatureIndex(crust.terrainFeatures)
  const texelCount = width * height
  const elevations = new Float32Array(texelCount)
  const isContinental = new Uint8Array(texelCount)
  const pixels = new Uint8Array(texelCount * 4)
  const point = Vector3.Zero()
  const warpedPoint = Vector3.Zero()

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    const polar = v * Math.PI
    const sinPolar = Math.sin(polar)
    const cosPolar = Math.cos(polar)
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const longitude = u * Math.PI * 2
      point.set(sinPolar * Math.cos(longitude), cosPolar, -sinPolar * Math.sin(longitude))
      // Domain-warp before every lookup, not just for the coastline check
      // — without this, plate/elevation assignment (and therefore the
      // coastline itself) still comes straight from the raw Voronoi
      // partition, which is exactly the straight-edge look this exists
      // to break up.
      warpPoint(point, crust.coastlineNoise, warpedPoint)

      const plateIndex = nearestPlateIndex(warpedPoint, world)
      const elevation = elevationAt(warpedPoint, world.types[plateIndex], world.ids[plateIndex], crust, featureIndex)
      const index = rowBase + x
      elevations[index] = elevation
      isContinental[index] = world.types[plateIndex] === 'continental' ? 1 : 0
    }
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * width
    for (let x = 0; x < width; x++) {
      const index = rowBase + x
      const left = rowBase + (x === 0 ? width - 1 : x - 1)
      const right = rowBase + (x === width - 1 ? 0 : x + 1)

      let isCoastline = crossesSeaLevel(elevations, isContinental, index, left) || crossesSeaLevel(elevations, isContinental, index, right)
      if (!isCoastline && y > 0) isCoastline = crossesSeaLevel(elevations, isContinental, index, index - width)
      if (!isCoastline && y < height - 1) isCoastline = crossesSeaLevel(elevations, isContinental, index, index + width)

      const [r, g, b] = isCoastline ? COASTLINE_COLOR : faintColorForElevation(elevations[index])
      const pixelBase = index * 4
      pixels[pixelBase] = Math.round(r * 255)
      pixels[pixelBase + 1] = Math.round(g * 255)
      pixels[pixelBase + 2] = Math.round(b * 255)
      pixels[pixelBase + 3] = 255
    }
  }

  return pixels
}

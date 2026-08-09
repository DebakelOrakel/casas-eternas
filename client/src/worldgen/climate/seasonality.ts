import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleDryLandAtCell, sampleElevationAtCell, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { wrapValue } from '../core/field'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Ocean cells carry this sentinel — seasonality is a land field (biomes are
// land; the ocean's near-nil swing would just flood the overlay with one color).
export const OCEAN_AMPLITUDE = -1

function wrapIndex(x: number, y: number): number {
  return wrapValue(y, RY) * RX + wrapValue(x, RX)
}

// Continentality 0..1 = normalized distance to the nearest ocean cell
// (multi-source BFS, 4-connected, toroidally wrapped). 0 at the coast/ocean,
// saturating to 1 deep inland. A fully-land or fully-ocean world degenerates
// gracefully (all 1 / all 0).
function computeContinentality(elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Float32Array {
  const n = RX * RY
  const dist = new Float32Array(n).fill(Infinity)
  const queue: number[] = []
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight) <= SEA_LEVEL && !sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)) {
        dist[i] = 0
        queue.push(i)
      }
    }
  }
  let head = 0
  while (head < queue.length) {
    const i = queue[head++]
    const gx = i % RX
    const gy = (i - gx) / RX
    const d = dist[i]
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const j = wrapIndex(gx + dx, gy + dy)
      if (d + 1 < dist[j]) {
        dist[j] = d + 1
        queue.push(j)
      }
    }
  }
  const continentality = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    continentality[i] = dist[i] === Infinity ? 1 : Math.min(1, dist[i] / CLIMATE_TUNING.seasonContinentalityScale)
  }
  return continentality
}

// Annual temperature amplitude (°C, the summer−winter range) on the climate
// grid — the requested seasonality. Grows with latitude (little at the equator,
// large toward the poles) and with continentality (interiors swing far more
// than maritime coasts); ocean cells stay low (thermal inertia). Biome
// classification later reads T_mean ± amplitude/2 for cold-winter / growing-
// season distinctions. See docs/decisions/climate-biomes.md.
export function computeSeasonalAmplitude(elevation: Float32Array, worldWidth: number, worldHeight: number, equatorOffset = 0, dryLand?: Uint8Array): Float32Array {
  const continentality = computeContinentality(elevation, worldWidth, worldHeight, dryLand)
  const amplitude = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = shiftedYNorm(gy, RY, equatorOffset)
    const phi = Math.abs(yNorm - 0.5) * 2
    const ampLat = CLIMATE_TUNING.seasonMaxAmplitude * phi
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const ocean = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight) <= SEA_LEVEL && !sampleDryLandAtCell(dryLand, gx, gy, worldWidth, worldHeight)
      amplitude[i] = ocean ? OCEAN_AMPLITUDE : ampLat * (CLIMATE_TUNING.seasonCoastDamp + (1 - CLIMATE_TUNING.seasonCoastDamp) * continentality[i])
    }
  }
  return amplitude
}

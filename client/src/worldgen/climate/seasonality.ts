import { CLIMATE_RES_X, CLIMATE_RES_Y, sampleElevationAtCell } from './climateField'
import { SEA_LEVEL } from '../erosion'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Peak annual temperature range (°C, summer − winter) — reached by a
// continental interior at high latitude. The equator sits near 0 (sun always
// high), a coast/ocean stays low (thermal inertia). Tune by eye.
const MAX_AMPLITUDE = 42
// Cells this many grid cells from the nearest ocean count as fully
// continental; nearer ones interpolate. A big continent's core sits deep
// enough to saturate.
const CONTINENTALITY_SCALE = 45
// Coastal land floor (continentality 0): even a coast swings a bit.
const COAST_DAMP = 0.3
// Ocean cells carry this sentinel — seasonality is a land field (biomes are
// land; the ocean's near-nil swing would just flood the overlay with one color).
export const OCEAN_AMPLITUDE = -1

function wrapIndex(x: number, y: number): number {
  return (((y % RY) + RY) % RY) * RX + (((x % RX) + RX) % RX)
}

// Continentality 0..1 = normalized distance to the nearest ocean cell
// (multi-source BFS, 4-connected, toroidally wrapped). 0 at the coast/ocean,
// saturating to 1 deep inland. A fully-land or fully-ocean world degenerates
// gracefully (all 1 / all 0).
function computeContinentality(elevation: Float32Array, worldWidth: number, worldHeight: number): Float32Array {
  const n = RX * RY
  const dist = new Float32Array(n).fill(Infinity)
  const queue: number[] = []
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight) <= SEA_LEVEL) {
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
    continentality[i] = dist[i] === Infinity ? 1 : Math.min(1, dist[i] / CONTINENTALITY_SCALE)
  }
  return continentality
}

// Annual temperature amplitude (°C, the summer−winter range) on the climate
// grid — the requested seasonality. Grows with latitude (little at the equator,
// large toward the poles) and with continentality (interiors swing far more
// than maritime coasts); ocean cells stay low (thermal inertia). Biome
// classification later reads T_mean ± amplitude/2 for cold-winter / growing-
// season distinctions. See docs/decisions/climate-biomes.md.
export function computeSeasonalAmplitude(elevation: Float32Array, worldWidth: number, worldHeight: number): Float32Array {
  const continentality = computeContinentality(elevation, worldWidth, worldHeight)
  const amplitude = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = (gy + 0.5) / RY
    const phi = Math.abs(yNorm - 0.5) * 2
    const ampLat = MAX_AMPLITUDE * phi
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const ocean = sampleElevationAtCell(elevation, gx, gy, worldWidth, worldHeight) <= SEA_LEVEL
      amplitude[i] = ocean ? OCEAN_AMPLITUDE : ampLat * (COAST_DAMP + (1 - COAST_DAMP) * continentality[i])
    }
  }
  return amplitude
}

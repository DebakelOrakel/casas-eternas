import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import type { Domain, DomainGrid } from '../core/domain'
import { DEFAULT_PLANET_FORCING, seasonalityFactor, type PlanetForcing } from '../planet/planetForcing'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Ocean cells carry this sentinel — seasonality is a land field (biomes are
// land; the ocean's near-nil swing would just flood the overlay with one color).
export const OCEAN_AMPLITUDE = -1

// Continentality 0..1 = normalized distance to the nearest ocean cell
// (multi-source BFS, 4-connected, wrapped by the grid). 0 at the coast/ocean,
// saturating to 1 deep inland. A fully-land or fully-ocean world degenerates
// gracefully (all 1 / all 0). `grid`: the climate grid.
//
// The distance is a length (step 4d5): a step east or west costs the row's
// cell width (DomainGrid.rowScale — cos φ on the sphere, where a polar
// row's cells are a few km wide), a step north or south one cell. The queue
// then corrects a cell's distance when a shorter path reaches it later
// (label-correcting); on the torus every step costs 1, no cell is ever
// corrected, and the search is the BFS it was.
function computeContinentality(elevation: Float32Array, worldWidth: number, worldHeight: number, grid: DomainGrid, dryLand?: Uint8Array): Float32Array {
  const n = RX * RY
  const dist = new Float32Array(n).fill(Infinity)
  const queue: number[] = []
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight)) {
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
    const across = grid.rowScale(gy)
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const j = grid.index(gx + dx, gy + dy)
      const step = dy === 0 ? across : 1
      if (d + step < dist[j]) {
        dist[j] = d + step
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
// `planet` (planet/planetForcing.ts): the tilt sets the swing, the orbit
// biases one hemisphere's. `domain`: what the elevation raster covers, one
// cell per unit.
export function computeSeasonalAmplitude(elevation: Float32Array, domain: Domain, equatorOffset = 0, dryLand?: Uint8Array, planet: PlanetForcing = DEFAULT_PLANET_FORCING): Float32Array {
  const { width: worldWidth, height: worldHeight } = domain
  const continentality = computeContinentality(elevation, worldWidth, worldHeight, domain.grid(RX, RY), dryLand)
  const amplitude = new Float32Array(RX * RY)
  for (let gy = 0; gy < RY; gy++) {
    const yNorm = shiftedYNorm(gy, RY, equatorOffset)
    const phi = Math.abs(yNorm - 0.5) * 2
    const ampLat = CLIMATE_TUNING.seasonMaxAmplitude * phi * seasonalityFactor(planet, yNorm < 0.5)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      const ocean = !isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight)
      amplitude[i] = ocean ? OCEAN_AMPLITUDE : ampLat * (CLIMATE_TUNING.seasonCoastDamp + (1 - CLIMATE_TUNING.seasonCoastDamp) * continentality[i])
    }
  }
  return amplitude
}

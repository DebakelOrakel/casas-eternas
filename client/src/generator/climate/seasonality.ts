import { latitudeOfNorm, shiftedNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { distanceToSea, type ClimateMesh, type ClimateTerrain } from './climateMesh'
import { DEFAULT_PLANET_FORCING, seasonalityFactor, type PlanetForcing } from '../planet/planetForcing'

// Ocean cells carry this sentinel — seasonality is a land field (biomes are
// land; the ocean's near-nil swing would just flood the overlay with one color).
export const OCEAN_AMPLITUDE = -1

// Continentality 0..1 = the distance to the nearest sea cell over the
// climate's field mesh (DEC-0036 phase 3; climateMesh.distanceToSea, metres
// along the cells' links) over `seasonContinentalityScaleM`: 0 at the
// coast and on the sea, saturating to 1 deep inland. A fully-land or
// fully-ocean world degenerates gracefully (all 1 / all 0). The former
// raster counted 4-connected cell steps; a path over the hexagons is
// within 15 % of the straight line, the raster's within 41 %.
function computeContinentality(cm: ClimateMesh, land: Uint8Array): Float64Array {
  const n = cm.mesh.count
  const { dist } = distanceToSea(cm.mesh, land)
  const continentality = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    continentality[i] = dist[i] === Infinity ? 1 : Math.min(1, dist[i] / CLIMATE_TUNING.seasonContinentalityScaleM)
  }
  return continentality
}

// Annual temperature amplitude (°C, the summer−winter range) per cell of
// the climate's field mesh — the requested seasonality. Grows with
// latitude (little at the equator, large toward the poles) and with
// continentality (interiors swing far more than maritime coasts); ocean
// cells carry OCEAN_AMPLITUDE (thermal inertia). Biome classification later
// reads T_mean ± amplitude/2 for cold-winter / growing-season distinctions.
// See docs/decisions/climate-biomes.md.
// `planet` (planet/planetForcing.ts): the tilt sets the swing, the orbit
// biases one hemisphere's.
export function computeSeasonalAmplitude(terrain: ClimateTerrain, equatorOffset = 0, planet: PlanetForcing = DEFAULT_PLANET_FORCING): Float64Array {
  const { cm, land } = terrain
  const continentality = computeContinentality(cm, land)
  const n = cm.mesh.count
  const amplitude = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      amplitude[i] = OCEAN_AMPLITUDE
      continue
    }
    const yNorm = shiftedNorm(cm.yNorm[i], equatorOffset)
    const phi = latitudeOfNorm(yNorm)
    const ampLat = CLIMATE_TUNING.seasonMaxAmplitude * phi * seasonalityFactor(planet, yNorm < 0.5)
    amplitude[i] = ampLat * (CLIMATE_TUNING.seasonCoastDamp + (1 - CLIMATE_TUNING.seasonCoastDamp) * continentality[i])
  }
  return amplitude
}

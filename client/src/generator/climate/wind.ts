import { CLIMATE_RES_X, CLIMATE_RES_Y, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'

// Prevailing surface wind as the prescribed three-cell pattern per hemisphere
// (Hadley / Ferrel / Polar): trade EASTERLIES 0–30°, mid-latitude WESTERLIES
// 30–60°, polar EASTERLIES 60–90°, each with the meridional flow its cell
// implies (Hadley + Polar equatorward at the surface, Ferrel poleward).
// Magnitude tapers to ~0 at every cell edge (the calm doldrums / horse-latitude
// / subpolar belts), so the bands blend instead of reversing sharply. Purely
// latitudinal for now (no land/sea modulation). Returned interleaved
// [u0,v0,u1,v1,…] on the climate grid: u = eastward (+x), v = toward the
// bottom/"south" (+y). See docs/decisions/climate-biomes.md.
export function computeWind(equatorOffset = 0): Float32Array {
  const wind = new Float32Array(CLIMATE_RES_X * CLIMATE_RES_Y * 2)
  for (let gy = 0; gy < CLIMATE_RES_Y; gy++) {
    const yNorm = shiftedYNorm(gy, CLIMATE_RES_Y, equatorOffset)
    const sLat = (yNorm - 0.5) * 2 // signed latitude: −1 north(top) … +1 south(bottom)
    const phi = Math.abs(sLat)
    const hemi = Math.sign(sLat) // −1 north, +1 south, 0 at the equator

    let uSign: number
    let poleward: boolean
    let local: number
    if (phi < 1 / 3) {
      uSign = -1 // Hadley: trade easterlies, equatorward
      poleward = false
      local = phi / (1 / 3)
    } else if (phi < 2 / 3) {
      uSign = +1 // Ferrel: westerlies, poleward
      poleward = true
      local = (phi - 1 / 3) / (1 / 3)
    } else {
      uSign = -1 // Polar: easterlies, equatorward
      poleward = false
      local = (phi - 2 / 3) / (1 / 3)
    }
    const taper = Math.sin(Math.PI * local) // 0 at the cell edges, 1 at its center
    const u = uSign * CLIMATE_TUNING.windZonalStrength * taper
    // equatorward → v = −hemi·|v|; poleward → v = +hemi·|v|
    const v = (poleward ? hemi : -hemi) * CLIMATE_TUNING.windMeridionalStrength * taper
    for (let gx = 0; gx < CLIMATE_RES_X; gx++) {
      const idx = (gy * CLIMATE_RES_X + gx) * 2
      wind[idx] = u
      wind[idx + 1] = v
    }
  }
  return wind
}

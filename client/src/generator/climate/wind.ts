import { beltYNorm, shiftedNorm } from './climateField'
import { hadleyEdge } from '../planet/planetForcing'
import { PLANET_INPUTS } from '../planet/planetInputParams'
import { CLIMATE_TUNING } from './climateTuneParams'
import { detSin } from '../core/detMath'
import type { ClimateMesh } from './climateMesh'

// A vector field on the climate's field mesh: east and south per cell, in
// the cell's own frame (DEC-0036 phase 3; climateMesh.ts).
export interface CellVectors {
  e: Float64Array
  s: Float64Array
}

// Prevailing surface wind as the prescribed three-cell pattern per hemisphere
// (Hadley / Ferrel / Polar): trade EASTERLIES 0–30°, mid-latitude WESTERLIES
// 30–60°, polar EASTERLIES 60–90°, each with the meridional flow its cell
// implies (Hadley + Polar equatorward at the surface, Ferrel poleward).
// Magnitude tapers to ~0 at every cell edge (the calm doldrums / horse-latitude
// / subpolar belts), so the bands blend instead of reversing sharply. Purely
// latitudinal for now (no land/sea modulation). Per cell of the climate's
// field mesh: u = eastward (+x), v = toward the bottom/"south" (+y), the
// cell's frame. See docs/decisions/climate-biomes.md.
// `rotationHours` (planet/planetForcing.ts): the Hadley cell's edge moves
// with the rotation period; the Ferrel cell takes half of what is left.
// `beltShift`: the season's shift of the cells (climateField.beltYNorm); 0,
// the year's mean position, for the history and the cheap climate.
// On the sphere the shift ends at the pole (beltYNorm).
export function computeWind(cm: ClimateMesh, equatorOffset = 0, rotationHours = PLANET_INPUTS.rotation.default, beltShift = 0): CellVectors {
  const n = cm.mesh.count
  const wind: CellVectors = { e: new Float64Array(n), s: new Float64Array(n) }
  const shape = cm.mesh.domain.kind
  const e1 = hadleyEdge(rotationHours)
  const e2 = (1 + e1) / 2
  for (let i = 0; i < n; i++) {
    const yNorm = beltYNorm(shiftedNorm(cm.yNorm[i], equatorOffset), beltShift, shape)
    const sLat = (yNorm - 0.5) * 2 // signed latitude: −1 north(top) … +1 south(bottom)
    const phi = Math.abs(sLat)
    const hemi = Math.sign(sLat) // −1 north, +1 south, 0 at the equator

    let uSign: number
    let poleward: boolean
    let local: number
    if (phi < e1) {
      uSign = -1 // Hadley: trade easterlies, equatorward
      poleward = false
      local = phi / e1
    } else if (phi < e2) {
      uSign = +1 // Ferrel: westerlies, poleward
      poleward = true
      local = (phi - e1) / (e2 - e1)
    } else {
      uSign = -1 // Polar: easterlies, equatorward
      poleward = false
      local = (phi - e2) / (1 - e2)
    }
    const taper = detSin(Math.PI * local) // 0 at the cell edges, 1 at its center
    const u = uSign * CLIMATE_TUNING.windZonalStrength * taper
    // equatorward → v = −hemi·|v|; poleward → v = +hemi·|v|
    const v = (poleward ? hemi : -hemi) * CLIMATE_TUNING.windMeridionalStrength * taper
    wind.e[i] = u
    wind.s[i] = v
  }
  return wind
}

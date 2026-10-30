import type { Domain } from '../core/domain'
import { climateMesh } from './climateMesh'

// THE CLIMATE STEP'S REFINEMENT (docs/design/climate-refinement.md): the
// climate the history left, computed again with more physics on the final
// geography. The engine computes it (climate/refinement.rs), per cell of
// the climate's field mesh (DEC-0036 phase 5). This file holds what the
// client reads of it: its shape, the order the save writes the storms in,
// and the restore's check. The screen's textures are its chart (the
// engine's refined_chart, climate/climate_chart.rs).

// The storms' fields, in the order the save writes them.
export const REFINED_STORMS = ['cyclone', 'tornado', 'blizzard', 'dust', 'thunder'] as const
export type RefinedStorms = Record<(typeof REFINED_STORMS)[number], Float32Array>

export interface RefinedReliability {
  rainVariability: Float32Array
  ensoPattern: Float32Array
  ensoPeriodYears: number
  ensoStrength: number
}

// The refinement per cell of the climate's field mesh. Float32: the values
// the session keeps ARE the values the save writes (world/save/
// refinedFields.ts), so a loaded refinement is the session's to the bit and
// is adopted without computing it again. Vectors are east/south in each
// cell's own frame (the Domain's). The sea's fields are 0 on the mesh's
// land cells (ClimateTerrain.land), the land's fields 0 on its sea.
export interface RefinedClimate {
  months: number
  // The field mesh the values belong to: its cell count and its spacing,
  // metres (climateMesh: the domain's width / 256) — what a restore checks.
  cells: number
  spacingM: number
  // Air temperature, °C, months × cells (month-major), the year's mean plus
  // the energy balance's cycle (energy_balance.rs), the overturning's warmth
  // and the phenomena.
  temperature: Float32Array
  // Precipitation, mm/yr at the month's rate, months × cells; OCEAN_PRECIP
  // on the sea. The year's total is their mean.
  precipitation: Float32Array
  // Sea-level pressure, hPa, months × cells.
  pressure: Float32Array
  // Surface wind, wind.rs's units (1 = 8 m/s), months × cells, east and
  // south.
  windE: Float32Array
  windS: Float32Array
  // The ocean currents under the year's mean wind (with the overturning's
  // inflow), normalised like ocean_currents.rs's, east and south.
  currentE: Float32Array
  currentS: Float32Array
  // The sea-surface anomaly those currents and the upwelling make, °C per
  // sea cell (positive warm, negative cold).
  currentAnomaly: Float32Array
  // Ekman upwelling per sea cell (ocean_currents.rs), the rising part
  // weighted like the cooling: near the equator by the cell's place in its
  // basin (only the east brings cold water up).
  upwelling: Float32Array
  // Sea surface salinity (psu) and where the surface water sinks (0..1),
  // salinity.rs.
  salinity: Float32Array
  deepWater: Float32Array
  // Weather phenomena, each a share of the year per land cell
  // (phenomena.rs).
  fog: Float32Array
  foehn: Float32Array
  // The rain's reliability and the ENSO see-saw (reliability.rs).
  reliability: RefinedReliability
  // Cyclones, tornadoes, blizzards, dust, thunder (storms.rs).
  storms: RefinedStorms
}

// Whether a refinement's values belong to the climate's field mesh of
// this domain (a restore's check, as mantleFits and oceanAgeFits).
export function refinementFits(domain: Domain, cells: number, spacingM: number): boolean {
  const cm = climateMesh(domain)
  return cells === cm.mesh.count && spacingM === cm.cellM
}

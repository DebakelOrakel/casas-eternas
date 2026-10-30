import type { Domain } from '../core/domain'
import { SEA_LEVEL } from '../elevation/elevationScale'
import { CLIMATE_TUNING } from '../pipeline/engineConstants'
import { climateMesh, type ClimateMesh } from './climateMesh'

// THE CLIMATE AT A POINT (DEC-0036 phase 7, docs/decisions/fields-on-
// meshes.md): what every stage outside the climate reads of it — the
// biomes, the ecology, the hydrology, the hydrogeology, the ice, the coast,
// the column's ledger, the bakes — as values at its own points (the
// terrain mesh's nodes, a bake level's nodes, the climate mesh's own
// cells), sampled once from the climate's field mesh. No stage reads a
// climate raster.
//
// The climate as its readers need it, per cell of the climate's field mesh
// (`ClimateCells`, Float32 — the values the save holds, world/save/
// climateFields.ts, so a bake samples what the generator sampled): the
// air temperature REDUCED TO SEA LEVEL (the lapse of the ground under the
// cell's centre taken off, by the rule the engine's temperature.rs applies: a dry
// floor unclamped, everything else clamped at the sea), so a point takes
// its own lapse back and a summit's cold does not bleed into the valley
// beside it; the rain, the seasonal range and the signed monsoon index
// with their sea marks (OCEAN_PRECIP, OCEAN_AMPLITUDE, OCEAN_PRECIP) — the
// marks ARE the cells' land mask; the refinement's months, its upwelling
// and its rain's reliability when the climate is refined; the year's wind.
//
// At a point (the engine's `climate_at_points`): the corners of the climate mesh's
// triangle under it, linearly. A land field reads the LAND corners only,
// their weights renormalised — never a blend with a sea mark — and a land
// point with no land corner (an island smaller than a cell) its latitude's
// land mean (climateMesh.zonalMean at the nearest cell), the island rule
// of the former climate grid. The monsoon index is blended as a magnitude
// (neighbours across the rain belt carry opposite signs, and their mean
// would read an even year where the wet-dry savanna lives); its sign, the
// rain's phase, is the heaviest land corner's. The sea fields (the
// upwelling, the sea's temperature) read the sea corners the same way.

export interface ClimateMonthCells {
  count: number
  // °C reduced to sea level and mm/yr at the month's rate (OCEAN_PRECIP on
  // the sea), months × cells, month-major.
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
}

export interface ClimateCells {
  cm: ClimateMesh
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  months: ClimateMonthCells | null
  // The refinement's Ekman upwelling (0 on land) and its rain's year-to-year
  // coefficient of variation (0 on the sea); null for a climate that was
  // not refined.
  upwelling: Float32Array | null
  rainVariability: Float32Array | null
  // The year's wind, east and south in each cell's own frame (the engine's
  // wind.rs's units).
  windE: Float32Array
  windS: Float32Array
}

// The lapse a height carries, °C (the engine's temperature.rs's rule).
export function lapseAt(height: number, dry: boolean): number {
  return CLIMATE_TUNING.lapseCPerElevation * (dry ? height - SEA_LEVEL : Math.max(0, height - SEA_LEVEL))
}

// The annual cells as values with the mesh they belong to — the save's
// form (world/save/climateFields.ts) and the bakes' input.
export interface ClimateCellValues {
  cells: number
  spacingM: number
  seaLevelTemperature: Float32Array
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
}

// The cells back from their values: the annual fields only, on the climate
// mesh of `domain` — refused when the values belong to another.
export function climateCellsFromSaved(domain: Domain, saved: ClimateCellValues): ClimateCells {
  const cm = climateMesh(domain)
  if (saved.cells !== cm.mesh.count || saved.spacingM !== cm.cellM) throw new Error(`the climate's values belong to a mesh of ${saved.cells} cells at ${saved.spacingM} m, this world's has ${cm.mesh.count} at ${cm.cellM} m`)
  const zero = new Float32Array(cm.mesh.count)
  return {
    cm, seaLevelTemperature: saved.seaLevelTemperature, precipitation: saved.precipitation, seasonalAmplitude: saved.seasonalAmplitude, monsoonIndex: saved.monsoonIndex,
    months: null, upwelling: null, rainVariability: null, windE: zero, windS: zero,
  }
}

export interface PointClimate {
  count: number
  // °C: reduced to sea level (land points; the sea's own on the sea), and at
  // the point's height (land: the sea-level value less its own lapse; sea:
  // the sea corners' temperature, the sea surface's).
  seaLevelTemperature: Float32Array
  temperature: Float32Array
  // The land fields, with their sea marks on sea points.
  precipitation: Float32Array
  seasonalAmplitude: Float32Array
  monsoonIndex: Float32Array
  // The months at the point's height (°C, mm/yr at the month's rate,
  // OCEAN_PRECIP on sea points; the sea's temperature on sea points),
  // months × points, month-major; null for a climate without months.
  months: { count: number; temperature: Float32Array; precipitation: Float32Array } | null
  upwelling: Float32Array | null
  rainVariability: Float32Array | null
  // The year's wind in the point's own frame; null unless asked for.
  windE: Float32Array | null
  windS: Float32Array | null
}

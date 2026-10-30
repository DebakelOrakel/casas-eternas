import { SEA_LEVEL } from '../elevation/elevationScale'
import { SURFACE_TUNING } from '../pipeline/engineConstants'

// The hydrology's discharge unit is mm/yr summed over contributing cells;
// × cell area × 1e-3 m/mm ÷ seconds-per-year gives m³/s, and a nominal
// runoff coefficient (real basins deliver roughly a third of their rainfall
// to the channel — the rest evaporates or seeps) keeps the number in the
// range real rivers of this catchment size actually carry. Display-grade
// realism, not a water-budget model; per cell size, so a bake's finer cells
// convert their own units. (Moved here from the screen for the river
// course's hydraulic geometry, 2026-09-22.)
export const RUNOFF_COEFFICIENT = 0.35
const SECONDS_PER_YEAR = 3.156e7
export function dischargeToM3s(dischargeUnits: number, cellM: number): number {
  return dischargeUnits * ((cellM * cellM * 1e-3) / SECONDS_PER_YEAR) * RUNOFF_COEFFICIENT
}

// Potential evaporation from an open water surface (mm/yr), rising with
// temperature — warm basins lose far more water, which is what makes hot dry
// basins into shrunken salt lakes (or none) while cold/wet ones brim over. Same
// mm/yr units as the discharge sum, so inflow and evaporation compare directly.
// Tune by eye.
export function evaporationPotential(tempC: number): number {
  const pet = SURFACE_TUNING.petBaseMm + SURFACE_TUNING.petPerDegC * tempC
  return pet < SURFACE_TUNING.petMinMm ? SURFACE_TUNING.petMinMm : pet > SURFACE_TUNING.petMaxMm ? SURFACE_TUNING.petMaxMm : pet
}

// One standing water body — or a basin that failed to hold one — as the
// hydrology decided it (ADAPTIVE_MESH_PLAN.md phase 1, decision 9 of
// adaptive-mesh.md): the LIST is the truth the save carries; the depth raster
// and the shore are derived from it against whatever terrain is at hand.
// Coordinates are texels of the raster the list was computed on (x + 0.5,
// y + 0.5 is the cell centre), so a consumer at another resolution scales
// them like river points.
export interface WaterBody {
  // Index in the list — what a raster of basin ids would carry.
  id: number
  // 'lake': an ordinary land basin brimming at its spill (river in, lake,
  // river out). 'terminal': an enclosed basin with a sub-sea floor, standing
  // at its climate balance level (the Caspian/Chad class). 'dry': a terminal
  // basin whose balance lies at or below its floor — no water, a salt pan.
  kind: 'lake' | 'terminal' | 'dry'
  // The water surface, elevation units. For 'dry' the balance level anyway,
  // at or below the floor, so nothing is wet.
  level: number
  // The pour point's ELEVATION — the lowest cell on the basin's rim, where
  // it overflows — and the deepest cell's. The extent is everything below
  // the pour point around the seed (the engine's `basin_cells_below`). Not the flood's fill
  // level: that sits an epsilon chain above the pour cell, and a recovery
  // against it would run through the pour cell into the valley beyond.
  spill: number
  floor: number
  // The deepest cell — the seed a consumer floods from to recover the
  // basin's extent — and the pour cell itself.
  seedX: number
  seedY: number
  outletX: number
  outletY: number
  // Flooded cells in the basin (its full extent up to the spill).
  cells: number
  // Frozen through: a glacier surface, see the engine's `LakeFields.frozen`.
  frozen: boolean
  // Under an ice sheet: a basin, not a lake; the lake once the ice goes
  // (the engine's `mark_subglacial`, DES-0027 entry 15). Absent in a save
  // made before 2026-10-30.
  subglacial?: boolean
}

// The sea's level: what every cell outside a basin is drawn against.
export const SEA_WATER_LEVEL = SEA_LEVEL

// What surface stands at a cell: the sea, a lake, a frozen lake. The codes
// of the water fields on the raster (mesh/meshHydrology.waterFieldsFromMesh,
// the engine's `water_level_field`) and of the map's water plugin. Derived,
// never stored: the save carries the list.
export const SURFACE_SEA = 0
export const SURFACE_LAKE = 1
export const SURFACE_ICE = 2

// Width relative to the world's biggest river (√ of flow — Hack's-law-ish), so a
// river's drawn width depends only on its own discharge, NOT on the current
// threshold. Moving the density knob therefore adds/removes channels without
// resizing the ones already shown.
// Exported because the map's ribbon overlay converts stored widths back onto
// this scale (reading worldgen vocabulary, per the map→worldgen boundary).
export const RIVER_MIN_WIDTH = 0.4
export const RIVER_MAX_WIDTH = 4

// River polylines for the scene-space ribbons (the engine's
// `river_polylines_from_graph` derives them from the feature graph): the points
// as [x, y, widthPx, …] in texel coordinates, and a per-polyline
// point-count table.
export interface RiverPolylines {
  points: Float32Array // [x, y, widthPx, …] in texel coords, all polylines concatenated
  lengths: Uint32Array // number of points in each polyline, in order
  // The flow regime of each polyline (RIVER_REGIME_CODE), in order — a
  // polyline never spans two regimes: its reach's.
  regimes: Uint8Array
}

// The regime as the ribbons carry it, one byte per polyline.
export const RIVER_REGIME_CODE = { perennial: 0, intermittent: 1, ephemeral: 2 } as const

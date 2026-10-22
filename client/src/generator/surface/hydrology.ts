import { SEA_LEVEL } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import type { DomainGrid } from '../core/domain'

// Rivers & lakes on the post-erosion topography, over the terrain mesh's
// flow substrate (flowSubstrate.ts; DEC-0036 phase 7b took the last of the
// raster's away): the erosion's drainage network (the single-flow receiver
// for the channel tree, the priority flood's `filled` for basins) and the
// climate's precipitation at the nodes as the water source. See
// docs/decisions/climate-biomes.md's pipeline note.
//
// Discharge is accumulated along the SINGLE steepest-descent flowTarget, not
// the multiple-flow edges erosion uses for drainage AREA. MFD is right for
// erosion (smooth area, no striping) but for DRAWN rivers it smears flow across
// the whole valley floor, so a "river" reads as a filled band rather than a line;
// single-flow concentrates the water onto one traceable channel.

// The one density the MODEL runs at: riparian biomes, the bake's extracted
// rivers and the coast status mask all read the channel set at this density.
// The panel's density slider is a DRAW filter over it — display-side, outside
// the spec and the artifact key — so moving it can neither change saved
// biomes nor invalidate a bake (erosion v2, P4). Same 0–100 scale as the
// slider; densityToCriticalArea maps it.
export const CANONICAL_RIVER_DENSITY = 55

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
  // the pour point around the seed (basinCellsBelow). Not the flood's fill
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
  // Frozen through: a glacier surface, see LakeFields.frozen.
  frozen: boolean
}

// The sea's level: what every cell outside a basin is drawn against.
export const SEA_WATER_LEVEL = SEA_LEVEL

// The cells of one basin on a terrain: the 4-connected region below its
// spill around its seed. The pour point itself sits AT the spill and is not
// below it, so the region stops there and does not leak into the valley
// beyond — the same set the flood marked (filled > elevation), recovered
// from the list and the terrain alone, which is what lets a save consumer
// (or the map, at draw time) derive the depth raster and the shore without
// a drainage network. Returns cell indices.
// `grid`: the elevation raster's grid over the domain.
export function basinCellsBelow(elevation: Float32Array, grid: DomainGrid, body: WaterBody): Int32Array {
  const { resX: width, resY: height } = grid
  const seed = Math.floor(body.seedY) * width + Math.floor(body.seedX)
  if (!(elevation[seed] < body.spill)) return Int32Array.of(seed)
  const seen = new Uint8Array(width * height)
  const queue: number[] = [seed]
  seen[seed] = 1
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]
    const cx = c % width
    const cy = (c - cx) / width
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nb = grid.neighbour(cx, cy, dx, dy)
      if (seen[nb] || !(elevation[nb] < body.spill)) continue
      seen[nb] = 1
      queue.push(nb)
    }
  }
  return Int32Array.from(queue)
}

// The level every cell's shore is drawn against, plus what surface stands
// there (SURFACE_SEA / SURFACE_LAKE / SURFACE_ICE): a basin's level over its
// whole extent AND its one-cell rim, the sea's elsewhere. The rim matters because a shore is found where the terrain,
// interpolated between cell centres, crosses the level — so the cell on the
// dry side of every shore must carry the same level as the wet side, or a
// dry basin floor would grow a false sea sliver along its rim and a lake a
// gap along its beach. Only rim cells AT OR ABOVE the level take it: a rim
// cell below it is the valley just past the pour point, which would read as
// a wet patch. A rim cell that is itself ocean keeps the sea; a rim cell
// between two basins keeps the first written (basins come in list order).
// Derived, never stored: the save carries the list.
export const SURFACE_SEA = 0
export const SURFACE_LAKE = 1
export const SURFACE_ICE = 2

export function waterLevelField(bodies: readonly WaterBody[], elevation: Float32Array, grid: DomainGrid): { level: Float32Array; body: Int32Array; surface: Uint8Array } {
  const width = grid.resX
  const n = width * grid.resY
  const level = new Float32Array(n).fill(SEA_WATER_LEVEL)
  const body = new Int32Array(n).fill(-1)
  const surface = new Uint8Array(n).fill(SURFACE_SEA)
  const rim: number[] = []
  for (const b of bodies) {
    const cells = basinCellsBelow(elevation, grid, b)
    const kind = b.frozen ? SURFACE_ICE : SURFACE_LAKE
    for (const c of cells) {
      level[c] = b.level
      body[c] = b.id
      surface[c] = kind
    }
    rim.length = 0
    for (const c of cells) {
      const cx = c % width
      const cy = (c - cx) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nb = grid.neighbour(cx, cy, dx, dy)
          if (body[nb] === -1 && elevation[nb] > SEA_LEVEL && elevation[nb] >= b.level) rim.push(nb)
        }
      }
    }
    for (const c of rim) {
      if (body[c] !== -1) continue
      level[c] = b.level
      body[c] = b.id
      surface[c] = kind
    }
  }
  return { level, body, surface }
}

// The depth raster from the list: level minus terrain over each basin's
// extent, zero elsewhere — what the save's `lakeDepth` layer IS, so a reader
// can check the layer against the list, or rebuild it on a finer terrain.
export function lakeDepthFromBodies(bodies: readonly WaterBody[], elevation: Float32Array, grid: DomainGrid): Float32Array {
  const depth = new Float32Array(grid.resX * grid.resY)
  for (const b of bodies) {
    if (b.kind === 'dry') continue
    for (const c of basinCellsBelow(elevation, grid, b)) {
      if (elevation[c] <= b.level) depth[c] = b.level - elevation[c]
    }
  }
  return depth
}

// Width relative to the world's biggest river (√ of flow — Hack's-law-ish), so a
// river's drawn width depends only on its own discharge, NOT on the current
// threshold. Moving the density knob therefore adds/removes channels without
// resizing the ones already shown.
// Exported because the map's ribbon overlay converts stored widths back onto
// this scale (reading worldgen vocabulary, per the map→worldgen boundary).
export const RIVER_MIN_WIDTH = 0.4
export const RIVER_MAX_WIDTH = 4

// --- the channel criterion -------------------------------------------------
//
// A cell is a channel when its discharge clears a threshold — but discharge
// alone gets mountains wrong, and measurably so. Channel density fell SEVENFOLD
// from coast to summit on a measured world (20.4 to 2.9 per 1000 land cells)
// even though the mountains are the wettest ground on it (936 mm/yr against
// 507 at the coast). The cause is drainage AREA: near a divide almost nothing
// drains to you, and a pure area criterion therefore cannot see a mountain
// stream at all.
//
// Real drainage density does the opposite — it RISES with relief, because steep
// ground concentrates flow into channels at far smaller catchments. That is the
// classic slope-area criterion (A*S^theta), and this is it, expressed as a boost
// on discharge so the density slider keeps its meaning.
//
// theta = 0.5 rather than the textbook 1.0, and the reason is the noise floor:
// at 1.0 a cell ten times steeper than the reference would channelise on ~65
// cells of support, under the 150-cell floor AREA_MIN exists to keep. Grid
// artefacts are worst exactly where the boost is largest — a ridge is lined
// with equally steep cells all picking the same D8 direction. At 0.5 that same
// cell still needs ~207 cells, and the measured effect is what was wanted:
// mountain density tripled while the TOTAL rose only 11 %, because the new
// channels come out of the gentle 250-500 m plateau rather than out of nowhere.
export const CHANNEL_SLOPE_EXPONENT = 0.5

// River polylines for the scene-space ribbons (riverGraph.
// riverPolylinesFromGraph derives them from the feature graph): the points
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

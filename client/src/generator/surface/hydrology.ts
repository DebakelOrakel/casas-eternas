import { metersToElevation, SEA_LEVEL } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import type { DomainGrid } from '../core/domain'
import type { FlowSubstrate } from './flowSubstrate'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { detExp, detLog, detPow } from '../core/detMath'
import { MinHeap } from '../core/minHeap'

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

// An element's precipitation (mm/yr) as its runoff. NO floor: an arid
// element contributes what actually falls on it, so drainage density is
// climate-driven — arid regions genuinely lose rivers. That is a deliberate
// reversal of the 200 mm/yr runoffFloor (erosion v2, P4): the floor existed so
// bone-dry land still developed channels from drainage area alone, which is
// exactly the climate-blindness v2 retires. Called for land elements only, so
// an ocean mark (OCEAN_PRECIP) clamps to 0 — the element still passes
// upstream discharge along, it just adds none. The climate per element is
// the caller's, sampled at the elements (climate/climatePoints.ts).
function runoffOf(p: number): number {
  return p > 0 ? p : 0
}

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

export interface LakeFields {
  // Water depth per cell (0 = dry) — land lakes at their spill, terminal seas
  // at their climate balance level.
  depth: Float32Array
  // 1 in the EVAPORITE BAND: dry terminal-basin floor within SURFACE_TUNING.saltBandM above
  // the balance level (or above the basin floor when bone dry) — where the
  // last water stood and everything it carried crystallised. The SaltFlat
  // biome override's source. A subset of dryBasin.
  saltFlat: Uint8Array
  // 1 on EVERY dry sub-sea-level terminal-basin cell — the land-override mask
  // the climate refinement pass (climate v2) consumes: these cells are land
  // despite the sign test, classify by their own (hot, deep) local climate.
  // Above the salt band that naturally comes out as desert rock.
  dryBasin: Uint8Array
  // 1 on every wet cell of a basin whose mean annual temperature is below
  // SURFACE_TUNING.lakeFrozenBelowC — a GLACIER, not open water. The depth
  // stays (ice is water, and the PET floor holding a cold basin full is
  // physically right for ice); what changes is the surface: Biome.Ice wins
  // the classification, no riparian moisture, no freshwater fishery, and the
  // maps paint ice. Decided per BASIN, not per cell — one lake is one
  // surface, and the mean temperature is already summed for the PET anyway.
  frozen: Uint8Array
  // Every basin the flood found, wet or not — see WaterBody.
  bodies: WaterBody[]
  // The water level a shore is drawn against, per cell — see waterLevelField.
  level: Float32Array
  // Per cell, which body's level that is (WaterBody.id, or -1 for the sea).
  body: Int32Array
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

// The lakes over the flow substrate (flowSubstrate.ts, the terrain mesh's
// nodes — mesh/meshHydrology.ts). Per element: depth, the evaporite band,
// the dry terminal floor, the frozen surface, and the body an element's
// water belongs to (-1 for none). Areas are the elements' (in world cells),
// so the balance `inflow < pet × area` reads the same at any spacing. `temperature`
// (°C) and `precip` (mm/yr, OCEAN_PRECIP on the sea) per element.
export function computeLakesOn(sub: FlowSubstrate, discharge: Float32Array, elevation: Float32Array, temperature: ArrayLike<number>, precip: ArrayLike<number>, minBasinReliefM = SURFACE_TUNING.minLakeBasinReliefM): LakeFields {
  const { filled, count: n } = sub
  const EPS = 1e-5
  const depth = new Float32Array(n)
  const saltFlat = new Uint8Array(n)
  const dryBasin = new Uint8Array(n)
  const frozen = new Uint8Array(n)
  const body = new Int32Array(n).fill(-1)
  const level = new Float32Array(n).fill(SEA_WATER_LEVEL)
  const flooded = new Uint8Array(n)
  const bodies: WaterBody[] = []
  for (let cell = 0; cell < n; cell++) {
    // Sub-sea-level cells count too now: with the flood seeded from the world
    // ocean only, an enclosed sea is a depression like any other, and its
    // basin must be gathered as one region with its above-sea shores.
    if (filled[cell] > elevation[cell] + EPS) flooded[cell] = 1
  }
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  const nb = new Int32Array(256)
  for (let s = 0; s < n; s++) {
    if (!flooded[s] || seen[s]) continue
    // Gather the connected flooded region (one basin).
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    const region: number[] = []
    let regionArea = 0
    let spill = -Infinity
    // The pour point: the lowest cell on the region's rim. The flood's own
    // fill level (`spill`, the max filled) sits an epsilon chain above it.
    let pour = Infinity
    let pourCell = s
    let inflow = 0
    let tempSum = 0
    while (head < tail) {
      const c = queue[head++]
      region.push(c)
      regionArea += sub.area(c)
      if (filled[c] > spill) spill = filled[c]
      if (discharge[c] > inflow) inflow = discharge[c]
      tempSum += temperature[c] * sub.area(c)
      const k = sub.facetNeighbours(c, nb)
      for (let i = 0; i < k; i++) {
        const o = nb[i]
        if (flooded[o]) {
          if (!seen[o]) {
            seen[o] = 1
            queue[tail++] = o
          }
        } else if (elevation[o] < pour) {
          pour = elevation[o]
          pourCell = o
        }
      }
    }
    let basinFloor = Infinity
    let floorCell = s
    for (const c of region) if (elevation[c] < basinFloor) { basinFloor = elevation[c]; floorCell = c }
    const meanTemp = tempSum / regionArea
    const pet = evaporationPotential(meanTemp)
    const isFrozen = meanTemp < SURFACE_TUNING.lakeFrozenBelowC
    const record = (kind: WaterBody['kind'], lvl: number): void => {
      const id = bodies.length
      bodies.push({
        id, kind, level: lvl, spill: pour, floor: basinFloor,
        seedX: sub.x(floorCell), seedY: sub.y(floorCell),
        outletX: sub.x(pourCell), outletY: sub.y(pourCell),
        cells: regionArea, frozen: isFrozen,
      })
      // The whole basin is the body's — its dry floor too (a terminal
      // basin's salt pan is the body without water), as the raster's
      // extent below the spill is; the depth says what is wet.
      for (const c of region) {
        body[c] = id
        level[c] = lvl
      }
    }
    if (basinFloor < SEA_LEVEL) {
      // Direct precipitation ON the basin is part of its water budget — the
      // Volga is not the Caspian's only source, and without this every deep
      // basin that happens to lack a river inlet came out bone dry (rivers'
      // discharge never seeds water cells, see accumulateDischargeOn). Summed
      // over the whole region: rain on the wet surface feeds the balance,
      // rain on the dry floor runs down to it.
      let basinRain = 0
      for (const c of region) basinRain += runoffOf(precip[c]) * sub.area(c)
      inflow += basinRain
      // TERMINAL SEA (the Caspian/Chad class): an enclosed basin whose floor
      // lies below sea level — a landlocked ocean remnant or deep rift graben.
      // These are the legitimate river ENDPOINTS without an outflow, so the
      // endorheic balance (removed for ordinary land basins the same day)
      // applies here: the water settles where inflow matches evaporation.
      // Whatever sub-sea-level floor stays dry is a salt flat — evaporation
      // concentrated everything the rivers ever carried in.
      let lvl = spill
      if (inflow < pet * regionArea) {
        const sorted = region.slice().sort((a, b) => elevation[a] - elevation[b])
        let area = 0
        lvl = basinFloor
        for (const c of sorted) {
          area += sub.area(c)
          if (pet * area >= inflow) {
            lvl = elevation[c]
            break
          }
        }
      }
      const saltBandTop = lvl + metersToElevation(SURFACE_TUNING.saltBandM)
      let wet = 0
      for (const c of region) {
        if (elevation[c] <= lvl) {
          depth[c] = lvl - elevation[c]
          if (isFrozen) frozen[c] = 1
          wet++
        } else if (elevation[c] <= SEA_LEVEL) {
          dryBasin[c] = 1
          if (elevation[c] <= saltBandTop) saltFlat[c] = 1
        }
      }
      // The floor cell itself is always "wet" by the ≤ test (level ≥ floor);
      // a basin is dry when the balance never rose above its floor.
      record(lvl > basinFloor && wet > 0 ? 'terminal' : 'dry', lvl)
      continue
    }
    // Ordinary land basin: texture dimples are not lakes (see
    // SURFACE_TUNING.minLakeBasinReliefM), and a lake must OVERFLOW — river in, lake,
    // river out (user rule, 2026-08-06). A basin whose inflow cannot sustain
    // its full spill-level surface holds no lake at all; the terminal-sea
    // branch above is the one deliberate exception to that rule. Neither
    // failure is a body: the basin is simply terrain.
    if (spill - basinFloor < metersToElevation(minBasinReliefM)) continue
    if (inflow < pet * regionArea) continue
    for (const c of region) {
      if (elevation[c] <= spill) {
        depth[c] = spill - elevation[c]
        if (isFrozen) frozen[c] = 1
      }
    }
    record('lake', spill)
  }
  return { depth, saltFlat, dryBasin, frozen, bodies, level, body }
}

// Precipitation-weighted discharge (relative water volume) per element,
// via SINGLE-flow (the receiver, flowTarget) reverse-popOrder accumulation:
// each element is seeded with its local runoff (its precipitation, land
// only) times its area and pushes its whole total downstream to one
// neighbour, so flow concentrates onto the channel tree (see the module
// comment on why not MFD here). discharge[element] = its runoff +
// everything upstream that drains through it. Units: mm/yr summed over
// contributing world cells (an element's area in cells) — consistent with
// lake evaporation later. popOrder is upstream-first in reverse, so an
// element's upstream contributions are already summed in before it pushes
// downstream.
export function accumulateDischargeOn(sub: FlowSubstrate, elevation: Float32Array, precip: ArrayLike<number>): Float32Array {
  const { flowTarget, popOrder, poppedCount, count } = sub
  const discharge = new Float32Array(count)
  for (let cell = 0; cell < count; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue // ocean is a sink, no runoff
    discharge[cell] = runoffOf(precip[cell]) * sub.area(cell)
  }
  for (let i = poppedCount - 1; i >= 0; i--) {
    const cell = popOrder[i]
    // A water body swallows what reaches it: rivers END in seas. With the
    // flood seeded from the world ocean only (2026-08-06), an enclosed
    // basin's filled surface technically drains onward over its spill — but
    // a terminal sea has no outflow river, so the discharge must not march
    // across the spill and draw a phantom river on the far side. The first
    // sub-sea-level cell keeps the arriving discharge (computeLakes reads
    // its basin inflow from exactly these shore cells).
    if (elevation[cell] <= SEA_LEVEL) continue
    const target = flowTarget[cell]
    if (target >= 0) discharge[target] += discharge[cell]
  }
  return discharge
}

// THE FLOW REGIME'S CLIMATE INPUTS (F6): what a reach's catchment could
// evaporate and what it receives in the dry half-year, accumulated down the
// same receivers as the discharge so the three compare per cell. `loss` is
// the potential evaporation (evaporationPotential of the coarse temperature)
// summed over the contributing cells; `dry` the dry season's precipitation —
// annual × (1 − |seasonality|), the smaller of the two seasons (see
// monsoon.ts's index) — summed the same way. The seasonality is optional:
// without it the year is even and only aridity can dry a river. The ocean
// sentinels (OCEAN_PRECIP, and |index| ≥ 1 which no land value reaches)
// contribute nothing, like runoffOf.
//
// With the climate step's months (`months`, 2026-09-29) the dry season is
// read off them instead: the mean of the driest months' water, where a
// month's water is its rain above freezing plus the snow melting in it. Snow
// that falls in the cold months lies until the thaw and feeds the rivers
// then, so a mountain river runs in a dry summer (degree-day melt,
// SURFACE_TUNING.snowMeltMmPerDegreeMonth).
export interface RegimeInputs {
  loss: Float32Array
  dry: Float32Array
}

// The climate step's months per element, month-major: °C at the element's
// height and mm/yr rates (OCEAN_PRECIP on the sea).
export interface ClimateMonths {
  temperature: Float32Array
  precipitation: Float32Array
  count: number
}

// The climate per element of `sub` (climate/climatePoints.ts).
export function accumulateRegimeInputsOn(sub: FlowSubstrate, elevation: Float32Array, temperature: ArrayLike<number>, precip: ArrayLike<number>, monsoonIndex: ArrayLike<number> | undefined, months?: ClimateMonths): RegimeInputs {
  const n = sub.count
  const pet = new Float32Array(n)
  const dryPrecip = new Float32Array(n)
  const water = new Float64Array(months?.count ?? 0)
  for (let i = 0; i < n; i++) {
    const p = precip[i]
    if (p === OCEAN_PRECIP || p <= 0) continue
    pet[i] = evaporationPotential(temperature[i])
    if (months && months.count > 0) {
      dryPrecip[i] = dryWaterFromMonths(months, i, n, water)
      continue
    }
    const s = monsoonIndex ? Math.abs(monsoonIndex[i]) : 0
    dryPrecip[i] = s < 1 ? p * (1 - s) : 0
  }
  return {
    loss: accumulateDischargeOn(sub, elevation, pet),
    dry: accumulateDischargeOn(sub, elevation, dryPrecip),
  }
}

// The dry season's water of one element from its months, as an annual
// rate (mm/yr): each month's rain above freezing plus its melt, the snow
// lying from the cold months (a degree-day melt, run over two years so the
// winter's pack reaches the spring whichever month the year starts in),
// then the mean of the `regimeDryMonths` driest THAWED months. A frozen
// month is not a dry one: the river runs on under its ice, on groundwater
// (the first cut counted frost as drought and made 42 % of Astrakan's land
// seasonal). With no thawed month at all, the year's mean. `water` is
// scratch, one entry per month.
function dryWaterFromMonths(months: ClimateMonths, i: number, n: number, water: Float64Array): number {
  const count = months.count
  let pack = 0
  for (let pass = 0; pass < 2; pass++) {
    for (let m = 0; m < count; m++) {
      const t = months.temperature[m * n + i]
      const rain = Math.max(0, months.precipitation[m * n + i]) / count // mm this month
      let flow = 0
      if (t <= 0) pack += rain
      else {
        const melt = Math.min(pack, SURFACE_TUNING.snowMeltMmPerDegreeMonth * t)
        pack -= melt
        flow = rain + melt
      }
      if (pass === 1) water[m] = flow * count // back to an annual rate
    }
  }
  const thawed: number[] = []
  let all = 0
  for (let m = 0; m < count; m++) {
    all += water[m] / count
    if (months.temperature[m * n + i] > 0) thawed.push(water[m])
  }
  if (thawed.length === 0) return all
  thawed.sort((a, b) => a - b)
  const k = Math.min(SURFACE_TUNING.regimeDryMonths, thawed.length)
  let sum = 0
  for (let m = 0; m < k; m++) sum += thawed[m]
  return sum / k
}

// Largest discharge anywhere on land — the reference for river WIDTH (the mouth
// of the biggest river is the widest; everything scales down from it). Absolute,
// so widths don't shift when the density knob moves.
export function maxDischargeOverLand(discharge: Float32Array, elevation: Float32Array): number {
  let max = 0
  for (let i = 0; i < discharge.length; i++) {
    if (elevation[i] > SEA_LEVEL && discharge[i] > max) max = discharge[i]
  }
  return max
}

// Density knob (0–100) → the critical DRAINAGE AREA (in cells) a cell needs
// upstream to become a channel — an ABSOLUTE, local criterion (unlike a global
// discharge quantile, which lets the biggest wet basins swallow the whole quota
// and starve every other landmass, the concentration the user saw). Geometric so
// the knob feels even across a wide range: ~4000 cells at density 0 (only the
// major rivers) down to ~30 at 100 (a fine network) — every catchment gets its
// own dendritic tree wherever that much area converges.
export function densityToCriticalArea(density: number): number {
  const d = Math.min(100, Math.max(0, density)) / 100
  return SURFACE_TUNING.channelAreaMax * detPow(SURFACE_TUNING.channelAreaMin / SURFACE_TUNING.channelAreaMax, d)
}

// The discharge threshold for a given critical area: that many average-runoff
// cells' worth of water. In wet regions each cell contributes more, so fewer are
// needed → a denser network; in dry regions more area must converge → sparser.
export function channelThreshold(criticalArea: number, meanRunoff: number): number {
  return criticalArea * meanRunoff
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

// Rise over run to the receiver, in elevation units per world cell: the
// drop over the step's true length, so a long step does not read as
// steeper than it is.
export function receiverSlopeOn(sub: FlowSubstrate, elevation: Float32Array, cell: number): number {
  const target = sub.flowTarget[cell]
  if (target < 0 || target >= sub.count) return 0
  const distance = sub.step(cell, target)
  const drop = elevation[cell] - elevation[target]
  return drop > 0 ? drop / distance : 0
}

// The slope the boost is neutral at: the median slope among cells that WOULD be
// channels without it. Anchoring on the network's own median is what keeps this
// a redistribution rather than a global loosening — the same world keeps
// roughly the same number of channels, they simply move to where the water
// actually concentrates. It also makes exponent 0 exactly today's behaviour.
export function channelReferenceSlopeOn(sub: FlowSubstrate, elevation: Float32Array, discharge: Float32Array, threshold: number): number {
  const slopes: number[] = []
  for (let cell = 0; cell < sub.count; cell++) {
    if (elevation[cell] <= SEA_LEVEL || discharge[cell] < threshold) continue
    slopes.push(receiverSlopeOn(sub, elevation, cell))
  }
  if (slopes.length === 0) return 1
  slopes.sort((a, b) => a - b)
  const median = slopes[slopes.length >> 1]
  // A world whose channels are all flat (or a degenerate one) must not divide
  // by zero and turn every cell into a river.
  return median > 0 ? median : 1
}

// Whether this cell carries a channel. ONE definition, used by the polyline
// extractor and by the riparian biomes — they disagreed silently before, which
// would have drawn mountain rivers with no green along them.
export function isChannelCellOn(sub: FlowSubstrate, elevation: Float32Array, discharge: Float32Array, cell: number, threshold: number, referenceSlope: number): boolean {
  if (elevation[cell] <= SEA_LEVEL) return false
  const boost = detPow(Math.max(receiverSlopeOn(sub, elevation, cell), 1e-7) / referenceSlope, CHANNEL_SLOPE_EXPONENT)
  return discharge[cell] * boost >= threshold
}

// The criterion above locates channel HEADS; membership needs one more rule:
// a channel, once begun, continues to the water it drains into. Slope-area is
// an INITIATION criterion (Montgomery & Dietrich) — under a big river on a
// floodplain the boost collapses with the slope and the bare criterion fails,
// and reading it as membership cut every plains crossing into dashes: drawn
// rivers with gaps where no lake is, riparian corridors with holes (visible
// since the slope-area change, 2026-08-08). Closing the mask downstream
// restores the reading the eye and the geomorphology agree on: the threshold
// decides where a river STARTS, the sea decides where it ends.
//
// One pass over popOrder REVERSED (donors before receivers) is enough: each
// channel cell marks its receiver, and the mark rides the chain to the coast.
export function buildChannelMaskOn(sub: FlowSubstrate, elevation: Float32Array, discharge: Float32Array, threshold: number): Uint8Array {
  const referenceSlope = channelReferenceSlopeOn(sub, elevation, discharge, threshold)
  const n = sub.count
  const channel = new Uint8Array(n)
  for (let cell = 0; cell < n; cell++) {
    if (isChannelCellOn(sub, elevation, discharge, cell, threshold, referenceSlope)) channel[cell] = 1
  }
  const { popOrder, poppedCount, flowTarget } = sub
  for (let k = poppedCount - 1; k >= 0; k--) {
    const cell = popOrder[k]
    if (!channel[cell]) continue
    const t = flowTarget[cell]
    if (t >= 0 && t < n && elevation[t] > SEA_LEVEL) channel[t] = 1
  }
  return channel
}

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

// Watershed labels: every land element tagged with the id of the river
// system that drains it — the classic each-catchment-its-own-colour map.
// Walks popOrder FORWARD (downstream before upstream, the flood's own
// guarantee), so an element inherits its receiver's label in one pass; a
// land element whose receiver is water (or nothing) is a system's mouth
// and roots a new basin. Only basins of at least `minAreaKm2` keep a label
// (id 1.., largest first); the coastal fringe of micro-catchments stays 0
// — colouring tens of thousands of one-node "systems" reads as noise, not
// as a map. Uint16 per element: the filter keeps the id space tiny. On the
// mesh since DEC-0036 phase 7b; the floor is the 200 world cells of 7.8 km
// it counted on the raster (a display choice, not a world property).
export function watershedsOn(sub: FlowSubstrate, elevation: Float32Array, minAreaKm2 = 12_168): Uint16Array {
  const { flowTarget, popOrder, poppedCount, count: n } = sub
  const km2PerCell = (sub.domain.metresPerUnit / 1000) * (sub.domain.metresPerUnit / 1000)
  const label = new Int32Array(n).fill(-1)
  let nextId = 0
  for (let k = 0; k < poppedCount; k++) {
    const v = popOrder[k]
    if (elevation[v] <= SEA_LEVEL) continue
    const t = flowTarget[v]
    if (t >= 0 && elevation[t] > SEA_LEVEL && label[t] >= 0) label[v] = label[t]
    else label[v] = nextId++
  }
  const areas = new Float64Array(nextId)
  for (let v = 0; v < n; v++) if (label[v] >= 0) areas[label[v]] += sub.area(v) * km2PerCell
  const order = Array.from({ length: nextId }, (_, i) => i)
    .filter((id) => areas[id] >= minAreaKm2)
    .sort((a, b) => areas[b] - areas[a])
    .slice(0, 65535)
  const remap = new Int32Array(nextId).fill(0)
  order.forEach((id, rank) => { remap[id] = rank + 1 })
  const out = new Uint16Array(n)
  for (let v = 0; v < n; v++) if (label[v] >= 0) out[v] = remap[label[v]]
  return out
}

// --- Phase 3: riparian zones (rivers/lakes moisten nearby land → wetter biomes) ---

// The riparian moisture bonus over a substrate (DEC-0036 phase 7: on the
// terrain mesh's nodes): a water strength per element — 1 at an open lake,
// √(discharge / max) at a channel (big rivers moisten more) — carried to
// the land around it with a decay in metres, the strongest reach kept:
// strength × riparianDecay^(d / riparianDecayLengthM) within
// riparianReachM, d the shortest path over the substrate's links (a
// multi-source Dijkstra on −log strength). Returned as the precipitation
// it adds to (`precip` per element, mm/yr, OCEAN_PRECIP on the sea), the
// sea untouched: what the biomes classify by (biomes.classifyPoints), so a
// river or lake greens its surroundings — a desert with a big river
// through it becomes a vegetated corridor.
//
// The raster version took the strongest water per 62.4 km climate cell
// and bled it one cell (riparianSpread 1, riparianDecay 0.45 per cell):
// the reach and the decay length are that cell in metres (no calibration).
//
// A frozen lake moistens nothing — there is no open water to evaporate, no
// Nile effect off a glacier (its river cells stay: meltwater exists).
export function riparianPrecipitationOn(sub: FlowSubstrate, elevation: Float32Array, discharge: Float32Array, threshold: number, maxDischarge: number, lakeDepth: Float32Array, frozen: Uint8Array | null, precip: ArrayLike<number>): Float32Array {
  const n = sub.count
  const T = SURFACE_TUNING
  const scale = maxDischarge > 0 ? maxDischarge : 1
  // The same downstream-closed mask the river graph draws — the two
  // disagreed silently once before, which drew mountain rivers with no
  // green along them, and a criterion-only mask here would green a
  // corridor with holes at every flat crossing.
  const channel = buildChannelMaskOn(sub, elevation, discharge, threshold)
  // The cost of a strength s at distance d: −log s + d · k, k the decay's
  // log per metre — the strongest reach is the cheapest path.
  const k = -detLog(T.riparianDecay) / T.riparianDecayLengthM
  const maxReach = T.riparianReachM * k
  const cost = new Float64Array(n).fill(Infinity)
  const reach = new Float64Array(n)
  const heap = new MinHeap(Math.max(16, n >> 4))
  for (let c = 0; c < n; c++) {
    if (elevation[c] <= SEA_LEVEL) continue
    let w = 0
    if (lakeDepth[c] > 0 && !(frozen && frozen[c])) w = 1
    else if (channel[c]) w = Math.min(1, Math.sqrt(discharge[c] / scale))
    if (w <= 0) continue
    cost[c] = -detLog(w)
    heap.push(cost[c], c)
  }
  // `reach` the decay's part of a cost (the distance's), which the reach
  // bounds.
  const metresPerUnit = sub.domain.metresPerUnit
  const nb = new Int32Array(256)
  while (heap.length > 0) {
    heap.pop()
    const c = heap.poppedIndex
    const here = heap.poppedKey
    if (here > cost[c]) continue
    const count = sub.rimNeighbours(c, nb)
    for (let i = 0; i < count; i++) {
      const o = nb[i]
      if (o < 0) continue
      const step = sub.step(c, o) * metresPerUnit * k
      if (reach[c] + step > maxReach) continue
      const next = here + step
      if (next >= cost[o]) continue
      cost[o] = next
      reach[o] = reach[c] + step
      heap.push(next, o)
    }
  }
  const out = new Float32Array(n)
  for (let c = 0; c < n; c++) {
    const p = precip[c]
    if (p === OCEAN_PRECIP) { out[c] = p; continue }
    out[c] = Number.isFinite(cost[c]) ? p + detExp(-cost[c]) * T.maxRiparianMm : p
  }
  return out
}

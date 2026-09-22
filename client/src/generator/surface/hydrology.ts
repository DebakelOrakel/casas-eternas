import { metersToElevation, SEA_LEVEL } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { wrapValue, sampleNearestWorld } from '../core/field'
import type { FlowRouting } from './flowRouting'
import { Biome, computeBiomesFine } from '../climate/biomes'
import { OCEAN_PRECIP } from '../climate/precipitation'

// Rivers & lakes on the post-erosion topography. Reuses the erosion module's
// drainage network (FlowRouting: D8 flowTarget for the channel tree,
// priority-flood `filled` for basins) and the climate precipitation as the
// water source. See docs/decisions/climate-biomes.md's pipeline note.
//
// Discharge is accumulated along the SINGLE steepest-descent flowTarget (D8), not
// the multiple-flow edges erosion uses for drainage AREA. MFD is right for
// erosion (smooth area, no striping) but for DRAWN rivers it smears flow across
// the whole valley floor, so a "river" reads as a filled band rather than a line;
// single-flow concentrates the water onto one traceable channel. Cells sitting in
// a filled depression (filled > raw) are excluded — they're lake bed, not
// channel (the radial fan D8 makes on a flat fill isn't a river).

// The one density the MODEL runs at: riparian biomes, the bake's extracted
// rivers and the coast status mask all read the channel set at this density.
// The panel's density slider is a DRAW filter over it — display-side, outside
// the spec and the artifact key — so moving it can neither change saved
// biomes nor invalidate a bake (erosion v2, P4). Same 0–100 scale as the
// slider; densityToCriticalArea maps it.
export const CANONICAL_RIVER_DENSITY = 55

// Nearest coarse-grid precip (mm/yr) at a full-res land cell. NO floor: an
// arid cell contributes what actually falls on it, so drainage density is
// climate-driven — arid regions genuinely lose rivers. That is a deliberate
// reversal of the 200 mm/yr runoffFloor (erosion v2, P4): the floor existed so
// bone-dry land still developed channels from drainage area alone, which is
// exactly the climate-blindness v2 retires. Called for land cells only, so an
// ocean-sentinel precip (coarse cell reads as ocean at the coast) clamps to
// 0 — the cell still passes upstream discharge along, it just adds none.
function precipRunoffAt(precip: Float32Array, cx: number, cy: number, worldW: number, worldH: number, climateResX: number, climateResY: number): number {
  const p = sampleNearestWorld(precip, climateResX, climateResY, cx, cy, worldW, worldH)
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

// Mean per-cell runoff over land — the reference the critical-area threshold
// multiplies against (so "A cells of drainage" translates to a discharge value).
export function meanLandRunoff(precip: Float32Array, elevation: Float32Array, worldW: number, worldH: number, climateResX: number, climateResY: number): number {
  let sum = 0
  let count = 0
  for (let cell = 0; cell < elevation.length; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue
    const cx = cell % worldW
    const cy = (cell - cx) / worldW
    sum += precipRunoffAt(precip, cx, cy, worldW, worldH, climateResX, climateResY)
    count++
  }
  return count > 0 ? sum / count : 0
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

function tempAtCell(temperature: Float32Array, cx: number, cy: number, worldW: number, worldH: number, climateResX: number, climateResY: number): number {
  return sampleNearestWorld(temperature, climateResX, climateResY, cx, cy, worldW, worldH)
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
export function basinCellsBelow(elevation: Float32Array, width: number, height: number, body: WaterBody): Int32Array {
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
      const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
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

export function waterLevelField(bodies: readonly WaterBody[], elevation: Float32Array, width: number, height: number): { level: Float32Array; body: Int32Array; surface: Uint8Array } {
  const n = width * height
  const level = new Float32Array(n).fill(SEA_WATER_LEVEL)
  const body = new Int32Array(n).fill(-1)
  const surface = new Uint8Array(n).fill(SURFACE_SEA)
  const rim: number[] = []
  for (const b of bodies) {
    const cells = basinCellsBelow(elevation, width, height, b)
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
          const nb = wrapValue(cy + dy, height) * width + wrapValue(cx + dx, width)
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
export function lakeDepthFromBodies(bodies: readonly WaterBody[], elevation: Float32Array, width: number, height: number): Float32Array {
  const depth = new Float32Array(width * height)
  for (const b of bodies) {
    if (b.kind === 'dry') continue
    for (const c of basinCellsBelow(elevation, width, height, b)) {
      if (elevation[c] <= b.level) depth[c] = b.level - elevation[c]
    }
  }
  return depth
}

export function computeLakes(routing: FlowRouting, discharge: Float32Array, elevation: Float32Array, temperature: Float32Array, precip: Float32Array, climateResX: number, climateResY: number, minBasinReliefM = SURFACE_TUNING.minLakeBasinReliefM): LakeFields {
  const { width, height, filled } = routing
  const n = width * height
  const EPS = 1e-5
  const depth = new Float32Array(n)
  const saltFlat = new Uint8Array(n)
  const dryBasin = new Uint8Array(n)
  const frozen = new Uint8Array(n)
  const flooded = new Uint8Array(n)
  const bodies: WaterBody[] = []
  for (let cell = 0; cell < n; cell++) {
    // Sub-sea-level cells count too now: with the flood seeded from the world
    // ocean only, an enclosed sea is a depression like any other, and its
    // basin must be gathered as one region with its above-sea shores.
    if (filled[cell] > elevation[cell] + EPS) flooded[cell] = 1
  }
  const wrap = (x: number, y: number): number => wrapValue(y, height) * width + wrapValue(x, width)
  const seen = new Uint8Array(n)
  const queue = new Int32Array(n)
  for (let s = 0; s < n; s++) {
    if (!flooded[s] || seen[s]) continue
    // Gather the connected flooded region (one basin).
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    const region: number[] = []
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
      if (filled[c] > spill) spill = filled[c]
      if (discharge[c] > inflow) inflow = discharge[c]
      const cx = c % width
      const cy = (c - cx) / width
      tempSum += tempAtCell(temperature, cx, cy, width, height, climateResX, climateResY)
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nb = wrap(cx + dx, cy + dy)
        if (flooded[nb]) {
          if (!seen[nb]) {
            seen[nb] = 1
            queue[tail++] = nb
          }
        } else if (elevation[nb] < pour) {
          pour = elevation[nb]
          pourCell = nb
        }
      }
    }
    let basinFloor = Infinity
    let floorCell = s
    for (const c of region) if (elevation[c] < basinFloor) { basinFloor = elevation[c]; floorCell = c }
    const pet = evaporationPotential(tempSum / region.length)
    const isFrozen = tempSum / region.length < SURFACE_TUNING.lakeFrozenBelowC
    const record = (kind: WaterBody['kind'], level: number): void => {
      bodies.push({
        id: bodies.length, kind, level, spill: pour, floor: basinFloor,
        seedX: (floorCell % width) + 0.5, seedY: Math.floor(floorCell / width) + 0.5,
        outletX: (pourCell % width) + 0.5, outletY: Math.floor(pourCell / width) + 0.5,
        cells: region.length, frozen: isFrozen,
      })
    }
    if (basinFloor < SEA_LEVEL) {
      // Direct precipitation ON the basin is part of its water budget — the
      // Volga is not the Caspian's only source, and without this every deep
      // basin that happens to lack a river inlet came out bone dry (rivers'
      // discharge never seeds water cells, see accumulateDischarge). Summed
      // over the whole region: rain on the wet surface feeds the balance,
      // rain on the dry floor runs down to it.
      let basinRain = 0
      for (const c of region) {
        const cx = c % width
        basinRain += precipRunoffAt(precip, cx, (c - cx) / width, width, height, climateResX, climateResY)
      }
      inflow += basinRain
      // TERMINAL SEA (the Caspian/Chad class): an enclosed basin whose floor
      // lies below sea level — a landlocked ocean remnant or deep rift graben.
      // These are the legitimate river ENDPOINTS without an outflow, so the
      // endorheic balance (removed for ordinary land basins the same day)
      // applies here: the water settles where inflow matches evaporation.
      // Whatever sub-sea-level floor stays dry is a salt flat — evaporation
      // concentrated everything the rivers ever carried in.
      let level = spill
      if (inflow < pet * region.length) {
        const sorted = region.slice().sort((a, b) => elevation[a] - elevation[b])
        let area = 0
        level = basinFloor
        for (const c of sorted) {
          area++
          if (pet * area >= inflow) {
            level = elevation[c]
            break
          }
        }
      }
      const saltBandTop = level + metersToElevation(SURFACE_TUNING.saltBandM)
      let wet = 0
      for (const c of region) {
        if (elevation[c] <= level) {
          depth[c] = level - elevation[c]
          if (isFrozen) frozen[c] = 1
          wet++
        } else if (elevation[c] <= SEA_LEVEL) {
          dryBasin[c] = 1
          if (elevation[c] <= saltBandTop) saltFlat[c] = 1
        }
      }
      // The floor cell itself is always "wet" by the ≤ test (level ≥ floor);
      // a basin is dry when the balance never rose above its floor.
      record(level > basinFloor && wet > 0 ? 'terminal' : 'dry', level)
      continue
    }
    // Ordinary land basin: texture dimples are not lakes (see
    // SURFACE_TUNING.minLakeBasinReliefM), and a lake must OVERFLOW — river in, lake,
    // river out (user rule, 2026-08-06). A basin whose inflow cannot sustain
    // its full spill-level surface holds no lake at all; the terminal-sea
    // branch above is the one deliberate exception to that rule. Neither
    // failure is a body: the basin is simply terrain.
    if (spill - basinFloor < metersToElevation(minBasinReliefM)) continue
    if (inflow < pet * region.length) continue
    for (const c of region) {
      if (elevation[c] <= spill) {
        depth[c] = spill - elevation[c]
        if (isFrozen) frozen[c] = 1
      }
    }
    record('lake', spill)
  }
  const levels = waterLevelField(bodies, elevation, width, height)
  return { depth, saltFlat, dryBasin, frozen, bodies, level: levels.level, body: levels.body }
}

// Precipitation-weighted discharge (relative water volume) per full-res cell,
// via SINGLE-flow (D8 flowTarget) reverse-popOrder accumulation: each cell is
// seeded with its local runoff (sampled precip, land only) and pushes its whole
// total downstream to one neighbor, so flow concentrates onto the channel tree
// (see the module comment on why not MFD here). discharge[cell] = its runoff +
// everything upstream that drains through it. Units: mm/yr summed over
// contributing cells (uniform cell area on the torus drops out) — consistent
// with lake evaporation later. popOrder is upstream-first in reverse, so a cell's
// upstream contributions are already summed in before it pushes downstream.
export function accumulateDischarge(routing: FlowRouting, elevation: Float32Array, precip: Float32Array, climateResX: number, climateResY: number): Float32Array {
  const { width, height, flowTarget, popOrder, poppedCount } = routing
  const discharge = new Float32Array(width * height)
  for (let cell = 0; cell < width * height; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue // ocean is a sink, no runoff
    const cx = cell % width
    const cy = (cell - cx) / width
    discharge[cell] = precipRunoffAt(precip, cx, cy, width, height, climateResX, climateResY)
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
  return SURFACE_TUNING.channelAreaMax * Math.pow(SURFACE_TUNING.channelAreaMin / SURFACE_TUNING.channelAreaMax, d)
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

function riverWidth(dischargeAtCell: number, maxDischarge: number): number {
  const scale = maxDischarge > 0 ? maxDischarge : 1
  return Math.min(RIVER_MAX_WIDTH, RIVER_MIN_WIDTH + (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH) * Math.sqrt(dischargeAtCell / scale))
}

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

// Slope to the D8 receiver, in elevation units per cell. Diagonal steps are
// longer, hence the distance divisor — without it every diagonal reads as
// steeper than it is, which would bias the boost along the diagonals.
export function receiverSlope(routing: FlowRouting, elevation: Float32Array, cell: number): number {
  const { width, height, flowTarget } = routing
  const target = flowTarget[cell]
  if (target < 0 || target >= width * height) return 0
  const x = cell % width
  const y = (cell - x) / width
  const tx = target % width
  const ty = (target - tx) / width
  let dx = Math.abs(tx - x)
  if (dx > width / 2) dx = width - dx // toroidal, both axes
  let dy = Math.abs(ty - y)
  if (dy > height / 2) dy = height - dy
  const distance = Math.hypot(dx, dy) || 1
  const drop = elevation[cell] - elevation[target]
  return drop > 0 ? drop / distance : 0
}

// The slope the boost is neutral at: the median slope among cells that WOULD be
// channels without it. Anchoring on the network's own median is what keeps this
// a redistribution rather than a global loosening — the same world keeps
// roughly the same number of channels, they simply move to where the water
// actually concentrates. It also makes exponent 0 exactly today's behaviour.
export function channelReferenceSlope(routing: FlowRouting, elevation: Float32Array, discharge: Float32Array, threshold: number): number {
  const slopes: number[] = []
  for (let cell = 0; cell < discharge.length; cell++) {
    if (elevation[cell] <= SEA_LEVEL || discharge[cell] < threshold) continue
    slopes.push(receiverSlope(routing, elevation, cell))
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
export function isChannelCell(routing: FlowRouting, elevation: Float32Array, discharge: Float32Array, cell: number, threshold: number, referenceSlope: number): boolean {
  if (elevation[cell] <= SEA_LEVEL) return false
  const boost = Math.pow(Math.max(receiverSlope(routing, elevation, cell), 1e-7) / referenceSlope, CHANNEL_SLOPE_EXPONENT)
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
export function buildChannelMask(routing: FlowRouting, elevation: Float32Array, discharge: Float32Array, threshold: number): Uint8Array {
  const referenceSlope = channelReferenceSlope(routing, elevation, discharge, threshold)
  const n = discharge.length
  const channel = new Uint8Array(n)
  for (let cell = 0; cell < n; cell++) {
    if (isChannelCell(routing, elevation, discharge, cell, threshold, referenceSlope)) channel[cell] = 1
  }
  const { popOrder, poppedCount, flowTarget } = routing
  for (let k = poppedCount - 1; k >= 0; k--) {
    const cell = popOrder[k]
    if (!channel[cell]) continue
    const t = flowTarget[cell]
    if (t >= 0 && t < n && elevation[t] > SEA_LEVEL) channel[t] = 1
  }
  return channel
}

// Connected river polylines for smooth rendering. Each channel cell (discharge ≥
// threshold, land — INCLUDING lake beds and filled dimples since 2026-08-06:
// excluding depression cells broke every river at every basin it crossed, and
// once the plains micro-relief landed the lines shattered map-wide; a river now
// draws as one continuous line through the lakes it feeds, river → lake →
// river, the way the user reads the map) flows to one D8 neighbour, so channel cells form
// trees rooted at the sea. We trace each headwater (a channel cell with no
// channel cell flowing into it) downstream along flowTarget, emitting an ORDERED
// path of [x, y, widthPx] points until it merges into an already-traced trunk
// (one connecting point is added so branches visually join) or leaves the
// channel. Tracing paths instead of loose segments lets the renderer spline-
// smooth them into curves (no more D8 staircase) and draw continuous ribbons.
// Returns the concatenated points and a per-polyline point-count table.
// Polylines never cross the toroidal seam (a wrap step ends the current one).
export interface RiverPolylines {
  points: Float32Array // [x, y, widthPx, …] in texel coords, all polylines concatenated
  lengths: Uint32Array // number of points in each polyline, in order
}

export function extractRiverPolylines(routing: FlowRouting, discharge: Float32Array, elevation: Float32Array, threshold: number, maxDischarge: number): RiverPolylines {
  const { width, height, flowTarget } = routing
  const n = width * height
  const channel = buildChannelMask(routing, elevation, discharge, threshold)
  const adjacent = (a: number, b: number): boolean => {
    const ax = a % width
    const ay = (a - ax) / width
    const bx = b % width
    const by = (b - bx) / width
    return Math.abs(bx - ax) <= 1 && Math.abs(by - ay) <= 1
  }
  // In-degree among channel cells → headwaters have none.
  const inDeg = new Uint8Array(n)
  for (let cell = 0; cell < n; cell++) {
    if (!channel[cell]) continue
    const t = flowTarget[cell]
    if (t >= 0 && channel[t] && adjacent(cell, t) && inDeg[t] < 255) inDeg[t]++
  }
  const visited = new Uint8Array(n)
  const points: number[] = []
  const lengths: number[] = []
  for (let start = 0; start < n; start++) {
    if (!channel[start] || inDeg[start] !== 0 || visited[start]) continue
    let cur = start
    let len = 0
    for (;;) {
      const cx = cur % width
      const cy = (cur - cx) / width
      points.push(cx + 0.5, cy + 0.5, riverWidth(discharge[cur], maxDischarge))
      len++
      visited[cur] = 1
      const t = flowTarget[cur]
      if (t < 0 || !channel[t] || !adjacent(cur, t)) {
        // A river must REACH the water it drains into. The channel mask stops
        // at the last land cell by construction (buildChannelMask only marks a
        // receiver above sea level), so without this the line ends one cell
        // short of the coast — invisible at map zoom, but exactly one cell
        // wide at every scale: 7.8 km at the macro raster, still ~2 km (about
        // six 300 m hex tiles) after an 8k bake, which is where it became
        // obvious (measured 2026-08-14; median gap was 1 cell at every
        // resolution).
        //
        // Only the terminal point is added, and only onto water. The mask
        // itself is left alone on purpose: computeRiparianBiomes shares it and
        // relies on it meaning "channel ON LAND" (it skips sea cells anyway),
        // and the two agreeing along the COURSE is what fixed the dashed
        // rivers of 2026-08-08. A point in the sea is a mouth, not membership.
        if (t >= 0 && t < n && adjacent(cur, t) && elevation[t] <= SEA_LEVEL) {
          const tx = t % width
          const ty = (t - tx) / width
          points.push(tx + 0.5, ty + 0.5, riverWidth(discharge[cur], maxDischarge))
          len++
        }
        break
      }
      if (visited[t]) {
        // Merge into an existing trunk: add its point so the branch connects, stop.
        const tx = t % width
        const ty = (t - tx) / width
        points.push(tx + 0.5, ty + 0.5, riverWidth(discharge[t], maxDischarge))
        len++
        break
      }
      cur = t
    }
    if (len >= 2) lengths.push(len)
    else points.length -= len * 3 // drop a lone point
  }
  return { points: Float32Array.from(points), lengths: Uint32Array.from(lengths) }
}

// Watershed labels: every land cell tagged with the id of the river system
// that drains it — the classic each-catchment-its-own-colour map. Walks
// popOrder FORWARD (downstream before upstream, the flood's own guarantee),
// so a cell can inherit its target's label in one pass; a land cell whose
// target is water (or nothing) is a system's mouth and roots a new basin.
// Only basins of at least `minAreaCells` keep a label (id 1.., largest
// first); the coastal fringe of micro-catchments stays 0 — colouring tens of
// thousands of one-cell "systems" reads as noise, not as a map. Uint16: the
// filter keeps the id space tiny.
export function computeWatersheds(routing: FlowRouting, elevation: Float32Array, minAreaCells = 200): Uint16Array {
  const { width, height, flowTarget, popOrder, poppedCount } = routing
  const n = width * height
  const label = new Int32Array(n).fill(-1)
  let nextId = 0
  for (let k = 0; k < poppedCount; k++) {
    const cell = popOrder[k]
    if (elevation[cell] <= SEA_LEVEL) continue
    const t = flowTarget[cell]
    if (t >= 0 && elevation[t] > SEA_LEVEL && label[t] >= 0) label[cell] = label[t]
    else label[cell] = nextId++
  }
  const areas = new Uint32Array(nextId)
  for (let i = 0; i < n; i++) if (label[i] >= 0) areas[label[i]]++
  const order = Array.from({ length: nextId }, (_, i) => i)
    .filter((id) => areas[id] >= minAreaCells)
    .sort((a2, b2) => areas[b2] - areas[a2])
    .slice(0, 65535)
  const remap = new Int32Array(nextId).fill(0)
  order.forEach((id, rank) => { remap[id] = rank + 1 })
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) if (label[i] >= 0) out[i] = remap[label[i]]
  return out
}

// --- Phase 3: riparian zones (rivers/lakes moisten nearby land → wetter biomes) ---

// Re-classifies biomes with a riparian moisture bonus: builds a coarse water-
// strength field (1 at lakes, √(discharge/max) at river channels — big rivers
// moisten more), bleeds it into neighbours with decay, adds it (× SURFACE_TUNING.maxRiparianMm)
// to precipitation, and re-runs the Whittaker classification. So a river or lake
// greens its surroundings — a desert with a big river through it becomes a
// vegetated corridor. `elevation` is the display terrain (land/ocean + biome
// substrate); discharge/lakeDepth share its grid.
//
// Output is at the WORLD raster's resolution, matching the climate step's biomes
// so the display never switches grids mid-run. The moisture model in between is
// still regional — see the comment at the classification call.
//
// `precipEff` comes back alongside the biomes, and that is the more reusable
// half: it is the whole riparian effect, expressed as a climate-grid
// precipitation field. Anyone holding it can reproduce this classification at
// ANY resolution with no hydrology at all — which is exactly what the worldmap's
// amplification bake needs, since re-deriving routing and discharge there just
// to learn that a river passes by would cost seconds per load to recompute
// something regional (see docs/decisions/worldmap-amplification.md).
export function computeRiparianBiomes(routing: FlowRouting, elevation: Float32Array, discharge: Float32Array, threshold: number, maxDischarge: number, lakeDepth: Float32Array, precip: Float32Array, temperature: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, worldW: number, worldH: number, climateResX: number, climateResY: number, saltFlat?: Uint8Array, dryLand?: Uint8Array, frozen?: Uint8Array): { biomes: Uint8Array; precipEff: Float32Array } {
  const scale = maxDischarge > 0 ? maxDischarge : 1
  // The same downstream-closed mask the polyline extractor draws — the two
  // disagreed silently once before, which drew mountain rivers with no green
  // along them, and a criterion-only mask here would green a corridor with
  // holes at every flat crossing.
  const channelMask = buildChannelMask(routing, elevation, discharge, threshold)
  const strength = new Float32Array(climateResX * climateResY)
  for (let cell = 0; cell < elevation.length; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue
    let w = 0
    // A frozen lake moistens nothing — there is no open water to evaporate,
    // no Nile effect off a glacier. (Its river cells stay: meltwater exists.)
    if (lakeDepth[cell] > 0 && !frozen?.[cell]) w = 1
    else if (channelMask[cell]) w = Math.min(1, Math.sqrt(discharge[cell] / scale))
    if (w <= 0) continue
    const x = cell % worldW
    const y = (cell - x) / worldW
    const gx = Math.min(climateResX - 1, Math.floor((x / worldW) * climateResX))
    const gy = Math.min(climateResY - 1, Math.floor((y / worldH) * climateResY))
    const gi = gy * climateResX + gx
    if (w > strength[gi]) strength[gi] = w
  }
  // Decay-bleed into neighbours (toroidal), taking the max so a band forms.
  let field = strength
  for (let it = 0; it < SURFACE_TUNING.riparianSpread; it++) {
    const next = field.slice()
    for (let gy = 0; gy < climateResY; gy++) {
      for (let gx = 0; gx < climateResX; gx++) {
        const gi = gy * climateResX + gx
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nx = wrapValue((gx + dx), climateResX)
          const ny = wrapValue((gy + dy), climateResY)
          const v = field[ny * climateResX + nx] * SURFACE_TUNING.riparianDecay
          if (v > next[gi]) next[gi] = v
        }
      }
    }
    field = next
  }
  const precipEff = precip.slice()
  for (let i = 0; i < precipEff.length; i++) {
    if (precipEff[i] === OCEAN_PRECIP) continue
    precipEff[i] = precipEff[i] + field[i] * SURFACE_TUNING.maxRiparianMm
  }
  // The moisture bleed above stays on the climate grid even though the OUTPUT is
  // full-res: it is a regional wetting, and bleeding it at world resolution
  // would be a different model rather than a sharper one. Only the
  // classification moves, which is the part that reads elevation.
  const biomes = computeBiomesFine(temperature, precipEff, seasonalAmplitude, monsoonIndex, elevation, worldW, worldH, dryLand)
  // Salt-flat override (see computeLakes' LakeFields.saltFlat): a terminal
  // basin's exposed floor is a hydrology state, not a climate — it wins over
  // whatever the Whittaker mapping said.
  //
  // The mask is full-res and so is the output, so it applies cell for cell. The
  // coarse version of this had to vote instead — a 62 km cell flipped only when
  // most of it was crust — which lost every basin floor smaller than about half
  // a cell. That is a real gain from going fine, not just a sharper edge.
  if (saltFlat) {
    for (let cell = 0; cell < saltFlat.length; cell++) {
      if (saltFlat[cell]) biomes[cell] = Biome.SaltFlat
    }
  }
  // Frozen-lake override, the same shape as the salt flat above: a glacier
  // surface is a hydrology state the classification cannot reach (Whittaker
  // sees the cell's climate, not that a basin's water froze through), and it
  // is what lets every map paint ice from the biome layer alone — the save
  // carries no separate frozen mask. Its OWN biome, not Biome.Ice: Ice is a
  // climate class on land, a glacier is a water body in a solid state.
  if (frozen) {
    for (let cell = 0; cell < frozen.length; cell++) {
      if (frozen[cell]) biomes[cell] = Biome.Glacier
    }
  }
  return { biomes, precipEff }
}

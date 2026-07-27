import { SEA_LEVEL } from './elevationScale'
import type { FlowRouting } from './erosion'
import { computeBiomes } from './climate/biomes'
import { OCEAN_PRECIP } from './climate/precipitation'

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

// A modest per-cell runoff floor so even a bone-dry landmass still develops
// channels from drainage area alone (precip only MODULATES density, it doesn't
// gate rivers entirely) — the user disliked rivers vanishing outside the wettest
// regions. Wet cells sit far above this, so precip still dominates where it's high.
const RUNOFF_FLOOR = 200

// Nearest coarse-grid precip (mm/yr) at a full-res land cell, floored (see
// RUNOFF_FLOOR). Called for land cells only, so an ocean-sentinel precip (coarse
// cell reads as ocean at the coast) just falls back to the floor.
function precipRunoffAt(precip: Float32Array, cx: number, cy: number, worldW: number, worldH: number, climateResX: number, climateResY: number): number {
  const gx = Math.min(climateResX - 1, Math.floor((cx / worldW) * climateResX))
  const gy = Math.min(climateResY - 1, Math.floor((cy / worldH) * climateResY))
  const p = precip[gy * climateResX + gx]
  return p > RUNOFF_FLOOR ? p : RUNOFF_FLOOR
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
  return count > 0 ? sum / count : RUNOFF_FLOOR
}

// Potential evaporation from an open water surface (mm/yr), rising with
// temperature — warm basins lose far more water, which is what makes hot dry
// basins into shrunken salt lakes (or none) while cold/wet ones brim over. Same
// mm/yr units as the discharge sum, so inflow and evaporation compare directly.
// Tune by eye.
export function evaporationPotential(tempC: number): number {
  const pet = 150 + 60 * tempC
  return pet < 100 ? 100 : pet > 3000 ? 3000 : pet
}

function tempAtCell(temperature: Float32Array, cx: number, cy: number, worldW: number, worldH: number, climateResX: number, climateResY: number): number {
  const gx = Math.min(climateResX - 1, Math.floor((cx / worldW) * climateResX))
  const gy = Math.min(climateResY - 1, Math.floor((cy / worldH) * climateResY))
  return temperature[gy * climateResX + gx]
}

// Lake water depth per full-res cell (0 = dry). Climate-aware / endorheic:
// priority-flood `filled` marks every depression's cells (filled > raw) and its
// spill level; for each basin (a connected flooded region) we weigh the water
// arriving (max discharge through it) against evaporation from the lake surface
// (evaporationPotential × area). If inflow ≥ evaporation at the spill-full area,
// the basin brims to its spill and overflows (an open lake feeding the river
// below); otherwise it's ENDORHEIC — the level settles where inflow balances
// evaporation, a shrunken closed lake (a hot dry basin becomes a small salt lake,
// or nothing). Depth = level − raw for cells under the level. 4-connected,
// toroidally wrapped. See docs/decisions/climate-biomes.md.
export function computeLakes(routing: FlowRouting, discharge: Float32Array, elevation: Float32Array, temperature: Float32Array, climateResX: number, climateResY: number): Float32Array {
  const { width, height, filled } = routing
  const n = width * height
  const EPS = 1e-5
  const depth = new Float32Array(n)
  const flooded = new Uint8Array(n)
  for (let cell = 0; cell < n; cell++) {
    if (elevation[cell] > SEA_LEVEL && filled[cell] > elevation[cell] + EPS) flooded[cell] = 1
  }
  const wrap = (x: number, y: number): number => (((y % height) + height) % height) * width + (((x % width) + width) % width)
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
        if (flooded[nb] && !seen[nb]) {
          seen[nb] = 1
          queue[tail++] = nb
        }
      }
    }
    const pet = evaporationPotential(tempSum / region.length)
    // Overflow if the water arriving can sustain the full spill-level surface;
    // otherwise find the endorheic level where inflow balances evaporation.
    let level = spill
    if (inflow < pet * region.length) {
      const sorted = region.slice().sort((a, b) => elevation[a] - elevation[b])
      let area = 0
      for (const c of sorted) {
        area++
        if (pet * area >= inflow) {
          level = elevation[c]
          break
        }
      }
    }
    for (const c of region) {
      if (elevation[c] <= level) depth[c] = level - elevation[c]
    }
  }
  return depth
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
  const AREA_MAX = 4000
  // Floored well above 1 cell: on smooth (un-eroded) terrain a too-low threshold
  // draws a channel from nearly every cell, and D8 picks the same steepest
  // direction for whole neighbourhoods → a mess of parallel lines. Keeping even
  // max density at a few hundred cells of support suppresses that noise.
  const AREA_MIN = 150
  return AREA_MAX * Math.pow(AREA_MIN / AREA_MAX, d)
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
const RIVER_MIN_WIDTH = 0.4
const RIVER_MAX_WIDTH = 4

function riverWidth(dischargeAtCell: number, maxDischarge: number): number {
  const scale = maxDischarge > 0 ? maxDischarge : 1
  return Math.min(RIVER_MAX_WIDTH, RIVER_MIN_WIDTH + (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH) * Math.sqrt(dischargeAtCell / scale))
}

// Connected river polylines for smooth rendering. Each channel cell (discharge ≥
// threshold, land, not lake bed) flows to one D8 neighbour, so channel cells form
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
  const { width, height, flowTarget, filled } = routing
  const n = width * height
  const DEPRESSION_EPS = 1e-5
  const channel = new Uint8Array(n)
  for (let cell = 0; cell < n; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue
    if (filled[cell] > elevation[cell] + DEPRESSION_EPS) continue
    if (discharge[cell] < threshold) continue
    channel[cell] = 1
  }
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
      if (t < 0 || !channel[t] || !adjacent(cur, t)) break
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

// --- Phase 3: riparian zones (rivers/lakes moisten nearby land → wetter biomes) ---

// Peak precipitation bonus (mm/yr) a cell gets right at a full-strength river/lake
// — enough to lift a hot desert (P<250) into savanna/forest (the Nile effect).
const MAX_RIPARIAN_MM = 900
// How far the moisture bleeds into neighbouring coarse cells, and its per-step
// falloff. Coarse cells are large (~60 km), so 1 step already reads as a green
// valley band without washing out the whole continent.
const RIPARIAN_SPREAD = 1
const RIPARIAN_DECAY = 0.45

// Re-classifies biomes with a riparian moisture bonus: builds a coarse water-
// strength field (1 at lakes, √(discharge/max) at river channels — big rivers
// moisten more), bleeds it into neighbours with decay, adds it (× MAX_RIPARIAN_MM)
// to precipitation, and re-runs the Whittaker classification. So a river or lake
// greens its surroundings — a desert with a big river through it becomes a
// vegetated corridor. `elevation` is the display terrain (land/ocean + biome
// substrate); discharge/lakeDepth share its grid. Coarse (climate-grid) output.
export function computeRiparianBiomes(elevation: Float32Array, discharge: Float32Array, threshold: number, maxDischarge: number, lakeDepth: Float32Array, precip: Float32Array, temperature: Float32Array, seasonalAmplitude: Float32Array, monsoonIndex: Float32Array, worldW: number, worldH: number, climateResX: number, climateResY: number): Uint8Array {
  const scale = maxDischarge > 0 ? maxDischarge : 1
  const strength = new Float32Array(climateResX * climateResY)
  for (let cell = 0; cell < elevation.length; cell++) {
    if (elevation[cell] <= SEA_LEVEL) continue
    let w = 0
    if (lakeDepth[cell] > 0) w = 1
    else if (discharge[cell] >= threshold) w = Math.min(1, Math.sqrt(discharge[cell] / scale))
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
  for (let it = 0; it < RIPARIAN_SPREAD; it++) {
    const next = field.slice()
    for (let gy = 0; gy < climateResY; gy++) {
      for (let gx = 0; gx < climateResX; gx++) {
        const gi = gy * climateResX + gx
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          const nx = (((gx + dx) % climateResX) + climateResX) % climateResX
          const ny = (((gy + dy) % climateResY) + climateResY) % climateResY
          const v = field[ny * climateResX + nx] * RIPARIAN_DECAY
          if (v > next[gi]) next[gi] = v
        }
      }
    }
    field = next
  }
  const precipEff = precip.slice()
  for (let i = 0; i < precipEff.length; i++) {
    if (precipEff[i] === OCEAN_PRECIP) continue
    precipEff[i] = precipEff[i] + field[i] * MAX_RIPARIAN_MM
  }
  return computeBiomes(temperature, precipEff, seasonalAmplitude, monsoonIndex, elevation, worldW, worldH)
}

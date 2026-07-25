import { SEA_LEVEL } from './erosion'
import type { FlowRouting } from './erosion'

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

import { fillDepressionsAndRouteFlow } from './flowRouting'
import { accumulateDischarge, computeWatersheds, maxDischargeOverLand, meanLandRunoff } from './hydrology'
import { SEA_LEVEL } from '../elevation/elevationScale'

// THE PLAN A BAKE IS CUT ALONG — computed on the MACRO raster, before any
// amplification, and cheap enough to run wherever the bake is commissioned.
//
// It answers three things at once, which is why it is one pass and not three:
//
//   1. WHERE THE CUTS GO. Nothing flows across a divide, so a catchment is the
//      only region that can erode itself: it receives water from rain, and rain
//      it knows. A rectangle in the middle of a river system cannot — a river
//      enters it carrying a drainage area computed elsewhere.
//   2. TWO NUMBERS THAT BELONG TO NOBODY. `maxDischarge` and `meanRunoff` set
//      the channel threshold and are defined over the whole world. If each job
//      computed its own, every catchment would get a different river density,
//      visible at every boundary.
//   3. THE JOB LIST, packed from the catchments to a budget.
//
// It is also the ORDERING, without needing a mechanism for it: there are no jobs
// to start too early, because until this has run there are no jobs at all.
//
// See docs/design/splitting-the-bake.md.

export interface BakePlanRequest {
  // The authoritative macro raster — the same one a bake amplifies.
  elevation: Float32Array
  width: number
  height: number
  // Climate, for the discharge the threshold is derived from. Without it the
  // two scalars come back 0 and the caller must not threshold rivers by them.
  precipitation?: Float32Array
  climateResX?: number
  climateResY?: number
  // How many MACRO land cells one job may take. The real cost scales with the
  // amplified area, so a caller picks this by dividing its budget by factor².
  budgetCells: number
  // The smallest catchment worth a label of its own. Everything below it lands
  // in the fragment group.
  //
  // Not computeWatersheds' own default, and the difference matters: that one is
  // tuned for the OVERLAY, where tens of thousands of one-cell systems read as
  // noise rather than as a map. A plan wants the opposite — the fewer cells left
  // unlabelled the better, because they all end up in one world-spanning job.
  minCatchmentCells?: number
}

// A region on the torus: origin plus extent, where the extent may be the full
// width or height and the origin may sit anywhere — reading x from `x` to
// `x + w` with wrapping. NOT a pair of corners: on a torus the box holding a
// catchment that straddles the seam has its "left" edge to the right of its
// "right" one, and a min/max box would silently grow to the whole world.
export interface TorusBox {
  x: number
  y: number
  w: number
  h: number
}

// One job's worth of work: the catchments it owns, and what they cost.
export interface BakeJobGroup {
  // Watershed labels, ascending. A job erodes exactly these and nothing else.
  catchments: number[]
  // Macro land cells across them — the number the budget is spent in, and the
  // proxy for TIME.
  cells: number
  // The macro region the job's catchments span. A DIAGNOSTIC, not an allocation
  // — measured 2026-08-09 and the measurement is why the wording is careful.
  //
  // One catchment fills only about half its own box (median 0.50, worst 0.09),
  // because a river system reaching from a range to the sea is long and bent.
  // Pack several into one job and the fill collapses to 1–3 %: at sixteen jobs
  // the boxes together cover 6.2× the whole world, against land that is 0.09× of
  // it. So a job that allocated its box would allocate seventy times what it
  // touches, and step 3 must cover a region some other way — the tile set is
  // 2–5× tighter and is the candidate.
  //
  // What the box IS good for is seeing that: a job whose box is most of the map
  // is one whose catchments have nothing to do with each other.
  box: TorusBox
}

export interface BakePlan {
  // Per macro cell: which catchment it belongs to, or NO_CATCHMENT.
  //
  // That value covers two different things on purpose, because a job treats them
  // the same: ocean, and land in a catchment too small for computeWatersheds to
  // keep. Those fragments are coastal strips draining straight to sea — they are
  // independent of everything else, so they ride along as one group rather than
  // earning labels of their own.
  labels: Uint16Array
  groups: BakeJobGroup[]
  // Land cells no kept catchment claims — the fragments above, which form the
  // last group. Surfaced because it is the number that says when the minimum
  // catchment area is doing more work than intended.
  fragmentCells: number
  // World-wide, so every job thresholds identically. 0 without climate.
  maxDischarge: number
  meanRunoff: number
}

// The label a cell carries when no kept catchment claims it.
export const NO_CATCHMENT = 0

// One cell, i.e. label everything — measured 2026-08-09 rather than assumed.
//
// computeWatersheds defaults to 200 for the overlay, and on a real 2048×1024
// world that leaves 36.7 % of the land unlabelled: a single fragment group
// holding more than a third of the work and spanning the whole map, which is the
// worst job in the plan by both measures. Lowering the minimum walks it down
// (200 → 36.7 %, 32 → 19.1 %, 8 → 9.4 %, 1 → none at all) and costs only labels:
// 1 gives 9327 catchments, comfortably inside computeWatersheds' 65535 cap.
//
// The cap is why the fragment group still exists rather than being deleted as
// unreachable. A world with much more coastline could cross it, and then the
// overflow lands at NO_CATCHMENT again — rare, and handled, instead of a
// partition that quietly stops being one.
export const DEFAULT_MIN_CATCHMENT_CELLS = 1

export async function planBake(request: BakePlanRequest): Promise<BakePlan> {
  const { elevation, width, height, budgetCells } = request
  if (budgetCells <= 0) throw new Error(`planBake: budgetCells is ${budgetCells}`)

  // The macro drainage, which is also the authority for where the divides are.
  // Rule 4 (docs/decisions/worldmap-amplification.md): amplification may refine
  // the macro shapes and never contradict them — so a partition taken from the
  // macro field is a legitimate one to cut along, even though the amplified
  // terrain will re-route in detail inside it.
  const routing = await fillDepressionsAndRouteFlow(elevation, width, height, SEA_LEVEL)
  const labels = computeWatersheds(routing, elevation, request.minCatchmentCells ?? DEFAULT_MIN_CATCHMENT_CELLS)

  let maxDischarge = 0
  let meanRunoff = 0
  const { precipitation, climateResX, climateResY } = request
  if (precipitation && climateResX && climateResY) {
    const discharge = accumulateDischarge(routing, elevation, precipitation, climateResX, climateResY)
    maxDischarge = maxDischargeOverLand(discharge, elevation)
    meanRunoff = meanLandRunoff(precipitation, elevation, width, height, climateResX, climateResY)
  }

  // Areas per label. Ocean is excluded, so `areas[NO_CATCHMENT]` counts exactly
  // the fragments and not the sea.
  let highest = 0
  for (let i = 0; i < labels.length; i++) if (labels[i] > highest) highest = labels[i]
  const areas = new Uint32Array(highest + 1)
  for (let i = 0; i < labels.length; i++) {
    if (elevation[i] <= SEA_LEVEL) continue
    areas[labels[i]]++
  }
  const fragmentCells = areas[NO_CATCHMENT]

  // Largest first, ties by label. computeWatersheds already numbers them that
  // way, and this sorts anyway rather than depending on it: the packing below is
  // what makes the bytes reproducible, so it takes its order from a rule it
  // states itself instead of from another module's documented side effect.
  const bySize: number[] = []
  for (let label = 1; label <= highest; label++) if (areas[label] > 0) bySize.push(label)
  bySize.sort((a, b) => areas[b] - areas[a] || a - b)

  // First-fit-decreasing, and it does not need to be optimal: the cost of an
  // uneven split is one job finishing late, against a bin packer whose output
  // nobody can predict. What it MUST be is deterministic — derived from the
  // sorted order rather than from which worker happened to be free, or the bytes
  // would depend on scheduling.
  const packed: number[][] = []
  const packedCells: number[] = []
  for (const label of bySize) {
    const size = areas[label]
    // A catchment bigger than a whole budget takes a job of its own and blows
    // through it. Splitting one is the expensive case — it can only be cut at
    // confluences, and then flow does cross the cut — so it is not done here;
    // the caller sees an over-budget group and decides.
    let target = -1
    if (size <= budgetCells) {
      for (let g = 0; g < packed.length; g++) {
        if (packedCells[g] + size <= budgetCells) { target = g; break }
      }
    }
    if (target < 0) { packed.push([label]); packedCells.push(size); continue }
    packed[target].push(label)
    packedCells[target] += size
  }

  // The fragments last and alone: they are scattered over the whole map, so
  // packing them beside a compact catchment would hand that job a bounding box
  // the size of the world.
  if (fragmentCells > 0) { packed.push([NO_CATCHMENT]) ; packedCells.push(fragmentCells) }

  for (const group of packed) group.sort((a, b) => a - b)
  const boxes = groupBoxes(labels, elevation, packed, width, height)

  const groups: BakeJobGroup[] = packed.map((catchments, g) => ({
    catchments,
    cells: packedCells[g],
    box: boxes[g],
  }))

  return { labels, groups, fragmentCells, maxDischarge, meanRunoff }
}

// Which job owns each cell of the AMPLIFIED grid: the group's index, or -1 for
// a cell no job computes.
//
// The plan is macro and the bake is fine, so somebody has to bridge them, and
// the obvious bridge — read the macro label under each fine cell — LOSES LAND.
// Measured on a real world at 4K: 7542 fine land cells of 723140 sit over a
// macro cell that is ocean, because amplification adds relief and a coastline
// gains islands and headlands the 2048 raster never had. Under the obvious rule
// those cells carry no label, so no job owns them, and they come out of a split
// bake at their seeded height while everything around them is eroded.
//
// So a fine land cell over unlabelled macro takes the nearest labelled macro
// cell's job, searched in growing rings and settled by the lowest group index on
// a tie — deterministic, because ownership decides which bytes each job writes.
//
// Lives here rather than in each caller for the ordinary reason: it was written
// twice within an hour (the harness and a measurement script) before it was
// written once.
export function fineOwnership(plan: BakePlan, macroWidth: number, macroHeight: number, fineElevation: Float32Array, factor: number): Int32Array {
  const fineWidth = macroWidth * factor
  const fineHeight = macroHeight * factor
  const groupOfLabel = new Int32Array(65536).fill(-1)
  plan.groups.forEach((group, index) => { for (const label of group.catchments) groupOfLabel[label] = index })

  // Per macro cell, once — a fine cell's neighbours resolve to the same answer
  // as any other fine cell in the same macro cell, and the ring search is the
  // expensive part.
  const groupOfMacro = new Int32Array(macroWidth * macroHeight)
  for (let i = 0; i < groupOfMacro.length; i++) groupOfMacro[i] = groupOfLabel[plan.labels[i]]

  const owners = new Int32Array(fineWidth * fineHeight).fill(-1)
  const resolved = new Map<number, number>()
  for (let y = 0; y < fineHeight; y++) {
    const macroY = (y / factor) | 0
    for (let x = 0; x < fineWidth; x++) {
      const fine = y * fineWidth + x
      if (fineElevation[fine] <= SEA_LEVEL) continue
      const macro = macroY * macroWidth + ((x / factor) | 0)
      const direct = groupOfMacro[macro]
      if (direct >= 0) { owners[fine] = direct; continue }
      let nearest = resolved.get(macro)
      if (nearest === undefined) {
        nearest = nearestGroup(groupOfMacro, macroWidth, macroHeight, macro)
        resolved.set(macro, nearest)
      }
      owners[fine] = nearest
    }
  }
  return owners
}

// The nearest owning macro cell, in Chebyshev rings. Returns -1 only for a world
// where no macro cell is owned at all, which is a world with no land.
function nearestGroup(groupOfMacro: Int32Array, width: number, height: number, from: number): number {
  const x0 = from % width
  const y0 = (from - x0) / width
  const limit = Math.max(width, height)
  for (let radius = 1; radius <= limit; radius++) {
    let best = -1
    for (let dy = -radius; dy <= radius; dy++) {
      const onHorizontalEdge = dy === -radius || dy === radius
      for (let dx = -radius; dx <= radius; dx++) {
        // Only the ring, not the filled square — the inside was searched already.
        if (!onHorizontalEdge && dx !== -radius && dx !== radius) continue
        const group = groupOfMacro[(((y0 + dy) % height + height) % height) * width + (((x0 + dx) % width + width) % width)]
        if (group >= 0 && (best < 0 || group < best)) best = group
      }
    }
    if (best >= 0) return best
  }
  return -1
}

// The toroidal box each group occupies, in one pass over the raster.
//
// Per group a column and a row occupancy mask, then the smallest wrapping span
// covering the occupied ones. Group count is small (a budget divides the world
// into tens of jobs, not thousands), so the masks are cheap; doing this per
// LABEL instead is what would not be.
function groupBoxes(labels: Uint16Array, elevation: Float32Array, packed: number[][], width: number, height: number): TorusBox[] {
  const count = packed.length
  const groupOfLabel = new Int32Array(65536).fill(-1)
  packed.forEach((catchments, g) => { for (const label of catchments) groupOfLabel[label] = g })

  const cols = new Uint8Array(count * width)
  const rows = new Uint8Array(count * height)
  for (let y = 0; y < height; y++) {
    const base = y * width
    for (let x = 0; x < width; x++) {
      const cell = base + x
      if (elevation[cell] <= SEA_LEVEL) continue
      const g = groupOfLabel[labels[cell]]
      if (g < 0) continue
      cols[g * width + x] = 1
      rows[g * height + y] = 1
    }
  }

  const boxes: TorusBox[] = []
  for (let g = 0; g < count; g++) {
    const [x, w] = wrappingSpan(cols, g * width, width)
    const [y, h] = wrappingSpan(rows, g * height, height)
    boxes.push({ x, y, w, h })
  }
  return boxes
}

// The shortest wrapping interval covering every set slot: find the LARGEST run of
// unset slots (circularly) and take the complement. On a line one would take
// min..max; on a ring that is wrong for anything crossing the seam, and this is
// the same computation done right.
function wrappingSpan(mask: Uint8Array, offset: number, size: number): [start: number, length: number] {
  let occupied = 0
  for (let i = 0; i < size; i++) if (mask[offset + i]) occupied++
  if (occupied === 0) return [0, 0]
  if (occupied === size) return [0, size]

  let bestGap = 0
  let bestGapEnd = 0
  let run = 0
  // Two laps, so a gap straddling index 0 is seen whole.
  for (let i = 0; i < size * 2; i++) {
    if (mask[offset + (i % size)]) {
      run = 0
      continue
    }
    run++
    if (run > bestGap) { bestGap = run; bestGapEnd = (i + 1) % size }
  }
  return [bestGapEnd, size - bestGap]
}

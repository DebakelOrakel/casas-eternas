import type { FlowRouting } from './flowRouting'
import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { buildChannelMask, RIVER_MAX_WIDTH, RIVER_MIN_WIDTH, RIVER_REGIME_CODE } from './hydrology'
import type { RegimeInputs, RiverPolylines, WaterBody } from './hydrology'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { WORLD_WIDTH_METERS } from './erosionEngine'
import type { RiverCourse } from './riverCourse'

// THE FEATURE GRAPH — the erosion's output as data (ADAPTIVE_MESH_PLAN.md
// phase 2, decision 10 of adaptive-mesh.md). Rivers are REACHES between
// NODES: a reach is the run of channel cells from one node to the next along
// the single-flow receivers, with what a consumer wants to know about it —
// discharge in and out, width, length, slope, sediment load, bank material,
// Strahler order — and a node is where reaches begin, meet or end: a source,
// a junction, a mouth into the sea, an inlet into a lake, a lake's outlet.
// The standing-water bodies of phase 1 are members (a lake is what an inlet
// reach ends in and an outlet reach starts from), and every mouth's
// catchment is recorded, which is the divide as data: the cells of the
// world that drain to that mouth.
//
// Derived from the raster (the routing, the discharge, the water bodies)
// deterministically, so it lives in the artifact store keyed like a bake
// until the save IS the mesh (phase 4). The river ribbons the generator
// draws are DERIVED from it (riverPolylinesFromGraph) rather than traced
// from the D8 receivers a second time; where the graph agrees with the old
// tracing the picture is the same, and where the old tracing broke a line
// at an arbitrary trunk it now follows the main stem.
//
// One deliberate carry-over: a river still runs THROUGH a lake as a reach
// of kind 'lake' from the inlet to the outlet, so the picture keeps the
// continuous line the map reads (river → lake → river, 2026-08-06); a
// consumer that wants the network without the lakes skips that kind.

export type RiverNodeKind = 'source' | 'junction' | 'mouth' | 'inlet' | 'outlet'

export interface RiverNode {
  id: number
  kind: RiverNodeKind
  // The node's cell, and its centre in texel coordinates. A mouth or an
  // inlet sits ON the water cell the reach ends in; an outlet on the last
  // wet cell before the river leaves its lake.
  cell: number
  x: number
  y: number
  // The water body a mouth (-1: the sea), inlet or outlet belongs to.
  body: number
  // For a mouth: how many land cells drain to it (its catchment); 0 for
  // other kinds.
  catchmentCells: number
}

export type RiverReachKind = 'river' | 'lake'

export interface RiverReach {
  id: number
  kind: RiverReachKind
  from: number
  to: number
  // The reach's cells in flow order, from the `from` node's cell to the
  // `to` node's cell inclusive — stored concatenated in RiverGraph.cells.
  cellStart: number
  cellCount: number
  // Discharge (the hydrology's unit: mm/yr summed over contributing cells)
  // entering at the first cell and leaving at the last own cell.
  dischargeIn: number
  dischargeOut: number
  // Drawn width at the downstream end, the ribbon scale (RIVER_MIN_WIDTH..
  // RIVER_MAX_WIDTH, √ of relative discharge).
  widthPx: number
  lengthKm: number
  // Height lost along the reach, metres, and the mean slope (m/m).
  dropM: number
  slope: number
  // Sediment carried out of the reach's last cell, m³ per engine iteration
  // (the engine's ξ–q flux), 0 when the caller had none.
  sedimentM3: number
  // The most common biome id along the reach's own cells (the bank
  // material phase 3 reads as bank strength), -1 when the caller had none.
  bank: number
  // Strahler order.
  order: number
  // Flow regime from climate alone (F6; SURFACE_TUNING.regimeAridBelow and
  // regimeDrySeasonBelow): perennial when the caller had no regime inputs.
  regime: RiverRegime
}

export type RiverRegime = 'perennial' | 'intermittent' | 'ephemeral'

export interface RiverGraph {
  width: number
  height: number
  nodes: RiverNode[]
  reaches: RiverReach[]
  // Every reach's cells, concatenated in reach order (see RiverReach.cellStart).
  cells: Int32Array
  // The standing-water bodies the inlets and outlets refer to (phase 1).
  bodies: WaterBody[]
  // The course of every reach wide enough to show one (phase 3,
  // riverCourse.ts), in reach order; absent until computed.
  courses?: RiverCourse[]
}

export interface RiverGraphInputs {
  routing: FlowRouting
  discharge: Float32Array
  elevation: Float32Array
  // The channel criterion, as the hydrology derives it (channelThreshold).
  threshold: number
  maxDischarge: number
  bodies: WaterBody[]
  // Which body each cell lies in, -1 for none (hydrology.LakeFields.body /
  // waterLevelField): a channel cell under a body's level is a lake cell.
  body: Int32Array
  lakeDepth: Float32Array
  sedimentFlux?: Float32Array
  biomes?: Uint8Array
  // The catchment's potential evaporation and dry-season precipitation,
  // accumulated like the discharge (hydrology.accumulateRegimeInputs).
  regime?: RegimeInputs
  // The channel criterion's catchment, in cells (hydrology.densityToCriticalArea).
  // With `regime`, it admits WADIS: a cell with that much catchment but too
  // little runoff for a lasting channel, in an arid catchment, is a dry
  // valley — carved by the rain that does fall, dry between rains. Without
  // it the network is the discharge criterion's alone.
  criticalArea?: number
}

// The regime rule (the reasoning sits with the two constants): the whole
// catchment arid → ephemeral, the dry season alone too dry → intermittent.
// Not "under the channel threshold → ephemeral": the channel criterion
// admits steep cells below the discharge threshold (channelReferenceSlope),
// so nearly half the headwater reaches sit under it and are real streams —
// measured 2026-09-22, 427 of 1007 reaches on the golden calibration world.
// A wadi's reach is ephemeral because its catchment is arid, which is the
// condition that admitted it.
export function classifyRegime(discharge: number, loss: number, dry: number): RiverRegime {
  if (loss <= 0) return 'perennial'
  if (discharge / loss < SURFACE_TUNING.regimeAridBelow) return 'ephemeral'
  if (dry / loss < SURFACE_TUNING.regimeDrySeasonBelow) return 'intermittent'
  return 'perennial'
}

const SQRT2 = Math.SQRT2

function riverWidth(discharge: number, maxDischarge: number): number {
  const scale = maxDischarge > 0 ? maxDischarge : 1
  return Math.min(RIVER_MAX_WIDTH, RIVER_MIN_WIDTH + (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH) * Math.sqrt(discharge / scale))
}

// A step between two D8 neighbours on the torus: its length factor, or 0
// when the two are not neighbours (which only a seam step looks like to a
// naive difference — handled by wrapping).
function stepFactor(a: number, b: number, width: number, height: number): number {
  const ax = a % width
  const ay = (a - ax) / width
  const bx = b % width
  const by = (b - bx) / width
  let dx = Math.abs(bx - ax)
  if (dx > width / 2) dx = width - dx
  let dy = Math.abs(by - ay)
  if (dy > height / 2) dy = height - dy
  return dx && dy ? SQRT2 : 1
}

export function buildRiverGraph(input: RiverGraphInputs): RiverGraph {
  const { routing, discharge, elevation, threshold, maxDischarge, bodies, body, lakeDepth } = input
  const { width, height, flowTarget, popOrder, poppedCount } = routing
  const n = width * height
  const cellKm = WORLD_WIDTH_METERS / width / 1000
  const channel = buildChannelMask(routing, elevation, discharge, threshold)
  // Catchment sizes: land cells draining to each cell, all of them, not only
  // channels — popOrder backward puts every donor before its receiver.
  const area = new Int32Array(n)
  for (let c = 0; c < n; c++) if (elevation[c] > SEA_LEVEL) area[c] = 1
  for (let i = poppedCount - 1; i >= 0; i--) {
    const c = popOrder[i]
    const t = flowTarget[c]
    if (t >= 0 && elevation[c] > SEA_LEVEL) area[t] += area[c]
  }
  // Wadis (F6): catchment enough for a valley, runoff too little for a
  // channel, climate arid — a channel cell all the same, closed downstream
  // to the water like the discharge network (the reach it starts is
  // ephemeral by the rule, since its catchment is arid).
  // Measured 2026-09-22 on the golden world alpha: 1335 cells sit under
  // the threshold with a critical catchment, 135 of them in an arid
  // catchment — the rest are humid valleys below a world-mean-scaled
  // threshold, not dry valleys, and stay out.
  if (input.regime && input.criticalArea !== undefined) {
    const { loss } = input.regime
    for (let c = 0; c < n; c++) {
      if (channel[c] || elevation[c] <= SEA_LEVEL || area[c] < input.criticalArea) continue
      if (loss[c] > 0 && discharge[c] / loss[c] < SURFACE_TUNING.regimeAridBelow) channel[c] = 1
    }
    for (let i = poppedCount - 1; i >= 0; i--) {
      const c = popOrder[i]
      if (!channel[c]) continue
      const t = flowTarget[c]
      if (t >= 0 && elevation[t] > SEA_LEVEL) channel[t] = 1
    }
  }
  // A wet body cell: under a lake's or a terminal sea's level AND inside the
  // body's recovered extent — a cell wet by an epsilon of fill but outside
  // the extent (the flood's fill sits an epsilon chain above the pour point)
  // is river, not lake, so every inlet and outlet names a body.
  const isLake = (c: number): boolean => lakeDepth[c] > 0 && body[c] >= 0

  // In-degree among channel cells: sources have none, junctions two or more.
  const inDeg = new Uint8Array(n)
  for (let c = 0; c < n; c++) {
    if (!channel[c]) continue
    const t = flowTarget[c]
    if (t >= 0 && channel[t] && inDeg[t] < 255) inDeg[t]++
  }

  // Node cells. A channel cell is a node when it starts a channel, joins
  // two, or sits at a land/water transition; the water cell a reach flows
  // into is a node too (the mouth or inlet itself), so every mouth is IN
  // water by construction.
  const nodeAt = new Int32Array(n).fill(-1)
  const nodes: RiverNode[] = []
  const addNode = (cell: number, kind: RiverNodeKind, bodyId: number): number => {
    if (nodeAt[cell] >= 0) return nodeAt[cell]
    const x = cell % width
    const y = (cell - x) / width
    const id = nodes.length
    nodes.push({ id, kind, cell, x: x + 0.5, y: y + 0.5, body: bodyId, catchmentCells: kind === 'mouth' || kind === 'inlet' ? area[cell] : 0 })
    nodeAt[cell] = id
    return id
  }
  for (let c = 0; c < n; c++) {
    if (!channel[c]) continue
    const t = flowTarget[c]
    const lakeHere = isLake(c)
    if (inDeg[c] === 0 && !lakeHere) addNode(c, 'source', -1)
    else if (inDeg[c] >= 2) addNode(c, 'junction', lakeHere ? body[c] : -1)
    if (t < 0) {
      // A land sink with no receiver: the reach ends here, in the terrain.
      addNode(c, 'mouth', -1)
      continue
    }
    const lakeNext = isLake(t)
    if (!lakeHere && lakeNext) addNode(t, 'inlet', body[t])
    else if (lakeHere && !lakeNext && channel[t]) addNode(c, 'outlet', body[c])
    // Into the sea, or onto a dry basin's floor (a body without water):
    // the body raster says which, -1 for the open sea.
    else if (!channel[t] || elevation[t] <= SEA_LEVEL) addNode(t, 'mouth', body[t])
  }
  // A source that is itself a lake cell (a channel beginning inside a lake)
  // is that lake's outlet chain's start: record it as a source anyway, the
  // reach it starts is of kind 'lake' until it leaves the water.
  for (let c = 0; c < n; c++) {
    if (channel[c] && inDeg[c] === 0 && nodeAt[c] < 0) addNode(c, 'source', body[c])
  }

  // Reaches: from every node that has a channel receiver, walk to the next
  // node. Every channel cell belongs to exactly one reach (the walk stops
  // at nodes, and nodes are where in-degree or land/water changes).
  const reaches: RiverReach[] = []
  const cellsOut: number[] = []
  const sedimentFlux = input.sedimentFlux
  const biomes = input.biomes
  const regime = input.regime
  for (const node of nodes) {
    const start = node.cell
    if (!channel[start]) continue // a mouth or inlet on water: nothing starts there
    const t0 = flowTarget[start]
    if (t0 < 0 || !channel[t0]) {
      // A source that is also a mouth (a one-cell channel into water): the
      // reach is the single step onto the water cell.
      if (t0 < 0 || nodeAt[t0] < 0) continue
    }
    const cellStart = cellsOut.length
    cellsOut.push(start)
    let cur = start
    let lengthKm = 0
    let guard = 0
    for (;;) {
      const t = flowTarget[cur]
      if (t < 0) break
      lengthKm += stepFactor(cur, t, width, height) * cellKm
      cellsOut.push(t)
      cur = t
      if (nodeAt[t] >= 0) break
      if (++guard > n) throw new Error('river graph: a reach does not terminate')
    }
    const cellCount = cellsOut.length - cellStart
    if (cellCount < 2) {
      cellsOut.length = cellStart
      continue
    }
    const to = nodeAt[cur] >= 0 ? nodeAt[cur] : addNode(cur, 'mouth', -1)
    const lastOwn = cellsOut[cellsOut.length - 2]
    const dischargeIn = discharge[start]
    const dischargeOut = discharge[lastOwn]
    // Drop over the reach's OWN cells: a mouth's water cell is the sea floor
    // or a lake bed, not the river's bed.
    const dropM = elevationToMeters(elevation[start]) - elevationToMeters(elevation[lastOwn])
    let bank = -1
    if (biomes) {
      const counts = new Map<number, number>()
      let best = -1
      let bestCount = 0
      for (let k = cellStart; k < cellsOut.length - 1; k++) {
        const b = biomes[cellsOut[k]]
        const count = (counts.get(b) ?? 0) + 1
        counts.set(b, count)
        if (count > bestCount || (count === bestCount && b < best)) { bestCount = count; best = b }
      }
      bank = best
    }
    reaches.push({
      id: reaches.length,
      kind: isLake(start) ? 'lake' : 'river',
      from: node.id,
      to,
      cellStart,
      cellCount,
      dischargeIn,
      dischargeOut,
      widthPx: riverWidth(dischargeOut, maxDischarge),
      lengthKm,
      dropM,
      slope: lengthKm > 0 ? dropM / (lengthKm * 1000) : 0,
      sedimentM3: sedimentFlux ? sedimentFlux[lastOwn] : 0,
      bank,
      order: 0,
      regime: regime ? classifyRegime(dischargeOut, regime.loss[lastOwn], regime.dry[lastOwn]) : 'perennial',
    })
  }

  // Strahler order, tributaries before the reach they feed (Kahn's order
  // over the reach DAG — iterative, since a long river is thousands of
  // reaches deep): a reach's order is its tributaries' max, plus one when
  // two or more share it; a reach with no tributary is order 1.
  const startingAt = new Int32Array(nodes.length).fill(-1)
  const pending = new Int32Array(reaches.length)
  const best = new Int32Array(reaches.length)
  const bestCount = new Int32Array(reaches.length)
  for (const r of reaches) startingAt[r.from] = r.id
  for (const r of reaches) {
    const next = startingAt[r.to]
    if (next >= 0) pending[next]++
  }
  const queue: number[] = []
  for (const r of reaches) if (pending[r.id] === 0) queue.push(r.id)
  for (let head = 0; head < queue.length; head++) {
    const r = reaches[queue[head]]
    r.order = best[r.id] === 0 ? 1 : bestCount[r.id] >= 2 ? best[r.id] + 1 : best[r.id]
    const next = startingAt[r.to]
    if (next < 0) continue
    if (r.order > best[next]) { best[next] = r.order; bestCount[next] = 1 }
    else if (r.order === best[next]) bestCount[next]++
    if (--pending[next] === 0) queue.push(next)
  }

  return { width, height, nodes, reaches, cells: Int32Array.from(cellsOut), bodies: bodies.slice() }
}

// Seam test for consecutive line points: a jump of more than half the
// raster is the torus seam, whatever the point spacing.
function seamStep(ax: number, ay: number, bx: number, by: number, width: number, height: number): boolean {
  return Math.abs(bx - ax) > width / 2 || Math.abs(by - ay) > height / 2
}

// The ribbons the map draws, from the graph: chains of reaches along the
// main stem (at a junction the tributary with the larger discharge
// continues the line, the others end there with the junction point so the
// branch joins visually), split where a chain steps across the torus seam
// (the ribbon overlay never crosses it). Widths run linearly from a reach's
// in to its out discharge, so the line thickens along the reach as the old
// per-cell tracing did in steps.
export function riverPolylinesFromGraph(graph: RiverGraph, maxDischarge: number): RiverPolylines {
  const { width, height, nodes, reaches, cells } = graph
  const points: number[] = []
  const lengths: number[] = []
  const regimes: number[] = []
  // The regime of the line being emitted; a chain is cut where it changes,
  // so every polyline carries one.
  let regime: number = RIVER_REGIME_CODE.perennial
  // A reach with a course draws its course instead of its cell path: the
  // first line continues the chain, the other lines (sub-channels,
  // distributaries) and the oxbows are their own polylines.
  const courseOf = new Map<number, RiverCourse>()
  for (const c of graph.courses ?? []) courseOf.set(c.reach, c)
  // Which reach continues each node's line: the largest incoming reach.
  const continues = new Int32Array(nodes.length).fill(-1)
  const largestIn = new Float64Array(nodes.length).fill(-1)
  const outOf = new Int32Array(nodes.length).fill(-1)
  for (const r of reaches) {
    if (outOf[r.from] < 0) outOf[r.from] = r.id
    if (r.dischargeOut > largestIn[r.to]) {
      largestIn[r.to] = r.dischargeOut
      continues[r.to] = r.id
    }
  }
  const drawn = new Uint8Array(reaches.length)
  let len = 0
  const flush = (): void => {
    if (len >= 2) {
      lengths.push(len)
      regimes.push(regime)
    } else points.length -= len * 3
    len = 0
  }
  let prevX = -1
  let prevY = -1
  const emitXY = (x: number, y: number, w: number): void => {
    if (prevX >= 0 && seamStep(prevX, prevY, x, y, width, height)) flush()
    points.push(x, y, w)
    prevX = x
    prevY = y
    len++
  }
  const emitLine = (line: Float32Array, wIn: number, wOut: number): void => {
    const count = line.length / 2
    for (let k = 0; k < count; k++) {
      const t = count > 1 ? k / (count - 1) : 1
      emitXY(line[k * 2], line[k * 2 + 1], wIn + (wOut - wIn) * t)
    }
  }
  const extras: { line: Float32Array; w: number; regime: number }[] = []
  for (const head of reaches) {
    if (drawn[head.id]) continue
    // Only start a line at a reach nothing continues INTO — the others are
    // reached by following a stem down.
    if (continues[head.from] >= 0 && !drawn[continues[head.from]]) continue
    let r: RiverReach | null = head
    let prevCell = -1
    prevX = -1
    prevY = -1
    while (r && !drawn[r.id]) {
      drawn[r.id] = 1
      const code = RIVER_REGIME_CODE[r.regime]
      if (code !== regime) {
        // A new line from the shared node cell, so the two regimes meet.
        flush()
        prevCell = -1
        regime = code
      }
      const wIn = riverWidth(r.dischargeIn, maxDischarge)
      const wOut = riverWidth(r.dischargeOut, maxDischarge)
      const course = courseOf.get(r.id)
      if (course && course.lines.length > 0) {
        emitLine(course.lines[0], wIn * course.lineWidth[0], wOut * course.lineWidth[0])
        for (let i = 1; i < course.lines.length; i++) extras.push({ line: course.lines[i], w: riverWidth(r.dischargeOut * course.lineWidth[i] * course.lineWidth[i], maxDischarge), regime: code })
        for (const o of course.oxbows) extras.push({ line: o, w: RIVER_MIN_WIDTH, regime: code })
        prevCell = cells[r.cellStart + r.cellCount - 1]
      } else {
        for (let k = 0; k < r.cellCount; k++) {
          const cell = cells[r.cellStart + k]
          if (prevCell === cell) continue // the node cell shared with the previous reach
          const cx = (cell % width) + 0.5
          const cy = Math.floor(cell / width) + 0.5
          const t = r.cellCount > 1 ? k / (r.cellCount - 1) : 1
          emitXY(cx, cy, wIn + (wOut - wIn) * t)
          prevCell = cell
        }
      }
      // Continue only if this reach is the main stem into its end node.
      const next: number = continues[r.to] === r.id ? outOf[r.to] : -1
      r = next >= 0 ? reaches[next] : null
    }
    flush()
    prevCell = -1
  }
  for (const extra of extras) {
    prevX = -1
    prevY = -1
    regime = extra.regime
    emitLine(extra.line, extra.w, extra.w)
    flush()
  }
  return { points: Float32Array.from(points), lengths: Uint32Array.from(lengths), regimes: Uint8Array.from(regimes) }
}

// The graph's serialised form: one JSON document for everything but the
// cell runs, which travel as raw Int32 bytes (a baked world's reaches run to
// millions of cells; JSON would be an order of magnitude larger).
export interface SerializedRiverGraph {
  json: string
  cells: Int32Array
  // Every course line and oxbow, concatenated [x, y, …]; the JSON's courses
  // carry (start, count) descriptors into it. Empty without courses.
  coursePoints: Float32Array
}

// A course as it sits in the JSON: the lines and oxbows replaced by
// descriptors into coursePoints.
type SerializedCourse = Omit<RiverCourse, 'lines' | 'oxbows'> & { lines: [number, number][]; oxbows: [number, number][] }

export function serializeRiverGraph(graph: RiverGraph): SerializedRiverGraph {
  const { cells, courses, ...rest } = graph
  const chunks: Float32Array[] = []
  let offset = 0
  const describe = (line: Float32Array): [number, number] => {
    const d: [number, number] = [offset, line.length / 2]
    chunks.push(line)
    offset += line.length / 2
    return d
  }
  const serialCourses: SerializedCourse[] | undefined = courses?.map((c) => ({ ...c, lines: c.lines.map(describe), oxbows: c.oxbows.map(describe) }))
  const coursePoints = new Float32Array(offset * 2)
  let at = 0
  for (const chunk of chunks) {
    coursePoints.set(chunk, at)
    at += chunk.length
  }
  return { json: JSON.stringify(serialCourses ? { ...rest, courses: serialCourses } : rest), cells, coursePoints }
}

export function deserializeRiverGraph(json: string, cells: Int32Array, coursePoints: Float32Array = new Float32Array(0)): RiverGraph | null {
  try {
    const parsed = JSON.parse(json) as Omit<RiverGraph, 'cells' | 'courses'> & { courses?: SerializedCourse[] }
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.reaches) || !Array.isArray(parsed.bodies)) return null
    const slice = ([start, count]: [number, number]): Float32Array => coursePoints.slice(start * 2, (start + count) * 2)
    const courses = parsed.courses?.map((c) => ({ ...c, lines: c.lines.map(slice), oxbows: c.oxbows.map(slice) }))
    const { courses: _dropped, ...rest } = parsed
    // A graph written before F6 carries no regime: perennial, as the
    // builder without regime inputs says.
    for (const r of rest.reaches) if (r.regime === undefined) r.regime = 'perennial'
    return courses ? { ...rest, cells, courses } : { ...rest, cells }
  } catch {
    return null
  }
}

// The invariants every graph must hold — the harness layer of phase 2.
// Each entry is a check name and the number of violations; a consumer
// asserts they are all zero.
export function riverGraphInvariants(graph: RiverGraph, elevation: Float32Array): Record<string, number> {
  const { nodes, reaches, cells, bodies } = graph
  const out: Record<string, number> = { acyclic: 0, dischargeMonotone: 0, mouthsInWater: 0, reachesTerminate: 0, bodiesKnown: 0, cellsContiguous: 0, regimeKnown: 0 }
  for (const r of reaches) if (!(r.regime in RIVER_REGIME_CODE)) out.regimeKnown++
  const outOf = new Map<number, number[]>()
  for (const r of reaches) {
    const list = outOf.get(r.from)
    if (list) list.push(r.id)
    else outOf.set(r.from, [r.id])
  }
  // Acyclic: following any reach's `to` node onward returns to no reach twice.
  for (const r of reaches) {
    const seen = new Set<number>([r.id])
    let cur = r
    let steps = 0
    for (;;) {
      const next = outOf.get(cur.to)
      if (!next || next.length === 0) break
      const n2 = reaches[next[0]]
      if (seen.has(n2.id)) { out.acyclic++; break }
      seen.add(n2.id)
      cur = n2
      if (++steps > reaches.length) { out.reachesTerminate++; break }
    }
  }
  // Discharge monotone: what leaves a reach is at least what entered it,
  // and what enters the downstream reach is at least what any tributary
  // brought.
  for (const r of reaches) {
    if (r.dischargeOut + 1e-6 < r.dischargeIn) out.dischargeMonotone++
    const next = outOf.get(r.to)
    if (next && next.length > 0 && reaches[next[0]].dischargeIn + 1e-6 < r.dischargeOut) out.dischargeMonotone++
  }
  // Every mouth and inlet sits in water (sea level or a body's wet cell).
  for (const node of nodes) {
    if (node.kind === 'mouth' && node.body === -1 && elevation[node.cell] > SEA_LEVEL) {
      // A land sink is a mouth into the terrain — allowed only when no
      // reach leaves it (the flood found no way out).
      if ((outOf.get(node.id) ?? []).length > 0) out.mouthsInWater++
    }
    if ((node.kind === 'inlet' || node.kind === 'outlet') && (node.body < 0 || node.body >= bodies.length)) out.bodiesKnown++
  }
  // Cell runs are contiguous and cover the reach.
  let expected = 0
  for (const r of reaches) {
    if (r.cellStart !== expected || r.cellCount < 2) out.cellsContiguous++
    expected = r.cellStart + r.cellCount
  }
  if (expected !== cells.length) out.cellsContiguous++
  return out
}

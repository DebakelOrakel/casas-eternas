import type { PeopleResult } from './people'

// THE INCUBATOR'S PEOPLE ROUTES (2026-10-25, a trial): the people's spread
// drawn as its rough directions (IncubatorScreen's people step).
//
// THE TREE (2026-10-26, after the generator's migration arrows,
// GeneratorScreen drawMigrationArrows): the routes' tree (people.ts, `from`
// and `flow`) cut at ROUTE_SHARE of all the land reached (0.005 at first: too dense with
// the wider spread), split into
// lines: a line runs from the origin or a parting to the next parting or
// an end. A line's width at a cell follows the people living beyond it at
// the time shown (flowAt), the trunk broad, the branches thinning toward
// the front. Drawn as continuous lines (incubatorSymbols.ts, routeSymbols),
// blue over the crossings the chronicle tells.
const ROUTE_SHARE = 0.01
// A line that ends (no parting after it) shorter than this many cells is
// left out: a stub.
const ROUTE_MIN_CELLS = 8
// A crossing's landing whose flow is LANDING_SHARE of all the land reached
// or more keeps its branch, back to the origin, under ROUTE_SHARE too: a
// land reached over the sea was drawn without a way to it while its branch
// was thin (2026-10-26). At first 30 cells, absolute: with the wider
// spread 109 landings on Morvane kept their branch, 190 lines in all.
const LANDING_SHARE = 0.003
// A branch begins this many cells back on the line it parts from, so that
// smoothed it leaves that line along it, not at an angle; the cells it
// shares lie under that line. Without it a branch bent at the parting
// (2026-10-26).
const ROUTE_LEAD_CELLS = 10

// A line's cells, in order from its first, the lead on the line it parts
// from included: `cells[lead]` is the parting (or the origin).
export interface RouteLine {
  cells: number[]
  lead: number
}

export function routesOf(people: PeopleResult): RouteLine[] {
  const { from, flow, origin } = people
  if (origin < 0) return []
  const least = Math.max(1, ROUTE_SHARE * flow[origin])
  const kept = new Uint8Array(from.length)
  for (let k = 0; k < people.crossings.length; k += 4) {
    const landed = people.crossings[k + 1]
    if (flow[landed] < LANDING_SHARE * flow[origin]) continue
    for (let c = landed; c >= 0 && !kept[c]; c = from[c]) kept[c] = 1
  }
  const children = new Map<number, number[]>()
  for (let c = 0; c < from.length; c++) {
    if (from[c] < 0 || (flow[c] < least && !kept[c])) continue
    const list = children.get(from[c])
    if (list) list.push(c)
    else children.set(from[c], [c])
  }
  const lines: RouteLine[] = []
  // [the line's first cell, its second].
  const stack: [number, number][] = (children.get(origin) ?? []).map((c) => [origin, c])
  while (stack.length > 0) {
    const [root, start] = stack.pop()!
    const line = [root, start]
    let lead = 0
    for (let back = from[root]; back >= 0 && lead < ROUTE_LEAD_CELLS; back = from[back], lead++) line.unshift(back)
    let c = start
    for (;;) {
      const next = children.get(c) ?? []
      if (next.length !== 1) {
        for (const k of next) stack.push([c, k])
        break
      }
      c = next[0]
      line.push(c)
    }
    if (line.length - lead >= ROUTE_MIN_CELLS || (children.get(c)?.length ?? 0) > 1) lines.push({ cells: line, lead })
  }
  return lines
}

// The cells people reached, the latest first: the order flowAt sums in.
export function routeOrder(people: PeopleResult): Int32Array {
  const cells: number[] = []
  for (let i = 0; i < people.arrival.length; i++) if (people.arrival[i] < Infinity) cells.push(i)
  return Int32Array.from(cells.sort((a, b) => people.arrival[b] - people.arrival[a]))
}

// Per cell, the sum of `weight` over it and every cell reached through it,
// as far as people came by `t`.
export function flowAt(people: PeopleResult, order: Int32Array, t: number, weight: (cell: number) => number): Float64Array {
  const sum = new Float64Array(people.arrival.length)
  for (const i of order) {
    if (!(people.arrival[i] <= t)) continue
    sum[i] += weight(i)
    if (people.from[i] >= 0) sum[people.from[i]] += sum[i]
  }
  return sum
}

import { Biome } from '../../generator/climate/biomes'
import { MinHeap } from '../../generator/core/minHeap'
import { mulberry32, type Habitat } from './habitat'
import type { PeopleResult } from './people'
import { SPAN_YEARS } from './peopleShared'

// THE INCUBATOR'S SIMULATION, its skeleton (2026-10-26, DES-0033 step 2):
// the people, one lifeway, over SPAN_YEARS in steps of STEP_YEARS, on the
// habitat's cells. Functions over typed arrays, no DOM, no screen state:
// to be ported to the engine later. Seeded, not yet bit-equal across
// builds.
//
// A STEP:
// 1. GROWTH: each cell's people toward what the land carries (its carrying
//    capacity, CARRYING_FULL at FORAGER_DENSITY a km², to twice), by
//    GROWTH_A a year, logistic.
// 2. SETTLING, SUB_STEPS times: a cell at SEED_SHARE of what it carries or
//    more settles each empty neighbour with a chance — its speed there
//    (as people.ts's front: SPEED_MIN_KM_A to SPEED_MAX_KM_A by the carrying
//    capacity, slower up a slope, CORRIDOR times faster along a river or a
//    coast) times the sub-step's years over the way's km — and gives it
//    SEED_PEOPLE of its own. Ice is not settled. Cellular, not a
//    diffusion: a diffusion on cells of 10 km is stable only in steps of
//    some 2 years, 50 000 of them.
// 3. THE SEA: the shelf to SHELF_M is land until BRIDGE_UNTIL (the sea
//    stands low); over open water the crossings (crossingsOf, made once):
//    from a settled coast cell to the nearest coast of another landmass,
//    once the reach of the time is as far, with CROSSING_CHANCE a step.
//
// THE RESULT: the spread as people.ts gives it (PeopleResult: when people
// came, from which cell, the routes' weights, the crossings and their
// ways), so that everything after it — the settlement, the chronicle —
// reads the simulation as it read the rules; and the people a km² every
// KEEP_YEARS, kept to play back.

export const STEP_YEARS = 25
export const KEEP_YEARS = 2500
const SUB_STEPS = 3
const FORAGER_DENSITY = 0.1
const CARRYING_FULL = 0.8
const GROWTH_A = 0.01
const SEED_SHARE = 0.5
const SEED_PEOPLE = 0.2
const FULL_SHARE = 0.99
const SPEED_MIN_KM_A = 0.05
const SPEED_MAX_KM_A = 0.5
const SLOPE_DRAG = 10
const CORRIDOR = 2
const SHELF_M = 120
// The sea stands low until 10 000 years before the game.
const BRIDGE_UNTIL = SPAN_YEARS - 10_000
// The reach over open water grows evenly from REACH_START to REACH_END km
// over the span; a crossing within it is tried with CROSSING_CHANCE a step.
const REACH_START = 30
const REACH_END = 450
const CROSSING_CHANCE = 0.02

export interface SimulationInput {
  carrying: Float32Array
  origin: number
  seed: number
}

export interface SimulationResult {
  people: PeopleResult
  // The people a km² at every KEEP_YEARS from 0, one array each.
  kept: Float32Array[]
  ms: number
}

// A crossing over open water: from a coast cell to another landmass's
// nearest coast, km of sea between.
interface Crossing {
  from: number
  to: number
  km: number
}

// The crossings, once: from every coast cell over the deep sea (the shelf
// is walked) a multi-source Dijkstra labelled by its landmass; where two
// labels meet, the way between their two coasts. The shortest for each
// pair of landmasses, both ways.
function crossingsOf(h: Habitat, maxKm: number): Crossing[] {
  const n = h.count
  const dist = new Float64Array(n).fill(Infinity)
  const source = new Int32Array(n).fill(-1)
  const heap = new MinHeap(1 << 16)
  for (let i = 0; i < n; i++) {
    if (!h.land[i]) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      if (h.land[h.nbr[e]]) continue
      dist[i] = 0
      source[i] = i
      heap.push(0, i)
      break
    }
  }
  const best = new Map<string, Crossing>()
  const meet = (a: number, b: number, km: number): void => {
    const ma = h.landmass[source[a]]
    const mb = h.landmass[source[b]]
    if (ma === mb || km > maxKm) return
    for (const [from, to] of [[source[a], source[b]], [source[b], source[a]]]) {
      const key = `${h.landmass[from]},${h.landmass[to]}`
      const known = best.get(key)
      if (!known || km < known.km) best.set(key, { from, to, km })
    }
  }
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const d = heap.poppedKey
    if (d > dist[i]) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      if (h.land[u]) {
        if (source[u] >= 0 && source[u] !== source[i]) meet(i, u, d + h.distKm[e])
        continue
      }
      const nd = d + h.distKm[e]
      if (source[u] >= 0 && h.landmass[source[u]] !== h.landmass[source[i]]) meet(i, u, nd + dist[u])
      if (nd >= dist[u] || nd > maxKm) continue
      dist[u] = nd
      source[u] = source[i]
      heap.push(nd, u)
    }
  }
  return [...best.values()]
}

export function simulate(h: Habitat, input: SimulationInput, onProgress?: (share: number) => void): SimulationResult {
  const started = performance.now()
  const n = h.count
  const random = mulberry32(input.seed ^ 0x51a7)
  const { land, biome, slope, nearRiver, nearSea, seaDepthM } = h
  // What each cell carries, a km²; 0 where people do not live.
  const capacity = new Float32Array(n)
  const speed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || biome[i] === Biome.Ice || biome[i] === Biome.Glacier) continue
    const k = Math.min(2, input.carrying[i] / CARRYING_FULL)
    capacity[i] = FORAGER_DENSITY * Math.max(0.05, k)
    let v = SPEED_MIN_KM_A + (SPEED_MAX_KM_A - SPEED_MIN_KM_A) * Math.min(1, k)
    v /= 1 + slope[i] * SLOPE_DRAG
    if (nearRiver[i] || nearSea[i]) v *= CORRIDOR
    speed[i] = v
  }
  // The shelf, walked while the sea stands low, carries as little as the
  // poorest land and is crossed at the slowest.
  const shelf = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (land[i] || seaDepthM[i] > SHELF_M) continue
    shelf[i] = 1
    capacity[i] = FORAGER_DENSITY * 0.05
    speed[i] = SPEED_MIN_KM_A * CORRIDOR
  }
  const crossings = crossingsOf(h, REACH_END)
  const crossingsFrom = new Map<number, Crossing[]>()
  for (const c of crossings) {
    const list = crossingsFrom.get(c.from)
    if (list) list.push(c)
    else crossingsFrom.set(c.from, [c])
  }

  const people = new Float32Array(n)
  const arrival = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  // [landmass, cell landed on, time, km] and [from, to, -1] each crossing
  // made (PeopleResult's crossings and crossingWays).
  const made: number[] = []
  const ways: number[] = []
  const kept: Float32Array[] = []
  // A step touches two lists alone: the cells still growing (until within
  // FULL_SHARE of what they carry), and the front — settled cells with an
  // empty neighbour people could settle. Over all the settled cells a run
  // took 40 s on Morvane.
  let growing: number[] = []
  let front: number[] = []
  const settle = (cell: number, t: number, density: number, parent: number): void => {
    people[cell] = density
    arrival[cell] = t
    from[cell] = parent
    growing.push(cell)
    front.push(cell)
  }
  const open = (u: number, bridges: boolean): boolean => arrival[u] === Infinity && capacity[u] > 0 && (!shelf[u] || bridges)
  if (input.origin >= 0) settle(input.origin, 0, capacity[input.origin] * SEED_SHARE, -1)

  const steps = Math.round(SPAN_YEARS / STEP_YEARS)
  const subYears = STEP_YEARS / SUB_STEPS
  for (let s = 0; s <= steps; s++) {
    const t = s * STEP_YEARS
    if (t % KEEP_YEARS === 0) kept.push(people.slice())
    if (s === steps) break
    const bridges = t < BRIDGE_UNTIL
    // 1. Growth; a cell near what it carries leaves the list.
    const grow = 1 - Math.exp(-GROWTH_A * STEP_YEARS)
    const stillGrowing: number[] = []
    for (const i of growing) {
      const k = capacity[i]
      if (shelf[i] && !bridges) continue
      people[i] += (k - people[i]) * grow
      if (people[i] < FULL_SHARE * k) stillGrowing.push(i)
    }
    growing = stillGrowing
    // 2. Settling, over SUB_STEPS passes; the newly settled join the next.
    // A front cell with no open neighbour left leaves the list (the shelf
    // only closes, at BRIDGE_UNTIL: it never reopens one).
    for (let pass = 0; pass < SUB_STEPS; pass++) {
      const at = t + (pass + 1) * subYears
      const count = front.length
      const stillFront: number[] = []
      for (let k = 0; k < count; k++) {
        const i = front[k]
        if (shelf[i] && !bridges) continue
        let openLeft = false
        for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
          const u = h.nbr[e]
          if (!open(u, bridges)) continue
          openLeft = true
          if (people[i] < SEED_SHARE * capacity[i]) continue
          const chance = Math.min(1, (speed[u] * subYears) / h.distKm[e])
          if (random() < chance) settle(u, at, capacity[u] * SEED_PEOPLE, i)
        }
        if (openLeft) stillFront.push(i)
      }
      // The newly settled, pushed onto `front` by settle, follow.
      for (let k = count; k < front.length; k++) stillFront.push(front[k])
      front = stillFront
    }
    // 3. The crossings within the time's reach.
    const reach = REACH_START + (REACH_END - REACH_START) * (t / SPAN_YEARS)
    for (const [from, list] of crossingsFrom) {
      if (people[from] < SEED_SHARE * capacity[from]) continue
      for (const c of list) {
        if (c.km > reach || arrival[c.to] < Infinity || capacity[c.to] <= 0) continue
        if (random() < CROSSING_CHANCE) {
          settle(c.to, t + STEP_YEARS, capacity[c.to] * SEED_PEOPLE, c.from)
          made.push(h.landmass[c.to], c.to, t + STEP_YEARS, c.km)
          ways.push(c.from, c.to, -1)
        }
      }
    }
    if (onProgress && s % 100 === 0) onProgress(s / steps)
  }
  // The routes' weights: each land cell reached counts once on its way
  // back, the latest first.
  const flow = new Float32Array(n)
  const order: number[] = []
  for (let i = 0; i < n; i++) if (arrival[i] < Infinity) order.push(i)
  order.sort((a, b) => arrival[b] - arrival[a])
  for (const i of order) {
    if (land[i]) flow[i] += 1
    if (from[i] >= 0) flow[from[i]] += flow[i]
  }
  return {
    people: { arrival, land, from, flow, origin: input.origin, crossings: Float32Array.from(made), crossingWays: Int32Array.from(ways) },
    kept,
    ms: Math.round(performance.now() - started),
  }
}

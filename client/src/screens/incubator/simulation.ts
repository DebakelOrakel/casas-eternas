import { Biome } from '../../generator/climate/biomes'
import { MinHeap } from '../../generator/core/minHeap'
import { mulberry32, type Habitat } from './habitat'
import type { PeopleResult } from './people'
import { SPAN_YEARS } from './peopleShared'
import { climateHistoryOf, coldShare, iceMayCover, ICE_REACH_KM } from './climateHistory'

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
// 0. THE CLIMATE (climateHistory.ts, 2026-10-26), every CLIMATE_YEARS: the
//    cold lowers what the land carries and closes the tundra and the
//    subarctic under the ice; the sea's drop lays the shelf to it dry, to
//    SHELF_M. A cell that carries nothing any more is left; one that
//    carries again may be settled again.
// 3. THE SEA: over open water the crossings (crossingsOf, made once):
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
// The climate moves the cells' carrying and the sea every CLIMATE_YEARS.
const CLIMATE_YEARS = 500
// THE KNOWLEDGE (2026-10-26, DES-0033 "Progression"), a region's (the
// habitable land's connected parts), every CLIMATE_YEARS: it moves toward
// KNOW_SCALE × log10(1 + its people / KNOW_PEOPLE) — more people keep more
// — by KNOW_GAIN of the way up, KNOW_LOSS of the way down (a small,
// isolated group loses some: Henrich's cumulative culture). People who
// cross bring KNOW_CARRIED of theirs. The boats' reach over open water is
// a region's: REACH_START + REACH_PER_KNOW × its knowledge, REACH_END at
// most — no longer the time's (it grew evenly from 30 to 450 km over the
// span, and reached 98.5 % of Morvane's land, its far islands too). A
// crossing within it is tried with CROSSING_CHANCE a step.
const KNOW_SCALE = 1
const KNOW_PEOPLE = 10_000
const KNOW_GAIN = 0.1
const KNOW_LOSS = 0.02
const KNOW_CARRIED = 0.8
const REACH_START = 30
const REACH_PER_KNOW = 150
const REACH_END = 450
const CROSSING_CHANCE = 0.02
const CROSSINGS_A_PAIR = 32
const VOYAGE_KM = 3000

export interface SimulationInput {
  carrying: Float32Array
  origin: number
  seed: number
}

export interface SimulationResult {
  people: PeopleResult
  // The people a km² at every KEEP_YEARS from 0, one array each.
  kept: Float32Array[]
  // The climate history's draw (climateHistory.ts).
  climate: { maxAt: number; depth: number; deglaciation: number }
  // The regions (the habitable land's connected parts) and their knowledge
  // at the end, for a readout.
  region: Int32Array
  knowledge: Float32Array
  ms: number
}

// A crossing over open water: from a coast cell to another landmass's
// nearest coast, km of sea between.
interface Crossing {
  from: number
  to: number
  km: number
}

// The regions: the habitable land's connected parts, an id a cell (-1
// elsewhere), and how many.
function regionsOf(h: Habitat, habitable: (i: number) => boolean): { region: Int32Array; regions: number } {
  const n = h.count
  const region = new Int32Array(n).fill(-1)
  let regions = 0
  const stack: number[] = []
  for (let s0 = 0; s0 < n; s0++) {
    if (!h.land[s0] || !habitable(s0) || region[s0] >= 0) continue
    region[s0] = regions
    stack.push(s0)
    while (stack.length > 0) {
      const c = stack.pop()!
      for (let e = h.nbrStart[c]; e < h.nbrStart[c + 1]; e++) {
        const u = h.nbr[e]
        if (!h.land[u] || !habitable(u) || region[u] >= 0) continue
        region[u] = regions
        stack.push(u)
      }
    }
    regions++
  }
  return { region, regions }
}

// The crossings, once: from every coast cell people can live on today
// (`habitable`) over the sea, a multi-source Dijkstra on the voyage's
// length, labelled by its REGION — the land people can live on, connected
// (a landmass the ice cuts into parts is several; by landmass, a landing
// reached one part and its people stayed there); where two labels meet,
// the way between
// their two coasts. A crossing needs as much reach as its longest stretch
// of OPEN water: a sea cell beside land (any land, ice too) ends a stretch
// — boats keep to the coast, past the ice (the "kelp highway" of the
// Americas' first people). A voyage is VOYAGE_KM long at most. For each
// coast cell its shortest to each other region; of those the
// CROSSINGS_A_PAIR needing the least reach a pair of regions, both ways.
// `region`: regionsOf's.
// Before (2026-10-26): the single shortest a pair, every sea km counted,
// left Morvane's first continent 258 km of open water from any other coast
// people can live on; and a coast of ice was a landing, where people
// stood on a strip before a glacier (the first skeleton even let such a
// landing, with no people, settle the land beyond: its 82 % were that).
function crossingsOf(h: Habitat, maxKm: number, habitable: (i: number) => boolean, region: Int32Array): Crossing[] {
  const n = h.count
  const voyage = new Float64Array(n).fill(Infinity)
  // The open stretch at a cell and the longest on the way to it.
  const stretch = new Float32Array(n)
  const longest = new Float32Array(n)
  const source = new Int32Array(n).fill(-1)
  const heap = new MinHeap(1 << 16)
  const coastal = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (h.land[i]) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1] && !coastal[i]; e++) if (h.land[h.nbr[e]]) coastal[i] = 1
  }
  for (let i = 0; i < n; i++) {
    if (!h.land[i] || !habitable(i)) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      if (h.land[h.nbr[e]]) continue
      voyage[i] = 0
      source[i] = i
      heap.push(0, i)
      break
    }
  }
  // The least reach from each coast cell to each other landmass.
  const best = new Map<string, Crossing>()
  const meet = (a: number, b: number): void => {
    const ma = region[source[a]]
    const mb = region[source[b]]
    const km = Math.max(longest[a], longest[b])
    if (ma === mb || km > maxKm) return
    for (const [from, to] of [[source[a], source[b]], [source[b], source[a]]]) {
      const key = `${from},${region[to]}`
      const known = best.get(key)
      if (!known || km < known.km) best.set(key, { from, to, km })
    }
  }
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const d = heap.poppedKey
    if (d > voyage[i]) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      if (h.land[u]) {
        if (source[u] >= 0 && source[u] !== source[i]) meet(i, u)
        continue
      }
      if (source[u] >= 0 && region[source[u]] !== region[source[i]]) meet(i, u)
      const nd = d + h.distKm[e]
      const open = coastal[u] ? 0 : stretch[i] + h.distKm[e]
      const most = Math.max(longest[i], open)
      if (nd >= voyage[u] || nd > VOYAGE_KM || most > maxKm) continue
      voyage[u] = nd
      stretch[u] = open
      longest[u] = most
      source[u] = source[i]
      heap.push(nd, u)
    }
  }
  const byPair = new Map<string, Crossing[]>()
  for (const c of best.values()) {
    const key = `${region[c.from]},${region[c.to]}`
    const list = byPair.get(key)
    if (list) list.push(c)
    else byPair.set(key, [c])
  }
  return [...byPair.values()].flatMap((list) => list.sort((a, b) => a.km - b.km).slice(0, CROSSINGS_A_PAIR))
}

export function simulate(h: Habitat, input: SimulationInput, onProgress?: (share: number) => void): SimulationResult {
  const started = performance.now()
  const n = h.count
  const random = mulberry32(input.seed ^ 0x51a7)
  const { land, biome, koppen, slope, nearRiver, nearSea, seaDepthM } = h
  const climate = climateHistoryOf(input.seed, SPAN_YEARS)
  // What each cell carries today, a km² (0 where people do not live), and
  // the front's speed through it.
  const base = new Float32Array(n)
  const speed = new Float32Array(n)
  // The shelf: sea cells the low sea may lay dry.
  const shelf = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      if (seaDepthM[i] > SHELF_M) continue
      // Walked while dry, carrying as little as the poorest land, crossed at
      // the slowest.
      shelf[i] = 1
      base[i] = FORAGER_DENSITY * 0.05
      speed[i] = SPEED_MIN_KM_A * CORRIDOR
      continue
    }
    if (biome[i] === Biome.Ice || biome[i] === Biome.Glacier) continue
    const k = Math.min(2, input.carrying[i] / CARRYING_FULL)
    base[i] = FORAGER_DENSITY * Math.max(0.05, k)
    let v = SPEED_MIN_KM_A + (SPEED_MAX_KM_A - SPEED_MIN_KM_A) * Math.min(1, k)
    v /= 1 + slope[i] * SLOPE_DRAG
    if (nearRiver[i] || nearSea[i]) v *= CORRIDOR
    speed[i] = v
  }
  // Each cell's distance from today's glaciers over the cold climates
  // (climateHistory.ts iceMayCover): how soon the ice reaches it.
  const iceKm = new Float32Array(n).fill(Infinity)
  {
    const heap = new MinHeap(1 << 16)
    for (let i = 0; i < n; i++) {
      if (!land[i] || (biome[i] !== Biome.Ice && biome[i] !== Biome.Glacier)) continue
      iceKm[i] = 0
      heap.push(0, i)
    }
    while (heap.length > 0) {
      heap.pop()
      const i = heap.poppedIndex
      const d = heap.poppedKey
      if (d > iceKm[i]) continue
      for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
        const u = h.nbr[e]
        const nd = d + h.distKm[e]
        if (!land[u] || !iceMayCover(koppen[u]) || nd >= iceKm[u] || nd > ICE_REACH_KM) continue
        iceKm[u] = nd
        heap.push(nd, u)
      }
    }
  }
  // What each cell carries now (climateHistory.ts): the cold's share of
  // today's, 0 under the ice; the shelf while the sea stands below it.
  const capacity = new Float32Array(n)
  const updateClimate = (t: number): void => {
    const cold = climate.cold(t)
    const drop = climate.seaDropM(t)
    for (let i = 0; i < n; i++) {
      if (base[i] <= 0) continue
      capacity[i] = shelf[i] ? (seaDepthM[i] <= drop ? base[i] : 0) : base[i] * coldShare(koppen[i], iceKm[i], cold)
    }
  }
  const habitable = (i: number): boolean => land[i] === 1 && base[i] > 0
  const { region, regions } = regionsOf(h, habitable)
  const crossings = crossingsOf(h, REACH_END, habitable, region)
  const knowledge = new Float32Array(regions)
  const regionPeople = new Float64Array(regions)
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
  // A step touches two lists alone: the cells still growing or shrinking
  // (until within FULL_SHARE of what they carry), and the front — lived-in
  // cells with an empty neighbour people could settle. Over all the
  // lived-in cells a run took 40 s on Morvane. Both are made again from
  // all the lived-in cells when the climate moves (CLIMATE_YEARS).
  let growing: number[] = []
  let front: number[] = []
  let lived: number[] = []
  // A cell is settled once it has people; one left (the ice, the sea over
  // the shelf) may be settled again. Its arrival is the first.
  const settle = (cell: number, t: number, density: number, parent: number): void => {
    people[cell] = density
    if (arrival[cell] === Infinity) {
      arrival[cell] = t
      from[cell] = parent
    }
    growing.push(cell)
    front.push(cell)
    lived.push(cell)
  }
  const open = (u: number): boolean => people[u] === 0 && capacity[u] > 0
  updateClimate(0)
  if (input.origin >= 0 && capacity[input.origin] > 0) settle(input.origin, 0, capacity[input.origin] * SEED_SHARE, -1)

  const steps = Math.round(SPAN_YEARS / STEP_YEARS)
  const subYears = STEP_YEARS / SUB_STEPS
  const grow = 1 - Math.exp(-GROWTH_A * STEP_YEARS)
  for (let s = 0; s <= steps; s++) {
    const t = s * STEP_YEARS
    if (t % KEEP_YEARS === 0) kept.push(people.slice())
    if (s === steps) break
    // 0. The climate, every CLIMATE_YEARS: what the cells carry; the people
    //    of a cell that carries nothing now leave it.
    if (t > 0 && t % CLIMATE_YEARS === 0) {
      updateClimate(t)
      const still: number[] = []
      for (const i of lived) {
        if (people[i] === 0) continue
        if (capacity[i] <= 0) {
          people[i] = 0
          continue
        }
        still.push(i)
      }
      lived = still
      growing = still.slice()
      front = still.slice()
      // The knowledge, toward what each region's people keep.
      regionPeople.fill(0)
      for (const i of lived) if (region[i] >= 0) regionPeople[region[i]] += people[i] * h.areaKm2[i]
      for (let g = 0; g < regions; g++) {
        const target = KNOW_SCALE * Math.log10(1 + regionPeople[g] / KNOW_PEOPLE)
        knowledge[g] += (target - knowledge[g]) * (target > knowledge[g] ? KNOW_GAIN : KNOW_LOSS)
      }
    }
    // 1. Growth, or shrinking toward less; a cell near what it carries
    //    leaves the list.
    const stillGrowing: number[] = []
    for (const i of growing) {
      const k = capacity[i]
      if (people[i] === 0) continue
      people[i] += (k - people[i]) * grow
      if (Math.abs(k - people[i]) > (1 - FULL_SHARE) * k) stillGrowing.push(i)
    }
    growing = stillGrowing
    // 2. Settling, over SUB_STEPS passes; the newly settled join the next.
    //    A front cell with no open neighbour left leaves the list.
    for (let pass = 0; pass < SUB_STEPS; pass++) {
      const at = t + (pass + 1) * subYears
      const count = front.length
      const stillFront: number[] = []
      for (let k = 0; k < count; k++) {
        const i = front[k]
        if (people[i] === 0) continue
        let openLeft = false
        for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
          const u = h.nbr[e]
          if (!open(u)) continue
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
    // 3. The crossings within the reach of their coast's knowledge.
    for (const [source, list] of crossingsFrom) {
      if (people[source] < SEED_SHARE * capacity[source]) continue
      const known = knowledge[region[source]]
      const reach = Math.min(REACH_END, REACH_START + REACH_PER_KNOW * known)
      for (const c of list) {
        if (c.km > reach || !open(c.to) || arrival[c.to] < Infinity) continue
        if (random() < CROSSING_CHANCE) {
          settle(c.to, t + STEP_YEARS, capacity[c.to] * SEED_PEOPLE, c.from)
          const to = region[c.to]
          knowledge[to] = Math.max(knowledge[to], KNOW_CARRIED * known)
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
    climate: { maxAt: climate.maxAt, depth: climate.depth, deglaciation: climate.deglaciation },
    region,
    knowledge,
    ms: Math.round(performance.now() - started),
  }
}

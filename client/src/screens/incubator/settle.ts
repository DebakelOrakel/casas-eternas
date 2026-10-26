import { MinHeap } from '../../generator/core/minHeap'
import { hashText, kmBetween, mulberry32, type Habitat } from './habitat'
import { SPAN_YEARS } from './peopleShared'
import { CARRYING_FULL, densityAt, GOODS, LIFEWAY, lifewaySince, sharesAt, type SettleTimes } from './settleShared'

// THE INCUBATOR'S SETTLEMENT (2026-10-25, a proof of concept): the people's
// end state, 5 000 years before the game — how they live in each cell they
// reached, how many, their villages and the trade between them. Simple
// rules, to see what it could look like; the time along the spread, and the
// numbers, are for later.
//
// 1. WHAT A CELL ALLOWS: farming, where a domesticable starch plant grows
//    and the arable land is FARM_ARABLE or more; herding, where a tamable
//    herd animal lives and the pasture is HERD_PASTURE or more; settled
//    fishing, where the ecology's fish is FISH_RICH or more (the Jōmon).
// 2. THE FARMING, invented and spread (2026-10-26): at no more than
//    CENTRES_MAX centres CENTRE_SPACING_KM apart — where people lived
//    FARM_SETTLED years or more, CENTRE_PLANTS domesticable starch plants
//    or more grow together and the arable land is CENTRE_ARABLE or more,
//    the most of them first — the first FARM_EARLIEST, 11 000 years before
//    the game, the next some 1 000 to 3 000 years after each other, as on
//    the earth's (the Fertile Crescent, China, New Guinea, the Americas).
//    From each the farmers spread FARM_KM_A, as the earth's did into
//    Europe; through land they cannot farm FARM_BARRIER times slower, not
//    over the sea, not ahead of the people. The herding begins at the same
//    centres HERD_LAG later — sheep and goats were tamed with the fields —
//    and spreads HERD_KM_A, the herds faster than the fields, into the
//    pasture: the earth's nomads took the steppes late and fast.
//    The herding has centres of its own too (2026-10-26), no more than
//    HERD_CENTRES_MAX, CENTRE_SPACING_KM from any centre: where
//    HERD_CENTRE_ANIMALS tamable herd animals or more live together on
//    pasture of HERD_CENTRE_PASTURE or more, the first HERD_EARLIEST, 8 000
//    years before the game, the next 1 000 to 3 000 years after — the
//    earth's reindeer, llamas and yaks were tamed far from any field.
// 3. THE LIFEWAYS' SHARES AND THE DENSITY over the time (settleShared.ts):
//    the end state's, 5 000 years before the game, places the villages:
//    where farmers or fishers are the most, the cells densest within
//    VILLAGE_RADIUS of them; a village is there from its lifeway's start.
// 4. THE TRADE: each village linked to its LINKS nearest within LINK_KM;
//    from the sources of tool stone, salt and copper (the ecology's fields
//    at SOURCE_RICH or more, one a SOURCE_RADIUS) the goods go down the
//    line, each link a step less (DECAY_HOPS), as obsidian did on the earth
//    (Renfrew's fall-off).
// 5. THE PEOPLE'S MARK ON THE ANIMALS (fauna, the step before):
//    the big game dies out where people came new: on a landmass other than
//    the people's own, settled EXTINCT_AFTER years or more, each species of
//    MEGAFAUNA by its chance, half again on an island (under ISLAND_KM2) —
//    as on the earth, where Australia's, the Americas' and the islands' big
//    animals went soon after people came, and Africa's, which grew up with
//    them, stayed. The hunt's and the herds' pressure on the animals is the
//    screen's, at the time it shows (settleShared.ts, pressure).


// What the settlement reads besides the habitat.
export interface SettleInput {
  // Years from the departure to the arrival (people.ts); Infinity where
  // none came.
  arrival: Float32Array
  // How many domesticable starch plants grow in a cell; how many tamable
  // herd animals live there.
  farmPlant: Uint8Array
  herdAnimal: Uint8Array
  // The people's origin cell; the animals as the fauna placed them
  // (fauna.ts): where they live.
  origin: number
  animals: { id: string; codes: Uint8Array }[]
  seed: number
}

export interface SettleResult {
  // The end state's largest lifeway and density.
  lifeway: Uint8Array
  density: Float32Array
  // The times the lifeways follow (settleShared.ts), the arrival aside.
  farmAt: Float32Array
  herdAt: Float32Array
  fishOk: Uint8Array
  farmSuit: Float32Array
  herdSuit: Float32Array
  fishSuit: Float32Array
  carrying: Float32Array
  // [cell, time, lifeway] a centre of the farming (LIFEWAY.farmers) or of
  // the herding (LIFEWAY.herders), the time it began there.
  centres: Float32Array
  // [cell, lifeway] a village, and when it began.
  villages: Int32Array
  villageFrom: Float32Array
  // [cell, good index] a source.
  sources: Int32Array
  // [village a, village b, weight] a link (indices into villages).
  links: Float32Array
  // Where a species died out: on a landmass, some years after the
  // departure; and each cell's landmass (-1 at sea).
  extinctions: { id: string; landmass: number; areaKm2: number; at: number }[]
  landmass: Int32Array
}

const FARM_ARABLE = 0.3
const HERD_PASTURE = 0.3
const FISH_RICH = 0.5
// In rings of cells (some 10 km each).
const VILLAGE_RADIUS: Record<number, number> = { 2: 5, 4: 3 }
// Below this many people a km², no village.
const VILLAGE_LEAST: Record<number, number> = { 2: 0.3, 4: 2 }
const LINKS = 3
const LINK_KM = 150
const SOURCE_RICH = 0.6
const SOURCE_REACH_KM = 800
// In rings of cells.
const SOURCE_RADIUS = 10
const DECAY_HOPS = 4
const MAX_HOPS = 16
const CENTRES_MAX = 5
const CENTRE_SPACING_KM = 1500
const CENTRE_PLANTS = 2
const CENTRE_ARABLE = 0.5
const FARM_SETTLED = 10_000
const FARM_EARLIEST = SPAN_YEARS - 6000
const FARM_KM_A = 1
const FARM_BARRIER = 5
const HERD_LAG = 1000
const HERD_CENTRES_MAX = 3
const HERD_CENTRE_ANIMALS = 2
const HERD_CENTRE_PASTURE = 0.5
const HERD_EARLIEST = SPAN_YEARS - 3000
const HERD_KM_A = 2
const HERD_BARRIER = 3
// The big game and its chance to die out where people came new.
const MEGAFAUNA: Record<string, number> = { elephant: 0.8, horse: 0.6, bison: 0.5, camel: 0.5, buffalo: 0.3, aurochs: 0.2, bear: 0.2 }
const EXTINCT_AFTER = 2000
const ISLAND_KM2 = 1_000_000
const ISLAND_CHANCE = 1.5


// The cells within `rings` rings of cell `c`, itself first.
function ringsAround(h: Habitat, c: number, rings: number, seen: Int32Array, mark: number): number[] {
  const cells = [c]
  seen[c] = mark
  let from = 0
  for (let r = 0; r < rings; r++) {
    const to = cells.length
    for (let k = from; k < to; k++) {
      const i = cells[k]
      for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
        const u = h.nbr[e]
        if (seen[u] === mark) continue
        seen[u] = mark
        cells.push(u)
      }
    }
    from = to
  }
  return cells
}

// The cells where `value` is the largest within `rings` rings, ties to the
// lower index, of those `candidate` admits.
function localTops(h: Habitat, value: Float32Array, rings: number, candidate: (i: number) => boolean): number[] {
  const seen = new Int32Array(h.count).fill(-1)
  const tops: number[] = []
  for (let i = 0; i < h.count; i++) {
    if (!candidate(i)) continue
    let top = true
    for (const u of ringsAround(h, i, rings, seen, i)) {
      if (u !== i && (value[u] > value[i] || (value[u] === value[i] && u < i))) {
        top = false
        break
      }
    }
    if (top) tops.push(i)
  }
  return tops
}

// From cell `c` over the cells, the nearest first, as far as `maxKm`:
// `visit(cell, km)` for each, stopping where it returns true.
function nearest(h: Habitat, c: number, maxKm: number, visit: (cell: number, km: number) => boolean, dist: Float64Array, touched: number[]): void {
  const heap = new MinHeap(256)
  dist[c] = 0
  touched.push(c)
  heap.push(0, c)
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const d = heap.poppedKey
    if (d > dist[i]) continue
    if (visit(i, d)) break
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      const nd = d + h.distKm[e]
      if (nd > maxKm || nd >= dist[u]) continue
      if (dist[u] === Infinity) touched.push(u)
      dist[u] = nd
      heap.push(nd, u)
    }
  }
  for (const i of touched) dist[i] = Infinity
  touched.length = 0
}

export function settle(h: Habitat, input: SettleInput): SettleResult {
  const { arrival, farmPlant, herdAnimal } = input
  const n = h.count
  const { land } = h
  const eco = h.ecology
  const carrying = h.carrying ?? new Float32Array(n).fill(0.4)
  const at = (field: Float32Array | undefined, i: number): number => (field ? field[i] : 0)

  // 1. What each reached land cell allows.
  const farmOk = new Uint8Array(n)
  const herdOk = new Uint8Array(n)
  const fishOk = new Uint8Array(n)
  const carryingNorm = new Float32Array(n)
  const farmSuit = new Float32Array(n)
  const herdSuit = new Float32Array(n)
  const fishSuit = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || !(arrival[i] < Infinity)) continue
    farmSuit[i] = Math.min(1, at(eco.arable, i))
    herdSuit[i] = Math.min(1, at(eco.pasture, i))
    fishSuit[i] = Math.min(1, at(eco.fish, i))
    if (farmPlant[i] && at(eco.arable, i) >= FARM_ARABLE) farmOk[i] = 1
    if (herdAnimal[i] && at(eco.pasture, i) >= HERD_PASTURE) herdOk[i] = 1
    if (at(eco.fish, i) >= FISH_RICH) fishOk[i] = 1
    carryingNorm[i] = Math.min(2, carrying[i] / CARRYING_FULL)
  }

  // 2. The farming's centres, then the herding's, then their spread.
  const centres: number[] = []
  // The best of `candidates` CENTRE_SPACING_KM from every centre, as
  // centres of `way` from `earliest` on, `most` of them.
  const placeCentres = (candidates: { cell: number; score: number }[], way: number, earliest: number, most: number): void => {
    candidates.sort((p, q) => q.score - p.score || p.cell - q.cell)
    const random = mulberry32(hashText(way === LIFEWAY.farmers ? 'farming' : 'herding') ^ input.seed)
    let next = earliest
    let placed = 0
    for (const c of candidates) {
      if (placed >= most) break
      let far = true
      for (let k = 0; k < centres.length && far; k += 3) far = kmBetween(h, c.cell, centres[k]) >= CENTRE_SPACING_KM
      if (!far) continue
      // One beginning after the span never shows.
      const begins = Math.max(next, arrival[c.cell] + FARM_SETTLED)
      if (begins > SPAN_YEARS) continue
      centres.push(c.cell, begins, way)
      placed++
      next += 1000 + 2000 * random()
    }
  }
  const farmCandidates: { cell: number; score: number }[] = []
  const herdCandidates: { cell: number; score: number }[] = []
  for (let i = 0; i < n; i++) {
    if (farmOk[i] && farmPlant[i] >= CENTRE_PLANTS && at(eco.arable, i) >= CENTRE_ARABLE && arrival[i] <= FARM_EARLIEST - FARM_SETTLED) {
      farmCandidates.push({ cell: i, score: farmPlant[i] * at(eco.arable, i) * carrying[i] })
    }
    if (herdOk[i] && herdAnimal[i] >= HERD_CENTRE_ANIMALS && at(eco.pasture, i) >= HERD_CENTRE_PASTURE && arrival[i] <= HERD_EARLIEST - FARM_SETTLED) {
      herdCandidates.push({ cell: i, score: herdAnimal[i] * at(eco.pasture, i) * carrying[i] })
    }
  }
  placeCentres(farmCandidates, LIFEWAY.farmers, FARM_EARLIEST, CENTRES_MAX)
  placeCentres(herdCandidates, LIFEWAY.herders, HERD_EARLIEST, HERD_CENTRES_MAX)
  // The waves' starts, [cell, time] …: the fields from the farming's
  // centres; the herds from their own, and from the farming's HERD_LAG
  // after the fields.
  const farmStarts: number[] = []
  const herdStarts: number[] = []
  for (let k = 0; k < centres.length; k += 3) {
    if (centres[k + 2] === LIFEWAY.farmers) farmStarts.push(centres[k], centres[k + 1])
    herdStarts.push(centres[k], centres[k + 1] + (centres[k + 2] === LIFEWAY.farmers ? HERD_LAG : 0))
  }
  // A wave from its starts ([cell, time] …) over the land people reached,
  // `kmA` a year where `ok` allows its lifeway, `barrier` times slower
  // where not, never over the sea nor ahead of the people: the time it
  // came to each cell `ok` allows, Infinity elsewhere.
  const wave = (starts: number[], ok: Uint8Array, kmA: number, barrier: number): Float32Array => {
    const came = new Float32Array(n).fill(Infinity)
    const time = new Float64Array(n).fill(Infinity)
    const heap = new MinHeap(1 << 16)
    for (let k = 0; k < starts.length; k += 2) {
      if (starts[k + 1] > SPAN_YEARS || starts[k + 1] >= time[starts[k]]) continue
      time[starts[k]] = starts[k + 1]
      heap.push(starts[k + 1], starts[k])
    }
    while (heap.length > 0) {
      heap.pop()
      const i = heap.poppedIndex
      const t = heap.poppedKey
      if (t > time[i]) continue
      if (ok[i]) came[i] = t
      for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
        const u = h.nbr[e]
        if (!land[u] || !(arrival[u] < Infinity)) continue
        const at2 = Math.max(t + (h.distKm[e] / kmA) * (ok[u] ? 1 : barrier), arrival[u])
        if (at2 >= time[u] || at2 > SPAN_YEARS) continue
        time[u] = at2
        heap.push(at2, u)
      }
    }
    return came
  }
  const farmAt = wave(farmStarts, farmOk, FARM_KM_A, FARM_BARRIER)
  // The herds faster than the farmers (2026-10-26: at one time over all
  // the pasture, the herders came up everywhere at once).
  const herdAt = wave(herdStarts, herdOk, HERD_KM_A, HERD_BARRIER)

  // 3. The end state's lifeway and density, and its villages: the densest
  // cell within its radius.
  const times: SettleTimes = { arrival, farmAt, herdAt, fishOk, farmSuit, herdSuit, fishSuit, carrying: carryingNorm }
  const lifeway = new Uint8Array(n)
  const density = new Float32Array(n)
  const shares = new Float32Array(5)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    lifeway[i] = sharesAt(times, i, SPAN_YEARS, shares)
    density[i] = densityAt(times, i, SPAN_YEARS, shares)
  }
  const villageCells: number[] = []
  const villageWays: number[] = []
  for (const way of [2, 4]) {
    for (const c of localTops(h, density, VILLAGE_RADIUS[way], (i) => lifeway[i] === way && density[i] >= VILLAGE_LEAST[way])) {
      villageCells.push(c)
      villageWays.push(way)
    }
  }

  // 4. The links: each village's LINKS nearest within LINK_KM, over the
  // cells.
  const villageOf = new Map<number, number>()
  villageCells.forEach((c, v) => villageOf.set(c, v))
  const dist = new Float64Array(n).fill(Infinity)
  const touched: number[] = []
  const edges = new Map<string, [number, number]>()
  const neighbours: number[][] = villageCells.map(() => [])
  villageCells.forEach((c, v) => {
    const near: number[] = []
    nearest(h, c, LINK_KM, (cell) => {
      const u = villageOf.get(cell)
      if (u !== undefined && u !== v) near.push(u)
      return near.length >= LINKS
    }, dist, touched)
    for (const u of near) {
      const key = v < u ? `${v},${u}` : `${u},${v}`
      if (edges.has(key)) continue
      edges.set(key, v < u ? [v, u] : [u, v])
      neighbours[v].push(u)
      neighbours[u].push(v)
    }
  })

  // The sources: the richest cell of a good within SOURCE_RADIUS rings,
  // reached by people; its goods leave from the village nearest to it,
  // within SOURCE_REACH_KM.
  const sources: number[] = []
  GOODS.forEach((good, g) => {
    const field = eco[good]
    if (!field) return
    for (const c of localTops(h, field, SOURCE_RADIUS, (i) => field[i] >= SOURCE_RICH && lifeway[i] > 0)) sources.push(c, g)
  })
  const weight = new Map<string, number>()
  for (let s = 0; s < sources.length; s += 2) {
    let start = -1
    nearest(h, sources[s], SOURCE_REACH_KM, (cell) => {
      const u = villageOf.get(cell)
      if (u === undefined) return false
      start = u
      return true
    }, dist, touched)
    if (start < 0) continue
    // The goods down the line, a step of the links less each hop.
    const hops = new Map<number, number>([[start, 0]])
    const queue = [start]
    for (let q = 0; q < queue.length; q++) {
      const v = queue[q]
      const d = hops.get(v)!
      if (d >= MAX_HOPS) continue
      for (const u of neighbours[v]) {
        if (hops.has(u)) continue
        hops.set(u, d + 1)
        queue.push(u)
        const key = v < u ? `${v},${u}` : `${u},${v}`
        weight.set(key, (weight.get(key) ?? 0) + Math.exp(-d / DECAY_HOPS))
      }
    }
  }
  const links: number[] = []
  for (const [key, [a, b]] of edges) links.push(a, b, weight.get(key) ?? 0)
  const villages: number[] = []
  villageCells.forEach((c, v) => villages.push(c, villageWays[v]))
  const villageFrom = Float32Array.from(villageCells, (c, v) => lifewaySince(times, c, villageWays[v]))
  const extinctions = dyingOut(h, input)
  return { lifeway, density, farmAt, herdAt, fishOk, farmSuit, herdSuit, fishSuit, carrying: carryingNorm, centres: Float32Array.from(centres), villages: Int32Array.from(villages), villageFrom, sources: Int32Array.from(sources), links: Float32Array.from(links), extinctions, landmass: h.landmass.slice() }
}

// 5. The big game dying out where people came new.
function dyingOut(h: Habitat, input: SettleInput): SettleResult['extinctions'] {
  const { arrival, origin, seed } = input
  const n = h.count
  const home = origin >= 0 ? h.landmass[origin] : -1
  // Each landmass's first people.
  const first = new Float64Array(h.landmasses).fill(Infinity)
  for (let i = 0; i < n; i++) if (h.landmass[i] >= 0 && arrival[i] < first[h.landmass[i]]) first[h.landmass[i]] = arrival[i]
  const extinctions: SettleResult['extinctions'] = []
  for (const animal of input.animals) {
    const chance = MEGAFAUNA[animal.id]
    if (!chance) continue
    const random = mulberry32(hashText(animal.id) ^ seed)
    const gone = new Uint8Array(h.landmasses)
    for (let m = 0; m < h.landmasses; m++) {
      const draw = random()
      if (m === home || first[m] + EXTINCT_AFTER > SPAN_YEARS) continue
      if (draw < Math.min(1, chance * (h.landmassKm2[m] < ISLAND_KM2 ? ISLAND_CHANCE : 1))) gone[m] = 1
    }
    const lived = new Uint8Array(h.landmasses)
    for (let i = 0; i < n; i++) {
      const m = h.landmass[i]
      if (m >= 0 && gone[m] && animal.codes[i] >= 2) lived[m] = 1
    }
    for (let m = 0; m < h.landmasses; m++) if (lived[m]) extinctions.push({ id: animal.id, landmass: m, areaKm2: h.landmassKm2[m], at: first[m] + EXTINCT_AFTER })
  }
  return extinctions
}

import { MinHeap } from '../../generator/core/minHeap'
import { hashText, kmBetween, mulberry32, type Habitat } from './habitat'
import { SPAN_YEARS } from './peopleShared'
import { POPULATION_MARKS, type LogEvent } from './historyLogShared'
import { reset, travelDays, withinDays } from './travel'
import type { PeopleResult } from './people'
import { CAME_NEVER, CAME_STEP, CARRYING_FULL, densityAt, extinctAt, GOODS, LIFEWAY, lifewaySince, PLANT_SUITS_CODE, sharesAt, type SettleTimes } from './settleShared'

// THE INCUBATOR'S SETTLEMENT (2026-10-25, a proof of concept): the people's
// end state, 5 000 years before the game — how they live in each cell they
// reached, how many, their villages and the trade between them. Simple
// rules, to see what it could look like; the time along the spread, and the
// numbers, are for later.
//
// 1. WHAT A CELL ALLOWS: farming, where the arable land is FARM_ARABLE or
//    more and a crop the farmers bring suits it; herding, where the pasture
//    is HERD_PASTURE or more and a herd animal the herders bring suits it;
//    settled fishing, where the ecology's fish is FISH_RICH or more (the
//    Jōmon).
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
//    THE DOMESTICATES (2026-10-26): a farming centre tames the domesticable
//    starch plants growing wild there, and HERD_LAG later the herd animals
//    living there; a herding centre its herd animals. Each spreads in a
//    wave of its own, where it suits the cell (its niche, reached or not),
//    beyond its wild range — as wheat and barley went to Europe; where two
//    meet, a cell holds both, as the earth's farmers sowed several crops
//    and took their neighbours'. The fields, the herds come to a cell with
//    the first. Not over the sea: the crops stay on their continent. Until
//    then a wave needed a wild one in every cell, and before that (the same
//    day) a cell took the first centre's wave alone.
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
// 4. THE TRADE, the far one (the everyday goods go a day or two, between
//    neighbours: simulation.ts, THE EXCHANGE): each village linked to its
//    LINKS nearest within LINK_DAYS of the ways (travel.ts: on foot by the
//    grade and the land, by dugout on the rivers, by boat along the
//    coast); from the sources of tool stone, salt and copper (the
//    ecology's fields at SOURCE_RICH or more, one a SOURCE_RADIUS) the
//    goods go down the line, less the more days from the source
//    (DECAY_DAYS), as obsidian did on the earth (Renfrew's fall-off).
//    Until 2026-10-26 the links were km over the cells (150 at most) and
//    the goods lost a step each link (a quarter, 16 links at most). With
//    the villages a day and a half apart, links of 4 days and a decay of
//    6 carried goods on few of them.
// 5. THE PEOPLE'S MARK ON THE ANIMALS (fauna, the step before):
//    the big game dies out where people came new: on a landmass other than
//    the people's own, each species of MEGAFAUNA by its chance, half again
//    on an island (under ISLAND_KM2) — as on the earth, where Australia's,
//    the Americas' and the islands' big animals went soon after people
//    came, and Africa's, which grew up with them, stayed. It goes cell by
//    cell behind the people's front (settleShared.ts, extinctAt; until
//    2026-10-26 from the whole landmass at once); once less than
//    REFUGE_LEAST of its cells are left, the rest go too, too few to last.
//    Without it a species lived on in the corners people never reached:
//    on Morvane 1 to 5 % of its cells, in 25 of 27 cases. The hunt's and the herds' pressure on the animals is the
//    screen's, at the time it shows (settleShared.ts, pressure).


// What the settlement reads besides the habitat.
export interface SettleInput {
  // Years from the departure to the arrival (people.ts); Infinity where
  // none came.
  arrival: Float32Array
  // The domesticable starch plants (plants.ts) and the tamable herd
  // animals (animals.ts), their codes per cell as the flora (flora.ts) and
  // the fauna (fauna.ts) gave them.
  crops: { id: string; codes: Uint8Array }[]
  herds: { id: string; codes: Uint8Array }[]
  // The people's origin cell; the animals as the fauna placed them
  // (fauna.ts): where they live.
  origin: number
  animals: { id: string; codes: Uint8Array }[]
  seed: number
  // The farming and the herding as a simulated history made them
  // (simulation.ts): its centres, its domesticates, when the fields and
  // the herds came to each cell. Given, they take the rules' place
  // (2 below).
  given?: SettleLifeways
}

// The farming's and the herding's centres, domesticates and times (2
// below), the rules' or a history's; a history's villages (3 below) and
// its people over the span too.
export interface SettleLifeways {
  centres: Float32Array
  farmAt: Float32Array
  herdAt: Float32Array
  domestications: SettleResult['domestications']
  villages?: { villages: Int32Array; villageFrom: Float32Array; villageTo: Float32Array }
  population?: Float32Array
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
  // The people over the span, every POPULATION_STEP years from the
  // departure: the density over the land reached, times its cells' areas.
  population: Float32Array
  // [cell, time, lifeway] a centre of the farming (LIFEWAY.farmers) or of
  // the herding (LIFEWAY.herders), the time it began there.
  centres: Float32Array
  // What a centre tamed, when: a plant or an animal, at the centre's cell;
  // and when its wave came to each cell, in CAME_STEP years (CAME_NEVER
  // where it never did).
  domestications: { kind: 'plant' | 'animal'; id: string; cell: number; at: number; came: Uint16Array }[]
  // [cell, lifeway] a village — or a camp, where the lifeway is the
  // foragers' or the herders' — when it began and when it was left
  // (Infinity: never; the rules' are never left).
  villages: Int32Array
  villageFrom: Float32Array
  villageTo: Float32Array
  // [cell, good index] a source.
  sources: Int32Array
  // [village a, village b, weight] a link (indices into villages).
  links: Float32Array
  // Where a species dies out: on a landmass, cell by cell (extinctAt), until
  // the rest goes at `at` (REFUGE_LEAST; Infinity where people leave more),
  // `cell` the last to go before; and each cell's landmass (-1 at sea).
  extinctions: { id: string; landmass: number; areaKm2: number; at: number; cell: number }[]
  // The log (historyLogShared.ts): a history's own, with the first trade
  // added (logWithTrade); the rules' made from their times (rulesLog).
  // Empty out of settle(); the worker fills it.
  log: LogEvent[]
  landmass: Int32Array
}

const FARM_ARABLE = 0.3
const HERD_PASTURE = 0.3
export const FISH_RICH = 0.5
// In rings of cells (some 10 km each).
export const VILLAGE_RADIUS: Record<number, number> = { 2: 5, 4: 3 }
// Below this many people a km², no village.
export const VILLAGE_LEAST: Record<number, number> = { 2: 0.3, 4: 2 }
// The rules' camps (2026-10-26), the foragers' and the herders', as their
// villages: in rings, and the least people a km².
const CAMP_RADIUS: Record<number, number> = { 1: 12, 3: 9 }
const CAMP_LEAST: Record<number, number> = { 1: 0.05, 3: 0.5 }
const LINKS = 3
const LINK_DAYS = 6
const SOURCE_RICH = 0.6
const SOURCE_DAYS = 20
// In rings of cells.
const SOURCE_RADIUS = 10
const DECAY_DAYS = 8
const MAX_DAYS = 32
const CENTRES_MAX = 5
const CENTRE_SPACING_KM = 1500
const CENTRE_PLANTS = 2
const CENTRE_ARABLE = 0.5
const FARM_SETTLED = 10_000
// The world's timeline (climateHistory.ts): the first fields from year
// 67 000, the herds from 70 000 (until 2026-10-26 11 000 and 8 000 years
// before the game).
const FARM_EARLIEST = 67_000
const FARM_KM_A = 1
const FARM_BARRIER = 5
const HERD_LAG = 1000
const HERD_CENTRES_MAX = 3
const HERD_CENTRE_ANIMALS = 2
const HERD_CENTRE_PASTURE = 0.5
const HERD_EARLIEST = 70_000
const HERD_KM_A = 2
const HERD_BARRIER = 3
// The big game and its chance to die out where people came new.
export const MEGAFAUNA: Record<string, number> = { elephant: 0.8, horse: 0.6, bison: 0.5, camel: 0.5, buffalo: 0.3, aurochs: 0.2, bear: 0.2 }
const ISLAND_KM2 = 1_000_000
const ISLAND_CHANCE = 1.5
const REFUGE_LEAST = 0.1
export const POPULATION_STEP = 500


// The cells within `rings` rings of cell `c`, itself first.
export function ringsAround(h: Habitat, c: number, rings: number, seen: Int32Array, mark: number): number[] {
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

export function settle(h: Habitat, input: SettleInput): SettleResult {
  const { arrival, crops, herds } = input
  const n = h.count
  const { land } = h
  const eco = h.ecology
  const carrying = h.carrying ?? new Float32Array(n).fill(0.4)
  const at = (field: Float32Array | undefined, i: number): number => (field ? field[i] : 0)

  // 1. What each reached land cell allows; how many crops grow wild there,
  // how many herd animals live there.
  const fishOk = new Uint8Array(n)
  const farmPlant = new Uint8Array(n)
  const herdAnimal = new Uint8Array(n)
  const carryingNorm = new Float32Array(n)
  const farmSuit = new Float32Array(n)
  const herdSuit = new Float32Array(n)
  const fishSuit = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || !(arrival[i] < Infinity)) continue
    farmSuit[i] = Math.min(1, at(eco.arable, i))
    herdSuit[i] = Math.min(1, at(eco.pasture, i))
    fishSuit[i] = Math.min(1, at(eco.fish, i))
    for (const crop of crops) if (crop.codes[i] >= PLANT_SUITS_CODE) farmPlant[i]++
    for (const herd of herds) if (herd.codes[i] >= 2) herdAnimal[i]++
    if (at(eco.fish, i) >= FISH_RICH) fishOk[i] = 1
    carryingNorm[i] = Math.min(2, carrying[i] / CARRYING_FULL)
  }

  // 2. The farming's centres, then the herding's, then their spread; or
  // a history's.
  const lifeways: SettleLifeways = input.given ?? ((): SettleLifeways => {
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
      if (farmPlant[i] >= CENTRE_PLANTS && at(eco.arable, i) >= CENTRE_ARABLE && arrival[i] <= FARM_EARLIEST - FARM_SETTLED) {
        farmCandidates.push({ cell: i, score: farmPlant[i] * at(eco.arable, i) * carrying[i] })
      }
      if (herdAnimal[i] >= HERD_CENTRE_ANIMALS && at(eco.pasture, i) >= HERD_CENTRE_PASTURE && arrival[i] <= HERD_EARLIEST - FARM_SETTLED) {
        herdCandidates.push({ cell: i, score: herdAnimal[i] * at(eco.pasture, i) * carrying[i] })
      }
    }
    placeCentres(farmCandidates, LIFEWAY.farmers, FARM_EARLIEST, CENTRES_MAX)
    placeCentres(herdCandidates, LIFEWAY.herders, HERD_EARLIEST, HERD_CENTRES_MAX)
    // A wave from a centre's cell at `start` over the land people reached,
    // `kmA` a year where `ok` allows its lifeway, `barrier` times slower
    // where not, never over the sea nor ahead of the people: the time it
    // came to each cell `ok` allows, Infinity elsewhere.
    const wave = (cell: number, start: number, ok: Uint8Array, kmA: number, barrier: number): Float32Array => {
      const came = new Float32Array(n).fill(Infinity)
      const time = new Float64Array(n).fill(Infinity)
      const heap = new MinHeap(1 << 16)
      if (start <= SPAN_YEARS) {
        time[cell] = start
        heap.push(start, cell)
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
    // Where a centre's domesticates suit a cell, with the land its lifeway
    // needs.
    const suitedBy = (layers: { codes: Uint8Array }[], from: number, field: Float32Array | undefined, least: number): Uint8Array => {
      const ok = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        if (!land[i] || !(arrival[i] < Infinity) || at(field, i) < least) continue
        for (const layer of layers) {
          const c = layer.codes[i]
          if (c === 1 || c >= from) {
            ok[i] = 1
            break
          }
        }
      }
      return ok
    }
    // Each centre's domesticates and their waves: the crops from a farming
    // centre; the herds from a herding centre, and from a farming centre
    // HERD_LAG after the fields. The fields, the herds come to a cell with
    // the first.
    const domestications: SettleResult['domestications'] = []
    const farmAt = new Float32Array(n).fill(Infinity)
    const herdAt = new Float32Array(n).fill(Infinity)
    const tame = (kind: 'plant' | 'animal', layer: { id: string; codes: Uint8Array }, cell: number, begins: number): void => {
      const plant = kind === 'plant'
      const ok = suitedBy([layer], plant ? PLANT_SUITS_CODE : 2, plant ? eco.arable : eco.pasture, plant ? FARM_ARABLE : HERD_PASTURE)
      const came = plant ? wave(cell, begins, ok, FARM_KM_A, FARM_BARRIER) : wave(cell, begins, ok, HERD_KM_A, HERD_BARRIER)
      const into = plant ? farmAt : herdAt
      const steps = new Uint16Array(n).fill(CAME_NEVER)
      for (let i = 0; i < n; i++) {
        if (!(came[i] < Infinity)) continue
        steps[i] = Math.round(came[i] / CAME_STEP)
        if (came[i] < into[i]) into[i] = came[i]
      }
      domestications.push({ kind, id: layer.id, cell, at: begins, came: steps })
    }
    for (let k = 0; k < centres.length; k += 3) {
      const cell = centres[k]
      const begins = centres[k + 1]
      const farm = centres[k + 2] === LIFEWAY.farmers
      if (farm) for (const crop of crops) if (crop.codes[cell] >= PLANT_SUITS_CODE) tame('plant', crop, cell, begins)
      // The herds faster than the farmers (2026-10-26: at one time over all
      // the pasture, the herders came up everywhere at once).
      const herdsFrom = farm ? begins + HERD_LAG : begins
      if (herdsFrom > SPAN_YEARS) continue
      for (const herd of herds) if (herd.codes[cell] >= 2) tame('animal', herd, cell, herdsFrom)
    }
    return { centres: Float32Array.from(centres), farmAt, herdAt, domestications }
  })()
  const { farmAt, herdAt, domestications } = lifeways
  const centres = Array.from(lifeways.centres)

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
  // The people over the span; a history's own (copied: the worker keeps
  // it for the next settlement).
  const population = input.given?.population?.slice() ?? new Float32Array(Math.floor(SPAN_YEARS / POPULATION_STEP) + 1)
  for (let i = 0; i < n && !input.given?.population; i++) {
    if (!land[i] || !(arrival[i] < Infinity)) continue
    for (let k = Math.ceil(arrival[i] / POPULATION_STEP); k < population.length; k++) {
      const t = k * POPULATION_STEP
      sharesAt(times, i, t, shares)
      population[k] += densityAt(times, i, t, shares) * h.areaKm2[i]
    }
  }
  const villageCells: number[] = []
  const villageWays: number[] = []
  const given = input.given?.villages
  if (given) {
    for (let v = 0; v < given.villages.length; v += 2) {
      villageCells.push(given.villages[v])
      villageWays.push(given.villages[v + 1])
    }
  } else {
    // The villages, then the camps (in the villages' lists, told apart by
    // their lifeway: the foragers' and the herders').
    for (const way of [2, 4, 1, 3]) {
      const radius = VILLAGE_RADIUS[way] ?? CAMP_RADIUS[way]
      const least = VILLAGE_LEAST[way] ?? CAMP_LEAST[way]
      for (const c of localTops(h, density, radius, (i) => lifeway[i] === way && density[i] >= least)) {
        villageCells.push(c)
        villageWays.push(way)
      }
    }
  }

  // 4. The links: each village's LINKS nearest within LINK_DAYS of the
  // ways (travel.ts).
  const wayDays = travelDays(h)
  const villageOf = new Map<number, number>()
  villageCells.forEach((c, v) => villageOf.set(c, v))
  const dist = new Float32Array(n).fill(Infinity)
  const edges = new Map<string, [number, number]>()
  const edgeDays = new Map<string, number>()
  const neighbours: number[][] = villageCells.map(() => [])
  const keyOf = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`)
  villageCells.forEach((c, v) => {
    const near: [number, number][] = []
    reset(dist, withinDays(h, wayDays, [c], LINK_DAYS, dist, (cell, d) => {
      const u = villageOf.get(cell)
      if (u !== undefined && u !== v) near.push([u, d])
      return near.length >= LINKS
    }))
    for (const [u, d] of near) {
      const key = keyOf(v, u)
      if (edges.has(key)) continue
      edges.set(key, v < u ? [v, u] : [u, v])
      edgeDays.set(key, d)
      neighbours[v].push(u)
      neighbours[u].push(v)
    }
  })

  // The sources: the richest cell of a good within SOURCE_RADIUS rings,
  // reached by people; its goods leave from the village nearest to it,
  // within SOURCE_DAYS.
  const sources: number[] = []
  GOODS.forEach((good, g) => {
    const field = eco[good]
    if (!field) return
    for (const c of localTops(h, field, SOURCE_RADIUS, (i) => field[i] >= SOURCE_RICH && lifeway[i] > 0)) sources.push(c, g)
  })
  const weight = new Map<string, number>()
  for (let s = 0; s < sources.length; s += 2) {
    let start = -1
    reset(dist, withinDays(h, wayDays, [sources[s]], SOURCE_DAYS, dist, (cell) => {
      const u = villageOf.get(cell)
      if (u === undefined) return false
      start = u
      return true
    }))
    if (start < 0) continue
    // The goods down the line, less the more days from the source's
    // village (DECAY_DAYS), as far as MAX_DAYS.
    const days = new Map<number, number>([[start, 0]])
    const heap = new MinHeap(64)
    heap.push(0, start)
    while (heap.length > 0) {
      heap.pop()
      const v = heap.poppedIndex
      const d = heap.poppedKey
      if (d > days.get(v)!) continue
      for (const u of neighbours[v]) {
        const nd = d + edgeDays.get(keyOf(v, u))!
        if (nd > MAX_DAYS || nd >= (days.get(u) ?? Infinity)) continue
        const first = !days.has(u)
        days.set(u, nd)
        heap.push(nd, u)
        if (first) weight.set(keyOf(v, u), (weight.get(keyOf(v, u)) ?? 0) + Math.exp(-d / DECAY_DAYS))
      }
    }
  }
  const links: number[] = []
  for (const [key, [a, b]] of edges) links.push(a, b, weight.get(key) ?? 0)
  const villages: number[] = []
  villageCells.forEach((c, v) => villages.push(c, villageWays[v]))
  const villageFrom = given ? given.villageFrom.slice() : Float32Array.from(villageCells, (c, v) => lifewaySince(times, c, villageWays[v]))
  const villageTo = given ? given.villageTo.slice() : new Float32Array(villageCells.length).fill(Infinity)
  const extinctions = dyingOut(h, input)
  return { lifeway, density, farmAt, herdAt, fishOk, farmSuit, herdSuit, fishSuit, carrying: carryingNorm, population, centres: Float32Array.from(centres), domestications, villages: Int32Array.from(villages), villageFrom, villageTo, sources: Int32Array.from(sources), links: Float32Array.from(links), extinctions, log: [], landmass: h.landmass.slice() }
}

// THE LOG's first trade (historyLogShared.ts): the first link that carries
// goods (a weight of TRADE_TOLD or more) once both its villages stand, at
// its first village's cell.
const TRADE_TOLD = 0.05
function firstTrade(s: SettleResult): LogEvent | null {
  let first = -1
  let firstAt = Infinity
  for (let k = 0; k < s.links.length; k += 3) {
    if (s.links[k + 2] < TRADE_TOLD) continue
    const at = Math.max(s.villageFrom[s.links[k]], s.villageFrom[s.links[k + 1]])
    if (at >= Math.min(s.villageTo[s.links[k]], s.villageTo[s.links[k + 1]]) || at >= firstAt) continue
    firstAt = at
    first = k
  }
  if (first < 0 || firstAt > SPAN_YEARS) return null
  const a = s.links[first]
  return { kind: 'trade', at: firstAt, cell: s.villages[2 * a], a, b: s.links[first + 1] }
}

// A history's log with its first trade, which the settlement lays.
export function logWithTrade(log: readonly LogEvent[], s: SettleResult): LogEvent[] {
  const trade = firstTrade(s)
  return (trade ? [...log, trade] : [...log]).sort((x, y) => x.at - y.at)
}

// THE RULES' LOG: the same events from the rules' times (people.ts,
// settle()): the departure, the crossings (`first` for the earliest to a
// landmass, made no later than any arrival there), the centres, the
// domesticates, the extinctions, the villages, the people's marks, the
// first trade.
export function rulesLog(h: Habitat, people: PeopleResult, s: SettleResult): LogEvent[] {
  const log: LogEvent[] = []
  if (people.origin >= 0) log.push({ kind: 'departure', at: 0, cell: people.origin })
  const arrived = new Float64Array(h.landmasses).fill(Infinity)
  for (let i = 0; i < people.arrival.length; i++) {
    const m = h.landmass[i]
    if (m >= 0 && people.arrival[i] < arrived[m]) arrived[m] = people.arrival[i]
  }
  const c = people.crossings
  const earliest = new Map<number, number>()
  for (let k = 0; k < c.length; k += 4) {
    const known = earliest.get(c[k])
    if (c[k + 2] <= arrived[c[k]] && (known === undefined || c[k + 2] < c[known + 2])) earliest.set(c[k], k)
  }
  const firsts = new Set(earliest.values())
  for (let k = 0; k < c.length; k += 4) log.push({ kind: 'crossing', at: c[k + 2], cell: c[k + 1], landmass: c[k], km: c[k + 3], first: firsts.has(k) })
  for (let k = 0; k < s.centres.length; k += 3) log.push({ kind: 'centre', at: s.centres[k + 1], cell: s.centres[k], lifeway: s.centres[k + 2] })
  for (const d of s.domestications) log.push({ kind: 'domesticated', at: d.at, cell: d.cell, id: d.id, plant: d.kind === 'plant' })
  for (const e of s.extinctions) if (e.at <= SPAN_YEARS) log.push({ kind: 'extinct', at: e.at, cell: e.cell, landmass: e.landmass, id: e.id })
  for (let v = 0; v < s.villageFrom.length; v++) {
    if (s.villageFrom[v] > SPAN_YEARS) continue
    const way = s.villages[2 * v + 1]
    log.push({ kind: way === LIFEWAY.foragers || way === LIFEWAY.herders ? 'camp' : 'village', at: s.villageFrom[v], cell: s.villages[2 * v], village: v, lifeway: way })
  }
  // The marks, between the curve's samples linearly.
  const curve = s.population
  for (const mark of POPULATION_MARKS) {
    const k = curve.findIndex((p) => p >= mark)
    if (k < 0) continue
    const at = k === 0 ? 0 : (k - 1 + (mark - curve[k - 1]) / Math.max(1e-9, curve[k] - curve[k - 1])) * POPULATION_STEP
    let villages = 0
    for (let v = 0; v < s.villageFrom.length; v++) if (s.villageFrom[v] <= at && at < s.villageTo[v] && (s.villages[2 * v + 1] === LIFEWAY.fishers || s.villages[2 * v + 1] === LIFEWAY.farmers)) villages++
    let centres = 0
    for (let k2 = 0; k2 < s.centres.length; k2 += 3) if (s.centres[k2 + 1] <= at) centres++
    log.push({ kind: 'population', at, cell: people.origin, count: mark, villages, centres })
  }
  return logWithTrade(log, s)
}

// 5. The big game dying out where people came new.
function dyingOut(h: Habitat, input: SettleInput): SettleResult['extinctions'] {
  const { arrival, origin, seed } = input
  const n = h.count
  const home = origin >= 0 ? h.landmass[origin] : -1
  const extinctions: SettleResult['extinctions'] = []
  for (const animal of input.animals) {
    const chance = MEGAFAUNA[animal.id]
    if (!chance) continue
    const random = mulberry32(hashText(animal.id) ^ seed)
    const gone = new Uint8Array(h.landmasses)
    for (let m = 0; m < h.landmasses; m++) {
      const draw = random()
      if (m === home) continue
      if (draw < Math.min(1, chance * (h.landmassKm2[m] < ISLAND_KM2 ? ISLAND_CHANCE : 1))) gone[m] = 1
    }
    // Each landmass's cells of it, by when they go.
    const goes = new Map<number, { at: number; cell: number }[]>()
    for (let i = 0; i < n; i++) {
      const m = h.landmass[i]
      if (m < 0 || !gone[m] || animal.codes[i] < 2) continue
      let list = goes.get(m)
      if (!list) goes.set(m, (list = []))
      list.push({ at: extinctAt(arrival[i], i), cell: i })
    }
    for (const [m, list] of goes) {
      list.sort((a, b) => a.at - b.at)
      const last = list[Math.max(0, Math.ceil((1 - REFUGE_LEAST) * list.length) - 1)]
      extinctions.push({ id: animal.id, landmass: m, areaKm2: h.landmassKm2[m], at: last.at, cell: last.cell })
    }
  }
  return extinctions
}

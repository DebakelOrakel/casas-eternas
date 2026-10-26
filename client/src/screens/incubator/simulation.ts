import { Biome } from '../../generator/climate/biomes'
import { MinHeap } from '../../generator/core/minHeap'
import { kmBetween, mulberry32, type Habitat } from './habitat'
import type { PeopleResult } from './people'
import { KEEP_YEARS, SPAN_YEARS } from './peopleShared'
import { FISH_RICH, POPULATION_STEP, ringsAround, VILLAGE_LEAST, VILLAGE_RADIUS, type SettleLifeways } from './settle'
import { CAME_NEVER, CAME_STEP, LIFEWAY, PLANT_SUITS_CODE, SETTLE_AFTER } from './settleShared'
import { POPULATION_MARKS, type LogEvent } from './historyLogShared'
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
const SUB_STEPS = 3
const FORAGER_DENSITY = 0.1
const CARRYING_FULL = 0.8
const GROWTH_A = 0.01
// A third (2026-10-26; a half before): with the cold and the hunt the
// foragers seldom got to half of what the land carried before, and the
// front stood.
const SEED_SHARE = 1 / 3
const SEED_PEOPLE = 0.2
const FULL_SHARE = 0.95
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
// THE SEAFARING (2026-10-26, a cheat, asked for): the reach takes the
// larger of a region's knowledge and its `seafaring`, which a crossing
// brings in full and which never falls; every CLIMATE_YEARS it passes
// both ways along the crossings made. Without it the ways to the large
// landmasses ran over small islands whose few people kept little, and
// Morvane's people reached 3 of its 7 large landmasses.
// THE STEPPING STONES (2026-10-26, a cheat too): from a region of fewer
// than STONE_CELLS cells people set out at once — any people, every
// crossing with STONE_CHANCE a step. The way to Morvane's largest
// landmass ran over some 100 such regions along a cold coast, at
// CROSSING_CHANCE each over 100 000 years.
// THE GAME (2026-10-26, DES-0033 step 3), every GAME_STEPS steps on the
// cells people live in or have hunted: the small game and the big game, a
// share each of what the land holds without people. Each grows back
// toward it (SMALL_REGROW_A, BIG_REGROW_A a year: the big slowly) and is
// hunted by the people there by their density over the foragers' (HUNT_A,
// BIG_HUNT_A a year at that density). The big game is each species' own
// (2026-10-26; one share for all of it before): a vulnerable species
// grows back slower, by (1.2 − its vulnerability), and is hunted harder, by
// its vulnerability over 0.5 — the elephant and the horse go first, the
// aurochs holds; the big game of the people's own
// landmass, which grew up with them, at HOME_WARY of that. What the
// foragers live on: PLANT_FOOD of it plants, the rest the game — SMALL_FOOD
// small, BIG_FOOD big where there is big game. A species of the big game is
// gone from a landmass when its cells there hold less than EXTINCT_BELOW
// of it: the rules drew that.
const GAME_STEPS = 8
const SMALL_REGROW_A = 0.05
const BIG_REGROW_A = 0.002
const HUNT_A = 0.02
const BIG_HUNT_A = 0.01
const HOME_WARY = 0.03
const PLANT_FOOD = 0.5
const SMALL_FOOD = 0.35
const BIG_FOOD = 0.15
const EXTINCT_BELOW = 0.1
const FOOD_MOVED = 0.02
const CAPACITY_MOVED = 0.02
// THE FARMING AND THE HERDING (2026-10-26, DES-0033 "Progression"):
// no dates. Every CLIMATE_YEARS each region's best cell may become a
// centre, by a chance: of the farming (FARM_RATE × its wild crops over two
// × its arable land) while the climate is stable (climateHistory.ts),
// where people have lived SETTLED_YEARS, CENTRE_CROPS wild crops grow and
// the arable land is CENTRE_ARABLE, and the region knows KNOW_FARM; of the
// herding (HERD_RATE × its herd animals over two × its pasture) likewise,
// the climate stable too (without it a herding centre came at year 7 500,
// deep in the cold; the earth's animals were all tamed in the Holocene),
// with CENTRE_HERDS herd animals, CENTRE_PASTURE pasture and KNOW_HERD — at
// CENTRE_SPACING_KM from any centre of its lifeway. A farming centre tames its wild crops
// at once, its herd animals HERD_LAG later; a herding centre its herd
// animals. They spread over the cells people live in, FARM_KM_A and
// HERD_KM_A a year, each where it suits (its niche; FARM_ARABLE,
// HERD_PASTURE): a cell takes what its neighbour has and suits it; land it
// does not suit it crosses FARM_BARRIER, HERD_BARRIER times slower, kept
// nowhere there (the rules'). Through suiting cells alone the waves ran
// out along the arable and pasture strips, half of the suiting cells
// never reached, in fronds (2026-10-26). The
// fields carry FARM_GAIN × the arable land times more people, the herds
// HERD_GAIN × the pasture (the rules' densities: farmers 15, herders 1.5,
// foragers 0.1 a km²). HERD_RATE was 0.2: the first herding centre came before
// the first fields on Morvane. A cell keeps its domesticates as bits, MAX_TAMED
// of them at most.
// THE FISHERS (2026-10-26, DES-0033 "Progression" 3): where the fish are
// FISH_RICH or more, people who have lived there SETTLE_AFTER years stay
// and grow dense — the fish carry FISH_GAIN × the fish times more people
// (the rules' densities: fishers 1 a km², foragers 0.1), where no fields
// carry them instead (the Jōmon).
// THE VILLAGES (the same day), every CLIMATE_YEARS: where the farmers (the
// fields) or the fishers live VILLAGE_LEAST a km² or more, the densest
// cell within VILLAGE_RADIUS rings with no village founds one (the rules'
// measures, settle.ts); a village whose people fall under VILLAGE_LEAVE of
// its least is left (the ice, the sea, the hunger). The people over the
// span are counted every POPULATION_STEP years. Before, a history's
// villages and its people were the rules', from its times.
const FISH_GAIN = 10
// THE DROUGHTS (2026-10-26, DES-0033 "Droughts"): the land in squares of
// DRY_SQUARE_KM a landmass, so that a drought is a place. Each step a
// square's rain is its mean times 1 + DRY_SCALE × its variability × an
// anomaly (the variability is a year's; a step's mean of 25 years varies
// less): its own random walk (DRY_KEEP of the last, the rest new), and in
// a step with a strong ENSO (ENSO_CHANCE × the see-saw's strength)
// ENSO_PUSH × its mark. Under DRY_BELOW the step is dry: STORE_STEPS of
// them in a row the stores take; more are a famine — the fields and the
// pasture give
// the rain's share, the plants and the game half the shortfall less, and
// the people more than that die at once; a village under VILLAGE_LEAVE of
// its least is left. A famine is told in the log (`famines`) with the
// people it cost and the villages given up. With the year's variability
// whole and a famine from the second dry step, Morvane had 71 814 famines
// (3 597 of 10 000 people or more); now some 650 (some 30).
const DRY_SQUARE_KM = 300
const DRY_SCALE = 0.25
const STORE_STEPS = 2
const DRY_KEEP = 0.6
const DRY_BELOW = 0.75
const ENSO_CHANCE = 0.3
const ENSO_PUSH = 1.5
// THE FLIGHT (2026-10-26, DES-0033 "Droughts"): of those a famine's land
// does not carry, FAMINE_DEATH die; the rest leave for the cells around
// its square that no famine holds, as far as each has room — up to
// FLIGHT_CROWD times what it carries (they thin out to it as the people
// do) — and the rest of them die too. Before, all of them died. On
// Morvane some 450 000 fled, 2.7 M died: the cells around are mostly
// full. Herders taking a famine's farmland were tried the same day and
// never came: a farming cell that suits the herds has them already, and
// the fields cannot be given up while the lifeways are times that only
// go forward.
const FAMINE_DEATH = 0.5
const FLIGHT_CROWD = 1.5
const VILLAGE_LEAVE = 0.5
const SETTLED_YEARS = 5000
const FARM_RATE = 0.3
const HERD_RATE = 0.1
const CENTRE_CROPS = 2
const CENTRE_ARABLE = 0.5
const CENTRE_HERDS = 2
const CENTRE_PASTURE = 0.5
const KNOW_FARM = 1
const KNOW_HERD = 0.8
const CENTRE_SPACING_KM = 1500
const HERD_LAG = 1000
const FARM_KM_A = 1
const HERD_KM_A = 2
const FARM_BARRIER = 5
const HERD_BARRIER = 3
const FARM_ARABLE = 0.3
const HERD_PASTURE = 0.3
const FARM_GAIN = 100
const HERD_GAIN = 10
const MAX_TAMED = 32
const KNOW_SCALE = 1
// 3 000 (2026-10-26; 10 000 before): the foragers are thin, a region
// knew too little to cross for most of the span.
const KNOW_PEOPLE = 3000
const KNOW_GAIN = 0.1
const KNOW_LOSS = 0.02
const KNOW_CARRIED = 0.8
const REACH_START = 30
const REACH_PER_KNOW = 150
const REACH_END = 450
const CROSSING_CHANCE = 0.02
const ROUTE_SLACK_YEARS = 1000
const STONE_CELLS = 100
const STONE_CHANCE = 0.5
const CROSSINGS_A_PAIR = 32
const VOYAGE_KM = 3000

export interface SimulationInput {
  carrying: Float32Array
  origin: number
  seed: number
  // The big game (settle.ts MEGAFAUNA) as the fauna placed it (fauna.ts):
  // a code a cell, 2 and above where it lives; and how vulnerable it is,
  // 0 … 1 (MEGAFAUNA's weight: the elephant 0.8 … the aurochs 0.2).
  bigGame: { id: string; codes: Uint8Array; vulnerability: number }[]
  // The domesticable starch plants (plants.ts) and the tamable herd
  // animals (animals.ts) as the flora and the fauna placed them.
  crops: { id: string; codes: Uint8Array }[]
  herds: { id: string; codes: Uint8Array }[]
  // The rain's reliability per cell (the save's, generator/climate/
  // reliability.ts): the annual rain's coefficient of variation, the
  // ENSO see-saw's mark (−1 drier in its warm phase … +1), the see-saw's
  // strength (0 … 1); null without the save's refinement: no droughts.
  rain: { variability: Float32Array; enso: Float32Array; ensoStrength: number } | null
}

// A kept state (every KEEP_YEARS from 0): the people a km² in
// PEOPLE_FRAME_STEP steps, the small game's share in 255ths, each species
// of the big game's share in 255ths on its cells (SimulationResult
// `species`, aligned). Float32 a cell, the people alone took 241 MB on
// Morvane.
export interface SimFrame {
  people: Uint16Array
  small: Uint8Array
  big: Uint8Array[]
}
// 1e-3: the farmers reach 15 a km² and more; the foragers' 0.1 is 100 steps.
export const PEOPLE_FRAME_STEP = 1e-3

export interface SimulationResult {
  people: PeopleResult
  kept: SimFrame[]
  // The big game's species, their cells (the frames' `big` aligned).
  species: { id: string; cells: Int32Array }[]
  // The climate history's draw (climateHistory.ts).
  climate: { maxAt: number; depth: number; deglaciation: number }
  // Where a species of the big game died out (settle.ts SettleResult's
  // form): on a landmass, when its last tenth went, at a cell of it.
  extinctions: { id: string; landmass: number; areaKm2: number; at: number; cell: number }[]
  // The history's log (historyLogShared.ts), each event written when it
  // happened, in the order it happened (THE LOG).
  log: LogEvent[]
  // The farming and the herding (settle.ts SettleLifeways): the settlement
  // takes them in the rules' place.
  lifeways: SettleLifeways
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
  // Its way over the sea, `from` to `to` (crossingsOf: made for the ones
  // kept).
  path: number[]
  // Where the two searches met: a on `from`'s side, b on `to`'s.
  a: number
  b: number
}

// Each cell's distance from today's glaciers over the cold climates
// (climateHistory.ts iceMayCover), km: how soon the ice reaches it;
// Infinity where it cannot. The simulation's and the ice's overlay's.
export function iceDistance(h: Habitat): Float32Array {
  const n = h.count
  const { land, biome, koppen } = h
  const iceKm = new Float32Array(n).fill(Infinity)
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
  return iceKm
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
  // The cell each was reached from, for the ways.
  const prev = new Int32Array(n).fill(-1)
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
    for (const [from, to, sa, sb] of [[source[a], source[b], a, b], [source[b], source[a], b, a]]) {
      const key = `${from},${region[to]}`
      const known = best.get(key)
      if (!known || km < known.km) best.set(key, { from, to, km, path: [], a: sa, b: sb })
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
      prev[u] = i
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
  const kept = [...byPair.values()].flatMap((list) => list.sort((a, b) => a.km - b.km).slice(0, CROSSINGS_A_PAIR))
  // The ways: from `from` out to where the searches met, and in to `to`.
  const back = (x: number): number[] => {
    const chain: number[] = []
    for (let c = x; c >= 0; c = prev[c]) chain.push(c)
    return chain
  }
  for (const c of kept) c.path = [...back(c.a).reverse(), ...back(c.b)]
  return kept
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
  const iceKm = iceDistance(h)
  // What each cell carries now (climateHistory.ts): the cold's share of
  // today's, 0 under the ice; the shelf while the sea stands below it.
  const capacity = new Float32Array(n)
  // A cell whose carrying moved by CAPACITY_MOVED of it or more is marked
  // (`movedNow`), to grow or shrink again.
  const movedNow = new Uint8Array(n)
  const updateClimate = (t: number): void => {
    const cold = climate.cold(t)
    const drop = climate.seaDropM(t)
    for (let i = 0; i < n; i++) {
      if (base[i] <= 0) continue
      const was = capacity[i]
      capacity[i] = shelf[i] ? (seaDepthM[i] <= drop ? base[i] : 0) : base[i] * coldShare(koppen[i], iceKm[i], cold)
      movedNow[i] = Math.abs(capacity[i] - was) >= CAPACITY_MOVED * Math.max(was, capacity[i]) ? 1 : 0
    }
  }
  const habitable = (i: number): boolean => land[i] === 1 && base[i] > 0
  const { region, regions } = regionsOf(h, habitable)
  const crossings = crossingsOf(h, REACH_END, habitable, region)
  const knowledge = new Float32Array(regions)
  const regionPeople = new Float64Array(regions)
  const seafaring = new Float32Array(regions)
  const regionCells = new Int32Array(regions)
  for (let i = 0; i < n; i++) if (region[i] >= 0) regionCells[region[i]]++
  const seaKnown = (g: number): number => Math.max(knowledge[g], seafaring[g])
  // The regions joined by a crossing made, in pairs.
  const links: number[] = []
  const crossingsFrom = new Map<number, Crossing[]>()
  for (const c of crossings) {
    const list = crossingsFrom.get(c.from)
    if (list) list.push(c)
    else crossingsFrom.set(c.from, [c])
  }

  // The game, a share of the land's; big game only where a species of it
  // lives (`bigHere`). `food`: what the foragers get of what the land
  // carries, from it.
  const small = new Float32Array(n).fill(1)
  // Each species of the big game: its cells, its share in each (aligned),
  // its cells' positions by landmass (for its extinction), its rates.
  const species = input.bigGame.map((g) => {
    const cells: number[] = []
    for (let i = 0; i < n; i++) if (g.codes[i] >= 2) cells.push(i)
    const byLandmass = new Map<number, number[]>()
    cells.forEach((i, k) => {
      if (h.landmass[i] < 0) return
      const list = byLandmass.get(h.landmass[i])
      if (list) list.push(k)
      else byLandmass.set(h.landmass[i], [k])
    })
    return {
      id: g.id,
      cells: Int32Array.from(cells),
      share: new Float32Array(cells.length).fill(1),
      byLandmass,
      regrow: BIG_REGROW_A * (1.2 - g.vulnerability),
      hunt: BIG_HUNT_A * (g.vulnerability / 0.5),
      gone: new Set<number>(),
    }
  })
  // Per cell the big game's shares summed, and how many species.
  const bigSum = new Float32Array(n)
  const bigCount = new Uint8Array(n)
  for (const sp of species) for (const i of sp.cells) {
    bigSum[i] += 1
    bigCount[i]++
  }
  const homeLandmass = input.origin >= 0 ? h.landmass[input.origin] : -1
  // What the fields and the herds add, as a factor on what the land carries.
  // The rain's share this step where a famine is (THE DROUGHTS), else 1.
  const rainOf = (i: number): number => (drySquare[i] >= 0 ? squareRain[drySquare[i]] : 1)
  const gain = (i: number): number => {
    const r = rainOf(i)
    return (farmAt[i] < Infinity ? 1 + FARM_GAIN * (arable?.[i] ?? 0) * r : fishing[i] ? 1 + FISH_GAIN * (fish?.[i] ?? 0) : 1) * (herdAt[i] < Infinity ? 1 + HERD_GAIN * (pasture?.[i] ?? 0) * r : 1) * ((1 + r) / 2)
  }
  const food = (i: number): number => PLANT_FOOD + (bigCount[i] ? SMALL_FOOD * small[i] + BIG_FOOD * (bigSum[i] / bigCount[i]) : (SMALL_FOOD + BIG_FOOD) * small[i])
  const extinctions: SimulationResult['extinctions'] = []
  // The farming and the herding: when each came to a cell, its
  // domesticates there as bits, the centres, the domesticates.
  const farmAt = new Float32Array(n).fill(Infinity)
  const herdAt = new Float32Array(n).fill(Infinity)
  const tamedBits = new Uint32Array(n)
  const centres: number[] = []
  const tamed: { kind: 'plant' | 'animal'; id: string; cell: number; at: number; came: Uint16Array; codes: Uint8Array }[] = []
  // Herds a farming centre tames HERD_LAG after its fields.
  const herdsDue: { cell: number; at: number }[] = []
  // The cells that may pass the fields or the herds on.
  let farmFront: number[] = []
  let herdFront: number[] = []
  const arable = h.ecology.arable
  const pasture = h.ecology.pasture
  const fish = h.ecology.fish
  // The cells the fishers live in (THE FISHERS).
  const fishing = new Uint8Array(n)
  // The villages: [cell, lifeway], when founded and left; the village in
  // a cell, -1 for none.
  const villages: number[] = []
  const villageFrom: number[] = []
  const villageTo: number[] = []
  const villageAt = new Int32Array(n).fill(-1)
  const ringSeen = new Int32Array(n).fill(-1)
  let ringMark = 0
  const population = new Float32Array(Math.floor(SPAN_YEARS / POPULATION_STEP) + 1)
  let nextMark = 0
  // THE LOG (historyLogShared.ts): each event when it happens; which
  // landmasses people reached, for a crossing's `first`.
  const log: LogEvent[] = []
  const landmassReached = new Uint8Array(h.landmasses)
  const suits = (d: number, cell: number): boolean => {
    const c = tamed[d].codes[cell]
    return tamed[d].kind === 'plant'
      ? (c === 1 || c >= PLANT_SUITS_CODE) && (arable?.[cell] ?? 0) >= FARM_ARABLE
      : c >= 1 && (pasture?.[cell] ?? 0) >= HERD_PASTURE
  }
  // A cell takes domesticate `d` at `t`: knows it, and keeps it where it
  // suits; where not, only passes it on.
  const take = (d: number, cell: number, t: number): void => {
    if (tamedBits[cell] & (1 << d)) return
    tamedBits[cell] |= 1 << d
    // On the front for each it takes: a cell that had left it with its
    // first passed none it took later on.
    const plant = tamed[d].kind === 'plant'
    ;(plant ? farmFront : herdFront).push(cell)
    if (!suits(d, cell)) return
    tamed[d].came[cell] = Math.round(t / CAME_STEP)
    if (plant) farmAt[cell] = Math.min(farmAt[cell], t)
    else herdAt[cell] = Math.min(herdAt[cell], t)
  }
  const tame = (kind: 'plant' | 'animal', layer: { id: string; codes: Uint8Array }, cell: number, t: number): void => {
    if (tamed.length >= MAX_TAMED) return
    tamed.push({ kind, id: layer.id, cell, at: t, came: new Uint16Array(n).fill(CAME_NEVER), codes: layer.codes })
    log.push({ kind: 'domesticated', at: t, cell, id: layer.id, plant: kind === 'plant' })
    take(tamed.length - 1, cell, t)
  }
  // CENTRE_SPACING_KM from every centre of the same lifeway: the farming
  // may begin beside a herding centre (with it, a herding centre at year
  // 7 500 kept Morvane's one place fit for the fields from farming).
  const farCentre = (cell: number, way: number): boolean => {
    for (let k = 0; k < centres.length; k += 3) if (centres[k + 2] === way && kmBetween(h, cell, centres[k]) < CENTRE_SPACING_KM) return false
    return true
  }
  // The cells hunted, kept while their game grows back.
  let hunted: number[] = []
  const inHunted = new Uint8Array(n)
  const people = new Float32Array(n)
  const arrival = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  // [landmass, cell landed on, time, km] and [from, to, -1] each crossing
  // made (PeopleResult's crossings and crossingWays).
  const made: number[] = []
  const ways: number[] = []
  const kept: SimFrame[] = []
  // A step touches two lists alone: the cells still growing or shrinking
  // (until within FULL_SHARE of what they carry), and the front — lived-in
  // cells with an empty neighbour people could settle. Over all the
  // lived-in cells a run took 40 s on Morvane. Both are made again from
  // all the lived-in cells when the climate moves (CLIMATE_YEARS).
  let growing: number[] = []
  // A cell on `growing` once at most.
  const inGrowing = new Uint8Array(n)
  const grows = (cell: number): void => {
    if (inGrowing[cell]) return
    inGrowing[cell] = 1
    growing.push(cell)
  }
  let front: number[] = []
  let lived: number[] = []
  // A cell is settled once it has people; one left (the ice, the sea over
  // the shelf) may be settled again. Its arrival is the first.
  const settle = (cell: number, t: number, density: number, parent: number): void => {
    people[cell] = density
    if (arrival[cell] === Infinity) {
      arrival[cell] = t
      from[cell] = parent
      if (h.landmass[cell] >= 0) landmassReached[h.landmass[cell]] = 1
    }
    grows(cell)
    front.push(cell)
    lived.push(cell)
  }
  const open = (u: number): boolean => people[u] === 0 && capacity[u] > 0
  updateClimate(0)
  if (input.origin >= 0 && capacity[input.origin] > 0) {
    settle(input.origin, 0, capacity[input.origin] * SEED_SHARE, -1)
    log.push({ kind: 'departure', at: 0, cell: input.origin })
  }

  // The droughts' squares (THE DROUGHTS): their cells, their mean
  // variability and ENSO mark, their anomaly, rain, dry steps in a row, and
  // the famine going on in each.
  const drySquare = new Int32Array(n).fill(-1)
  const squareCells: number[][] = []
  if (input.rain) {
    const ids = new Map<string, number>()
    const rows = Math.max(1, Math.round((h.radiusKm > 0 ? Math.PI * h.radiusKm : h.heightKm) / DRY_SQUARE_KM))
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue
      const row = Math.min(rows - 1, Math.floor(h.v[i] * rows))
      const around = h.radiusKm > 0 ? 2 * Math.PI * h.radiusKm * Math.cos((0.5 - (row + 0.5) / rows) * Math.PI) : h.widthKm
      const cols = Math.max(1, Math.round(around / DRY_SQUARE_KM))
      const key = `${h.landmass[i]} ${row} ${Math.min(cols - 1, Math.floor(h.u[i] * cols))}`
      let id = ids.get(key)
      if (id === undefined) {
        id = squareCells.length
        ids.set(key, id)
        squareCells.push([])
      }
      drySquare[i] = id
      squareCells[id].push(i)
    }
  }
  const squares = squareCells.length
  const squareVariability = new Float32Array(squares)
  const squareEnso = new Float32Array(squares)
  for (let q = 0; q < squares; q++) {
    for (const i of squareCells[q]) {
      squareVariability[q] += input.rain!.variability[i] / squareCells[q].length
      squareEnso[q] += input.rain!.enso[i] / squareCells[q].length
    }
  }
  const anomaly = new Float32Array(squares)
  const squareRain = new Float32Array(squares).fill(1)
  const dryRun = new Int32Array(squares)
  const famine: ({ at: number; cell: number; before: number; lost: number; left: number; villages: number } | null)[] = new Array(squares).fill(null)
  // The cells around each square, outside it: where its people flee to.
  const squareRim: number[][] = squareCells.map((cells, q) => {
    const rim = new Set<number>()
    for (const i of cells) for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) if (drySquare[h.nbr[e]] !== q && base[h.nbr[e]] > 0) rim.add(h.nbr[e])
    return [...rim]
  })
  const endFamine = (q: number, t: number): void => {
    const f = famine[q]
    famine[q] = null
    if (!f || f.cell < 0) return
    log.push({ kind: 'famine', at: f.at, to: t, cell: f.cell, landmass: h.landmass[f.cell], before: f.before, lost: f.lost, left: f.left, villages: f.villages })
  }
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())

  const steps = Math.round(SPAN_YEARS / STEP_YEARS)
  const subYears = STEP_YEARS / SUB_STEPS
  const grow = 1 - Math.exp(-GROWTH_A * STEP_YEARS)
  for (let s = 0; s <= steps; s++) {
    const t = s * STEP_YEARS
    if (t % KEEP_YEARS === 0) {
      const frame: SimFrame = { people: new Uint16Array(n), small: new Uint8Array(n), big: species.map((sp) => new Uint8Array(sp.share.length)) }
      for (let i = 0; i < n; i++) {
        const p = people[i] / PEOPLE_FRAME_STEP
        frame.people[i] = p > 65535 ? 65535 : p + 0.5
        frame.small[i] = small[i] * 255 + 0.5
      }
      species.forEach((sp, k) => {
        for (let j = 0; j < sp.share.length; j++) frame.big[k][j] = sp.share[j] * 255 + 0.5
      })
      kept.push(frame)
    }
    if (t % POPULATION_STEP === 0) {
      let sum = 0
      for (const i of lived) sum += people[i] * h.areaKm2[i]
      population[t / POPULATION_STEP] = sum
      // The marks passed since the last count, at the time between.
      const last = t > 0 ? population[t / POPULATION_STEP - 1] : 0
      while (nextMark < POPULATION_MARKS.length && sum >= POPULATION_MARKS[nextMark]) {
        const mark = POPULATION_MARKS[nextMark++]
        let standing = 0
        for (const to of villageTo) if (to === Infinity) standing++
        const at = t > 0 ? t - POPULATION_STEP * (1 - (mark - last) / Math.max(1e-9, sum - last)) : 0
        log.push({ kind: 'population', at, cell: input.origin, count: mark, villages: standing, centres: centres.length / 3 })
      }
    }
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
      for (const i of still) if (movedNow[i]) grows(i)
      front = still.slice()
      // The big game's extinctions: a species under EXTINCT_BELOW of its
      // own on a landmass.
      for (const sp of species) {
        for (const [m, at] of sp.byLandmass) {
          if (sp.gone.has(m)) continue
          let sum = 0
          for (const k of at) sum += sp.share[k]
          if (sum >= EXTINCT_BELOW * at.length) continue
          sp.gone.add(m)
          extinctions.push({ id: sp.id, landmass: m, areaKm2: h.landmassKm2[m], at: t, cell: sp.cells[at[0]] })
          log.push({ kind: 'extinct', at: t, cell: sp.cells[at[0]], landmass: m, id: sp.id })
        }
      }
      // The knowledge, toward what each region's people keep.
      regionPeople.fill(0)
      for (const i of lived) if (region[i] >= 0) regionPeople[region[i]] += people[i] * h.areaKm2[i]
      for (let g = 0; g < regions; g++) {
        const target = KNOW_SCALE * Math.log10(1 + regionPeople[g] / KNOW_PEOPLE)
        knowledge[g] += (target - knowledge[g]) * (target > knowledge[g] ? KNOW_GAIN : KNOW_LOSS)
      }
      for (let k = 0; k < links.length; k += 2) {
        const a = links[k]
        const b = links[k + 1]
        const most = Math.max(seaKnown(a), seaKnown(b))
        seafaring[a] = Math.max(seafaring[a], most)
        seafaring[b] = Math.max(seafaring[b], most)
      }
      // The centres: each region's best cell for the farming and for the
      // herding, by a chance.
      const bestFarm = new Map<number, { cell: number; w: number }>()
      const bestHerd = new Map<number, { cell: number; w: number }>()
      const stable = climate.stable(t)
      // A domesticate is tamed once on a landmass: a centre counts only the
      // wild ones not tamed there yet (each centre tamed its own; on
      // Morvane the horse five times, five herding centres, 2026-10-26).
      const tamedOn = new Set<string>()
      for (const d of tamed) tamedOn.add(`${d.id} ${h.landmass[d.cell]}`)
      const wildHere = (id: string, i: number): boolean => !tamedOn.has(`${id} ${h.landmass[i]}`)
      for (const i of lived) {
        const g = region[i]
        if (g < 0 || people[i] === 0 || arrival[i] > t - SETTLED_YEARS) continue
        if (stable && farmAt[i] === Infinity && knowledge[g] >= KNOW_FARM && (arable?.[i] ?? 0) >= CENTRE_ARABLE) {
          let wild = 0
          for (const crop of input.crops) if (crop.codes[i] >= PLANT_SUITS_CODE && wildHere(crop.id, i)) wild++
          const w = wild >= CENTRE_CROPS ? (wild / 2) * (arable?.[i] ?? 0) : 0
          if (w > (bestFarm.get(g)?.w ?? 0)) bestFarm.set(g, { cell: i, w })
        }
        if (stable && herdAt[i] === Infinity && knowledge[g] >= KNOW_HERD && (pasture?.[i] ?? 0) >= CENTRE_PASTURE) {
          let wild = 0
          for (const herd of input.herds) if (herd.codes[i] >= 2 && wildHere(herd.id, i)) wild++
          const w = wild >= CENTRE_HERDS ? (wild / 2) * (pasture?.[i] ?? 0) : 0
          if (w > (bestHerd.get(g)?.w ?? 0)) bestHerd.set(g, { cell: i, w })
        }
      }
      for (const { cell, w } of bestFarm.values()) {
        if (random() >= FARM_RATE * Math.min(1, w) || !farCentre(cell, LIFEWAY.farmers)) continue
        centres.push(cell, t, LIFEWAY.farmers)
        log.push({ kind: 'centre', at: t, cell, lifeway: LIFEWAY.farmers })
        for (const crop of input.crops) if (crop.codes[cell] >= PLANT_SUITS_CODE && wildHere(crop.id, cell)) tame('plant', crop, cell, t)
        herdsDue.push({ cell, at: t + HERD_LAG })
        grows(cell)
      }
      for (const { cell, w } of bestHerd.values()) {
        if (random() >= HERD_RATE * Math.min(1, w) || !farCentre(cell, LIFEWAY.herders)) continue
        centres.push(cell, t, LIFEWAY.herders)
        log.push({ kind: 'centre', at: t, cell, lifeway: LIFEWAY.herders })
        for (const herd of input.herds) if (herd.codes[cell] >= 2 && wildHere(herd.id, cell)) tame('animal', herd, cell, t)
        grows(cell)
      }
      for (let k = herdsDue.length - 1; k >= 0; k--) {
        if (herdsDue[k].at > t) continue
        const { cell } = herdsDue[k]
        for (const herd of input.herds) if (herd.codes[cell] >= 2 && wildHere(herd.id, cell)) tame('animal', herd, cell, t)
        herdsDue.splice(k, 1)
        grows(cell)
      }
      // The fishers, the villages (THE FISHERS, THE VILLAGES).
      for (const i of lived) {
        if (fishing[i] || (fish?.[i] ?? 0) < FISH_RICH || arrival[i] > t - SETTLE_AFTER) continue
        fishing[i] = 1
        grows(i)
      }
      for (let v = 0; v < villageTo.length; v++) {
        const cell = villages[2 * v]
        if (villageTo[v] < Infinity || people[cell] >= VILLAGE_LEAST[villages[2 * v + 1]] * VILLAGE_LEAVE) continue
        villageTo[v] = t
        villageAt[cell] = -1
        log.push({ kind: 'villageLeft', at: t, cell, village: v })
      }
      for (const i of lived) {
        const way = farmAt[i] <= t ? LIFEWAY.farmers : fishing[i] ? LIFEWAY.fishers : LIFEWAY.none
        if (way === LIFEWAY.none || villageAt[i] >= 0 || people[i] < VILLAGE_LEAST[way]) continue
        let top = true
        for (const u of ringsAround(h, i, VILLAGE_RADIUS[way], ringSeen, ++ringMark)) {
          if (u !== i && (villageAt[u] >= 0 || people[u] > people[i] || (people[u] === people[i] && u < i))) {
            top = false
            break
          }
        }
        if (!top) continue
        villageAt[i] = villageTo.length
        log.push({ kind: 'village', at: t, cell: i, village: villageTo.length, lifeway: way })
        villages.push(i, way)
        villageFrom.push(t)
        villageTo.push(Infinity)
      }
    }
    // 0b. The game, every GAME_STEPS: hunted where people live, grown back
    //     where they hunted; the cells people live in grow or shrink by it.
    if (s % GAME_STEPS === 0) {
      const years = GAME_STEPS * STEP_YEARS
      for (const i of lived) {
        if (people[i] > 0 && !inHunted[i]) {
          inHunted[i] = 1
          hunted.push(i)
        }
      }
      const stillHunted: number[] = []
      // The cells whose food moved by FOOD_MOVED or more grow or shrink again.
      const moved: number[] = []
      const before = hunted.map(food)
      for (const i of hunted) {
        const pressure = people[i] / FORAGER_DENSITY
        small[i] = Math.max(0.01, Math.min(1, small[i] + years * (SMALL_REGROW_A * small[i] * (1 - small[i]) - HUNT_A * pressure * small[i])))
      }
      // Each species over its cells hunted or growing back.
      for (const sp of species) {
        for (let k = 0; k < sp.cells.length; k++) {
          const i = sp.cells[k]
          const was = sp.share[k]
          if (people[i] === 0 && was >= 0.999) continue
          const pressure = people[i] / FORAGER_DENSITY
          const wary = h.landmass[i] === homeLandmass ? HOME_WARY : 1
          const now = Math.max(0.001, Math.min(1, was + years * (sp.regrow * was * (1 - was) - sp.hunt * wary * pressure * was)))
          sp.share[k] = now
          bigSum[i] += now - was
        }
      }
      hunted.forEach((i, k) => {
        if (people[i] > 0 || small[i] < 0.99 || (bigCount[i] && bigSum[i] < 0.99 * bigCount[i])) stillHunted.push(i)
        else inHunted[i] = 0
        if (people[i] > 0 && Math.abs(food(i) - before[k]) >= FOOD_MOVED) moved.push(i)
      })
      hunted = stillHunted
      for (const i of moved) grows(i)
    }
    // 0c. The droughts (THE DROUGHTS).
    if (squares > 0) {
      const enso = random() < ENSO_CHANCE * input.rain!.ensoStrength ? ENSO_PUSH : 0
      const spread = Math.sqrt(1 - DRY_KEEP * DRY_KEEP)
      for (let q = 0; q < squares; q++) {
        anomaly[q] = DRY_KEEP * anomaly[q] + spread * gauss() + enso * squareEnso[q]
        const wet = 1 + DRY_SCALE * squareVariability[q] * anomaly[q]
        if (wet < DRY_BELOW) dryRun[q]++
        else {
          dryRun[q] = 0
          endFamine(q, t)
        }
        const r = dryRun[q] > STORE_STEPS ? Math.max(0, wet) : 1
        if (r === squareRain[q]) continue
        squareRain[q] = r
        for (const i of squareCells[q]) if (people[i] > 0) grows(i)
        if (r === 1) continue
        // The famine: of those the land does not carry now, some die, the
        // rest flee (THE FLIGHT).
        let lost = 0
        let most = -1
        let before = 0
        let fleeing = 0
        for (const i of squareCells[q]) {
          if (people[i] === 0) continue
          before += people[i] * h.areaKm2[i]
          if (most < 0 || people[i] > people[most]) most = i
          const k = capacity[i] * food(i) * gain(i)
          if (people[i] <= k) continue
          const over = (people[i] - k) * h.areaKm2[i]
          lost += FAMINE_DEATH * over
          fleeing += (1 - FAMINE_DEATH) * over
          people[i] = k
        }
        // Their room around the square, people.
        let room = 0
        const rooms: number[] = []
        for (const u of squareRim[q]) {
          const free = rainOf(u) < 1 || capacity[u] <= 0 ? 0 : Math.max(0, (FLIGHT_CROWD * capacity[u] * food(u) * gain(u) - people[u]) * h.areaKm2[u])
          rooms.push(free)
          room += free
        }
        const fled = Math.min(fleeing, room)
        lost += fleeing - fled
        if (fled > 0) {
          squareRim[q].forEach((u, k) => {
            if (rooms[k] <= 0) return
            const density = (rooms[k] * fled) / room / h.areaKm2[u]
            if (people[u] === 0) settle(u, t, density, most)
            else {
              people[u] += density
              grows(u)
            }
          })
        }
        let left = 0
        for (let v = 0; v < villageTo.length; v++) {
          const cell = villages[2 * v]
          if (villageTo[v] < Infinity || drySquare[cell] !== q || people[cell] >= VILLAGE_LEAST[villages[2 * v + 1]] * VILLAGE_LEAVE) continue
          villageTo[v] = t
          villageAt[cell] = -1
          log.push({ kind: 'villageLeft', at: t, cell, village: v })
          left++
        }
        const f = famine[q] ?? (famine[q] = { at: t, cell: most, before, lost: 0, left: 0, villages: 0 })
        f.lost += lost
        f.left += fled
        f.villages += left
        if (f.cell < 0) f.cell = most
      }
    }
    // 1. Growth, or shrinking toward less; a cell near what it carries
    //    leaves the list.
    const stillGrowing: number[] = []
    for (const i of growing) {
      const k = capacity[i] * food(i) * gain(i)
      if (people[i] > 0) people[i] += (k - people[i]) * grow
      if (people[i] > 0 && Math.abs(k - people[i]) > (1 - FULL_SHARE) * k) stillGrowing.push(i)
      else inGrowing[i] = 0
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
          if (people[i] < SEED_SHARE * capacity[i] * food(i)) continue
          const chance = Math.min(1, (speed[u] * subYears) / h.distKm[e])
          if (random() < chance) settle(u, at, capacity[u] * SEED_PEOPLE, i)
        }
        if (openLeft) stillFront.push(i)
      }
      // The newly settled, pushed onto `front` by settle, follow.
      for (let k = count; k < front.length; k++) stillFront.push(front[k])
      front = stillFront
    }
    // 2b. The fields and the herds, passed on to the lived-in neighbours
    //     they suit; a front cell with nothing left to pass leaves.
    const passOn = (frontList: number[], kmA: number, plant: boolean): number[] => {
      const still: number[] = []
      const count = frontList.length
      for (let k = 0; k < count; k++) {
        const i = frontList[k]
        let left = false
        for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
          const u = h.nbr[e]
          if (people[u] === 0) continue
          for (let d = 0; d < tamed.length; d++) {
            if (!(tamedBits[i] & (1 << d)) || (tamedBits[u] & (1 << d)) || (tamed[d].kind === 'plant') !== plant) continue
            left = true
            const barrier = suits(d, u) ? 1 : plant ? FARM_BARRIER : HERD_BARRIER
            if (random() < Math.min(1, (kmA * STEP_YEARS) / (h.distKm[e] * barrier))) {
              take(d, u, t + STEP_YEARS)
              grows(u)
            }
          }
        }
        if (left) still.push(i)
      }
      return still
    }
    if (farmFront.length > 0) {
      const added = farmFront.length
      const kept0 = passOn(farmFront.slice(0, added), FARM_KM_A, true)
      farmFront = kept0.concat(farmFront.slice(added))
    }
    if (herdFront.length > 0) {
      const added = herdFront.length
      const kept0 = passOn(herdFront.slice(0, added), HERD_KM_A, false)
      herdFront = kept0.concat(herdFront.slice(added))
    }
    // 3. The crossings within the reach of their coast's knowledge.
    for (const [source, list] of crossingsFrom) {
      // An empty coast sets out on none: where it carries nothing (the
      // ice) the share alone was 0 ≤ 0, and coasts never reached set out
      // (2026-10-26; a third of Morvane's crossings, and `from` in circles).
      const stone = regionCells[region[source]] < STONE_CELLS
      if (people[source] === 0 || (!stone && people[source] < SEED_SHARE * capacity[source] * food(source))) continue
      const known = seaKnown(region[source])
      const reach = Math.min(REACH_END, REACH_START + REACH_PER_KNOW * known)
      for (const c of list) {
        if (c.km > reach || !open(c.to) || arrival[c.to] < Infinity) continue
        if (random() < (stone ? STONE_CHANCE : CROSSING_CHANCE)) {
          // The way over the sea is passed (an arrival and a from, as the
          // rules' crossings have them), so the routes follow it. A land
          // cell on the way is a parent only once reached.
          let parent = c.from
          for (const cell of c.path) {
            if (cell === c.from || cell === c.to) continue
            if (!land[cell] && arrival[cell] === Infinity) {
              arrival[cell] = t + STEP_YEARS
              from[cell] = parent
            }
            if (arrival[cell] < Infinity) parent = cell
          }
          const landed = h.landmass[c.to]
          log.push({ kind: 'crossing', at: t + STEP_YEARS, cell: c.to, landmass: landed, km: c.km, first: landed >= 0 && !landmassReached[landed] })
          settle(c.to, t + STEP_YEARS, capacity[c.to] * SEED_PEOPLE, parent)
          const to = region[c.to]
          knowledge[to] = Math.max(knowledge[to], KNOW_CARRIED * knowledge[region[source]])
          seafaring[to] = Math.max(seafaring[to], known)
          links.push(region[source], to)
          made.push(h.landmass[c.to], c.to, t + STEP_YEARS, c.km)
          ways.push(...c.path, -1)
        }
      }
    }
    if (onProgress && s % 100 === 0) onProgress(s / steps)
  }
  for (let q = 0; q < squares; q++) endFamine(q, SPAN_YEARS)
  // THE ROUTES' TREE (2026-10-26), made after the run: the shortest ways
  // from the origin over the cells reached (the quickest, at the cells'
  // speeds, ran along the rivers and the coasts in zigzags), never to a
  // cell settled more
  // than ROUTE_SLACK_YEARS before the one it leaves — the history's order
  // kept, its chance not. `from` as settled (each cell to the neighbour that
  // settled it, by a chance) drew the routes as hair. A cell the ways do not
  // reach keeps the settling's parent.
  const routeFrom = new Int32Array(n).fill(-1)
  const cost = new Float64Array(n).fill(Infinity)
  const popped: number[] = []
  if (input.origin >= 0 && arrival[input.origin] < Infinity) {
    const heap = new MinHeap(1 << 16)
    cost[input.origin] = 0
    heap.push(0, input.origin)
    while (heap.length > 0) {
      heap.pop()
      const i = heap.poppedIndex
      const d = heap.poppedKey
      if (d > cost[i]) continue
      popped.push(i)
      for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
        const u = h.nbr[e]
        if (!(arrival[u] < Infinity) || arrival[u] < arrival[i] - ROUTE_SLACK_YEARS) continue
        const nd = d + h.distKm[e]
        if (nd >= cost[u]) continue
        cost[u] = nd
        routeFrom[u] = i
        heap.push(nd, u)
      }
    }
  }
  // The routes' weights: each land cell reached counts once on its way
  // back — the cells the ways missed first (on the settling's parents, the
  // latest first), then the ways' from their ends in.
  const flow = new Float32Array(n)
  const missed: number[] = []
  for (let i = 0; i < n; i++) {
    if (!(arrival[i] < Infinity) || cost[i] < Infinity) continue
    routeFrom[i] = from[i]
    missed.push(i)
  }
  missed.sort((a, b) => arrival[b] - arrival[a])
  for (const i of missed) {
    if (land[i]) flow[i] += 1
    if (routeFrom[i] >= 0) flow[routeFrom[i]] += flow[i]
  }
  for (let k = popped.length - 1; k >= 0; k--) {
    const i = popped[k]
    if (land[i]) flow[i] += 1
    if (routeFrom[i] >= 0) flow[routeFrom[i]] += flow[i]
  }
  return {
    people: { arrival, land, from: routeFrom, flow, origin: input.origin, crossings: Float32Array.from(made), crossingWays: Int32Array.from(ways) },
    kept,
    climate: { maxAt: climate.maxAt, depth: climate.depth, deglaciation: climate.deglaciation },
    species: species.map((sp) => ({ id: sp.id, cells: sp.cells })),
    lifeways: {
      centres: Float32Array.from(centres),
      farmAt,
      herdAt,
      domestications: tamed.map(({ kind, id, cell, at, came }) => ({ kind, id, cell, at, came })),
      villages: { villages: Int32Array.from(villages), villageFrom: Float32Array.from(villageFrom), villageTo: Float32Array.from(villageTo) },
      population,
    },
    extinctions,
    log,
    region,
    knowledge,
    ms: Math.round(performance.now() - started),
  }
}

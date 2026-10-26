import { hashText, mulberry32, readHabitat, type HabitatInput } from './habitat'
import { SPAN_YEARS } from './peopleShared'
import { MinHeap } from '../../generator/core/minHeap'
import { CARRYING_FULL, densityAt, GOODS, lifewayAt, lifewaySince, type SettleTimes } from './settleShared'

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
//    over the sea, not ahead of the people.
// 3. THE LIFEWAYS AND THE DENSITY over the time (settleShared.ts): the
//    end state's, 5 000 years before the game, places the villages: where
//    farmers or fishers live, the cells densest within VILLAGE_RADIUS of
//    them; a village is there from its lifeway's start.
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


export interface SettleWorkerInbound extends HabitatInput {
  // How many domesticable starch plants grow in a cell; whether a tamable
  // herd animal lives there.
  // Years from the departure to the arrival (peopleWorker.ts); Infinity
  // where none came.
  arrival: Float32Array
  carrying: Float32Array
  farmPlant: Uint8Array
  herdAnimal: Uint8Array
  // The people's origin cell; the animals as the fauna placed them
  // (animalWorker.ts), their codes copied in: where they live.
  origin: number
  animals: { id: string; codes: Uint8Array }[]
}

export interface SettleResult {
  // The end state's lifeway and density.
  lifeway: Uint8Array
  density: Float32Array
  // The times the lifeways follow (settleShared.ts), the arrival aside.
  farmAt: Float32Array
  herdOk: Uint8Array
  fishOk: Uint8Array
  carrying: Float32Array
  // [cell, time] a centre of the farming, the time it began there.
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

export type SettleWorkerOutbound =
  | ({ type: 'settled'; ms: number } & SettleResult)
  | { type: 'failed'; message: string }

const FARM_ARABLE = 0.3
const HERD_PASTURE = 0.3
const FISH_RICH = 0.5
const VILLAGE_RADIUS: Record<number, number> = { 2: 5, 4: 3 }
// Below this many people a km², no village.
const VILLAGE_LEAST: Record<number, number> = { 2: 0.3, 4: 2 }
const LINKS = 3
const LINK_KM = 150
const SOURCE_RICH = 0.6
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
// The big game and its chance to die out where people came new.
const MEGAFAUNA: Record<string, number> = { elephant: 0.8, horse: 0.6, bison: 0.5, camel: 0.5, buffalo: 0.3, aurochs: 0.2, bear: 0.2 }
const EXTINCT_AFTER = 2000
const ISLAND_KM2 = 1_000_000
const ISLAND_CHANCE = 1.5

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<SettleWorkerInbound>): void => {
  try {
    const started = performance.now()
    const result = settle(event.data)
    worker.postMessage({ type: 'settled', ms: Math.round(performance.now() - started), ...result } satisfies SettleWorkerOutbound, [result.lifeway.buffer, result.density.buffer, result.farmAt.buffer, result.herdOk.buffer, result.fishOk.buffer, result.carrying.buffer, result.centres.buffer, result.villageFrom.buffer, result.villages.buffer, result.sources.buffer, result.links.buffer, result.landmass.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies SettleWorkerOutbound)
  }
}

function settle(message: SettleWorkerInbound): SettleResult {
  const { width: W, height: H, arrival, carrying, farmPlant, herdAnimal } = message
  const eco = message.ecology ?? {}
  const n = W * H
  const h = readHabitat(message)
  const { land, dxKm, dyKm } = h
  const at = (field: Float32Array | undefined, i: number): number => (field ? field[i] : 0)

  const kmBetween = (a: number, b: number): number => {
    const ay = Math.floor(a / W)
    const by = Math.floor(b / W)
    let dx = Math.abs((a % W) - (b % W))
    dx = Math.min(dx, W - dx)
    return Math.hypot(dx * dxKm[Math.min(H - 1, Math.floor((ay + by) / 2))], (by - ay) * dyKm)
  }

  // 1. What each reached land cell allows.
  const farmOk = new Uint8Array(n)
  const herdOk = new Uint8Array(n)
  const fishOk = new Uint8Array(n)
  const carryingNorm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || !(arrival[i] < Infinity)) continue
    if (farmPlant[i] && at(eco.arable, i) >= FARM_ARABLE) farmOk[i] = 1
    if (herdAnimal[i] && at(eco.pasture, i) >= HERD_PASTURE) herdOk[i] = 1
    if (at(eco.fish, i) >= FISH_RICH) fishOk[i] = 1
    carryingNorm[i] = Math.min(2, carrying[i] / CARRYING_FULL)
  }

  // 2. The farming's centres, then its spread.
  const candidates: { cell: number; score: number }[] = []
  for (let i = 0; i < n; i++) {
    if (!farmOk[i] || farmPlant[i] < CENTRE_PLANTS || at(eco.arable, i) < CENTRE_ARABLE || arrival[i] > FARM_EARLIEST - FARM_SETTLED) continue
    candidates.push({ cell: i, score: farmPlant[i] * at(eco.arable, i) * carrying[i] })
  }
  candidates.sort((p, q) => q.score - p.score || p.cell - q.cell)
  const centres: number[] = []
  const random = mulberry32(hashText('farming') ^ message.seed)
  let next = FARM_EARLIEST
  for (const c of candidates) {
    if (centres.length / 2 >= CENTRES_MAX) break
    let far = true
    for (let k = 0; k < centres.length && far; k += 2) far = kmBetween(c.cell, centres[k]) >= CENTRE_SPACING_KM
    if (!far) continue
    centres.push(c.cell, Math.max(next, arrival[c.cell] + FARM_SETTLED))
    next += 1000 + 2000 * random()
  }
  const farmAt = new Float32Array(n).fill(Infinity)
  {
    const time = new Float64Array(n).fill(Infinity)
    const heap = new MinHeap(1 << 16)
    for (let k = 0; k < centres.length; k += 2) {
      if (centres[k + 1] > SPAN_YEARS) continue
      time[centres[k]] = centres[k + 1]
      heap.push(centres[k + 1], centres[k])
    }
    while (heap.length > 0) {
      heap.pop()
      const i = heap.poppedIndex
      const t = heap.poppedKey
      if (t > time[i]) continue
      if (farmOk[i]) farmAt[i] = t
      const x = i % W
      const y = Math.floor(i / W)
      for (let j = -1; j <= 1; j++) {
        const yy = y + j
        if (!h.torus && (yy < 0 || yy >= H)) continue
        for (let k = -1; k <= 1; k++) {
          if (k === 0 && j === 0) continue
          const u = h.clampY(yy) * W + h.wrapX(x + k)
          if (!land[u] || !(arrival[u] < Infinity)) continue
          const km = Math.hypot(k * dxKm[y], j * dyKm)
          const step = (km / FARM_KM_A) * (farmOk[u] ? 1 : FARM_BARRIER)
          const at2 = Math.max(t + step, arrival[u])
          if (at2 >= time[u] || at2 > SPAN_YEARS) continue
          time[u] = at2
          heap.push(at2, u)
        }
      }
    }
  }

  // 3. The end state's lifeway and density.
  const times: SettleTimes = { arrival, farmAt, herdOk, fishOk, carrying: carryingNorm }
  const lifeway = new Uint8Array(n)
  const density = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    lifeway[i] = lifewayAt(times, i, SPAN_YEARS)
    density[i] = densityAt(times, i, SPAN_YEARS)
  }

  // 3. The villages: the densest cell within its radius, ties to the lower
  // index.
  const villageCells: number[] = []
  const villageWays: number[] = []
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const way = lifeway[i]
      const r = VILLAGE_RADIUS[way]
      if (!r || density[i] < VILLAGE_LEAST[way]) continue
      let top = true
      for (let j = -r; j <= r && top; j++) {
        const yy = y + j
        if (yy < 0 || yy >= H) continue
        for (let k = -r; k <= r && top; k++) {
          const u = yy * W + h.wrapX(x + k)
          if (u !== i && (density[u] > density[i] || (density[u] === density[i] && u < i))) top = false
        }
      }
      if (top) {
        villageCells.push(i)
        villageWays.push(way)
      }
    }
  }

  // 4. The links: each village's LINKS nearest within LINK_KM, by a grid of
  // buckets a LINK_KM wide.
  const kmPerCell = dyKm
  const bucket = Math.max(1, Math.ceil(LINK_KM / kmPerCell))
  const bw = Math.ceil(W / bucket)
  const bh = Math.ceil(H / bucket)
  const buckets = new Map<number, number[]>()
  villageCells.forEach((c, v) => {
    const key = Math.floor(Math.floor(c / W) / bucket) * bw + Math.floor((c % W) / bucket)
    const list = buckets.get(key)
    if (list) list.push(v)
    else buckets.set(key, [v])
  })
  const edges = new Map<string, [number, number]>()
  const neighbours: number[][] = villageCells.map(() => [])
  villageCells.forEach((c, v) => {
    const by = Math.floor(Math.floor(c / W) / bucket)
    const bx = Math.floor((c % W) / bucket)
    const near: { v: number; km: number }[] = []
    for (let j = -1; j <= 1; j++) {
      if (by + j < 0 || by + j >= bh) continue
      for (let k = -1; k <= 1; k++) {
        for (const u of buckets.get((by + j) * bw + ((bx + k + bw) % bw)) ?? []) {
          if (u === v) continue
          const km = kmBetween(c, villageCells[u])
          if (km <= LINK_KM) near.push({ v: u, km })
        }
      }
    }
    near.sort((p, q) => p.km - q.km)
    for (const { v: u } of near.slice(0, LINKS)) {
      const key = v < u ? `${v},${u}` : `${u},${v}`
      if (edges.has(key)) continue
      edges.set(key, v < u ? [v, u] : [u, v])
      neighbours[v].push(u)
      neighbours[u].push(v)
    }
  })

  // The sources: the richest cell of a good within SOURCE_RADIUS, reached
  // by people; its goods leave from the village nearest to it.
  const sources: number[] = []
  GOODS.forEach((good, g) => {
    const field = eco[good]
    if (!field) return
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (field[i] < SOURCE_RICH || !lifeway[i]) continue
        let top = true
        for (let j = -SOURCE_RADIUS; j <= SOURCE_RADIUS && top; j++) {
          const yy = y + j
          if (yy < 0 || yy >= H) continue
          for (let k = -SOURCE_RADIUS; k <= SOURCE_RADIUS && top; k++) {
            const u = yy * W + h.wrapX(x + k)
            if (u !== i && (field[u] > field[i] || (field[u] === field[i] && u < i))) top = false
          }
        }
        if (top) sources.push(i, g)
      }
    }
  })
  // The goods down the line: from each source's nearest village, a step of
  // the links less each hop.
  const weight = new Map<string, number>()
  for (let s = 0; s < sources.length; s += 2) {
    const c = sources[s]
    let start = -1
    let best = Infinity
    const by = Math.floor(Math.floor(c / W) / bucket)
    const bx = Math.floor((c % W) / bucket)
    for (let j = -1; j <= 1; j++) {
      if (by + j < 0 || by + j >= bh) continue
      for (let k = -1; k <= 1; k++) {
        for (const u of buckets.get((by + j) * bw + ((bx + k + bw) % bw)) ?? []) {
          const km = kmBetween(c, villageCells[u])
          if (km < best) {
            best = km
            start = u
          }
        }
      }
    }
    if (start < 0) continue
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
  const extinctions = dyingOut(message, h)
  return { lifeway, density, farmAt, herdOk, fishOk, carrying: carryingNorm, centres: Float32Array.from(centres), villages: Int32Array.from(villages), villageFrom, sources: Int32Array.from(sources), links: Float32Array.from(links), extinctions, landmass: Int32Array.from(h.landmass) }
}

// 5. The animals after the people.
function dyingOut(message: SettleWorkerInbound, h: ReturnType<typeof readHabitat>): SettleResult['extinctions'] {
  const { arrival, origin, seed } = message
  const n = message.width * message.height
  const home = origin >= 0 ? h.landmass[origin] : -1
  // Each landmass's first people.
  const first = new Float64Array(h.landmasses).fill(Infinity)
  for (let i = 0; i < n; i++) if (h.landmass[i] >= 0 && arrival[i] < first[h.landmass[i]]) first[h.landmass[i]] = arrival[i]
  const extinctions: SettleResult['extinctions'] = []
  for (const animal of message.animals) {
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

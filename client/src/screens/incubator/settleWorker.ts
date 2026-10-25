import { readHabitat, type HabitatInput } from './habitat'
import { GOODS, LIFEWAY } from './settleShared'

// THE INCUBATOR'S SETTLEMENT (2026-10-25, a proof of concept): the people's
// end state, 5 000 years before the game — how they live in each cell they
// reached, how many, their villages and the trade between them. Simple
// rules, to see what it could look like; the time along the spread, and the
// numbers, are for later.
//
// 1. THE LIFEWAY of a reached land cell, the first that holds:
//    farmers   a domesticable starch plant grows there, the arable land is
//              FARM_ARABLE or more;
//    herders   a tamable herd animal lives there, the pasture is HERD_PASTURE
//              or more;
//    fishers   the ecology's fish is FISH_RICH or more: sedentary, as the
//              earth's rich coasts' foragers were (the Jōmon);
//    foragers  else: mobile bands.
// 2. THE DENSITY, people a km²: the carrying capacity over CARRYING_FULL,
//    times the lifeway's DENSITY (the earth's: foragers some 0.01 to 0.2,
//    herders 0.5 to 3, farmers 10 to 100).
// 3. THE VILLAGES: where farmers or fishers live, the cells densest within
//    VILLAGE_RADIUS of them.
// 4. THE TRADE: each village linked to its LINKS nearest within LINK_KM;
//    from the sources of tool stone, salt and copper (the ecology's fields
//    at SOURCE_RICH or more, one a SOURCE_RADIUS) the goods go down the
//    line, each link a step less (DECAY_HOPS), as obsidian did on the earth
//    (Renfrew's fall-off).


export interface SettleWorkerInbound extends HabitatInput {
  // Years from the departure to the arrival (peopleWorker.ts); Infinity
  // where none came.
  arrival: Float32Array
  carrying: Float32Array
  // 1 where a domesticable starch plant grows, a tamable herd animal lives.
  farmPlant: Uint8Array
  herdAnimal: Uint8Array
}

export interface SettleResult {
  lifeway: Uint8Array
  density: Float32Array
  // [cell, lifeway] a village.
  villages: Int32Array
  // [cell, good index] a source.
  sources: Int32Array
  // [village a, village b, weight] a link (indices into villages).
  links: Float32Array
}

export type SettleWorkerOutbound =
  | ({ type: 'settled'; ms: number } & SettleResult)
  | { type: 'failed'; message: string }

const FARM_ARABLE = 0.3
const HERD_PASTURE = 0.3
const FISH_RICH = 0.5
const CARRYING_FULL = 0.8
const DENSITY: Record<number, number> = { 1: 0.1, 2: 1, 3: 1.5, 4: 15 }
const VILLAGE_RADIUS: Record<number, number> = { 2: 5, 4: 3 }
// Below this many people a km², no village.
const VILLAGE_LEAST: Record<number, number> = { 2: 0.3, 4: 2 }
const LINKS = 3
const LINK_KM = 150
const SOURCE_RICH = 0.6
const SOURCE_RADIUS = 10
const DECAY_HOPS = 4
const MAX_HOPS = 16

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<SettleWorkerInbound>): void => {
  try {
    const started = performance.now()
    const result = settle(event.data)
    worker.postMessage({ type: 'settled', ms: Math.round(performance.now() - started), ...result } satisfies SettleWorkerOutbound, [result.lifeway.buffer, result.density.buffer, result.villages.buffer, result.sources.buffer, result.links.buffer])
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

  // 1, 2. The lifeway and the density.
  const lifeway = new Uint8Array(n)
  const density = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i] || !(arrival[i] < Infinity)) continue
    let way: number = LIFEWAY.foragers
    if (farmPlant[i] && at(eco.arable, i) >= FARM_ARABLE) way = LIFEWAY.farmers
    else if (herdAnimal[i] && at(eco.pasture, i) >= HERD_PASTURE) way = LIFEWAY.herders
    else if (at(eco.fish, i) >= FISH_RICH) way = LIFEWAY.fishers
    lifeway[i] = way
    density[i] = DENSITY[way] * Math.min(2, carrying[i] / CARRYING_FULL)
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
  const kmBetween = (a: number, b: number): number => {
    const ay = Math.floor(a / W)
    const by = Math.floor(b / W)
    let dx = Math.abs((a % W) - (b % W))
    dx = Math.min(dx, W - dx)
    return Math.hypot(dx * dxKm[Math.min(H - 1, Math.floor((ay + by) / 2))], (by - ay) * dyKm)
  }
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
  return { lifeway, density, villages: Int32Array.from(villages), sources: Int32Array.from(sources), links: Float32Array.from(links) }
}

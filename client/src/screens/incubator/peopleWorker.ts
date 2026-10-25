import { Biome } from '../../generator/climate/biomes'
import { KOPPEN_CODES } from '../../generator/climate/koppen'
import { MinHeap } from '../../generator/core/minHeap'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { readHabitat, type HabitatInput } from './habitat'
import { SPAN_YEARS } from './peopleShared'

// THE INCUBATOR'S PEOPLE (2026-10-25, a trial): when people reach each
// cell of the world raster, from one origin, and by which way — the idea of
// the generator's migration step (generator/migration/migrationField.ts),
// for people alone and with a time.
//
// The cheapest ways from the origin, in years (a Dijkstra on the arrival
// time). Over the land the front moves as fast as the land feeds it (the
// ecology's carrying capacity, level 1's), slower up a slope, faster
// along a river or a coast; the ice it does not cross. Over the sea two
// ways, both in time:
//  - the land bridges: while the sea stands low (an ice age), the shelf
//    down to SHELF_M is land, until BRIDGE_UNTIL;
//  - the crossings: open water as far as the reach of the time, which
//    grows evenly from REACH_START to REACH_END over the span; a crossing
//    longer than its time allows waits for it. Beyond REACH_NO_BOAT only by people
//    who have boats: who passed land with boat wood on their way (the
//    trees' `boat`, trees.ts) and carry the craft on. Asked of the coast
//    alone, it left Morvane's two largest continents unreached: no boat
//    wood grows by the straits (2026-10-25, 18 % of the land reached
//    against 82 % without the rule).
// So people fill their own landmass first, walk to the near ones while the
// sea is low, and reach the far islands last, or never: before the bronze
// age the earth's remote islands were empty too.
//
// Against the earth (2026-10-25): the span is the spread out of Africa,
// some 70 000 years ago, to the bronze age, some 5 000; the sea rose over
// the shelf from some 12 000 to 8 000 years ago, here 10 000; the crossing
// to Australia, some 90 km, was made 65 000 to 50 000 years ago. On
// Morvane, REACH_END 450 reaches 80 % of the land and 80 of its 85
// landmasses; a continent 645 km over the sea stays empty. With the reach
// growing with the cube of the time, or ending at 300 or 400 km, most
// continents stayed empty.
//
// The numbers are first guesses, not calibrated.

export interface PeopleWorkerInbound extends HabitatInput {
  // The carrying capacity of a land cell, 0 … 3 (the ecology's field).
  carrying: Float32Array
  // 1 where boat wood grows.
  boat: Uint8Array
  // The origin's cell; -1 to choose it (originOf).
  origin: number
}

export interface PeopleResult {
  // Years from the departure to the arrival, the sea's cells crossed too;
  // Infinity where people never came within SPAN_YEARS.
  arrival: Float32Array
  // 1 on the land (habitat.ts): where people settle.
  land: Uint8Array
  // The cell each came from, -1 at the origin and where none came.
  from: Int32Array
  // How many cells were reached through each: the routes' weight.
  flow: Float32Array
  origin: number
}

export type PeopleWorkerOutbound =
  | ({ type: 'people'; ms: number } & PeopleResult)
  | { type: 'failed'; message: string }

// The front over land, km a year: on land that feeds nobody, and on land
// that feeds as well as CARRYING_FULL or better (Morvane's mean is 0.4,
// 2026-10-25). A slope of 0.1 halves it; a river or a coast doubles it.
// The earth's first spread went some 0.3 to 0.5 km a year.
const CARRYING_FULL = 0.8
const SPEED_MIN_KM_A = 0.05
const SPEED_MAX_KM_A = 0.5
const SLOPE_DRAG = 10
const CORRIDOR = 2
// The land bridges: the shelf to 120 m under today's sea, dry until 60 000
// years after the departure, 10 000 years before the game.
const SHELF_M = 120
const BRIDGE_UNTIL = 60_000
// The crossings: km of open water, growing evenly with the time; without
// boats no farther than REACH_NO_BOAT. On the water the front
// moves SEA_KM_A.
const REACH_START = 30
const REACH_END = 450
const REACH_NO_BOAT = 60
const SEA_KM_A = 20

const reachAt = (t: number): number => REACH_START + (REACH_END - REACH_START) * Math.min(1, t / SPAN_YEARS)
// The time the reach first is `km`; Infinity beyond REACH_END.
const timeForReach = (km: number): number => (km <= REACH_START ? 0 : km > REACH_END ? Infinity : SPAN_YEARS * ((km - REACH_START) / (REACH_END - REACH_START)))

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<PeopleWorkerInbound>): void => {
  try {
    const started = performance.now()
    const result = spread(event.data)
    worker.postMessage({ type: 'people', ms: Math.round(performance.now() - started), ...result } satisfies PeopleWorkerOutbound, [result.arrival.buffer, result.land.buffer, result.from.buffer, result.flow.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies PeopleWorkerOutbound)
  }
}

// The origin when none is given: the land that feeds best in a tropical
// class (Köppen A), else anywhere.
function originOf(message: PeopleWorkerInbound, land: Uint8Array): number {
  const tropical = KOPPEN_CODES.map((code) => code.startsWith('A'))
  let best = -1
  let bestTropical = -1
  for (let i = 0; i < land.length; i++) {
    if (!land[i] || message.biome[i] === Biome.Ice || message.biome[i] === Biome.Glacier) continue
    if (best < 0 || message.carrying[i] > message.carrying[best]) best = i
    if (tropical[message.koppen[i]] && (bestTropical < 0 || message.carrying[i] > message.carrying[bestTropical])) bestTropical = i
  }
  return bestTropical >= 0 ? bestTropical : best
}

function spread(message: PeopleWorkerInbound): PeopleResult {
  const { width: W, height: H, elevation, biome, carrying, boat } = message
  const n = W * H
  const h = readHabitat(message)
  const { land, slope, nearRiver, nearSea, dxKm, dyKm, torus } = h
  const origin = message.origin >= 0 && land[message.origin] ? message.origin : originOf(message, land)
  const arrival = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const flow = new Float32Array(n)
  if (origin < 0) return { arrival, land, from, flow, origin }
  const time = new Float64Array(n).fill(Infinity)
  // The open water crossed since the last land, km, and whether the
  // people there have boats.
  const water = new Float32Array(n)
  const withBoat = new Uint8Array(n)
  const depthM = (i: number): number => -elevation[i] * ELEVATION_METERS
  const landSpeed = (i: number): number => {
    let v = SPEED_MIN_KM_A + (SPEED_MAX_KM_A - SPEED_MIN_KM_A) * Math.min(1, Math.max(0, carrying[i] / CARRYING_FULL))
    v /= 1 + slope[i] * SLOPE_DRAG
    if (nearRiver[i] || nearSea[i]) v *= CORRIDOR
    return v
  }
  const heap = new MinHeap(1 << 16)
  const order: number[] = []
  time[origin] = 0
  withBoat[origin] = boat[origin]
  heap.push(0, origin)
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const t = heap.poppedKey
    if (t > time[i]) continue
    order.push(i)
    const x = i % W
    const y = Math.floor(i / W)
    const atSea = !land[i]
    for (let j = -1; j <= 1; j++) {
      const yy = y + j
      if (!torus && (yy < 0 || yy >= H)) continue
      for (let k = -1; k <= 1; k++) {
        if (k === 0 && j === 0) continue
        const u = h.clampY(yy) * W + h.wrapX(x + k)
        const km = Math.hypot(k * dxKm[y], j * dyKm)
        let next: number
        let wet = 0
        let boatHere = 0
        if (land[u]) {
          if (biome[u] === Biome.Ice || biome[u] === Biome.Glacier) continue
          next = t + km / landSpeed(u)
          boatHere = withBoat[i] || boat[u]
        } else if (t < BRIDGE_UNTIL && depthM(u) <= SHELF_M) {
          // The dry shelf, a coast to walk along; a boat's wood comes
          // along it.
          next = t + km / (SPEED_MIN_KM_A * CORRIDOR)
          if (next > BRIDGE_UNTIL) continue
          boatHere = withBoat[i]
        } else {
          wet = (atSea ? water[i] : 0) + km
          boatHere = withBoat[i]
          if (!boatHere && wet > REACH_NO_BOAT) continue
          next = t + km / SEA_KM_A
          if (wet > reachAt(next)) next = Math.max(next, timeForReach(wet))
        }
        if (next >= time[u] || next > SPAN_YEARS) continue
        time[u] = next
        from[u] = i
        water[u] = wet
        withBoat[u] = boatHere
        heap.push(next, u)
      }
    }
  }
  // The routes: each land cell reached counts once on its way back.
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    arrival[i] = time[i]
    if (land[i]) flow[i] += 1
    if (from[i] >= 0) flow[from[i]] += flow[i]
  }
  return { arrival, land, from, flow, origin }
}

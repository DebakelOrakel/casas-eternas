import { Biome } from '../../generator/climate/biomes'
import { KOPPEN_CODES } from '../../generator/climate/koppen'
import { MinHeap } from '../../generator/core/minHeap'
import type { Habitat } from './habitat'
import { SPAN_YEARS } from './peopleShared'

// THE INCUBATOR'S PEOPLE (2026-10-25, a trial): when people reach each
// cell of the habitat (habitat.ts), from one origin, and by which way — the idea of
// the generator's migration step (generator/migration/migrationField.ts),
// for people alone and with a time.
//
// The cheapest ways from the origin over the cells, in years (a Dijkstra
// on the arrival time). Over the land the front moves as fast as the land
// feeds it (the ecology's carrying capacity, level 1's), slower up a slope,
// faster
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
// landmasses; a continent 645 km over the sea stays empty. On the cells
// (cells.ts, 2026-10-26) 83 % of the ice-free land and 55 of its 75
// landmasses: the cells merge the small islands. With the reach
// growing with the cube of the time, or ending at 300 or 400 km, most
// continents stayed empty.
//
// The numbers are first guesses, not calibrated.

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
  // [landmass, cell, time, km] a landmass people first came to over open
  // water (by boat, or a crossing short enough without), the cell they
  // landed on, when, and the open water's widest stretch on the way, km.
  // Not one first reached over land or a land bridge.
  crossings: Float32Array
}

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

// The origin when none is given: the land that feeds best in a tropical
// class (Köppen A), else anywhere.
function originOf(h: Habitat, carrying: Float32Array): number {
  const tropical = KOPPEN_CODES.map((code) => code.startsWith('A'))
  let best = -1
  let bestTropical = -1
  for (let i = 0; i < h.count; i++) {
    if (!h.land[i] || h.biome[i] === Biome.Ice || h.biome[i] === Biome.Glacier) continue
    if (best < 0 || carrying[i] > carrying[best]) best = i
    if (tropical[h.koppen[i]] && (bestTropical < 0 || carrying[i] > carrying[bestTropical])) bestTropical = i
  }
  return bestTropical >= 0 ? bestTropical : best
}

// `boat`: 1 where boat wood grows (the trees'); `origin`: a cell, or -1 to
// choose it (originOf).
export function spreadPeople(h: Habitat, carrying: Float32Array, boat: Uint8Array, given: number): PeopleResult {
  const { count: n, land, slope, nearRiver, nearSea, biome, seaDepthM } = h
  const origin = given >= 0 && land[given] ? given : originOf(h, carrying)
  const arrival = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const flow = new Float32Array(n)
  if (origin < 0) return { arrival, land, from, flow, origin, crossings: new Float32Array(0) }
  const time = new Float64Array(n).fill(Infinity)
  // The open water crossed since the last land, km, and whether the
  // people there have boats.
  const water = new Float32Array(n)
  const withBoat = new Uint8Array(n)
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
    const atSea = !land[i]
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      const km = h.distKm[e]
      let next: number
      let wet = 0
      let boatHere = 0
      if (land[u]) {
        if (biome[u] === Biome.Ice || biome[u] === Biome.Glacier) continue
        next = t + km / landSpeed(u)
        boatHere = withBoat[i] || boat[u]
      } else if (t < BRIDGE_UNTIL && seaDepthM[u] <= SHELF_M) {
        // The dry shelf, a coast to walk along; a boat's wood comes along
        // it.
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
  // The routes: each land cell reached counts once on its way back.
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    arrival[i] = time[i]
    if (land[i]) flow[i] += 1
    if (from[i] >= 0) flow[from[i]] += flow[i]
  }
  return { arrival, land, from, flow, origin, crossings: crossingsOf(h, time, from, water) }
}

// The crossings (PeopleResult): each landmass's first cell reached, and
// the way back from it to the land of another landmass; open water on that
// way makes it a crossing.
function crossingsOf(h: Habitat, time: Float64Array, from: Int32Array, water: Float32Array): Float32Array {
  const first = new Int32Array(h.landmasses).fill(-1)
  for (let i = 0; i < h.count; i++) {
    const m = h.landmass[i]
    if (m >= 0 && time[i] < Infinity && (first[m] < 0 || time[i] < time[first[m]])) first[m] = i
  }
  const crossings: number[] = []
  for (let m = 0; m < h.landmasses; m++) {
    const landed = first[m]
    if (landed < 0) continue
    let km = 0
    for (let c = from[landed]; c >= 0; c = from[c]) {
      if (h.land[c] && h.landmass[c] !== m) break
      if (!h.land[c]) km = Math.max(km, water[c])
    }
    if (km > 0) crossings.push(m, landed, time[landed], km)
  }
  return Float32Array.from(crossings)
}

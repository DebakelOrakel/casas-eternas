import { Biome } from '../../generator/climate/biomes'
import { MinHeap } from '../../generator/core/minHeap'
import type { Habitat } from './habitat'
import { detExp } from '../../generator/core/detMath'

// THE WAYS' DAYS (2026-10-26, DES-0033 "Villages and trade"): how long a
// step from a cell to its neighbour takes, in days, for the central places'
// spacing, the trade and the exchange between neighbours. Before, they
// counted km over the cells, and the trade the links passed.
//
// - On foot: Tobler's hiking function on the step's grade, WALK_HOURS a
//   day (6 km/h at a slight downhill, 5 on the flat: some 30 km a day),
//   times the land's ease (TERRAIN_EASE by biome: the rainforest half,
//   the open land whole); ice and glaciers are not crossed.
// - On a river (both cells beside one of RIVER_BOAT_SIZE or more, the
//   habitat's riverSize): by dugout, RIVER_DOWN_KM_DAY downstream (the
//   lower cell ahead), RIVER_UP_KM_DAY up — or on foot, whichever is
//   quicker.
// - Along the coast, by boat: sea cells of COAST_DEPTH_M or less at
//   COAST_KM_DAY, landing or setting out LANDING_DAYS; the open sea is
//   not a way (the crossings are the people's, not the trade's).
const WALK_HOURS = 6
const TERRAIN_EASE: Partial<Record<number, number>> = {
  [Biome.Ice]: 0,
  [Biome.Glacier]: 0,
  [Biome.TropicalRainforest]: 0.5,
  [Biome.TemperateRainforest]: 0.6,
  [Biome.Alpine]: 0.6,
  [Biome.Boreal]: 0.7,
  [Biome.TemperateForest]: 0.8,
  [Biome.TropicalDryForest]: 0.8,
  [Biome.Woodland]: 0.8,
  [Biome.Tundra]: 0.8,
  [Biome.Desert]: 0.8,
  [Biome.ColdDesert]: 0.8,
  [Biome.SaltFlat]: 0.8,
}
const RIVER_BOAT_SIZE = 0.1
const RIVER_DOWN_KM_DAY = 50
const RIVER_UP_KM_DAY = 20
const COAST_DEPTH_M = 200
const COAST_KM_DAY = 40
const LANDING_DAYS = 0.25

// The days of each step, aligned with the habitat's neighbours (nbr);
// Infinity where it is not a way.
export function travelDays(h: Habitat): Float32Array {
  const days = new Float32Array(h.nbr.length).fill(Infinity)
  const byBoat = (i: number): boolean => !h.land[i] && h.seaDepthM[i] <= COAST_DEPTH_M
  for (let i = 0; i < h.count; i++) {
    if (!h.land[i] && !byBoat(i)) continue
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      const km = h.distKm[e]
      if (h.land[i] && h.land[u]) {
        const ease = TERRAIN_EASE[h.biome[u]] ?? 1
        if (ease <= 0) continue
        const grade = (h.heightM[u] - h.heightM[i]) / (km * 1000)
        let kmDay = WALK_HOURS * 6 * detExp(-3.5 * Math.abs(grade + 0.05)) * ease
        if (h.riverSize[i] >= RIVER_BOAT_SIZE && h.riverSize[u] >= RIVER_BOAT_SIZE) kmDay = Math.max(kmDay, h.heightM[u] <= h.heightM[i] ? RIVER_DOWN_KM_DAY : RIVER_UP_KM_DAY)
        days[e] = km / kmDay
      } else if (byBoat(i) && byBoat(u)) days[e] = km / COAST_KM_DAY
      else if (byBoat(i) || byBoat(u)) days[e] = km / COAST_KM_DAY + LANDING_DAYS
    }
  }
  return days
}

// From the cells `from` over the ways, the nearest first, as far as
// `maxDays`: `dist` set on each cell reached (the caller's, Infinity
// elsewhere, set back by `reset`), `visit(cell, days)` for each, stopping
// where it returns true; `owner`, if given, set on each cell reached to
// the index in `from` of the cell nearest it. The cells reached, to reset.
export function withinDays(h: Habitat, days: Float32Array, from: readonly number[], maxDays: number, dist: Float32Array, visit?: (cell: number, d: number) => boolean, owner?: Int32Array): number[] {
  const touched: number[] = []
  const heap = new MinHeap(256)
  from.forEach((c, k) => {
    if (dist[c] === 0) return
    dist[c] = 0
    if (owner) owner[c] = k
    touched.push(c)
    heap.push(0, c)
  })
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const d = heap.poppedKey
    if (d > dist[i]) continue
    if (visit?.(i, d)) break
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const nd = d + days[e]
      const u = h.nbr[e]
      if (nd > maxDays || nd >= dist[u]) continue
      if (dist[u] === Infinity) touched.push(u)
      dist[u] = nd
      if (owner) owner[u] = owner[i]
      heap.push(nd, u)
    }
  }
  return touched
}

export const reset = (dist: Float32Array, touched: readonly number[]): void => {
  for (const c of touched) dist[c] = Infinity
}

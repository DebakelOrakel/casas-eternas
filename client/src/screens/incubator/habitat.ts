import { MinHeap } from '../../generator/core/minHeap'
import type { EcologyFieldId } from '../../generator/ecology/ecologyField'
import { detAcos, detCos, detHypot, detSin, sq } from '../../generator/core/detMath'

// THE INCUBATOR'S HABITAT (2026-10-25, a trial): the world as a living
// thing sees it, for the plants (flora.ts), the animals (fauna.ts) and
// the people (people.ts, settle.ts) alike, and the two steps they all
// take: a niche's response (a trapezoid) and the spread of a range from
// its origins.
//
// THE CELLS (2026-10-26): an icosahedron's lattice on the sphere, the
// hexagons on the torus, some 10 km apart (cells.ts, the generator's field
// mesh unrelaxed): cells of near one size everywhere, six neighbours each
// (the sphere's twelve, five) at their true distances, no pole. The world
// raster this stood on before (2048 × 1024) had cells half as wide at 60°
// as at the equator, none at the poles, and fronts that ran octagons along
// its eight neighbours. Each cell holds level 1's terrain under it: its
// height, slope, biome, Köppen class, its rivers (the ones the chart
// draws), lakes, coast, and the ecology's fields.

export interface Habitat {
  count: number
  torus: boolean
  // Per cell: on the land (most of it under level 1's land), its area.
  land: Uint8Array
  landCount: number
  areaKm2: Float32Array
  // The land's height and slope (m a m, the mean over its neighbours); the
  // sea's depth, m.
  heightM: Float32Array
  slope: Float32Array
  seaDepthM: Float32Array
  biome: Uint8Array
  // The Köppen–Geiger class ids (generator/climate/koppen.ts).
  koppen: Uint8Array
  // A river through the cell (level 1's that hold water some of the year
  // at least), and the size of its biggest: the square root of its
  // discharge over the world's largest, as the ribbon's width is
  // (surface/riverGraph.ts), 0 … 1.
  nearRiver: Uint8Array
  riverSize: Float32Array
  // A lake in the cell or a neighbour; the sea within two rings.
  nearLake: Uint8Array
  nearSea: Uint8Array
  // The land's connected pieces: an id a land cell, -1 at sea; their
  // number and areas, km².
  landmass: Int32Array
  landmasses: number
  landmassKm2: Float64Array
  // The ecology's game and carrying capacity, 0 … 3, and more of its fields
  // (LEVEL_ECOLOGY), each the mean over the cell's land; null or missing
  // without level 1's ecology.
  game: Float32Array | null
  carrying: Float32Array | null
  ecology: Partial<Record<EcologyFieldId, Float32Array>>
  // The neighbours, CSR: cell i's are nbr[nbrStart[i] .. nbrStart[i + 1]),
  // distKm[e] the way to each.
  nbrStart: Int32Array
  nbr: Int32Array
  distKm: Float32Array
  // Where the cell's centre lies on the chart, as fractions (u across, v
  // down), for the marks and the arrows.
  u: Float32Array
  v: Float32Array
  // The world's size: the globe's radius, km (0 on the torus), or the
  // torus's width and height, km.
  radiusKm: number
  widthKm: number
  heightKm: number
}

// The distance between two cells' centres, km: the great circle on the
// globe, the shorter way round on the torus.
export function kmBetween(h: Habitat, a: number, b: number): number {
  if (h.radiusKm > 0) {
    const lonA = h.u[a] * 2 * Math.PI
    const lonB = h.u[b] * 2 * Math.PI
    const latA = (0.5 - h.v[a]) * Math.PI
    const latB = (0.5 - h.v[b]) * Math.PI
    const c = detSin(latA) * detSin(latB) + detCos(latA) * detCos(latB) * detCos(lonA - lonB)
    return h.radiusKm * detAcos(Math.min(1, Math.max(-1, c)))
  }
  let du = Math.abs(h.u[a] - h.u[b])
  let dv = Math.abs(h.v[a] - h.v[b])
  du = Math.min(du, 1 - du)
  dv = Math.min(dv, 1 - dv)
  return detHypot(du * h.widthKm, dv * h.heightKm)
}

// The ecology's fields the habitat carries besides the game and the
// carrying capacity.
export const LEVEL_ECOLOGY: readonly EcologyFieldId[] = ['arable', 'pasture', 'fish', 'toolStone', 'salt', 'copper']

// A trapezoid [a, b, c, d]: 0 below a, up to 1 at b, 1 to c, down to 0 at d.
export type Trapezoid = readonly [number, number, number, number]

export function trapezoid(v: number, t: Trapezoid): number {
  if (v <= t[0] || v >= t[3]) return 0
  if (v < t[1]) return (v - t[0]) / (t[1] - t[0])
  if (v > t[2]) return (t[3] - v) / (t[3] - t[2])
  return 1
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashText(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

// One origin on a landmass, with its `chance`, for each landmass the
// niche suits somewhere: drawn there by the niche to the fourth.
export function drawOriginsByLandmass(h: Habitat, best: Float32Array, chance: (landmass: number) => number, suitable: number, random: () => number): number[] {
  const total = new Float64Array(h.landmasses)
  for (let i = 0; i < best.length; i++) if (best[i] >= suitable && h.landmass[i] >= 0) total[h.landmass[i]] += sq(sq(best[i]))
  const pick = new Float64Array(h.landmasses).fill(-1)
  for (let m = 0; m < h.landmasses; m++) {
    // Both draws for every landmass, so one landmass's draw does not
    // depend on which others the niche suits.
    const take = random() < chance(m)
    const at = random()
    if (take && total[m] > 0) pick[m] = at * total[m]
  }
  const origins: number[] = []
  for (let i = 0; i < best.length; i++) {
    if (best[i] < suitable || h.landmass[i] < 0) continue
    const m = h.landmass[i]
    if (pick[m] < 0) continue
    pick[m] -= sq(sq(best[i]))
    if (pick[m] > 0) continue
    origins.push(i)
    pick[m] = -1
  }
  return origins
}

export interface SpreadOptions {
  // A cell is suitable from this niche on.
  suitable: number
  // The cost of a kilometre through land the niche does not suit, over one
  // through it.
  barrier: number
  // How far a range spreads, kilometres through the niche.
  maxKm: number
  // Only through suitable cells (the salmon up its rivers).
  onlySuitable?: boolean
}

// A range: what the cheapest ways from the starts reach within the budget,
// over land only — the sea is not crossed.
export function spreadRange(h: Habitat, best: Float32Array, starts: number[], options: SpreadOptions): Uint8Array {
  const range = new Uint8Array(h.count)
  const cost = new Float64Array(h.count).fill(Infinity)
  const heap = new MinHeap(1 << 16)
  for (const i of starts) {
    cost[i] = 0
    heap.push(0, i)
  }
  while (heap.length > 0) {
    heap.pop()
    const i = heap.poppedIndex
    const c = heap.poppedKey
    if (c > cost[i]) continue
    range[i] = 1
    for (let e = h.nbrStart[i]; e < h.nbrStart[i + 1]; e++) {
      const u = h.nbr[e]
      if (!h.land[u]) continue
      if (options.onlySuitable && best[u] < options.suitable) continue
      const fit = Math.min(1, best[u] / options.suitable)
      const next = c + h.distKm[e] * (1 + (options.barrier - 1) * (1 - fit))
      if (next >= cost[u] || next > options.maxKm) continue
      cost[u] = next
      heap.push(next, u)
    }
  }
  return range
}

import { drawOrigins, hashText, mulberry32, readHabitat, spreadRange, trapezoid, type HabitatInput } from './habitat'
import { EDIBLE_SHARE, SPECIES, type SpeciesSpec } from './species'

// THE INCUBATOR'S SPECIES WORKER (2026-10-23, a trial): where each animal
// of species.ts lives, on the world raster (habitat.ts).
//
// 1. THE NICHE: the species' responses to the cell's climate, height,
//    slope, biome and water (species.ts), multiplied.
// 2. THE RANGE: not every suitable place is reached. Each group starts at a
//    few origins, drawn by its niche, and spreads by the cheapest way: a
//    kilometre through its niche costs one, through land it does not suit
//    up to BARRIER times more, the sea it does not cross. What the budget
//    reaches is its range; a suitable place outside it is an empty niche.
//    The salmon instead swims up the rivers from every suitable mouth.
// 3. THE DENSITY: the herbivores share the forage (the Miami model's net
//    primary production, the biome's edible share), each by its niche
//    squared among those in range there; a predator follows the
//    herbivores in its range; a fish is its niche.

export type SpeciesWorkerInbound = HabitatInput

// One code a cell: 0 nothing, 1 suitable but not reached, 2 … 255 in the
// range, the density on a scale of the species' own (its 99th percentile
// at 255).
export interface SpeciesLayer {
  id: string
  name: string
  role: SpeciesSpec['role']
  codes: Uint8Array
  // Shares of the land: suitable, reached, suitable and not reached.
  suitable: number
  reached: number
  empty: number
  origins: { x: number; y: number }[]
}

export type SpeciesWorkerOutbound =
  | { type: 'species'; layers: SpeciesLayer[]; ms: number }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<SpeciesWorkerInbound>): void => {
  try {
    const started = performance.now()
    const layers = distribute(event.data)
    worker.postMessage({ type: 'species', layers, ms: Math.round(performance.now() - started) } satisfies SpeciesWorkerOutbound, layers.map((l) => l.codes.buffer))
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies SpeciesWorkerOutbound)
  }
}

// A cell is suitable from this niche on.
const SUITABLE = 0.3
// The cost of a kilometre through land the species does not suit, over
// one through its niche.
const BARRIER = 30
// How far a range spreads, in kilometres through the niche.
const SPREAD_KM = 8000
// The origins of a group.
const ORIGINS = 2
// The salmon's river: the save's discharge (habitat.ts RIVER_DISCHARGE).
const SALMON_DISCHARGE = 50

function distribute(message: SpeciesWorkerInbound): SpeciesLayer[] {
  const { width: W, height: H, elevation, biome, discharge } = message
  const n = W * H
  const h = readHabitat(message)
  const { land, landCount, coldest, warmest, rain, heightM, slope, nearRiver, clampY, wrapX } = h

  // The forage: the Miami model's net primary production, g/m²/yr, times
  // the biome's edible share.
  const forage = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    const t = (coldest[i] + warmest[i]) / 2
    const npp = Math.min(3000 / (1 + Math.exp(1.315 - 0.119 * t)), 3000 * (1 - Math.exp(-0.000664 * rain[i])))
    forage[i] = npp * (EDIBLE_SHARE[biome[i]] ?? 0)
  }

  // 1. The niches.
  const niches = SPECIES.map((s) => {
    const niche = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue
      let v = trapezoid(coldest[i], s.coldest) * trapezoid(warmest[i], s.warmest) * trapezoid(rain[i], s.rain) * (s.biomes[biome[i]] ?? 0)
      if (v === 0) continue
      if (s.height) v *= trapezoid(heightM[i], s.height)
      if (s.slope) v *= trapezoid(slope[i], s.slope)
      if (s.water) v *= 1 - s.water + s.water * nearRiver[i]
      if (s.role === 'fish') v *= discharge[i] >= SALMON_DISCHARGE ? 1 : 0
      niche[i] = v
    }
    return niche
  })

  // 2. The ranges, a group at a time.
  const groups = new Map<string, number[]>()
  SPECIES.forEach((s, k) => groups.set(s.group ?? s.id, [...(groups.get(s.group ?? s.id) ?? []), k]))
  const ranges = new Array<Uint8Array>(SPECIES.length)
  const originsOf = new Array<{ x: number; y: number }[]>(SPECIES.length)
  for (const [group, members] of groups) {
    const best = new Float32Array(n)
    for (const k of members) for (let i = 0; i < n; i++) best[i] = Math.max(best[i], niches[k][i])
    const fish = SPECIES[members[0]].role === 'fish'
    let starts: number[] = []
    if (fish) {
      // Every suitable river cell by the sea.
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          if (best[i] < SUITABLE) continue
          let sea = false
          for (let j = -1; j <= 1 && !sea; j++) for (let ii = -1; ii <= 1 && !sea; ii++) sea = !land[clampY(y + j) * W + wrapX(x + ii)] && elevation[clampY(y + j) * W + wrapX(x + ii)] <= 0
          if (sea) starts.push(i)
        }
      }
    } else {
      starts = drawOrigins(best, ORIGINS, SUITABLE, mulberry32(hashText(group) ^ message.seed))
    }
    const range = spreadRange(h, best, starts, { suitable: SUITABLE, barrier: BARRIER, maxKm: fish ? Infinity : SPREAD_KM, onlySuitable: fish })
    const origins = fish ? [] : starts.map((i) => ({ x: i % W, y: Math.floor(i / W) }))
    for (const k of members) {
      ranges[k] = range
      originsOf[k] = origins
    }
  }

  // 3. The densities.
  const density = SPECIES.map(() => new Float32Array(n))
  const herbivores = SPECIES.map((s, k) => (s.role === 'herbivore' ? k : -1)).filter((k) => k >= 0)
  const prey = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    let sum = 0
    for (const k of herbivores) if (ranges[k][i]) sum += niches[k][i] ** 2
    if (sum === 0) continue
    for (const k of herbivores) {
      if (!ranges[k][i]) continue
      density[k][i] = (forage[i] * niches[k][i] ** 2) / sum
      prey[i] += density[k][i]
    }
  }
  SPECIES.forEach((s, k) => {
    if (s.role === 'herbivore') return
    for (let i = 0; i < n; i++) if (ranges[k][i]) density[k][i] = s.role === 'predator' ? prey[i] * niches[k][i] : niches[k][i]
  })

  return SPECIES.map((s, k) => {
    const d = density[k]
    const inRange: number[] = []
    for (let i = 0; i < n; i++) if (d[i] > 0) inRange.push(d[i])
    inRange.sort((a, b) => a - b)
    const top = inRange.length > 0 ? inRange[Math.floor(0.99 * (inRange.length - 1))] : 1
    const codes = new Uint8Array(n)
    let suitable = 0
    let reached = 0
    let empty = 0
    for (let i = 0; i < n; i++) {
      const fits = niches[k][i] >= SUITABLE
      if (fits) suitable++
      if (fits && ranges[k][i]) reached++
      if (d[i] > 0) codes[i] = 2 + Math.round(253 * Math.min(1, d[i] / top))
      else if (fits && !ranges[k][i]) {
        codes[i] = 1
        empty++
      }
    }
    return { id: s.id, name: s.name, role: s.role, codes, suitable: suitable / landCount, reached: reached / landCount, empty: empty / landCount, origins: originsOf[k] }
  })
}

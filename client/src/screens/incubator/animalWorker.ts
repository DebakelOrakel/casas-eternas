import { readHabitat, spreadRange, type HabitatInput } from './habitat'
import { ANIMALS, EDIBLE_SHARE, type AnimalUse } from './animals'
import { BARRIER, nicheOf, rangeOf, SUITABLE } from './niche'

// THE INCUBATOR'S ANIMAL WORKER (2026-10-25, a trial): where each animal of
// animals.ts lives, and how many, on the world raster (habitat.ts).
//
// 1. THE NICHE AND THE RANGE, as a plant's (niche.ts): the Köppen class,
//    the cover, the water and the coast; an origin on a landmass by its
//    size, the spread by the cheapest way. The salmon instead swims up the
//    rivers from every suitable mouth; the shore's animals are on every
//    coast that suits them.
// 2. HOW MANY: the herbivores share the land's game (the ecology's field,
//    level 1's) times the biome's edible share, each by its niche squared
//    among those in range there; a predator follows the herbivores in its
//    range; an animal of the water is its niche. Without the game, every
//    land cell feeds alike.

export type AnimalWorkerInbound = HabitatInput

// One code a cell: 0 nothing, 1 suitable but not reached, 2 … 255 where
// it suits and lives, how many on a scale of the animal's own (its 99th
// percentile at 255).
export interface AnimalLayer {
  id: string
  uses: readonly AnimalUse[]
  codes: Uint8Array
  // Shares of the land: suitable, reached, suitable and not reached.
  suitable: number
  reached: number
  empty: number
}

export type AnimalWorkerOutbound =
  | { type: 'animals'; layers: AnimalLayer[]; ms: number }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<AnimalWorkerInbound>): void => {
  try {
    const started = performance.now()
    const layers = populate(event.data)
    worker.postMessage({ type: 'animals', layers, ms: Math.round(performance.now() - started) } satisfies AnimalWorkerOutbound, layers.map((l) => l.codes.buffer))
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies AnimalWorkerOutbound)
  }
}

function populate(message: AnimalWorkerInbound): AnimalLayer[] {
  const { width: W, height: H, elevation, biome, game } = message
  const n = W * H
  const h = readHabitat(message)
  const { land, landCount, clampY, wrapX } = h

  // 1. The niches and the ranges.
  const grown = ANIMALS.map((s) => {
    if (s.bySea) {
      const { niche } = nicheOf(s, h, message.koppen, biome)
      const range = new Uint8Array(n)
      for (let i = 0; i < n; i++) if (niche[i] >= SUITABLE) range[i] = 1
      return { niche, range }
    }
    if (!s.upriver) {
      const { niche, range } = rangeOf(s, h, message)
      return { niche, range }
    }
    const { niche } = nicheOf(s, h, message.koppen, biome)
    // Every suitable cell by the sea.
    const starts: number[] = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (niche[i] < SUITABLE) continue
        let sea = false
        for (let j = -1; j <= 1 && !sea; j++) for (let k = -1; k <= 1 && !sea; k++) sea = elevation[clampY(y + j) * W + wrapX(x + k)] <= 0
        if (sea) starts.push(i)
      }
    }
    return { niche, range: spreadRange(h, niche, starts, { suitable: SUITABLE, barrier: BARRIER, maxKm: Infinity, onlySuitable: true }) }
  })
  const lives = (k: number, i: number): boolean => grown[k].range[i] === 1 && grown[k].niche[i] >= SUITABLE

  // 2. How many.
  const density = ANIMALS.map(() => new Float32Array(n))
  const herbivores = ANIMALS.flatMap((s, k) => (s.role === 'herbivore' ? [k] : []))
  const prey = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue
    let sum = 0
    for (const k of herbivores) if (lives(k, i)) sum += grown[k].niche[i] ** 2
    if (sum === 0) continue
    const forage = (game ? game[i] : 1) * (EDIBLE_SHARE[biome[i]] ?? 0)
    for (const k of herbivores) {
      if (!lives(k, i)) continue
      density[k][i] = (forage * grown[k].niche[i] ** 2) / sum
      prey[i] += density[k][i]
    }
  }
  ANIMALS.forEach((s, k) => {
    if (s.role === 'herbivore') return
    for (let i = 0; i < n; i++) if (lives(k, i)) density[k][i] = s.role === 'predator' ? prey[i] * grown[k].niche[i] : grown[k].niche[i]
  })

  return ANIMALS.map((s, k) => {
    const d = density[k]
    const living: number[] = []
    for (let i = 0; i < n; i++) if (d[i] > 0) living.push(d[i])
    living.sort((a, b) => a - b)
    const top = living.length > 0 ? living[Math.floor(0.99 * (living.length - 1))] : 1
    const codes = new Uint8Array(n)
    let suitable = 0
    let reached = 0
    let empty = 0
    for (let i = 0; i < n; i++) {
      const fits = grown[k].niche[i] >= SUITABLE
      if (fits) suitable++
      if (lives(k, i)) reached++
      if (d[i] > 0) codes[i] = 2 + Math.round(253 * Math.min(1, d[i] / top))
      else if (fits && !grown[k].range[i]) {
        codes[i] = 1
        empty++
      }
    }
    return { id: s.id, uses: s.uses, codes, suitable: suitable / landCount, reached: reached / landCount, empty: empty / landCount }
  })
}

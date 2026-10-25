import { Biome } from '../../generator/climate/biomes'
import { readHabitat, type HabitatInput } from './habitat'
import { rangeOf } from './niche'
import { PLANTS, type PlantUse } from './plants'
import { TREES, type WoodUse } from './trees'

// THE INCUBATOR'S PLANT WORKER (2026-10-25, a trial): where each plant of
// plants.ts grows, on the world raster (habitat.ts), and what the plants
// give together.
//
// 1. THE NICHE: the plant's weight for the cell's Köppen class, times its
//    responses to the height, slope, cover, water and sea (plants.ts).
//    A salt flat suits only the plants that stand it.
// 2. THE RANGE: a plant starts on a landmass by originChance, at one
//    origin drawn by its niche, and spreads by the cheapest way, as an
//    animal does (niche.ts): land whose climate it does not suit
//    is BARRIER times dearer, the sea is not crossed. A suitable place outside the
//    range is an empty niche. So most landmasses have a plant of each
//    use, and some lack one: what it would grow on there is grey.
// The trees of trees.ts grow the same way, a layer each.
// 3. THE COVER: per land cell without ice, which uses (starch, fat, fruit,
//    fibre) a plant in range gives there. The aim of the catalogue is
//    every such cell with a starch, a fat and a fruit.

export type PlantWorkerInbound = HabitatInput

// One code a cell: 0 nothing, 1 suitable but not reached, 2 … 255 in the
// range, the niche (1 at 255).
export interface PlantLayer {
  id: string
  use: PlantUse
  domesticable: boolean
  codes: Uint8Array
  // Shares of the land: suitable, reached, suitable and not reached.
  suitable: number
  reached: number
  empty: number
  origins: { x: number; y: number }[]
}

// A tree's layer: as a plant's, by the uses of its wood.
export interface TreeLayer {
  id: string
  woods: readonly WoodUse[]
  codes: Uint8Array
  suitable: number
  reached: number
  empty: number
  origins: { x: number; y: number }[]
}

// The cover: one code a cell, 0 for the sea and the ice, else 1 + a bit
// per use present (USE_BITS). `shares`: of the land without ice, the share
// each use is present on; `food`: the share with starch, fat and fruit.
export interface PlantCover {
  codes: Uint8Array
  shares: Record<PlantUse, number>
  food: number
}

export const USE_BITS: Record<PlantUse, number> = { starch: 1, fat: 2, fruit: 4, fibre: 8 }

export type PlantWorkerOutbound =
  | { type: 'plants'; layers: PlantLayer[]; trees: TreeLayer[]; cover: PlantCover; ms: number }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<PlantWorkerInbound>): void => {
  try {
    const started = performance.now()
    const { layers, trees, cover } = grow(event.data)
    worker.postMessage({ type: 'plants', layers, trees, cover, ms: Math.round(performance.now() - started) } satisfies PlantWorkerOutbound, [...layers.map((l) => l.codes.buffer), ...trees.map((l) => l.codes.buffer), cover.codes.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies PlantWorkerOutbound)
  }
}

function grow(message: PlantWorkerInbound): { layers: PlantLayer[]; trees: TreeLayer[]; cover: PlantCover } {
  const { width: W, biome } = message
  const h = readHabitat(message)
  const n = W * message.height
  const present = new Uint8Array(n)
  const layers = PLANTS.map((s): PlantLayer => {
    const { codes, present: here, suitable, reached, empty, origins } = rangeOf(s, h, message)
    for (let i = 0; i < n; i++) if (here[i]) present[i] |= USE_BITS[s.use]
    return { id: s.id, use: s.use, domesticable: s.domesticable, codes, suitable, reached, empty, origins }
  })
  const trees = TREES.map((s): TreeLayer => {
    const { codes, suitable, reached, empty, origins } = rangeOf(s, h, message)
    return { id: s.id, woods: s.woods, codes, suitable, reached, empty, origins }
  })

  // The cover, over the land without ice.
  const codes = new Uint8Array(n)
  const counts: Record<PlantUse, number> = { starch: 0, fat: 0, fruit: 0, fibre: 0 }
  let food = 0
  let open = 0
  const FOOD = USE_BITS.starch | USE_BITS.fat | USE_BITS.fruit
  for (let i = 0; i < n; i++) {
    if (!h.land[i] || biome[i] === Biome.Ice || biome[i] === Biome.Glacier) continue
    open++
    codes[i] = 1 + present[i]
    for (const use of Object.keys(USE_BITS) as PlantUse[]) if (present[i] & USE_BITS[use]) counts[use]++
    if ((present[i] & FOOD) === FOOD) food++
  }
  const share = (v: number): number => (open > 0 ? v / open : 0)
  return {
    layers,
    trees,
    cover: { codes, shares: { starch: share(counts.starch), fat: share(counts.fat), fruit: share(counts.fruit), fibre: share(counts.fibre) }, food: share(food) },
  }
}

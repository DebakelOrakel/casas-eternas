import type { Habitat } from './habitat'
import { rangeOf } from './niche'
import { PLANTS, type PlantUse } from './plants'
import { TREES, type WoodUse } from './trees'

// THE INCUBATOR'S FLORA (2026-10-25, a trial): where each plant of
// plants.ts and each tree of trees.ts grows, on the habitat's cells.
//
// 1. THE NICHE: the plant's weight for the cell's Köppen class, times its
//    responses to the height, slope, cover, water and sea (plants.ts).
//    A salt flat suits only the plants that stand it.
// 2. THE RANGE: a plant starts on a landmass by its size, at one origin
//    drawn by its niche, and spreads by the cheapest way (niche.ts): land
//    whose climate it does not suit is dearer, the sea is not crossed. A
//    suitable place outside the range is an empty niche: what it would
//    grow on there is grey.

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
}

// A tree's layer: as a plant's, by the uses of its wood.
export interface TreeLayer {
  id: string
  woods: readonly WoodUse[]
  codes: Uint8Array
  suitable: number
  reached: number
  empty: number
}

export function growFlora(h: Habitat, seed: number): { plants: PlantLayer[]; trees: TreeLayer[] } {
  const plants = PLANTS.map((s): PlantLayer => {
    const { codes, suitable, reached, empty } = rangeOf(s, h, seed)
    return { id: s.id, use: s.use, domesticable: s.domesticable, codes, suitable, reached, empty }
  })
  const trees = TREES.map((s): TreeLayer => {
    const { codes, suitable, reached, empty } = rangeOf(s, h, seed)
    return { id: s.id, woods: s.woods, codes, suitable, reached, empty }
  })
  return { plants, trees }
}

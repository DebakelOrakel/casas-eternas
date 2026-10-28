import { Biome } from '../../generator/climate/biomes'
import catalog from 'casas-incubator-data/catalog.json'
import type { NicheSpec } from './plants'

// THE INCUBATOR'S ANIMALS (2026-10-25, a trial): the wild animals people
// hunt, tame, fish, wear or fear just before the bronze age, by what they
// are to people; an animal is to people one thing or more. Archetypes, a
// niche over the habitat as the plants' (plants.ts, niche.ts); their names
// are `animal.<id>`. The first try (2026-10-23, the POC) set the coldest
// and the warmest month and the rain after the real species, and drew two
// origins on the whole world: the plants showed both wrong (plants.ts,
// flora.ts).
//
// The role says how many there are (fauna.ts): a herbivore shares
// the land's game with the herbivores in range by its niche, a predator
// follows the herbivores in its range, the animals of the water are as
// many as their niche. The salmon swims up the rivers from the sea alone,
// the shellfish and the seal come along the coasts by the sea.
//
// The weights are first guesses from the real species' ranges: 1 the main
// classes, about 0.5 the edge. The catalog is data (plants.ts); a shore
// animal's own — land by the sea, low, reached by the sea — is written out
// in it.

import type { AnimalUse } from '../../map/overlayGroups'
export type AnimalRole = 'herbivore' | 'predator' | 'water'

export interface AnimalSpec extends NicheSpec {
  uses: readonly AnimalUse[]
  role: AnimalRole
  // From the sea up the rivers only, a mouth for an origin.
  upriver?: boolean
  // Along the coasts by the sea: wherever its niche suits it, no spread
  // over the land.
  bySea?: boolean
}

export const ANIMALS: readonly AnimalSpec[] = catalog.animals as readonly AnimalSpec[]

// The share of a biome's production the herbivores can eat: the grass of
// the open land most, the canopy of a closed forest little.
export const EDIBLE_SHARE: Partial<Record<number, number>> = Object.fromEntries(
  Object.entries(catalog.edibleShare).map(([name, share]) => [Biome[name as keyof typeof Biome], share]),
)

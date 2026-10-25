import { Biome } from '../../generator/climate/biomes'
import { ALL_C, ALL_D, UP_TO, type NicheSpec } from './plants'

// THE INCUBATOR'S ANIMALS (2026-10-25, a trial): the wild animals people
// hunt, tame, fish, wear or fear just before the bronze age, by what they
// are to people; an animal is to people one thing or more. Archetypes, a
// niche over the habitat as the plants' (plants.ts, niche.ts); their names
// are `animal.<id>`. The first try (2026-10-23, the POC) set the coldest
// and the warmest month and the rain after the real species, and drew two
// origins on the whole world: the plants showed both wrong (plants.ts,
// plantWorker.ts).
//
// The role says how many there are (animalWorker.ts): a herbivore shares
// the land's game with the herbivores in range by its niche, a predator
// follows the herbivores in its range, the animals of the water are as
// many as their niche. The salmon swims up the rivers from the sea alone,
// the shellfish and the seal come along the coasts by the sea.
//
// The weights are first guesses from the real species' ranges: 1 the main
// classes, about 0.5 the edge.

export type AnimalUse = 'hunt' | 'tame' | 'water' | 'fur' | 'danger'
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

// The coast's own: land by the sea, low, reached by the sea.
const SHORE = { coast: 1, height: UP_TO(20, 60), bySea: true }

export const ANIMALS: readonly AnimalSpec[] = [
  {
    id: 'aurochs', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { Cfb: 1, Cfa: 1, Dfa: 0.8, Dfb: 0.8, Csb: 0.7, Csa: 0.6, Cwa: 0.6, BSk: 0.5, Aw: 0.4 }, height: UP_TO(1200, 2200), wet: 0.5,
  },
  {
    id: 'bison', uses: ['hunt', 'fur'], role: 'herbivore',
    climates: { Dfb: 1, Dfa: 1, BSk: 1, Dwb: 0.8, Dwa: 0.8, Dfc: 0.4, Cfb: 0.4 },
  },
  {
    id: 'horse', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { BSk: 1, Dwb: 0.8, Dwa: 0.8, BSh: 0.7, Dsb: 0.7, Dfb: 0.6, BWk: 0.6, Csa: 0.4, ET: 0.2 }, height: UP_TO(2500, 3500), cover: 'open',
  },
  {
    id: 'deer', uses: ['hunt'], role: 'herbivore',
    climates: { Cfb: 1, Dfb: 1, Dfc: 0.8, Cfa: 0.8, Dfa: 0.8, Dwb: 0.7, Cfc: 0.7, Dwc: 0.6, Csb: 0.6 }, cover: 'forest',
  },
  {
    id: 'boar', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { Cfb: 1, Cfa: 1, Dfa: 0.8, Cwa: 0.8, Dfb: 0.7, Csa: 0.7, Csb: 0.7, Aw: 0.6, Am: 0.6, Af: 0.5 }, cover: 'forest', wet: 0.3,
  },
  // The reindeer migrates, the summer on the tundra, the winter in the
  // boreal forest: one niche for both.
  {
    id: 'reindeer', uses: ['hunt', 'tame', 'fur'], role: 'herbivore',
    climates: { ET: 1, Dfc: 1, Dwc: 1, Dfd: 1, Dwd: 1, Dsc: 0.8 },
  },
  {
    id: 'gazelle', uses: ['hunt'], role: 'herbivore',
    climates: { BSh: 1, BSk: 0.8, Aw: 0.7, BWh: 0.6, As: 0.6, BWk: 0.5, Csa: 0.4 }, cover: 'open',
  },
  {
    id: 'sheep', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { BSk: 1, Csa: 0.8, Csb: 0.8, Dsa: 0.8, Dsb: 0.8, BWk: 0.6, Cwb: 0.6, Dfb: 0.4, ET: 0.4, Dfc: 0.3 }, height: [300, 800, 5000, 6000], slope: [0.02, 0.06, 10, 20],
  },
  {
    id: 'elephant', uses: ['hunt', 'danger'], role: 'herbivore',
    climates: { Aw: 1, Am: 1, Af: 0.8, As: 0.8, Cwa: 0.6, BSh: 0.5 }, wet: 0.4,
  },
  {
    id: 'camel', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { BWh: 1, BWk: 1, BSh: 0.8, BSk: 0.8 }, cover: 'open', salt: true,
  },
  {
    id: 'buffalo', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { Aw: 1, Am: 1, Cwa: 1, Af: 0.7, As: 0.7, Cfa: 0.6 }, wet: 0.9,
  },
  {
    id: 'yak', uses: ['hunt', 'tame'], role: 'herbivore',
    climates: { ET: 1, Dwc: 0.7, Dsc: 0.7, BWk: 0.5, Dfc: 0.4 }, height: [2500, 3500, 6000, 6500],
  },
  {
    id: 'wolf', uses: ['tame', 'fur', 'danger'], role: 'predator',
    climates: { ...ALL_C, ...ALL_D, ET: 0.8, BSk: 0.8, BWk: 0.5 },
  },
  {
    id: 'bigcat', uses: ['fur', 'danger'], role: 'predator',
    climates: { Aw: 1, As: 1, Am: 0.8, BSh: 0.8, Cwa: 0.8, Af: 0.7, Dwa: 0.5, BSk: 0.4, Csa: 0.4 },
  },
  {
    id: 'bear', uses: ['hunt', 'fur', 'danger'], role: 'predator',
    climates: { Dfb: 1, Dfc: 1, Dwb: 0.8, Dwc: 0.8, Cfb: 0.8, Cfc: 0.8, Dfa: 0.7, ET: 0.5, Csb: 0.4 }, cover: 'forest',
  },
  {
    id: 'crocodile', uses: ['danger'], role: 'water',
    climates: { Af: 1, Am: 1, Aw: 1, As: 0.8, Cwa: 0.6, BSh: 0.4 }, wet: 1,
  },
  {
    id: 'salmon', uses: ['water'], role: 'water', upriver: true,
    climates: { Dfb: 1, Dfc: 1, Cfb: 1, Cfc: 1, Dwb: 0.8, Dwc: 0.8, Dfd: 0.6, ET: 0.5, Csb: 0.4 }, wet: 1,
  },
  {
    id: 'sturgeon', uses: ['water'], role: 'water',
    climates: { Dfa: 1, Dfb: 1, Dwa: 1, Dwb: 1, Cfa: 1, Cwa: 1, BSk: 0.8, Aw: 0.7 }, wet: 1, floodplain: 1,
  },
  {
    id: 'shellfish', uses: ['water'], role: 'water',
    climates: { Af: 1, Am: 1, Aw: 1, As: 1, BWh: 1, BWk: 1, BSh: 1, BSk: 1, ...ALL_C, ...ALL_D, ET: 0.4 }, ...SHORE,
  },
  {
    id: 'seal', uses: ['water', 'fur'], role: 'water',
    climates: { ET: 1, Dfc: 1, Dfd: 1, Cfc: 1, Dwc: 0.8, Dwd: 0.8, Dfb: 0.6, Dsc: 0.6, Cfb: 0.5 }, ...SHORE,
  },
  {
    id: 'waterfowl', uses: ['water'], role: 'water',
    climates: { ...ALL_C, ...ALL_D, Aw: 0.7, ET: 0.7, BSk: 0.6 }, wet: 1,
  },
  {
    id: 'beaver', uses: ['fur'], role: 'water',
    climates: { Dfb: 1, Dfc: 1, Dfa: 0.8, Dwb: 0.8, Dwc: 0.8, Cfb: 0.7 }, wet: 1, cover: 'forest',
  },
  {
    id: 'fox', uses: ['fur'], role: 'predator',
    climates: { ...ALL_D, ET: 0.8, BSk: 0.7, Cfb: 0.7, Cfa: 0.7, Csa: 0.7, Csb: 0.7 },
  },
]

// The share of a biome's production the herbivores can eat: the grass of
// the open land most, the canopy of a closed forest little.
export const EDIBLE_SHARE: Partial<Record<number, number>> = {
  [Biome.Tundra]: 0.5, [Biome.Boreal]: 0.3, [Biome.Grassland]: 1, [Biome.Woodland]: 0.7,
  [Biome.TemperateForest]: 0.45, [Biome.TemperateRainforest]: 0.35, [Biome.Desert]: 0.6, [Biome.Savanna]: 1,
  [Biome.TropicalRainforest]: 0.2, [Biome.Alpine]: 0.6, [Biome.MediterraneanScrub]: 0.5, [Biome.Steppe]: 0.9,
  [Biome.TropicalDryForest]: 0.6, [Biome.ColdDesert]: 0.5,
}

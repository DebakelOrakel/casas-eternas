import { Biome } from '../../generator/climate/biomes'
import type { Trapezoid } from './habitat'

// THE INCUBATOR'S ANIMALS (2026-10-23, a trial): a few animals that matter
// to people just before the bronze age, each a NICHE over the fields the
// save holds. The plants are in plants.ts. Archetypes, named for now
// after the real species they stand for. Hardcoded names, no catalog
// keys: we are trying it out.
//
// A niche is a product of responses, each 0 … 1: the coldest and the
// warmest month (the annual mean ∓ half the seasonal range), °C; the rain,
// mm a year; the height, metres; the slope, metres a metre over a world
// cell; the biome's weight; and, with `water`, how much the species needs
// a river near (0 does not care, 1 lives only there). A response is a
// trapezoid (habitat.ts).
//
// The numbers are first guesses from the real species' ranges, not
// calibrated.

export type SpeciesRole = 'herbivore' | 'predator' | 'fish'

export interface SpeciesSpec {
  id: string
  name: string
  role: SpeciesRole
  coldest: Trapezoid
  warmest: Trapezoid
  rain: Trapezoid
  height?: Trapezoid
  slope?: Trapezoid
  biomes: Partial<Record<number, number>>
  water?: number
  // Species of one group share a range: the range is spread on the best of
  // their niches, from the group's origins. A migrating species is a group
  // of its seasons.
  group?: string
}

const ANY_LAND: Partial<Record<number, number>> = {
  [Biome.Tundra]: 0.8, [Biome.Boreal]: 0.8, [Biome.Grassland]: 0.8, [Biome.Woodland]: 0.8,
  [Biome.TemperateForest]: 0.8, [Biome.TemperateRainforest]: 0.8, [Biome.Desert]: 0.3, [Biome.Savanna]: 0.8,
  [Biome.TropicalRainforest]: 0.1, [Biome.Alpine]: 0.6, [Biome.MediterraneanScrub]: 0.8, [Biome.Steppe]: 0.8,
  [Biome.TropicalDryForest]: 0.6, [Biome.ColdDesert]: 0.5,
}

export const SPECIES: readonly SpeciesSpec[] = [
  // The herbivores share the land's forage (EDIBLE_SHARE), by niche.
  {
    id: 'aurochs', name: 'Wildrind', role: 'herbivore',
    coldest: [-15, -5, 15, 25], warmest: [12, 18, 32, 38], rain: [250, 500, 2500, 4000], height: [-1e9, -1e9, 1200, 2200],
    biomes: { [Biome.Grassland]: 0.8, [Biome.Woodland]: 1, [Biome.TemperateForest]: 0.7, [Biome.Savanna]: 0.5, [Biome.Steppe]: 0.5, [Biome.MediterraneanScrub]: 0.6, [Biome.TropicalDryForest]: 0.5 },
    water: 0.5,
  },
  {
    id: 'horse', name: 'Wildpferd', role: 'herbivore',
    coldest: [-35, -25, 5, 15], warmest: [10, 16, 30, 36], rain: [150, 250, 700, 1200], height: [-1e9, -1e9, 2500, 3500],
    biomes: { [Biome.Steppe]: 1, [Biome.Grassland]: 1, [Biome.ColdDesert]: 0.6, [Biome.Tundra]: 0.3, [Biome.Woodland]: 0.3, [Biome.Savanna]: 0.3 },
  },
  {
    id: 'reddeer', name: 'Rothirsch', role: 'herbivore',
    coldest: [-25, -15, 10, 18], warmest: [10, 15, 28, 34], rain: [400, 600, 2500, 4000], height: [-1e9, -1e9, 2000, 3000],
    biomes: { [Biome.TemperateForest]: 1, [Biome.Woodland]: 1, [Biome.Boreal]: 0.6, [Biome.TemperateRainforest]: 0.7, [Biome.MediterraneanScrub]: 0.5, [Biome.Alpine]: 0.3 },
  },
  {
    id: 'boar', name: 'Wildschwein', role: 'herbivore',
    coldest: [-20, -10, 25, 30], warmest: [12, 16, 35, 40], rain: [350, 600, 3000, 5000],
    biomes: { [Biome.TemperateForest]: 1, [Biome.Woodland]: 0.9, [Biome.TemperateRainforest]: 0.7, [Biome.MediterraneanScrub]: 0.6, [Biome.TropicalDryForest]: 0.8, [Biome.TropicalRainforest]: 0.7, [Biome.Boreal]: 0.3 },
    water: 0.3,
  },
  // The reindeer migrates: the summer on the tundra, the winter in the
  // boreal forest. One range, two seasons.
  {
    id: 'reindeerSummer', name: 'Ren (Sommer)', role: 'herbivore', group: 'reindeer',
    coldest: [-60, -50, -5, 0], warmest: [3, 6, 14, 18], rain: [100, 150, 1500, 3000],
    biomes: { [Biome.Tundra]: 1, [Biome.Alpine]: 0.5, [Biome.Boreal]: 0.3 },
  },
  {
    id: 'reindeerWinter', name: 'Ren (Winter)', role: 'herbivore', group: 'reindeer',
    coldest: [-55, -45, -10, -3], warmest: [8, 12, 20, 24], rain: [150, 250, 1500, 3000],
    biomes: { [Biome.Boreal]: 1, [Biome.Tundra]: 0.3 },
  },
  {
    id: 'ibex', name: 'Steinbock / Wildziege', role: 'herbivore',
    coldest: [-30, -20, 10, 18], warmest: [5, 10, 30, 35], rain: [100, 200, 1500, 3000], height: [500, 1200, 4500, 5500], slope: [0.02, 0.06, 10, 20],
    biomes: { [Biome.Alpine]: 1, [Biome.MediterraneanScrub]: 0.7, [Biome.ColdDesert]: 0.6, [Biome.Steppe]: 0.5, [Biome.Woodland]: 0.5, [Biome.TemperateForest]: 0.4, [Biome.Boreal]: 0.3, [Biome.Grassland]: 0.3, [Biome.Desert]: 0.3 },
  },
  {
    id: 'gazelle', name: 'Gazelle', role: 'herbivore',
    coldest: [-10, 0, 25, 30], warmest: [22, 26, 40, 45], rain: [30, 80, 600, 1000],
    biomes: { [Biome.Savanna]: 1, [Biome.Steppe]: 0.8, [Biome.Desert]: 0.6, [Biome.Grassland]: 0.6, [Biome.MediterraneanScrub]: 0.5, [Biome.ColdDesert]: 0.3 },
  },
  {
    id: 'buffalo', name: 'Wasserbüffel', role: 'herbivore',
    coldest: [8, 14, 30, 35], warmest: [22, 25, 38, 42], rain: [800, 1200, 5000, 8000],
    biomes: { [Biome.TropicalDryForest]: 0.8, [Biome.TropicalRainforest]: 0.7, [Biome.Savanna]: 0.6, [Biome.Woodland]: 0.6, [Biome.Grassland]: 0.5 },
    water: 0.9,
  },
  // The predators live on the herbivores in their range.
  {
    id: 'wolf', name: 'Wolf', role: 'predator',
    coldest: [-55, -40, 15, 22], warmest: [5, 10, 30, 36], rain: [50, 100, 4000, 6000],
    biomes: ANY_LAND,
  },
  {
    id: 'bigcat', name: 'Großkatze', role: 'predator',
    coldest: [0, 8, 30, 35], warmest: [20, 24, 40, 45], rain: [100, 300, 2500, 4000],
    biomes: { [Biome.Savanna]: 1, [Biome.TropicalDryForest]: 0.8, [Biome.Grassland]: 0.7, [Biome.Woodland]: 0.5, [Biome.MediterraneanScrub]: 0.5, [Biome.Steppe]: 0.4, [Biome.Desert]: 0.2 },
  },
  // The salmon: the rivers of cool summers, reached from the sea up the
  // river alone (speciesWorker.ts).
  {
    id: 'salmon', name: 'Lachs', role: 'fish',
    coldest: [-60, -50, 10, 15], warmest: [4, 8, 18, 22], rain: [0, 0, 1e9, 1e9],
    biomes: ANY_LAND,
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

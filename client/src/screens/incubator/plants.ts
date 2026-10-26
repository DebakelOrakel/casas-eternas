import catalog from 'casas-history-data/catalog.json'
import type { KoppenCode } from '../../generator/climate/koppen'

// A trapezoid [a, b, c, d]: 0 below a, up to 1 at b, 1 to c, down to 0 at d
// (casas-history habitat.rs trapezoid).
export type Trapezoid = readonly [number, number, number, number]

// THE INCUBATOR'S PLANTS (2026-10-25, a trial): what people eat or use of
// the wild plants just before the bronze age, each a NICHE over the fields
// the save holds (habitat.ts). Archetypes, named after the real species
// they stand for; their names are `plant.<id>` (i18n/locales/*/plant.json).
// Only food and fibre for people: what the animals eat is the forage of
// fauna.ts.
//
// The aim: every land cell where gathering can feed people has a source of
// starch, of fat or protein and of fruit within the range of a plant
// (flora.ts measures it). The tundra and the desert keep their gaps:
// there people live from animals, or at an oasis.
//
// A niche is the plant's weight for the cell's Köppen–Geiger class (the
// generator derives the classes from the twelve months, and the biomes
// from the classes), times its responses, each 0 … 1: the height, metres;
// the slope, metres a metre over a world cell; with `wet`, how much the
// plant needs a river near (0 does not care, 1 grows only there); with
// `coast`, how much it needs the sea near. A class in `oasis` counts only
// by a river. The first try (2026-10-25) set the coldest and the warmest
// month and the rain after the real species: the world's climates are not
// the earth's, and the plants missed the classes they belong to (its
// Mediterranean class had no starch on 70 % of it).
//
// The second try (2026-10-25) adds the ground the class does not say:
// `cover`, whether the plant grows in the open (the wild grasses, the
// pulses) or in the forest (the nut trees), from the cell's biome; with
// `wet`, a lake shore counts as a river; `floodplain`, how much the plant
// needs a BIG river (the wet rice of the river plains); `salt`, that it
// stands a salt flat, where nothing else grows. With the cover, the forest
// had no starch: the acorn and the chestnut, starch more than fat, were
// the forest's bread (the Jōmon, California), and the wild rice of the
// northern lakes its grain.
//
// The weights are first guesses from the real species' ranges: 1 the main
// classes, about 0.5 the edge.
//
// The catalog itself is data since 2026-10-26 (casas-history's
// data/catalog.json): the history's crate reads it as this client does
// (docs/decisions/incubator-history-engine.md). A comment that stood before
// an entry is its `note`.

// What people get of a plant.
export type PlantUse = 'starch' | 'fat' | 'fruit' | 'fibre'

// A niche over the habitat, the plant's and the tree's alike (trees.ts).
export interface NicheSpec {
  id: string
  climates: Partial<Record<KoppenCode, number>>
  oasis?: readonly KoppenCode[]
  height?: Trapezoid
  slope?: Trapezoid
  wet?: number
  floodplain?: number
  coast?: number
  cover?: 'open' | 'forest'
  salt?: boolean
  // Why the entry is as it is, where it says (the catalog's own comment).
  note?: string
}

export interface PlantSpec extends NicheSpec {
  use: PlantUse
  // A founder of farming, or one that was domesticated by the bronze age.
  domesticable: boolean
}

export const PLANTS: readonly PlantSpec[] = catalog.plants as readonly PlantSpec[]

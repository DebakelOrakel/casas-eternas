import type { KoppenCode } from '../../generator/climate/koppen'
import type { Trapezoid } from './habitat'

// THE INCUBATOR'S PLANTS (2026-10-25, a trial): what people eat or use of
// the wild plants just before the bronze age, each a NICHE over the fields
// the save holds (habitat.ts). Archetypes, named after the real species
// they stand for; hardcoded names, no catalog keys: we are trying it out.
// Only food and fibre for people: what the animals eat is the forage of
// speciesWorker.ts.
//
// The aim: every land cell where gathering can feed people has a source of
// starch, of fat or protein and of fruit within the range of a plant
// (plantWorker.ts measures it). The tundra and the desert keep their gaps:
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

// What people get of a plant.
export type PlantUse = 'starch' | 'fat' | 'fruit' | 'fibre'

export interface PlantSpec {
  id: string
  name: string
  use: PlantUse
  // A founder of farming, or one that was domesticated by the bronze age.
  domesticable: boolean
  climates: Partial<Record<KoppenCode, number>>
  oasis?: readonly KoppenCode[]
  height?: Trapezoid
  slope?: Trapezoid
  wet?: number
  floodplain?: number
  coast?: number
  cover?: 'open' | 'forest'
  salt?: boolean
}

// A height response: full up to `top`, none from `end`, metres.
const UP_TO = (top: number, end: number): Trapezoid => [-1e9, -1e9, top, end]

// Every class of a main group, at one weight.
const ALL_C: Partial<Record<KoppenCode, number>> = { Csa: 1, Csb: 1, Csc: 1, Cwa: 1, Cwb: 1, Cwc: 1, Cfa: 1, Cfb: 1, Cfc: 1 }
const ALL_D: Partial<Record<KoppenCode, number>> = { Dsa: 1, Dsb: 1, Dsc: 1, Dsd: 1, Dwa: 1, Dwb: 1, Dwc: 1, Dwd: 1, Dfa: 1, Dfb: 1, Dfc: 1, Dfd: 1 }
const ALL_A = (w: number): Partial<Record<KoppenCode, number>> => ({ Af: w, Am: w, Aw: w, As: w })
const ALL_B = (w: number): Partial<Record<KoppenCode, number>> => ({ BWh: w, BWk: w, BSh: w, BSk: w })

export const PLANTS: readonly PlantSpec[] = [
  // STARCH: grains, pseudo-grains, tubers, the sago pith.
  {
    id: 'wheat', name: 'Wildweizen', use: 'starch', domesticable: true,
    climates: { Csa: 1, Csb: 1, BSk: 0.6, BSh: 0.5, Dsa: 0.5, Dsb: 0.5 }, height: UP_TO(1800, 2500), cover: 'open',
  },
  {
    id: 'barley', name: 'Wildgerste', use: 'starch', domesticable: true,
    climates: { Csa: 1, Csb: 1, BSk: 1, BSh: 0.7, Dsa: 0.7, Dsb: 0.7, Cfb: 0.4, BWh: 0.5, BWk: 0.5 }, oasis: ['BWh', 'BWk'], height: UP_TO(3000, 4200), cover: 'open',
  },
  {
    id: 'millet', name: 'Wildhirse (Sorghum)', use: 'starch', domesticable: true,
    climates: { Aw: 1, As: 1, BSh: 1, Cwa: 0.7 }, cover: 'open',
  },
  {
    id: 'rice', name: 'Wildreis', use: 'starch', domesticable: true,
    climates: { Aw: 1, Am: 1, Cwa: 1, Cfa: 0.7, Af: 0.5 }, wet: 0.9, floodplain: 0.7,
  },
  {
    id: 'chenopod', name: 'Gänsefuss (Quinoa-Typ)', use: 'starch', domesticable: true,
    climates: { Cfb: 1, Cwb: 1, Dfb: 1, Dwb: 1, Cfa: 0.6, Dfa: 0.6, BSk: 0.5 }, cover: 'open',
  },
  {
    id: 'buckwheat', name: 'Buchweizen', use: 'starch', domesticable: true,
    climates: { Dfb: 1, Dwb: 1, Dfc: 1, Cfb: 0.6, Cwb: 0.6, Dwc: 0.6, Dsc: 0.5 }, height: UP_TO(3500, 4500), cover: 'open',
  },
  {
    id: 'potato', name: 'Hochlandknolle (Kartoffel-Typ)', use: 'starch', domesticable: true,
    climates: { Cwb: 1, Cwc: 1, Cfc: 1, Cfb: 0.6, ET: 0.3 }, height: [1500, 2500, 4200, 4800], cover: 'open',
  },
  {
    id: 'yam', name: 'Yams', use: 'starch', domesticable: true,
    climates: { Aw: 1, Am: 1, Af: 0.7 }, cover: 'forest',
  },
  {
    id: 'cassava', name: 'Maniok-Typ', use: 'starch', domesticable: true,
    climates: { Aw: 1, As: 1, Am: 0.8, BSh: 0.3 }, cover: 'open',
  },
  {
    id: 'taro', name: 'Taro', use: 'starch', domesticable: true,
    climates: { Af: 1, Am: 1 }, wet: 0.8, cover: 'forest',
  },
  {
    id: 'sago', name: 'Sagopalme', use: 'starch', domesticable: false,
    climates: { Af: 1 }, wet: 0.95, cover: 'forest',
  },
  {
    id: 'camas', name: 'Camas (Zwiebelknolle)', use: 'starch', domesticable: false,
    climates: { Cfb: 1, Cfc: 1, Csb: 1, Dfb: 0.5 }, cover: 'open',
  },
  {
    id: 'cattail', name: 'Rohrkolben', use: 'starch', domesticable: false,
    climates: { ...ALL_A(0.5), ...ALL_B(0.5), ...ALL_C, ...ALL_D }, wet: 0.95,
  },
  {
    id: 'zizania', name: 'Wasserreis (Zizania)', use: 'starch', domesticable: false,
    climates: { Dfb: 1, Dfc: 1, Dwb: 1, Dwc: 1, Dfa: 0.7, Cfb: 0.5, Dsc: 0.5 }, wet: 0.95,
  },
  // FAT AND PROTEIN: nuts, pulses, oil fruits.
  {
    id: 'lentil', name: 'Linse / Erbse', use: 'fat', domesticable: true,
    climates: { Csa: 1, Csb: 1, BSk: 0.7, Dsa: 0.6, Dsb: 0.6 }, cover: 'open',
  },
  {
    id: 'oak', name: 'Eiche (Eicheln)', use: 'starch', domesticable: false,
    climates: { Cfa: 1, Cfb: 1, Csa: 1, Csb: 1, Dfa: 0.6, Dfb: 0.6 }, cover: 'forest',
  },
  {
    id: 'hazel', name: 'Haselnuss', use: 'fat', domesticable: false,
    climates: { Cfb: 1, Dfb: 1, Cfa: 0.6, Dfa: 0.6, Dwb: 0.6 }, cover: 'forest',
  },
  {
    id: 'walnut', name: 'Walnuss', use: 'fat', domesticable: true,
    climates: { Cfa: 1, Dfa: 1, Dsa: 1, Csa: 0.7, Cwb: 0.6, Cwa: 0.5, BSk: 0.4 }, cover: 'forest',
  },
  {
    id: 'chestnut', name: 'Edelkastanie', use: 'starch', domesticable: true,
    climates: { Cfa: 1, Cfb: 1, Csb: 1, Csa: 0.6 }, cover: 'forest',
  },
  {
    id: 'stonepine', name: 'Zirbelkiefer (Pinienkerne)', use: 'fat', domesticable: false,
    climates: { Dfc: 1, Dwc: 1, Dfd: 1, Dwd: 1, Dsc: 0.8, Dfb: 0.5, ET: 0.2 }, cover: 'forest',
  },
  {
    id: 'olive', name: 'Olive', use: 'fat', domesticable: true,
    climates: { Csa: 1, Csb: 0.7, BSh: 0.3 },
  },
  {
    id: 'almond', name: 'Mandel / Pistazie', use: 'fat', domesticable: true,
    climates: { BSk: 1, Csa: 1, BSh: 0.7, BWk: 0.4 }, cover: 'open',
  },
  {
    id: 'shea', name: 'Shea (Karité)', use: 'fat', domesticable: false,
    climates: { Aw: 1, As: 0.8 }, cover: 'open',
  },
  {
    id: 'cowpea', name: 'Kuhbohne / Erdnuss', use: 'fat', domesticable: true,
    climates: { Aw: 1, As: 1, BSh: 0.6, Cwa: 0.6 }, cover: 'open',
  },
  {
    id: 'coconut', name: 'Kokospalme', use: 'fat', domesticable: true,
    climates: { Af: 1, Am: 1, Aw: 1 }, coast: 1,
  },
  {
    id: 'oilpalm', name: 'Ölpalme', use: 'fat', domesticable: true,
    climates: { Af: 1, Am: 1, Aw: 0.5 }, cover: 'forest',
  },
  // FRUIT AND SUGAR.
  {
    id: 'apple', name: 'Wildobst (Apfel / Birne)', use: 'fruit', domesticable: true,
    climates: { Cfb: 1, Cfa: 1, Dfb: 1, Dfa: 1, Dwa: 0.8, Dwb: 0.8, Dsb: 0.6, Cwb: 0.6 }, cover: 'forest',
  },
  {
    id: 'date', name: 'Dattelpalme', use: 'fruit', domesticable: true,
    climates: { BWh: 1, BSh: 0.6 }, wet: 0.95, salt: true,
  },
  {
    id: 'berries', name: 'Beeren (Heidel- / Moltebeere)', use: 'fruit', domesticable: false,
    climates: { Dfc: 1, Dwc: 1, ET: 1, Dfd: 0.8, Dwd: 0.8, Dsc: 0.8, Dfb: 0.5 },
  },
  {
    id: 'fig', name: 'Feige', use: 'fruit', domesticable: true,
    climates: { Csa: 1, Csb: 0.8, BSh: 0.6, Cfa: 0.4 },
  },
  {
    id: 'grape', name: 'Weinrebe', use: 'fruit', domesticable: true,
    climates: { Csa: 1, Csb: 1, Cfa: 1, Cfb: 0.6, Cwa: 0.5, Dfa: 0.5 },
  },
  {
    id: 'banana', name: 'Banane / Brotfrucht', use: 'fruit', domesticable: true,
    climates: { Af: 1, Am: 1, Cwa: 0.6, Aw: 0.4 }, cover: 'forest',
  },
  {
    id: 'baobab', name: 'Baobab / Tamarinde', use: 'fruit', domesticable: false,
    climates: { Aw: 1, As: 1, BSh: 1 }, cover: 'open',
  },
  {
    id: 'mesquite', name: 'Mesquite / Akazienschoten', use: 'fruit', domesticable: false,
    climates: { BWh: 1, BSh: 1, BWk: 0.4 }, cover: 'open', salt: true,
  },
  {
    id: 'seabuckthorn', name: 'Sanddorn', use: 'fruit', domesticable: false,
    climates: { BSk: 1, BWk: 1, Dsc: 0.6, Dfb: 0.5, Dfc: 0.5, ET: 0.3 }, cover: 'open', salt: true,
  },
  // FIBRE.
  {
    id: 'flax', name: 'Flachs', use: 'fibre', domesticable: true,
    climates: { Cfb: 1, Csb: 1, Dfb: 1, Cfa: 0.6, Csa: 0.6 },
  },
  {
    id: 'hemp', name: 'Hanf', use: 'fibre', domesticable: true,
    climates: { Dfb: 1, Dwb: 1, Dfa: 1, Dwa: 1, BSk: 1 }, cover: 'open',
  },
  {
    id: 'cotton', name: 'Wildbaumwolle', use: 'fibre', domesticable: true,
    climates: { Aw: 1, BSh: 1, BWh: 0.4 }, cover: 'open',
  },
  {
    id: 'reed', name: 'Schilf / Papyrus', use: 'fibre', domesticable: false,
    climates: { ...ALL_A(1), ...ALL_B(1), ...ALL_C, ...ALL_D }, wet: 0.95, salt: true,
  },
]

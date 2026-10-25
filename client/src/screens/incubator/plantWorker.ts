import { Biome } from '../../generator/climate/biomes'
import { KOPPEN_CODES, type KoppenCode } from '../../generator/climate/koppen'
import { drawOriginsByLandmass, hashText, mulberry32, readHabitat, spreadRange, trapezoid, type Habitat, type HabitatInput } from './habitat'
import { PLANTS, type PlantSpec, type PlantUse } from './plants'

// THE INCUBATOR'S PLANT WORKER (2026-10-25, a trial): where each plant of
// plants.ts grows, on the world raster (habitat.ts), and what the plants
// give together.
//
// 1. THE NICHE: the plant's weight for the cell's Köppen class, times its
//    responses to the height, slope, cover, water and sea (plants.ts).
//    A salt flat suits only the plants that stand it.
// 2. THE RANGE: a plant starts on a landmass by originChance, at one
//    origin drawn by its niche, and spreads by the cheapest way, as an
//    animal does (speciesWorker.ts): land whose climate it does not suit
//    is BARRIER times dearer, the sea is not crossed. A suitable place outside the
//    range is an empty niche. So most landmasses have a plant of each
//    use, and some lack one: what it would grow on there is grey.
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
  | { type: 'plants'; layers: PlantLayer[]; cover: PlantCover; ms: number }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<PlantWorkerInbound>): void => {
  try {
    const started = performance.now()
    const { layers, cover } = grow(event.data)
    worker.postMessage({ type: 'plants', layers, cover, ms: Math.round(performance.now() - started) } satisfies PlantWorkerOutbound, [...layers.map((l) => l.codes.buffer), cover.codes.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies PlantWorkerOutbound)
  }
}

// A cell is suitable from this niche on.
const SUITABLE = 0.3
// The cost of a kilometre through land the plant does not suit, over one
// through its niche.
const BARRIER = 30
// How far a range spreads, in kilometres through the niche.
const SPREAD_KM = 8000
// The chance a plant reached a landmass its niche suits, by the
// landmass's size: 1 − e^(−area / ORIGIN_AREA_KM2). More than an animal's
// two origins on the whole world, because a plant has had the millennia
// since the ice and its seeds travel with birds, rivers and people. A
// continent has nearly every plant (Australia's 7.7 M km²: 1.00), an
// island of Madagascar's size most (0.69), Britain's a third (0.37). A
// chance of 0.6 on every landmass (the first try, 2026-10-25) left the
// niche empty on whole continents: on Morvane four fifths of the empty
// fruit niche lay on landmasses the plant had no origin on.
const ORIGIN_AREA_KM2 = 500_000
const originChance = (h: Habitat) => (m: number): number => 1 - Math.exp(-h.landmassKm2[m] / ORIGIN_AREA_KM2)
// A plant of the open land in the forest, or a forest plant in the open:
// at its edges and clearings, so a part of its niche, under the
// threshold where the class alone would suit it.
const OFF_COVER = 0.25
// A big river (`floodplain`): a size of 0.3, about the largest tenth of
// level 1's rivers (Morvane, 2026-10-25), 9 % of the world's largest
// discharge.
const BIG_RIVER = 0.3

// The biomes of the open land and of the forest. The woodland and the dry
// tropical forest are both, half open.
const OPEN_BIOMES = new Set<number>([Biome.Grassland, Biome.Steppe, Biome.Savanna, Biome.Desert, Biome.ColdDesert, Biome.Tundra, Biome.Alpine, Biome.MediterraneanScrub, Biome.SaltFlat])
const FOREST_BIOMES = new Set<number>([Biome.Boreal, Biome.TemperateForest, Biome.TemperateRainforest, Biome.TropicalRainforest])
function coverFit(s: PlantSpec, biome: number): number {
  if (!s.cover) return 1
  const open = OPEN_BIOMES.has(biome)
  const forest = FOREST_BIOMES.has(biome)
  if (!open && !forest) return 1
  return (s.cover === 'open') === open ? 1 : OFF_COVER
}

// The niche, and the climate's part of it alone (the class, the height,
// the slope): a plant spreads through its climate, carried by birds,
// animals and people, and grows where its water is too. A plant of the
// river spread through the dry land between two rivers no better than
// through land it does not suit, and stayed on the river it started on
// (2026-10-25: the date on 0.1 % of the land).
function nicheOf(s: PlantSpec, h: ReturnType<typeof readHabitat>, koppen: Float32Array, biome: Float32Array): { niche: Float32Array; climate: Float32Array } {
  const n = h.W * h.H
  // The weight and the oasis rule by class id.
  const weight = KOPPEN_CODES.map((code) => (code === '' ? 0 : s.climates[code as KoppenCode] ?? 0))
  const oasis = KOPPEN_CODES.map((code) => code !== '' && (s.oasis ?? []).includes(code as KoppenCode))
  const niche = new Float32Array(n)
  const climate = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    if (!h.land[i]) continue
    let v = weight[koppen[i]] ?? 0
    if (v === 0) continue
    if (s.height) v *= trapezoid(h.heightM[i], s.height)
    if (s.slope) v *= trapezoid(h.slope[i], s.slope)
    v *= coverFit(s, biome[i])
    climate[i] = v
    if (biome[i] === Biome.SaltFlat && !s.salt) v = 0
    const water = h.nearRiver[i] || h.nearLake[i]
    if (oasis[koppen[i]] && !water) v = 0
    if (s.wet) v *= 1 - s.wet + s.wet * water
    if (s.floodplain) v *= 1 - s.floodplain + s.floodplain * Math.min(1, h.riverSize[i] / BIG_RIVER)
    if (s.coast) v *= 1 - s.coast + s.coast * h.nearSea[i]
    niche[i] = v
  }
  return { niche, climate }
}

function grow(message: PlantWorkerInbound): { layers: PlantLayer[]; cover: PlantCover } {
  const { width: W, biome } = message
  const h = readHabitat(message)
  const n = W * message.height
  const present = new Uint8Array(n)
  const layers = PLANTS.map((s): PlantLayer => {
    const { niche, climate } = nicheOf(s, h, message.koppen, biome)
    const starts = drawOriginsByLandmass(h, niche, originChance(h), SUITABLE, mulberry32(hashText(s.id) ^ message.seed))
    const range = spreadRange(h, climate, starts, { suitable: SUITABLE, barrier: BARRIER, maxKm: SPREAD_KM })
    const codes = new Uint8Array(n)
    let suitable = 0
    let reached = 0
    let empty = 0
    for (let i = 0; i < n; i++) {
      const fits = niche[i] >= SUITABLE
      if (fits) suitable++
      if (fits && range[i]) {
        reached++
        present[i] |= USE_BITS[s.use]
      }
      if (range[i] && niche[i] > 0) codes[i] = 2 + Math.round(253 * Math.min(1, niche[i]))
      else if (fits) {
        codes[i] = 1
        empty++
      }
    }
    return {
      id: s.id, use: s.use, domesticable: s.domesticable, codes,
      suitable: suitable / h.landCount, reached: reached / h.landCount, empty: empty / h.landCount,
      origins: starts.map((i) => ({ x: i % W, y: Math.floor(i / W) })),
    }
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
    cover: { codes, shares: { starch: share(counts.starch), fat: share(counts.fat), fruit: share(counts.fruit), fibre: share(counts.fibre) }, food: share(food) },
  }
}

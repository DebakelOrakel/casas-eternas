import { buildCells, type CellInput } from './cells'
import { populate, type AnimalLayer } from './fauna'
import { growFlora, type PlantLayer, type TreeLayer } from './flora'
import type { Habitat } from './habitat'
import { spreadPeople, type PeopleResult } from './people'
import { PLANTS } from './plants'
import { settle, type SettleResult } from './settle'
import { PLANT_SUITS_CODE } from './settleShared'

// THE INCUBATOR'S WORKER (2026-10-26): the habitat's cells (cells.ts), made
// once a world, and what the steps grow on them in turn — the flora, the
// fauna, the people's spread, their settlement — each asked for by the
// screen and answered with copies, the worker keeping its own for the
// next: the people's boats come from the trees, the settlement's fields and
// herds from the plants and the animals. One worker for them all, as the
// cells are 1.5 million and made in seconds.

export type IncubatorRequest =
  | ({ type: 'cells'; seed: number } & CellInput)
  | { type: 'flora' }
  | { type: 'fauna' }
  | { type: 'people'; origin: number }
  | { type: 'settle' }

export type IncubatorAnswer =
  | { type: 'cells'; count: number; owners: Int32Array; u: Float32Array; v: Float32Array; land: Uint8Array; ms: number }
  | { type: 'flora'; plants: PlantLayer[]; trees: TreeLayer[]; ms: number }
  | { type: 'fauna'; animals: AnimalLayer[]; ms: number }
  | ({ type: 'people'; ms: number } & PeopleResult)
  | ({ type: 'settle'; ms: number } & SettleResult)
  | { type: 'failed'; message: string }

// The tamable herd animals (animals.ts) the herders keep; the domesticable
// starch plants (plants.ts) the farmers sow.
const HERD_ANIMALS = new Set(['aurochs', 'horse', 'sheep', 'camel', 'reindeer', 'yak', 'buffalo'])
const FARM_PLANTS = new Set(PLANTS.filter((p) => p.domesticable && p.use === 'starch').map((p) => p.id))

const worker = self as unknown as Worker

let habitat: Habitat | null = null
let seed = 0
let flora: { plants: PlantLayer[]; trees: TreeLayer[] } | null = null
let animals: AnimalLayer[] | null = null
let people: PeopleResult | null = null

// A layer's codes copied, for the answer; the worker keeps its own.
const copied = <L extends { codes: Uint8Array }>(layers: L[]): L[] => layers.map((l) => ({ ...l, codes: l.codes.slice() }))

worker.onmessage = (event: MessageEvent<IncubatorRequest>): void => {
  try {
    const started = performance.now()
    const ms = (): number => Math.round(performance.now() - started)
    const ask = event.data
    if (ask.type === 'cells') {
      const { seed: worldSeed, ...input } = ask
      const built = buildCells(input)
      habitat = built.habitat
      seed = worldSeed
      flora = null
      animals = null
      people = null
      const answer: IncubatorAnswer = { type: 'cells', count: habitat.count, owners: built.owners, u: habitat.u.slice(), v: habitat.v.slice(), land: habitat.land.slice(), ms: ms() }
      worker.postMessage(answer, [built.owners.buffer, answer.u.buffer, answer.v.buffer, answer.land.buffer])
      return
    }
    if (!habitat) throw new Error('no cells yet')
    const h = habitat
    if (ask.type === 'flora') {
      flora = growFlora(h, seed)
      const plants = copied(flora.plants)
      const trees = copied(flora.trees)
      worker.postMessage({ type: 'flora', plants, trees, ms: ms() } satisfies IncubatorAnswer, [...plants, ...trees].map((l) => l.codes.buffer))
      return
    }
    if (ask.type === 'fauna') {
      animals = populate(h, seed)
      const out = copied(animals)
      worker.postMessage({ type: 'fauna', animals: out, ms: ms() } satisfies IncubatorAnswer, out.map((l) => l.codes.buffer))
      return
    }
    if (ask.type === 'people') {
      if (!flora) throw new Error('the people need the flora first')
      const boat = new Uint8Array(h.count)
      for (const tree of flora.trees) if (tree.woods.includes('boat')) for (let i = 0; i < h.count; i++) if (tree.codes[i] >= PLANT_SUITS_CODE) boat[i] = 1
      people = spreadPeople(h, h.carrying ?? new Float32Array(h.count).fill(0.4), boat, ask.origin)
      const out = { ...people, arrival: people.arrival.slice(), land: people.land.slice(), from: people.from.slice(), flow: people.flow.slice() }
      worker.postMessage({ type: 'people', ms: ms(), ...out } satisfies IncubatorAnswer, [out.arrival.buffer, out.land.buffer, out.from.buffer, out.flow.buffer])
      return
    }
    if (!flora || !animals || !people) throw new Error('the settlement needs the flora, the fauna and the people first')
    const farmPlant = new Uint8Array(h.count)
    const herdAnimal = new Uint8Array(h.count)
    for (const plant of flora.plants) if (FARM_PLANTS.has(plant.id)) for (let i = 0; i < h.count; i++) if (plant.codes[i] >= PLANT_SUITS_CODE && farmPlant[i] < 255) farmPlant[i]++
    for (const animal of animals) if (HERD_ANIMALS.has(animal.id)) for (let i = 0; i < h.count; i++) if (animal.codes[i] >= 2 && herdAnimal[i] < 255) herdAnimal[i]++
    const result = settle(h, { arrival: people.arrival, farmPlant, herdAnimal, origin: people.origin, animals, seed })
    worker.postMessage({ type: 'settle', ms: ms(), ...result } satisfies IncubatorAnswer, [result.lifeway.buffer, result.density.buffer, result.farmAt.buffer, result.herdAt.buffer, result.fishOk.buffer, result.carrying.buffer, result.centres.buffer, result.villageFrom.buffer, result.villages.buffer, result.sources.buffer, result.links.buffer, result.landmass.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies IncubatorAnswer)
  }
}

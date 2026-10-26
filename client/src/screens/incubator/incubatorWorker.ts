import { buildCells, type CellInput } from './cells'
import { populate, type AnimalLayer } from './fauna'
import { growFlora, type PlantLayer, type TreeLayer } from './flora'
import type { Habitat } from './habitat'
import { spreadPeople, type PeopleResult } from './people'
import { PLANTS } from './plants'
import { MEGAFAUNA, settle, type SettleResult } from './settle'
import { iceDistance, PEOPLE_FRAME_STEP, simulate, type SimFrame, type SimulationResult } from './simulation'
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
  | { type: 'simulate'; origin: number }
  | { type: 'frame'; index: number }
  | { type: 'settle' }

export type IncubatorAnswer =
  | { type: 'cells'; count: number; owners: Int32Array; u: Float32Array; v: Float32Array; land: Uint8Array; landmass: Int32Array; landmassKm2: Float64Array; areaKm2: Float32Array; iceKm: Float32Array; seaDepthM: Float32Array; ms: number }
  | { type: 'flora'; plants: PlantLayer[]; trees: TreeLayer[]; ms: number }
  | { type: 'fauna'; animals: AnimalLayer[]; ms: number }
  | ({ type: 'people'; ms: number } & PeopleResult)
  | ({ type: 'settle'; ms: number } & SettleResult)
  | { type: 'frame'; index: number; people: Float32Array | null; small: Uint8Array | null; big: { id: string; cells: Int32Array; share: Uint8Array }[]; ms: number }
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
// The history's kept states (simulation.ts KEEP_YEARS apart), null for the
// rules' spread.
let frames: SimFrame[] | null = null
let frameSpecies: SimulationResult['species'] = []
// The history's extinctions (simulation.ts), null for the rules' spread.
let historyExtinctions: SimulationResult['extinctions'] | null = null
let historyLifeways: SimulationResult['lifeways'] | null = null

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
      frames = null
      flora = null
      animals = null
      people = null
      const answer: IncubatorAnswer = { type: 'cells', count: habitat.count, owners: built.owners, u: habitat.u.slice(), v: habitat.v.slice(), land: habitat.land.slice(), landmass: habitat.landmass.slice(), landmassKm2: habitat.landmassKm2.slice(), areaKm2: habitat.areaKm2.slice(), iceKm: iceDistance(habitat), seaDepthM: habitat.seaDepthM.slice(), ms: ms() }
      worker.postMessage(answer, [built.owners.buffer, answer.u.buffer, answer.v.buffer, answer.land.buffer, answer.landmass.buffer, answer.landmassKm2.buffer, answer.areaKm2.buffer, answer.iceKm.buffer, answer.seaDepthM.buffer])
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
    if (ask.type === 'simulate') {
      // The history (simulation.ts) in the rules' place: the settlement
      // after it reads it as it read the rules' spread. Its kept states stay
      // here, sent one at a time as the playback asks (`frame`).
      if (!animals || !flora) throw new Error('the history needs the flora and the fauna first')
      const result = simulate(h, { carrying: h.carrying ?? new Float32Array(h.count).fill(0.4), origin: ask.origin >= 0 ? ask.origin : people?.origin ?? -1, seed, bigGame: animals.filter((a) => a.id in MEGAFAUNA).map((a) => ({ id: a.id, codes: a.codes, vulnerability: MEGAFAUNA[a.id] })), crops: flora!.plants.filter((p) => FARM_PLANTS.has(p.id)), herds: animals.filter((a) => HERD_ANIMALS.has(a.id)) })
      people = result.people
      frames = result.kept
      frameSpecies = result.species
      historyExtinctions = result.extinctions
      historyLifeways = result.lifeways
      const out = { ...people, arrival: people.arrival.slice(), land: people.land.slice(), from: people.from.slice(), flow: people.flow.slice(), crossings: people.crossings.slice(), crossingWays: people.crossingWays.slice() }
      worker.postMessage({ type: 'people', ms: ms(), ...out } satisfies IncubatorAnswer, [out.arrival.buffer, out.land.buffer, out.from.buffer, out.flow.buffer, out.crossings.buffer, out.crossingWays.buffer])
      return
    }
    if (ask.type === 'frame') {
      // Sent out of its compact form: the people a km², the shares.
      const frame = frames?.[ask.index]
      const peopleNow = frame ? Float32Array.from(frame.people, (p) => p * PEOPLE_FRAME_STEP) : null
      const small = frame ? frame.small.slice() : null
      const big = frame ? frameSpecies.map((sp, k) => ({ id: sp.id, cells: sp.cells.slice(), share: frame.big[k].slice() })) : []
      worker.postMessage({ type: 'frame', index: ask.index, people: peopleNow, small, big, ms: ms() } satisfies IncubatorAnswer, [...(peopleNow ? [peopleNow.buffer] : []), ...(small ? [small.buffer] : []), ...big.flatMap((b) => [b.cells.buffer, b.share.buffer])])
      return
    }
    if (ask.type === 'people') {
      frames = null
      historyExtinctions = null
      historyLifeways = null
      if (!flora) throw new Error('the people need the flora first')
      const boat = new Uint8Array(h.count)
      for (const tree of flora.trees) if (tree.woods.includes('boat')) for (let i = 0; i < h.count; i++) if (tree.codes[i] >= PLANT_SUITS_CODE) boat[i] = 1
      people = spreadPeople(h, h.carrying ?? new Float32Array(h.count).fill(0.4), boat, ask.origin)
      const out = { ...people, arrival: people.arrival.slice(), land: people.land.slice(), from: people.from.slice(), flow: people.flow.slice(), crossings: people.crossings.slice(), crossingWays: people.crossingWays.slice() }
      worker.postMessage({ type: 'people', ms: ms(), ...out } satisfies IncubatorAnswer, [out.arrival.buffer, out.land.buffer, out.from.buffer, out.flow.buffer, out.crossings.buffer, out.crossingWays.buffer])
      return
    }
    if (!flora || !animals || !people) throw new Error('the settlement needs the flora, the fauna and the people first')
    const ruled = settle(h, { arrival: people.arrival, crops: flora.plants.filter((p) => FARM_PLANTS.has(p.id)), herds: animals.filter((a) => HERD_ANIMALS.has(a.id)), origin: people.origin, animals, seed, given: historyLifeways ?? undefined })
    // The history's extinctions in the rules' place: hunted out, not drawn.
    // The history's domesticates are the worker's own: sent as copies.
    const result = historyExtinctions ? { ...ruled, extinctions: historyExtinctions, domestications: ruled.domestications.map((d) => ({ ...d, came: d.came.slice() })) } : ruled
    worker.postMessage({ type: 'settle', ms: ms(), ...result } satisfies IncubatorAnswer, [result.lifeway.buffer, result.density.buffer, result.farmAt.buffer, result.herdAt.buffer, result.fishOk.buffer, result.farmSuit.buffer, result.herdSuit.buffer, result.fishSuit.buffer, result.carrying.buffer, result.centres.buffer, result.population.buffer, ...result.domestications.map((d) => d.came.buffer), result.villageFrom.buffer, result.villageTo.buffer, result.villages.buffer, result.sources.buffer, result.links.buffer, result.landmass.buffer])
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies IncubatorAnswer)
  }
}

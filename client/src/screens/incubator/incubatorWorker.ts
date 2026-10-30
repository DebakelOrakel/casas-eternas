import initHistory, { coldCurve, iceReachKm, Incubator } from 'casas-incubator-wasm/casas-incubator.js'
import historyWasmUrl from 'casas-incubator-wasm/casas-incubator_bg.wasm?url'
import { ANIMALS } from './animals'
import type { AnimalLayer, CellInput, PeopleResult, PlantLayer, SettleResult, TreeLayer } from './cellsShared'
import { incubatorOf } from './historyInput'
import type { LogEvent } from './historyLogShared'
import { peopleIdsOf, unpackHistory, unpackSettled, type PackedHistory, type PeoplesTree } from './historyPack'
import { PEOPLE_FRAME_STEP } from './peopleShared'
import type { PeoplingInput } from '../../world/historyArtifacts'
import { PLANTS } from './plants'
import { TREES } from './trees'

// THE INCUBATOR'S WORKER (2026-10-26; on casas-incubator since 2026-10-27,
// docs/decisions/incubator-history-engine.md): the crate's WASM build holds
// the habitat's cells, made once a world, and what is grown and run on
// them in turn — the flora, the fauna, the history, its settlement — each
// asked for by the screen and answered with copies. The history comes as
// its packed bytes (the H1 artifact's, historyPack.ts), which the worker
// reads and keeps: its kept states go out one at a time as the playback
// asks (`frame`), its bytes whole to be kept (`pack`). One worker for them
// all; one request after the other, as the screen's client pairs the
// answers with the asks in order.

// `rain`: the rain's reliability charted (map/refinedLayers.ts, the
// variability and the ENSO mark; null without the save's refinement).
// `controls`: step 1's (casas-incubator peopling.rs Controls), always
// given, so that the screen's input is the one the crate runs.
export type PeoplingControls = Omit<PeoplingInput, 'origin'>
export type IncubatorRequest =
  | ({ type: 'cells'; seed: number; spacingKm?: number } & CellInput)
  | { type: 'flora' }
  | { type: 'fauna' }
  // The world's cold over the span (from its seed alone).
  | { type: 'climate'; seed: number }
  | { type: 'simulate'; origin: number; controls: PeoplingControls; rain: { width: number; height: number; variability: Float32Array; enso: Float32Array; ensoStrength: number } | null }
  | { type: 'frame'; index: number }
  // The old stone age from `origin` (-1: the worker's choice).
  | { type: 'peopling'; origin: number; controls: PeoplingControls }
  // The history run or restored last, packed, for its artifact; and a
  // packed one taken in a run's place.
  | { type: 'pack' }
  | { type: 'restore'; bytes: ArrayBuffer }
  | { type: 'settle' }

export type IncubatorAnswer =
  | { type: 'cells'; count: number; owners: Int32Array; u: Float32Array; v: Float32Array; land: Uint8Array; landmass: Int32Array; landmassKm2: Float64Array; areaKm2: Float32Array; iceKm: Float32Array; seaDepthM: Float32Array; ms: number }
  | { type: 'flora'; plants: PlantLayer[]; trees: TreeLayer[]; ms: number }
  | { type: 'fauna'; animals: AnimalLayer[]; ms: number }
  // The cold every `stepYears` from the departure; the ice's reach at a
  // cold of 1 (the sea's drop then is step 1's control).
  | { type: 'climate'; cold: Float32Array; stepYears: number; iceReachKm: number; ms: number }
  // The history's spread, its start and end, and its peoples' tree without
  // the kept states' ids, which come with the states (historyPack.ts).
  | ({ type: 'people'; start: number; end: number; peoples: PeoplesWithoutIds; ms: number } & PeopleResult)
  // The old stone age (casas-incubator peopling.rs): its spread as a
  // history's, `flow` left 0; each cell's group and their number; the
  // foragers a km² each reached cell carries in today's climate; its log,
  // the departure and the landings after open sea; its span, years.
  | ({ type: 'peopling'; group: Int32Array; groups: number; density: Float32Array; log: LogEvent[]; span: number; ms: number } & PeopleResult)
  | ({ type: 'settle'; ms: number } & SettleResult)
  // `peoples`: each cell's people id (historyPack.ts NO_PEOPLE for none).
  | { type: 'frame'; index: number; people: Float32Array | null; small: Uint8Array | null; peoples: Uint16Array | null; big: { id: string; cells: Int32Array; share: Uint8Array }[]; ms: number }
  | { type: 'pack'; bytes: ArrayBuffer | null; ms: number }
  | { type: 'failed'; message: string }

export type PeoplesWithoutIds = Omit<PeoplesTree, 'ids'>

// The cold curve's step (casas-incubator STEP_YEARS).
const COLD_STEP_YEARS = 25

const worker = self as unknown as Worker

let ready: Promise<unknown> | null = null
let engine: Incubator | null = null
let seed = 0
// The history run or restored last, read, and its bytes.
let history: PackedHistory | null = null
let historyBytes: Uint8Array | null = null

// The spread, copied for an answer.
function peopleAnswer(h: PackedHistory, ms: number): void {
  const p = h.people
  const out = { ...p, arrival: p.arrival.slice(), land: p.land.slice(), from: p.from.slice(), flow: p.flow.slice(), crossings: p.crossings.slice(), crossingWays: p.crossingWays.slice() }
  const { ids: _ids, ...tree } = h.peoples
  const peoples = Object.fromEntries(Object.entries(tree).map(([k, a]) => [k, a.slice()])) as unknown as PeoplesWithoutIds
  worker.postMessage({ type: 'people', start: h.start, end: h.end, peoples, ms, ...out } satisfies IncubatorAnswer, [out.arrival.buffer, out.land.buffer, out.from.buffer, out.flow.buffer, out.crossings.buffer, out.crossingWays.buffer, ...Object.values(peoples).map((a) => a.buffer as ArrayBuffer)])
}

// A history's bytes taken: read, kept.
function adopt(bytes: Uint8Array): PackedHistory {
  const read = unpackHistory(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  if (!read) throw new Error('the bytes are not a packed history')
  history = read
  historyBytes = bytes
  return read
}

async function answer(ask: IncubatorRequest): Promise<void> {
  const started = performance.now()
  const ms = (): number => Math.round(performance.now() - started)
  ready ??= initHistory({ module_or_path: historyWasmUrl })
  await ready
  if (ask.type === 'climate') {
    worker.postMessage({ type: 'climate', cold: coldCurve(ask.seed), stepYears: COLD_STEP_YEARS, iceReachKm: iceReachKm(), ms: ms() } satisfies IncubatorAnswer)
    return
  }
  if (ask.type === 'cells') {
    engine?.free()
    history = null
    historyBytes = null
    seed = ask.seed
    engine = incubatorOf(Incubator, ask, ask.spacingKm)
    const e = engine
    const out: IncubatorAnswer = { type: 'cells', count: e.count(), owners: e.owners(), u: e.floats('u'), v: e.floats('v'), land: e.bytes('land'), landmass: e.ints('landmass'), landmassKm2: e.landmassKm2(), areaKm2: e.floats('areaKm2'), iceKm: e.iceKm(), seaDepthM: e.floats('seaDepthM'), ms: ms() }
    worker.postMessage(out, [out.owners.buffer, out.u.buffer, out.v.buffer, out.land.buffer, out.landmass.buffer, out.landmassKm2.buffer, out.areaKm2.buffer, out.iceKm.buffer, out.seaDepthM.buffer])
    return
  }
  const e = engine
  if (!e) throw new Error('no cells yet')
  const n = e.count()
  // A layer's codes and shares out of the crate's run of them.
  const layer = (codes: Uint8Array, shares: Float64Array, k: number) => ({ codes: codes.slice(k * n, (k + 1) * n), suitable: shares[3 * k], reached: shares[3 * k + 1], empty: shares[3 * k + 2] })
  if (ask.type === 'flora') {
    e.growFlora(seed)
    const codes = e.floraCodes()
    const shares = e.floraShares()
    const plants = PLANTS.map((p, k): PlantLayer => ({ id: p.id, use: p.use, domesticable: p.domesticable, ...layer(codes, shares, k) }))
    const trees = TREES.map((t, k): TreeLayer => ({ id: t.id, woods: t.woods, ...layer(codes, shares, PLANTS.length + k) }))
    worker.postMessage({ type: 'flora', plants, trees, ms: ms() } satisfies IncubatorAnswer, [...plants, ...trees].map((l) => l.codes.buffer))
    return
  }
  if (ask.type === 'fauna') {
    e.populate(seed)
    const codes = e.faunaCodes()
    const shares = e.faunaShares()
    const animals = ANIMALS.map((a, k): AnimalLayer => ({ id: a.id, uses: a.uses, ...layer(codes, shares, k) }))
    worker.postMessage({ type: 'fauna', animals, ms: ms() } satisfies IncubatorAnswer, animals.map((l) => l.codes.buffer))
    return
  }
  if (ask.type === 'peopling') {
    const origin = ask.origin >= 0 ? ask.origin : e.originOf()
    const span = e.people(Int32Array.of(origin), seed, ask.controls.reachKm, ask.controls.seaLowM)
    const arrival = e.peoplingFloats('arrival')
    const from = e.peoplingInts('from')
    const group = e.peoplingInts('group')
    const afloat = e.peoplingAfloat()
    const land = e.bytes('land')
    const landings = e.peoplingLandings()
    // As a history's: [landmass, cell, time, km] a crossing, and its way
    // from the cell it set off from over the water, ended by -1; with the
    // dry shelf walked from where the boat landed.
    const crossings = new Float32Array(landings.length)
    const ways: number[] = []
    const log: LogEvent[] = [{ kind: 'departure', at: 0, cell: origin }]
    for (let k = 0; k < landings.length; k += 4) {
      const [at, cell, landmass, km] = landings.subarray(k, k + 4)
      crossings.set([landmass, cell, at, km], k)
      const way = [cell]
      let c = from[cell]
      for (; c >= 0 && !land[c] && !afloat[c]; c = from[c]) way.push(c)
      for (; c >= 0 && afloat[c]; c = from[c]) way.push(c)
      if (c >= 0) way.push(c)
      ways.push(...way.reverse(), -1)
      log.push({ kind: 'crossing', at, cell, landmass, km, first: true })
    }
    let groups = 0
    for (const g of group) groups = Math.max(groups, g + 1)
    const out = { arrival, land, from, flow: new Float32Array(n), origin, crossings, crossingWays: Int32Array.from(ways), group, groups, density: e.peoplingFloats('density'), log, span }
    worker.postMessage({ type: 'peopling', ms: ms(), ...out } satisfies IncubatorAnswer, [out.arrival.buffer, out.land.buffer, out.from.buffer, out.flow.buffer, out.crossings.buffer, out.crossingWays.buffer, out.group.buffer, out.density.buffer])
    return
  }
  if (ask.type === 'simulate') {
    const rain = ask.rain
    const bytes = e.simulate(ask.origin, seed, rain?.width ?? 0, rain?.height ?? 0, rain?.variability, rain?.enso, rain?.ensoStrength ?? 0, undefined, ask.controls.reachKm, ask.controls.seaLowM)
    peopleAnswer(adopt(bytes), ms())
    return
  }
  if (ask.type === 'restore') {
    peopleAnswer(adopt(new Uint8Array(ask.bytes)), ms())
    return
  }
  if (ask.type === 'pack') {
    const bytes = historyBytes ? historyBytes.slice().buffer : null
    worker.postMessage({ type: 'pack', bytes, ms: ms() } satisfies IncubatorAnswer, bytes ? [bytes] : [])
    return
  }
  if (ask.type === 'frame') {
    // Sent out of its compact form: the people a km², the shares.
    const frame = history?.kept[ask.index]
    const peopleNow = frame ? Float32Array.from(frame.people, (p) => p * PEOPLE_FRAME_STEP) : null
    const small = frame ? frame.small.slice() : null
    const ids = history?.peoples.ids[ask.index]
    const peoples = frame && ids ? peopleIdsOf(ids, frame.people) : null
    const big = frame && history ? history.species.map((sp, k) => ({ id: sp.id, cells: sp.cells.slice(), share: frame.big[k].slice() })) : []
    worker.postMessage({ type: 'frame', index: ask.index, people: peopleNow, small, peoples, big, ms: ms() } satisfies IncubatorAnswer, [...(peopleNow ? [peopleNow.buffer] : []), ...(small ? [small.buffer] : []), ...(peoples ? [peoples.buffer] : []), ...big.flatMap((b) => [b.cells.buffer, b.share.buffer])])
    return
  }
  // The settlement (`settle`): the crate's of the history, with the
  // history's own; copies, as the worker keeps the history.
  if (!history) throw new Error('the settlement needs a history first')
  const p = history.people
  const l = history.lifeways
  const v = l.villages
  if (!v || !l.population) throw new Error('the history holds no villages')
  const settled = unpackSettled(e.settleHistory(p.arrival, l.farmAt, l.herdAt, v.villages, v.villageFrom, v.villageTo, v.villageTown, history.end).buffer as ArrayBuffer)
  if (!settled) throw new Error('the settlement could not be read')
  const a = settled.arrays
  const get = <T>(name: string): T => a.get(name) as T
  const result: SettleResult = {
    lifeway: get('lifeway'), density: get('density'), fishOk: get('fishOk'), farmSuit: get('farmSuit'), herdSuit: get('herdSuit'), fishSuit: get('fishSuit'), carrying: get('carrying'),
    sources: get('sources'), links: get('links'),
    farmAt: l.farmAt.slice(), herdAt: l.herdAt.slice(), population: l.population.slice(), centres: l.centres.slice(),
    domestications: l.domestications.map((d) => ({ ...d, came: d.came.slice() })),
    villages: v.villages.slice(), villageFrom: v.villageFrom.slice(), villageTo: v.villageTo.slice(),
    extinctions: history.extinctions,
    // The history's log with the first trade, in time (a stable
    // sort).
    log: [...history.log, ...(settled.trade ? [settled.trade] : [])].sort((x, y) => x.at - y.at),
    landmass: e.ints('landmass'),
  }
  const buffers = new Set<ArrayBuffer>([result.lifeway.buffer as ArrayBuffer, result.farmAt.buffer as ArrayBuffer, result.herdAt.buffer as ArrayBuffer, result.population.buffer as ArrayBuffer, result.centres.buffer as ArrayBuffer, result.villages.buffer as ArrayBuffer, result.villageFrom.buffer as ArrayBuffer, result.villageTo.buffer as ArrayBuffer, result.landmass.buffer as ArrayBuffer, ...result.domestications.map((d) => d.came.buffer as ArrayBuffer)])
  worker.postMessage({ type: 'settle', ms: ms(), ...result } satisfies IncubatorAnswer, [...buffers])
}

let queue: Promise<void> = Promise.resolve()
worker.onmessage = (event: MessageEvent<IncubatorRequest>): void => {
  queue = queue.then(() => answer(event.data)).catch((e: unknown) => {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies IncubatorAnswer)
  })
}

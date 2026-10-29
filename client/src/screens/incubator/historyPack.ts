import type { PeopleResult, SettleResult } from './cellsShared'
import type { LogEvent } from './historyLogShared'

// THE HISTORY PACKED (2026-10-26, the H1 artifact: world/historyArtifacts.ts):
// a simulated history as one file, so a world opened again with the same
// origin loads it instead of running it — the spread, the kept states, the
// species' cells, the lifeways, the villages, the people's count, the
// extinctions, the log. casas-incubator writes it (its pack.rs, since
// 2026-10-27; this file wrote it before, the crate's bytes are its); this
// module reads it, and the crate's settlement of it.
//
// The layout: a u32 with the header's length, the header (JSON: the plain
// values, and each array's name, type, offset and length), padding to 8,
// the arrays' bytes, each at an offset a multiple of 8.
//
// The kept states hold the cells people ever reached alone (`reached`):
// elsewhere the people are none and the game whole, at every state. Whole,
// they were 301 MB on Morvane, and Safari took minutes to store them; now
// 168 MB.
//
// THE PEOPLES (since the incubator's v3, 2026-10-29; the crate's
// peoples.rs Tree and pack.rs): each kept state's people ids, and the
// peoples' tree (PeoplesTree).

type Typed = Float32Array | Int32Array | Uint8Array | Uint16Array
const TYPES = { f32: Float32Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array } as const
type TypeName = keyof typeof TYPES
const pad8 = (n: number): number => (n + 7) & ~7

interface Header {
  json: unknown
  arrays: { name: string; type: TypeName; offset: number; length: number }[]
}

function unpack(buffer: ArrayBuffer): { json: unknown; arrays: Map<string, Typed> } {
  const length = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as Header
  const start = pad8(4 + length)
  const arrays = new Map<string, Typed>()
  for (const a of header.arrays) arrays.set(a.name, new TYPES[a.type](buffer, start + a.offset, a.length))
  return { json: header.json, arrays }
}

// A kept state (every KEEP_YEARS from 0): the people a km² in
// PEOPLE_FRAME_STEP steps, the small game's share in 255ths, each species
// of the big game's share in 255ths on its cells (`species`, aligned).
export interface SimFrame {
  people: Uint16Array
  small: Uint8Array
  big: Uint8Array[]
}

// THE PEOPLES' TREE (pack.rs): by people id its parent (-1 for one of step
// 2's start), step 1's group, the years it was first seen and first not
// seen (Infinity while it lives), the people most of it went into (-1 where
// it died out), 1 where it is big (not only an isolated small band: the
// chronicle tells these alone). Then by (people, kept state it is seen at),
// CSR from `frameStart` (one more than the peoples): the state, its people,
// its km², its farmers' share in 255ths, its heart's cell. `ids`: each kept
// state's id of each cell its `people` is over 0 at, in the cells' order.
export interface PeoplesTree {
  parent: Int32Array
  group: Int32Array
  born: Float32Array
  ended: Float32Array
  mergedInto: Int32Array
  big: Uint8Array
  frameStart: Int32Array
  frame: Uint16Array
  people: Float32Array
  km2: Float32Array
  farmers: Uint8Array
  centre: Int32Array
  ids: Uint16Array[]
}

// A people id where a cell has none (a kept state's ids made whole).
export const NO_PEOPLE = 65535

// The ids of a kept state on every cell: NO_PEOPLE where `people` is 0.
export function peopleIdsOf(ids: Uint16Array, people: ArrayLike<number>): Uint16Array {
  const out = new Uint16Array(people.length).fill(NO_PEOPLE)
  let k = 0
  for (let i = 0; i < people.length; i++) if (people[i] > 0) out[i] = ids[k++]
  return out
}

// What a packed history holds.
export interface PackedHistory {
  people: PeopleResult
  // Its start, the old stone age's end, and its end, years after the
  // departure: the kept states every KEEP_YEARS from the start and at the
  // end, the people's count every POPULATION_STEP from the start.
  start: number
  end: number
  kept: SimFrame[]
  // The big game's species, their cells (the frames' `big` aligned).
  species: { id: string; cells: Int32Array }[]
  // The climate history's draw.
  climate: { maxAt: number; depth: number; deglaciation: number }
  extinctions: SettleResult['extinctions']
  log: LogEvent[]
  lifeways: {
    centres: Float32Array
    farmAt: Float32Array
    herdAt: Float32Array
    domestications: SettleResult['domestications']
    // villageTown: each one's town at the end, people (0 for a camp; the
    // settlement's draw, settle.rs).
    villages?: { villages: Int32Array; villageFrom: Float32Array; villageTo: Float32Array; villageTown: Float32Array }
    population?: Float32Array
  }
  peoples: PeoplesTree
}

interface Plain {
  origin: number
  start: number
  end: number
  climate: PackedHistory['climate']
  extinctions: PackedHistory['extinctions']
  log: LogEvent[]
  species: string[]
  frames: number
  domestications: { kind: 'plant' | 'animal'; id: string; cell: number; at: number }[]
}

export function unpackHistory(buffer: ArrayBuffer): PackedHistory | null {
  try {
    const { json, arrays } = unpack(buffer)
    const plain = json as Plain
    const get = <T extends Typed>(name: string): T => {
      const a = arrays.get(name)
      if (!a) throw new Error(`no ${name}`)
      return a as T
    }
    // The kept states whole again: none and the game whole where people
    // never came.
    const n = get<Float32Array>('arrival').length
    const reached = get<Int32Array>('reached')
    const speciesReached = plain.species.map((_, j) => get<Int32Array>(`speciesReached${j}`))
    const speciesCells = plain.species.map((_, j) => get<Int32Array>(`species${j}`).length)
    const kept: SimFrame[] = []
    for (let k = 0; k < plain.frames; k++) {
      const people = new Uint16Array(n)
      const small = new Uint8Array(n).fill(255)
      const peopleAt = get<Uint16Array>(`people${k}`)
      const smallAt = get<Uint8Array>(`small${k}`)
      reached.forEach((c, r) => {
        people[c] = peopleAt[r]
        small[c] = smallAt[r]
      })
      const big = speciesReached.map((at, j) => {
        const share = new Uint8Array(speciesCells[j]).fill(255)
        const values = get<Uint8Array>(`big${k}.${j}`)
        at.forEach((position, r) => (share[position] = values[r]))
        return share
      })
      kept.push({ people, small, big })
    }
    return {
      // No flow: the history makes no routes of its own (the old stone
      // age's are the routes).
      people: { arrival: get('arrival'), land: get('land'), from: get('from'), flow: new Float32Array(n), origin: plain.origin, crossings: get('crossings'), crossingWays: get('crossingWays') },
      start: plain.start,
      end: plain.end,
      kept,
      climate: plain.climate,
      species: plain.species.map((id, k) => ({ id, cells: get(`species${k}`) })),
      extinctions: plain.extinctions,
      log: plain.log,
      lifeways: {
        centres: get('centres'),
        farmAt: get('farmAt'),
        herdAt: get('herdAt'),
        domestications: plain.domestications.map((d, k) => ({ ...d, came: get(`came${k}`) })),
        villages: arrays.has('villages') ? { villages: get('villages'), villageFrom: get('villageFrom'), villageTo: get('villageTo'), villageTown: get('villageTown') } : undefined,
        population: arrays.has('population') ? get('population') : undefined,
      },
      peoples: {
        parent: get('peopleParent'),
        group: get('peopleGroup'),
        born: get('peopleBorn'),
        ended: get('peopleEnded'),
        mergedInto: get('peopleMergedInto'),
        big: get('peopleBig'),
        frameStart: get('peopleFrameStart'),
        frame: get('peopleFrame'),
        people: get('peoplePeople'),
        km2: get('peopleKm2'),
        farmers: get('peopleFarmers'),
        centre: get('peopleCentre'),
        ids: Array.from({ length: plain.frames }, (_, k) => get<Uint16Array>(`peopleIds${k}`)),
      },
    }
  } catch {
    return null
  }
}

// What casas-incubator's settlement of a history computes besides the
// history's own (the crate's pack.rs pack_settled): the arrays by their
// names in SettleResult, and the first trade; null where the bytes are not
// such a pack.
export interface PackedSettled {
  trade: Extract<LogEvent, { kind: 'trade' }> | null
  arrays: Map<string, Typed>
}
export function unpackSettled(buffer: ArrayBuffer): PackedSettled | null {
  try {
    const { json, arrays } = unpack(buffer)
    return { trade: (json as { trade: PackedSettled['trade'] }).trade, arrays }
  } catch {
    return null
  }
}

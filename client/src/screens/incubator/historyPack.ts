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
//
// THE LANGUAGES (since 2026-10-31, TEG-138; the crate's languages.rs and
// pack.rs): each people's node, and the tree of the families, languages
// and dialects with their descriptions (LanguagesTree).
//
// THE NAMES (since 2026-10-31, TEG-139; the crate's place_names.rs and
// pack.rs): the places' names as recipes (PlaceNamesPacked). A history
// packed before them has none (`names` null).

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

// THE LANGUAGES' TREE (pack.rs, languages.rs): by people id its node
// (`peopleLanguage`: a dialect, or a language or a family's proto-language
// where it speaks no dialect). By node, the parents before their
// daughters: its parent (-1 for a family), its level (LANGUAGE_LEVEL), the
// people a language or a dialect is of (-1 for a family), when its line
// parted from its parent's, when it arose and its last year spoken (years),
// its seed and its spelling's style. As CSR by node, its dated sound
// changes (the year in centuries after `from`, the kit's template, its
// choice) and its new words (the year so, the kit's meaning); the forms
// follow from them and the kit, through the crate (its WASM
// `languageView`). `description`: JSON, a language's sounds, a family's
// stress and syllable forms (null for a dialect).
export interface LanguagesTree {
  peopleLanguage: Int32Array
  parent: Int32Array
  level: Uint8Array
  people: Int32Array
  from: Float32Array
  at: Float32Array
  until: Float32Array
  seed: Int32Array
  style: Uint8Array
  changeStart: Int32Array
  changeYear: Uint16Array
  change: Uint8Array
  changeChoice: Uint8Array
  wordStart: Int32Array
  wordYear: Uint16Array
  wordMeaning: Uint8Array
  description: Uint8Array
}

// `LanguagesTree.level`.
export const LANGUAGE_LEVEL = { family: 0, language: 1, dialect: 2 } as const

// The tree's arrays by their pack names.
export const LANGUAGE_ARRAYS: Record<keyof LanguagesTree, string> = {
  peopleLanguage: 'peopleLanguage',
  parent: 'languageParent',
  level: 'languageLevel',
  people: 'languagePeople',
  from: 'languageFrom',
  at: 'languageAt',
  until: 'languageUntil',
  seed: 'languageSeed',
  style: 'languageStyle',
  changeStart: 'languageChangeStart',
  changeYear: 'languageChangeYear',
  change: 'languageChange',
  changeChoice: 'languageChangeChoice',
  wordStart: 'languageWordStart',
  wordYear: 'languageWordYear',
  wordMeaning: 'languageWordMeaning',
  description: 'languages',
}

// THE NAMES (pack.rs, place_names.rs): by name its kind (NAME_KINDS), its
// place (a village's index, a river's line in level 1's ribbons, a
// mountain's highest cell, a lake's first cell, a landmass's id), its cell
// (the village's, the river's mouth, the mountain's highest, the lake's
// first, the landmass's first people's first), the node of the languages'
// tree that gave it, the year, and the recipe: its pattern, two meanings
// (255 for none), the sounds of its word of its own (`ownLength` a name,
// `own` one after the other). The letters follow from the tree and the
// kit, through the crate (its WASM `PlaceNames`).
export interface PlaceNamesPacked {
  kind: Uint8Array
  place: Int32Array
  cell: Int32Array
  namer: Uint16Array
  year: Float32Array
  pattern: Uint8Array
  meaning: Uint8Array
  ownLength: Uint8Array
  own: Uint8Array
}

// `PlaceNamesPacked.kind` (the crate's language/names.rs Kind).
export const NAME_KINDS = ['village', 'river', 'mountain', 'lake', 'landmass'] as const
export type NameKind = (typeof NAME_KINDS)[number]

// The names' arrays by their pack names.
export const NAME_ARRAYS: Record<keyof PlaceNamesPacked, string> = {
  kind: 'nameKind',
  place: 'namePlace',
  cell: 'nameCell',
  namer: 'nameNamer',
  year: 'nameYear',
  pattern: 'namePattern',
  meaning: 'nameMeaning',
  ownLength: 'nameOwnLength',
  own: 'nameOwn',
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
  languages: LanguagesTree
  names: PlaceNamesPacked | null
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
      languages: Object.fromEntries(Object.entries(LANGUAGE_ARRAYS).map(([key, name]) => [key, get(name)])) as unknown as LanguagesTree,
      names: arrays.has(NAME_ARRAYS.kind) ? (Object.fromEntries(Object.entries(NAME_ARRAYS).map(([key, name]) => [key, get(name)])) as unknown as PlaceNamesPacked) : null,
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

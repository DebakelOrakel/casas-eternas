import type { SimFrame, SimulationResult } from './simulation'

// THE HISTORY PACKED (2026-10-26, the H1 artifact: world/historyArtifacts.ts):
// a simulated history (simulation.ts) as one file, so a world opened again
// with the same origin loads it instead of running it. What the worker keeps
// of a run and the screen reads — the spread, the kept states, the species'
// cells, the lifeways, the villages, the people's count, the extinctions,
// the log — not the knowledge or the regions, which nothing reads after.
//
// The layout: a u32 with the header's length, the header (JSON: the plain
// values, and each array's name, type, offset and length), padding to 8,
// the arrays' bytes, each at an offset a multiple of 8.
//
// The kept states hold the cells people ever reached alone (`reached`):
// elsewhere the people are none and the game whole, at every state. Whole,
// they were 301 MB on Morvane, and Safari took minutes to store them; now
// 168 MB.

type Typed = Float32Array | Int32Array | Uint8Array | Uint16Array
const TYPES = { f32: Float32Array, i32: Int32Array, u8: Uint8Array, u16: Uint16Array } as const
type TypeName = keyof typeof TYPES
const typeOf = (a: Typed): TypeName => (a instanceof Float32Array ? 'f32' : a instanceof Int32Array ? 'i32' : a instanceof Uint16Array ? 'u16' : 'u8')
const pad8 = (n: number): number => (n + 7) & ~7

interface Header {
  json: unknown
  arrays: { name: string; type: TypeName; offset: number; length: number }[]
}

function pack(json: unknown, arrays: [string, Typed][]): ArrayBuffer {
  let offset = 0
  const placed = arrays.map(([name, a]) => {
    const at = offset
    offset = pad8(offset + a.byteLength)
    return { name, type: typeOf(a), offset: at, length: a.length }
  })
  const head = new TextEncoder().encode(JSON.stringify({ json, arrays: placed } satisfies Header))
  const start = pad8(4 + head.byteLength)
  const out = new ArrayBuffer(start + offset)
  new DataView(out).setUint32(0, head.byteLength, true)
  new Uint8Array(out, 4, head.byteLength).set(head)
  arrays.forEach(([, a], k) => new Uint8Array(out, start + placed[k].offset, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)))
  return out
}

function unpack(buffer: ArrayBuffer): { json: unknown; arrays: Map<string, Typed> } {
  const length = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as Header
  const start = pad8(4 + length)
  const arrays = new Map<string, Typed>()
  for (const a of header.arrays) arrays.set(a.name, new TYPES[a.type](buffer, start + a.offset, a.length))
  return { json: header.json, arrays }
}

// What a packed history holds: a SimulationResult but its knowledge and
// regions, and its time.
export type PackedHistory = Omit<SimulationResult, 'region' | 'knowledge' | 'ms'>

interface Plain {
  origin: number
  climate: SimulationResult['climate']
  extinctions: SimulationResult['extinctions']
  log: SimulationResult['log']
  species: string[]
  frames: number
  domestications: { kind: 'plant' | 'animal'; id: string; cell: number; at: number }[]
}

export function packHistory(h: PackedHistory): ArrayBuffer {
  const p = h.people
  const l = h.lifeways
  const arrays: [string, Typed][] = [
    ['arrival', p.arrival], ['land', p.land], ['from', p.from], ['flow', p.flow], ['crossings', p.crossings], ['crossingWays', p.crossingWays],
    ['centres', l.centres], ['farmAt', l.farmAt], ['herdAt', l.herdAt],
  ]
  if (l.villages) arrays.push(['villages', l.villages.villages], ['villageFrom', l.villages.villageFrom], ['villageTo', l.villages.villageTo])
  if (l.population) arrays.push(['population', l.population])
  l.domestications.forEach((d, k) => arrays.push([`came${k}`, d.came]))
  h.species.forEach((s, k) => arrays.push([`species${k}`, s.cells]))
  // The cells reached, and for each species its own cells among them.
  const reached: number[] = []
  for (let i = 0; i < p.arrival.length; i++) if (p.arrival[i] < Infinity) reached.push(i)
  const speciesReached = h.species.map((s) => {
    const at: number[] = []
    s.cells.forEach((c, k) => {
      if (p.arrival[c] < Infinity) at.push(k)
    })
    return Int32Array.from(at)
  })
  arrays.push(['reached', Int32Array.from(reached)])
  speciesReached.forEach((at, j) => arrays.push([`speciesReached${j}`, at]))
  h.kept.forEach((f, k) => {
    arrays.push([`people${k}`, Uint16Array.from(reached, (c) => f.people[c])], [`small${k}`, Uint8Array.from(reached, (c) => f.small[c])])
    f.big.forEach((b, j) => arrays.push([`big${k}.${j}`, Uint8Array.from(speciesReached[j], (at) => b[at])]))
  })
  const plain: Plain = {
    origin: p.origin,
    climate: h.climate,
    extinctions: h.extinctions,
    log: h.log,
    species: h.species.map((s) => s.id),
    frames: h.kept.length,
    domestications: l.domestications.map(({ kind, id, cell, at }) => ({ kind, id, cell, at })),
  }
  return pack(plain, arrays)
}

// Null where the bytes are not a packed history.
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
      people: { arrival: get('arrival'), land: get('land'), from: get('from'), flow: get('flow'), origin: plain.origin, crossings: get('crossings'), crossingWays: get('crossingWays') },
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
        villages: arrays.has('villages') ? { villages: get('villages'), villageFrom: get('villageFrom'), villageTo: get('villageTo') } : undefined,
        population: arrays.has('population') ? get('population') : undefined,
      },
    }
  } catch {
    return null
  }
}

import type { LanguageDetail, LanguageLevel, LanguageNode, LanguageView, NameEntry } from '../../ui/languagePanel/languageTypes'
import type { LogEvent } from './historyLogShared'
import { KEEP_YEARS } from './peopleShared'
import type { PeoplesWithoutIds } from './incubatorWorker'

// THE LANGUAGES OF A HISTORY (2026-10-31, TEG-140, DES-0033): the view
// model of the languages panel (ui/languagePanel) from the history's
// peoples (historyPack.ts PeoplesTree), its log (historyLogShared.ts) and
// a language engine. The engine says which languages there are and which
// one each people speaks; this adapter derives, from the history, what the
// engine need not know: how many speak each node when, which big peoples
// speak it, and when it died out.
//
// - The speakers of a node at a kept state: the people of every people
//   that speaks it or one of the nodes below it, in that state. So the
//   speakers of the families together are the people of the peoples.
// - A dialect is extinct where its people's end is told (the log's
//   peopleGone, peopleMerged, peopleReplaced: `at`); a language or a family
//   where all of its dialects are, at the last of them. A node with no
//   dialect does not die out.
//
// Incubator-only, as the peoples are. When the languages are kept with a
// world, their loading goes to world/ and this derivation stays here.

// What a language engine gives: the nodes (without what the history says
// of them), the node each people speaks (by people id, an index into
// `nodes`), and what a node's view asks of it.
export interface LanguageEngine {
  divide(tree: PeoplesWithoutIds): { nodes: readonly EngineNode[]; speaks: Int32Array }
  detail(id: string): LanguageDetail | null
  names(id: string, from: number, count: number): { total: number; rows: readonly NameEntry[] }
  peopleName(people: number): string
}

export interface EngineNode {
  id: string
  level: LanguageLevel
  parent: string | null
  name: string
  proto: boolean
  born: number
  // For a dialect: the big people it is of (its end is the dialect's).
  people?: number
}

// The kept states' times (as IncubatorScreen keeps them): every KEEP_YEARS
// from the history's start, and its end.
export function keptTimes(start: number, end: number): Float32Array {
  const count = Math.ceil((end - start) / KEEP_YEARS) + 1
  return Float32Array.from({ length: count }, (_, k) => Math.min(end, start + k * KEEP_YEARS))
}

// The end of each people the log tells, by people id.
export function peopleEnds(log: readonly LogEvent[]): Map<number, number> {
  const ends = new Map<number, number>()
  for (const e of log) {
    if (e.kind === 'peopleGone' || e.kind === 'peopleMerged' || e.kind === 'peopleReplaced') ends.set(e.people, e.at)
  }
  return ends
}

export function deriveLanguageView(history: { tree: PeoplesWithoutIds; log: readonly LogEvent[]; start: number; end: number }, engine: LanguageEngine): LanguageView {
  const { tree, log } = history
  const times = keptTimes(history.start, history.end)
  const { nodes: made, speaks } = engine.divide(tree)
  const position = new Map(made.map((n, k) => [n.id, k]))
  const parentOf = made.map((n) => (n.parent === null ? -1 : position.get(n.parent) ?? -1))
  const speakers = made.map(() => new Float32Array(times.length))
  const peoples = made.map(() => [] as number[])
  const peopleCount = tree.parent.length
  for (let p = 0; p < peopleCount; p++) {
    const own = speaks[p]
    if (own < 0) continue
    for (let r = tree.frameStart[p]; r < tree.frameStart[p + 1]; r++) {
      const k = tree.frame[r]
      if (k >= times.length) continue
      for (let at = own; at >= 0; at = parentOf[at]) speakers[at][k] += tree.people[r]
    }
    if (tree.big[p]) for (let at = own; at >= 0; at = parentOf[at]) peoples[at].push(p)
  }
  // The ends: the dialects' from the log, the rest from their dialects.
  const ends = peopleEnds(log)
  const ended: (number | null)[] = made.map((n) => (n.level === 'dialect' && n.people !== undefined ? ends.get(n.people) ?? null : null))
  const below = made.map(() => [] as number[])
  parentOf.forEach((at, j) => {
    if (at >= 0) below[at].push(j)
  })
  // The dialects below a node: whether there are any, whether all of them
  // have ended, the last end.
  const dialectEnds = (at: number): { any: boolean; all: boolean; last: number } => {
    const out = { any: false, all: true, last: -Infinity }
    for (const j of below[at]) {
      if (made[j].level === 'dialect') {
        out.any = true
        const end = ended[j]
        if (end === null) out.all = false
        else out.last = Math.max(out.last, end)
      }
      const deeper = dialectEnds(j)
      out.any ||= deeper.any
      out.all &&= deeper.all
      out.last = Math.max(out.last, deeper.last)
    }
    return out
  }
  made.forEach((n, k) => {
    if (n.level === 'dialect') return
    const d = dialectEnds(k)
    ended[k] = d.any && d.all ? d.last : null
  })
  const nodes: LanguageNode[] = made.map((n, k) => ({ id: n.id, level: n.level, parent: n.parent, name: n.name, proto: n.proto, born: n.born, ended: ended[k], speakers: speakers[k], peoples: peoples[k] }))
  return {
    times,
    nodes,
    detail: (id) => engine.detail(id),
    names: (id, from, count) => engine.names(id, from, count),
    peopleName: (p) => engine.peopleName(p),
  }
}

// THE STUB ENGINE, until a language engine is written (TEG-136 and after):
// a family for each of step 1's groups (the peoples' `group`), one language
// for each family, a dialect for each big people; a small people speaks the
// dialect of its nearest big forebear, or its family's language. Names made
// of a few syllables by the id, nothing more: no detail, no names of
// places.
const SYLLABLES = ['ka', 'tav', 'vel', 'or', 'nur', 'sa', 'il', 'kel', 'mi', 'dra', 'ho', 'ren', 'u', 'lis', 'ga', 'ton']
const stem = (n: number): string => {
  const a = SYLLABLES[n % SYLLABLES.length]
  const b = SYLLABLES[Math.floor(n / SYLLABLES.length + 7 * n + 3) % SYLLABLES.length]
  const word = a + b
  return word[0].toUpperCase() + word.slice(1)
}

export const stubLanguageEngine: LanguageEngine = {
  divide(tree) {
    const count = tree.parent.length
    const nodes: EngineNode[] = []
    const familyOf = new Map<number, number>()
    const languageOf = new Map<number, number>()
    for (let p = 0; p < count; p++) {
      const g = tree.group[p]
      const known = familyOf.get(g)
      if (known !== undefined) {
        // Born with its first people.
        nodes[known].born = Math.min(nodes[known].born, tree.born[p])
        nodes[known + 1].born = nodes[known].born
        continue
      }
      familyOf.set(g, nodes.length)
      nodes.push({ id: `f${g}`, level: 'family', parent: null, name: stem(g), proto: false, born: tree.born[p] })
      languageOf.set(g, nodes.length)
      nodes.push({ id: `l${g}`, level: 'language', parent: `f${g}`, name: stem(g + 101), proto: false, born: tree.born[p] })
    }
    const dialectOf = new Map<number, number>()
    for (let p = 0; p < count; p++) {
      if (!tree.big[p]) continue
      dialectOf.set(p, nodes.length)
      nodes.push({ id: `d${p}`, level: 'dialect', parent: `l${tree.group[p]}`, name: `${stem(tree.group[p] + 101)} ${p + 1}`, proto: false, born: tree.born[p], people: p })
    }
    const speaks = new Int32Array(count)
    for (let p = 0; p < count; p++) {
      let at = p
      while (at >= 0 && !dialectOf.has(at)) at = tree.parent[at]
      speaks[p] = at >= 0 ? dialectOf.get(at)! : languageOf.get(tree.group[p]) ?? -1
    }
    return { nodes, speaks }
  },
  detail: () => null,
  names: () => ({ total: 0, rows: [] }),
  peopleName: (p) => stem(p + 211),
}

// Where a node is spoken, for the map to go to: the heart of the biggest of
// its peoples at kept state `frame`, or at its last state before it; -1
// where none of them is seen by then.
export function peopleCentre(tree: PeoplesWithoutIds, peoples: readonly number[], frame: number): number {
  let cell = -1
  let most = -1
  for (const p of peoples) {
    let row = -1
    for (let r = tree.frameStart[p]; r < tree.frameStart[p + 1]; r++) if (tree.frame[r] <= frame && (row < 0 || tree.frame[r] >= tree.frame[row])) row = r
    if (row >= 0 && tree.people[row] > most) {
      most = tree.people[row]
      cell = tree.centre[row]
    }
  }
  return cell
}

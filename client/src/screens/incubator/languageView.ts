import type { LanguageDetail, LanguageLevel, LanguageNode, LanguageView, NameEntry } from '../../ui/languagePanel/languageTypes'
import { LANGUAGE_LEVEL, NAME_KINDS, type LanguagesTree } from './historyPack'
import type { LogEvent } from './historyLogShared'
import { KEEP_YEARS } from './peopleShared'
import type { PeoplesWithoutIds } from './incubatorWorker'

// THE LANGUAGES OF A HISTORY (2026-10-31, TEG-140, TEG-138, DES-0033): the
// view model of the languages panel (ui/languagePanel) from the history's
// languages' tree (historyPack.ts LanguagesTree, made by casas-incubator's
// languages.rs), what the crate makes of it (`LanguagesMade`: the names and
// the languages' details, through its WASM `languageView`), the history's
// peoples (historyPack.ts PeoplesTree) and its log (historyLogShared.ts).
// The tree says which languages there are and which one each people
// speaks; this adapter derives, from the history, what the tree does not
// keep: how many speak each node when, which big peoples speak it, and
// when it died out.
//
// - The view's nodes: a family of the tree gives two, the family and its
//   proto-language (`proto`); a language sits below its family, whatever
//   language it came from (the panel shows families, their languages and
//   their dialects); a dialect below its language.
// - The speakers of a node at a kept state: the people of every people
//   that speaks it or one of the nodes below it then. A people whose
//   language arose from it speaks, before that, the language it came from
//   (the tree's `at`). So the speakers of the families together are the
//   people of the peoples.
// - A dialect is extinct where its people's end is told (the log's
//   peopleGone, peopleMerged, peopleReplaced: `at`); a language where the
//   log says it is gone (languageGone), a family and its proto-language
//   where the log says the family is (familyGone).
//
// Incubator-only, as the peoples are. When the languages are kept with a
// world, their loading goes to world/ and this derivation stays here.

// What the crate makes of the tree (casas-incubator languages.rs
// `Languages::view`): by node its name and, for a family's proto-language
// and a language, its detail; by people id its name. The names are the
// world's content: no i18n.
export interface LanguagesMade {
  nodes: { name: string; detail: Omit<LanguageDetail, 'id'> | null }[]
  peoples: string[]
}

// THE NAMES a history carries (TEG-139; historyPack.ts PlaceNamesPacked,
// the crate's place_names.rs): by name its kind (NAME_KINDS' index), 1
// where a village is a town (its town at the history's end TOWN_PEOPLE or
// more), its place and cell, the node of the tree that gave it, the year
// it was given, and its forms over time as the crate spells them (its WASM
// `PlaceNames`): the years from which each form holds, rising, and the
// forms. The names are the world's content: no i18n.
export interface HistoryNames {
  kind: Uint8Array
  town: Uint8Array
  place: Int32Array
  cell: Int32Array
  namer: Uint16Array
  year: Float32Array
  forms: { years: number[]; forms: string[] }[]
}

// A village is a town in the languages panel from this town at the
// history's end, people (simulation.rs THE TOWNS; the city is one). On the
// three v15 worlds (2026-10-31) 719 of Morvane's 5 383 villages and camps,
// 802 of Thalassor's 9 360, 584 of Zephyra's 2 438.
export const TOWN_PEOPLE = 1000

// Name j in `year`: the form of that year; null before it was given.
export function nameAt(names: HistoryNames, j: number, year: number): string | null {
  if (year < names.year[j]) return null
  const { years, forms } = names.forms[j]
  let k = 0
  while (k + 1 < years.length && years[k + 1] <= year) k++
  return forms[k] ?? null
}

// The languages a history carries: its tree, what the crate made of it,
// and the names of its places (null for a history packed before them).
export interface HistoryLanguages {
  tree: LanguagesTree
  made: LanguagesMade
  names: HistoryNames | null
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

// The view's id of a tree node; a family's proto-language's.
const LEVEL_NAMES: LanguageLevel[] = ['family', 'language', 'dialect']
const viewId = (tree: LanguagesTree, k: number): string => `${LEVEL_NAMES[tree.level[k]][0]}${k}`
const protoId = (k: number): string => `f${k}p`
// The view's node a people speaks in when it speaks tree node k without a
// dialect: a language, or a family's proto-language.
const spokenId = (tree: LanguagesTree, k: number): string => (tree.level[k] === LANGUAGE_LEVEL.family ? protoId(k) : viewId(tree, k))

export function deriveLanguageView(history: { tree: PeoplesWithoutIds; log: readonly LogEvent[]; start: number; end: number; languages: HistoryLanguages }): LanguageView {
  const { tree: peoplesTree, log } = history
  const { tree, made } = history.languages
  const times = keptTimes(history.start, history.end)
  const count = tree.parent.length
  const familyOf = (k: number): number => {
    while (tree.parent[k] >= 0) k = tree.parent[k]
    return k
  }
  // The ends the log tells.
  const peopleEnd = peopleEnds(log)
  const languageEnd = new Map<number, number>()
  const familyEnd = new Map<number, number>()
  for (const e of log) {
    if (e.kind === 'languageGone') languageEnd.set(e.language, e.at)
    else if (e.kind === 'familyGone') familyEnd.set(e.family, e.at)
  }
  // The nodes, the tree's order; a family's proto-language after it.
  const nodes: (Omit<LanguageNode, 'speakers' | 'peoples'> & { speakers: Float32Array; peoples: number[] })[] = []
  const position = new Map<string, number>()
  const add = (node: Omit<LanguageNode, 'speakers' | 'peoples'>): void => {
    position.set(node.id, nodes.length)
    nodes.push({ ...node, speakers: new Float32Array(times.length), peoples: [] })
  }
  for (let k = 0; k < count; k++) {
    const name = made.nodes[k]?.name ?? ''
    const level = tree.level[k]
    if (level === LANGUAGE_LEVEL.family) {
      const ended = familyEnd.get(k) ?? null
      add({ id: viewId(tree, k), level: 'family', parent: null, name, proto: false, born: tree.from[k], ended })
      add({ id: protoId(k), level: 'language', parent: viewId(tree, k), name, proto: true, born: tree.from[k], ended })
    } else if (level === LANGUAGE_LEVEL.language) {
      add({ id: viewId(tree, k), level: 'language', parent: viewId(tree, familyOf(k)), name, proto: false, born: tree.at[k], ended: languageEnd.get(k) ?? null })
    } else {
      const parent = spokenId(tree, tree.parent[k])
      const born = Math.max(tree.from[k], nodes[position.get(parent)!].born)
      add({ id: viewId(tree, k), level: 'dialect', parent, name, proto: false, born, ended: peopleEnd.get(tree.people[k]) ?? null })
    }
  }
  const parentOf = nodes.map((n) => (n.parent === null ? -1 : position.get(n.parent) ?? -1))
  // The speakers and the big peoples.
  const peopleCount = peoplesTree.parent.length
  for (let p = 0; p < peopleCount; p++) {
    const k = tree.peopleLanguage[p]
    if (k < 0) continue
    const own = position.get(tree.level[k] === LANGUAGE_LEVEL.dialect ? viewId(tree, k) : spokenId(tree, k))!
    // Its language, and whether it arose from this people: before then
    // the people speaks the language it came from.
    const language = tree.level[k] === LANGUAGE_LEVEL.dialect ? tree.parent[k] : k
    const founder = tree.level[language] === LANGUAGE_LEVEL.language && tree.people[language] === p
    const before = founder ? position.get(spokenId(tree, tree.parent[language]))! : own
    for (let r = peoplesTree.frameStart[p]; r < peoplesTree.frameStart[p + 1]; r++) {
      const f = peoplesTree.frame[r]
      if (f >= times.length) continue
      const at0 = founder && times[f] < tree.at[language] ? before : own
      for (let at = at0; at >= 0; at = parentOf[at]) nodes[at].speakers[f] += peoplesTree.people[r]
    }
    if (peoplesTree.big[p]) for (let at = own; at >= 0; at = parentOf[at]) nodes[at].peoples.push(p)
  }
  // THE NAMES by the view's node: each name under the node that gave it
  // and every node above it, in the order given.
  const names = history.languages.names
  const namesOf = new Map<string, number[]>()
  const namerOf: string[] = []
  if (names) {
    const order = Array.from(names.kind, (_, j) => j).sort((a, b) => names.year[a] - names.year[b] || a - b)
    for (const j of order) {
      const k = names.namer[j]
      const id = tree.level[k] === LANGUAGE_LEVEL.dialect ? viewId(tree, k) : spokenId(tree, k)
      namerOf[j] = id
      for (let at = position.get(id) ?? -1; at >= 0; at = parentOf[at]) {
        const list = namesOf.get(nodes[at].id)
        if (list) list.push(j)
        else namesOf.set(nodes[at].id, [j])
      }
    }
  }
  // The names a panel lists: those given by `year`.
  const listed = (j: number, year: number): boolean => names !== null && names.year[j] <= year
  const entry = (j: number, year: number): NameEntry => {
    const kind = NAME_KINDS[names!.kind[j]]
    return { name: nameAt(names!, j, year) ?? '', kind: kind === 'village' && names!.town[j] ? 'town' : kind, language: namerOf[j], cell: names!.cell[j], given: names!.year[j] }
  }
  const detailOf = new Map<string, number>()
  for (let k = 0; k < count; k++) {
    if (tree.level[k] === LANGUAGE_LEVEL.dialect) continue
    detailOf.set(spokenId(tree, k), k)
  }
  return {
    times,
    nodes,
    detail: (id) => {
      const k = detailOf.get(id)
      const detail = k === undefined ? null : made.nodes[k]?.detail ?? null
      return detail ? { id, ...detail } : null
    },
    names: (id, from, count, year = Infinity) => {
      const list = (namesOf.get(id) ?? []).filter((j) => listed(j, year))
      const at = Number.isFinite(year) ? year : history.end
      return { total: list.length, rows: list.slice(from, from + count).map((j) => entry(j, at)) }
    },
    namesFound: (query, year) => {
      const found = new Set<string>()
      if (!names || !query) return found
      for (let j = 0; j < names.kind.length; j++) {
        if (found.has(namerOf[j]) || !listed(j, year)) continue
        if ((nameAt(names, j, year) ?? '').toLowerCase().includes(query)) found.add(namerOf[j])
      }
      return found
    },
    peopleName: (p) => made.peoples[p] || String(p + 1),
  }
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

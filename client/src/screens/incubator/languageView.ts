import type { LanguageDetail, LanguageLevel, LanguageNode, LanguageView, NameEntry, NamePart, NameStory, OtherName } from '../../ui/languagePanel/languageTypes'
import { LANGUAGE_LEVEL, NAME_HOW, NAME_KINDS, type LanguagesTree } from './historyPack'
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
// - A language or a dialect is extinct from the last end (the peoples'
//   tree's `ended`) of the peoples that speak it or a node below it, once
//   all of them ended; a family and its proto-language where the log says
//   the family is (familyGone). Not the log's ends for the languages and
//   the dialects (until 2026-10-31): the log tells the ends of the big
//   peoples only, and no language gone whose last speakers took a
//   daughter of it, so a node with no speakers left showed as living.
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
// forms; the current name, through the names the peoples that took the
// place gave it. THE OTHER NAMES (TEG-142, TEG-143; the crate's
// name_contact.rs): by name its chain from its first name (how it came,
// historyPack.ts NAME_HOW or NAME_FIRST; the node; the year; its form when
// the next one came; the meaning of its head word, null for none) and its
// exonyms (how, the node, the year, the forms over time). The names are
// the world's content: no i18n.
export interface HistoryNames {
  kind: Uint8Array
  town: Uint8Array
  place: Int32Array
  cell: Int32Array
  namer: Uint16Array
  year: Float32Array
  forms: NameForms[]
  chain: NameChainEntry[][]
  exonyms: NameExonym[][]
}

export interface NameForms {
  years: number[]
  forms: string[]
}
export interface NameChainEntry {
  how: number
  namer: number
  year: number
  form: string
  head: string | null
}
export interface NameExonym extends NameForms {
  how: number
  namer: number
  year: number
}

// The crate's names over time (`PlaceNames.forms`, by name [year, form,
// …]) and other names (`PlaceNames.others`), as HistoryNames holds them.
export type OthersRaw = { chain: [number, number, number, string, string | null][]; exonyms: [number, number, number, (number | string)[]][] }[]
export function formsOf(list: (number | string)[]): NameForms {
  return { years: list.filter((_, k) => k % 2 === 0) as number[], forms: list.filter((_, k) => k % 2 === 1) as string[] }
}
export function otherNamesOf(others: OthersRaw): Pick<HistoryNames, 'chain' | 'exonyms'> {
  return {
    chain: others.map((o) => o.chain.map(([how, namer, year, form, head]) => ({ how, namer, year, form, head: head ?? null }))),
    exonyms: others.map((o) => o.exonyms.map(([how, namer, year, list]) => ({ how, namer, year, ...formsOf(list) }))),
  }
}

// A name's story as the crate gives it (`PlaceNames.story`, TEG-141): the
// node of the tree that gave the entry current then, by its index.
export interface NameStoryRaw {
  namer: number
  year: number
  parts: NamePart[]
  steps: { year: number; form: string; rules: string[] }[]
}

// A form over time in `year`: the form of the last span begun by then.
function formIn(f: NameForms, year: number): string {
  let k = 0
  while (k + 1 < f.years.length && f.years[k + 1] <= year) k++
  return f.forms[k] ?? ''
}

// The entry of name j's chain current in `year`: the last given by then;
// -1 before its first.
export function chainAt(names: HistoryNames, j: number, year: number): number {
  const chain = names.chain[j]
  let c = -1
  while (c + 1 < chain.length && chain[c + 1].year <= year) c++
  return c
}

// A village is a town in the languages panel from this town at the
// history's end, people (simulation.rs THE TOWNS; the city is one). On the
// three v15 worlds (2026-10-31) 719 of Morvane's 5 383 villages and camps,
// 802 of Thalassor's 9 360, 584 of Zephyra's 2 438.
export const TOWN_PEOPLE = 1000

// Name j in `year`: the form of that year; null before it was given.
export function nameAt(names: HistoryNames, j: number, year: number): string | null {
  if (year < names.year[j]) return null
  return formIn(names.forms[j], year) || null
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

// The view's id of a tree node; a family's proto-language's.
const LEVEL_NAMES: LanguageLevel[] = ['family', 'language', 'dialect']
const viewId = (tree: LanguagesTree, k: number): string => `${LEVEL_NAMES[tree.level[k]][0]}${k}`
const protoId = (k: number): string => `f${k}p`
// The view's node a people speaks in when it speaks tree node k without a
// dialect: a language, or a family's proto-language.
const spokenId = (tree: LanguagesTree, k: number): string => (tree.level[k] === LANGUAGE_LEVEL.family ? protoId(k) : viewId(tree, k))
// The view's node of a tree node a people speaks: a dialect's own, else
// the language or the proto-language.
const nodeIdOf = (tree: LanguagesTree, k: number): string => (tree.level[k] === LANGUAGE_LEVEL.dialect ? viewId(tree, k) : spokenId(tree, k))
// The family of tree node k.
export function familyOf(tree: LanguagesTree, k: number): number {
  while (tree.parent[k] >= 0) k = tree.parent[k]
  return k
}

// The tree node people p speaks in `year`: its node (`peopleLanguage`),
// but a people whose language arose from it speaks, before then, the
// language it came from (the tree's `at`); -1 for a people of no node.
export function spokenNode(tree: LanguagesTree, p: number, year: number): number {
  const k = p < tree.peopleLanguage.length ? tree.peopleLanguage[p] : -1
  if (k < 0) return -1
  const language = tree.level[k] === LANGUAGE_LEVEL.dialect ? tree.parent[k] : k
  const founder = tree.level[language] === LANGUAGE_LEVEL.language && tree.people[language] === p
  return founder && year < tree.at[language] ? tree.parent[language] : k
}

// The tree nodes whose speakers speak the view's node `id` (a family, a
// proto-language, a language or a dialect) or a node below it in the
// view: 1 by tree node. Null for an id that is no node of the tree.
export function speakersOf(tree: LanguagesTree, id: string): Uint8Array | null {
  const out = new Uint8Array(tree.parent.length)
  let any = false
  for (let k = 0; k < out.length; k++) {
    const dialect = tree.level[k] === LANGUAGE_LEVEL.dialect
    if (nodeIdOf(tree, k) === id || (dialect && spokenId(tree, tree.parent[k]) === id) || viewId(tree, familyOf(tree, k)) === id) {
      out[k] = 1
      any = true
    }
  }
  return any ? out : null
}

// `places`, where the screen has them: the names' stories (the worker's
// book, TEG-141: null where it has none), and where the cells lie
// (LanguageView.cellAt, aspect).
export interface LanguagePlaces {
  story?: (index: number, year: number) => Promise<NameStoryRaw | null>
  cellAt?: (cell: number) => { u: number; v: number } | null
  aspect?: number
}

export function deriveLanguageView(history: { tree: PeoplesWithoutIds; log: readonly LogEvent[]; start: number; end: number; languages: HistoryLanguages }, places: LanguagePlaces = {}): LanguageView {
  const { tree: peoplesTree, log } = history
  const { tree, made } = history.languages
  const times = keptTimes(history.start, history.end)
  const count = tree.parent.length
  // The families' ends the log tells.
  const familyEnd = new Map<number, number>()
  for (const e of log) if (e.kind === 'familyGone') familyEnd.set(e.family, e.at)
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
      add({ id: viewId(tree, k), level: 'language', parent: viewId(tree, familyOf(tree, k)), name, proto: false, born: tree.at[k], ended: null })
    } else {
      const parent = spokenId(tree, tree.parent[k])
      const born = Math.max(tree.from[k], nodes[position.get(parent)!].born)
      add({ id: viewId(tree, k), level: 'dialect', parent, name, proto: false, born, ended: null })
    }
  }
  const parentOf = nodes.map((n) => (n.parent === null ? -1 : position.get(n.parent) ?? -1))
  // The speakers and the big peoples; by node the last year spoken
  // (Infinity while spoken at the history's end).
  const lastSpoken = new Float64Array(nodes.length).fill(-Infinity)
  const spokenUntil = (from: number, until: number): void => {
    for (let at = from; at >= 0; at = parentOf[at]) lastSpoken[at] = Math.max(lastSpoken[at], until)
  }
  const peopleCount = peoplesTree.parent.length
  for (let p = 0; p < peopleCount; p++) {
    const k = tree.peopleLanguage[p]
    if (k < 0) continue
    const own = position.get(nodeIdOf(tree, k))!
    // Its node from its birth to its end; a people whose language arose
    // from it the one it came from until then (spokenNode).
    const ended = peoplesTree.ended[p]
    const before = spokenNode(tree, p, -Infinity)
    if (before !== k) {
      const language = tree.level[k] === LANGUAGE_LEVEL.dialect ? tree.parent[k] : k
      spokenUntil(position.get(nodeIdOf(tree, before))!, Math.min(ended, tree.at[language]))
    }
    spokenUntil(own, ended)
    for (let r = peoplesTree.frameStart[p]; r < peoplesTree.frameStart[p + 1]; r++) {
      const f = peoplesTree.frame[r]
      if (f >= times.length) continue
      // Before its language arose from it, the people speaks the one it
      // came from (spokenNode).
      const at0 = position.get(nodeIdOf(tree, spokenNode(tree, p, times[f])))!
      for (let at = at0; at >= 0; at = parentOf[at]) nodes[at].speakers[f] += peoplesTree.people[r]
    }
    if (peoplesTree.big[p]) for (let at = own; at >= 0; at = parentOf[at]) nodes[at].peoples.push(p)
  }
  for (let at = 0; at < nodes.length; at++) {
    const node = nodes[at]
    if (node.level !== 'family' && !node.proto && Number.isFinite(lastSpoken[at])) node.ended = lastSpoken[at]
  }
  // THE NAMES by the view's node: each name under the node of each entry
  // of its chain and every node above it, in the order given; listed in a
  // year under the node of the entry current then (another people that
  // took the place gave it its name since: TEG-143).
  const names = history.languages.names
  const namesOf = new Map<string, [number, number][]>()
  if (names) {
    const given: [number, number][] = []
    names.chain.forEach((chain, j) => chain.forEach((_, c) => given.push([j, c])))
    given.sort(([a, c], [b, d]) => names.chain[a][c].year - names.chain[b][d].year || a - b || c - d)
    for (const [j, c] of given) {
      for (let at = position.get(nodeIdOf(tree, names.chain[j][c].namer)) ?? -1; at >= 0; at = parentOf[at]) {
        const list = namesOf.get(nodes[at].id)
        if (list) list.push([j, c])
        else namesOf.set(nodes[at].id, [[j, c]])
      }
    }
  }
  // The names a panel lists: those given by `year`.
  const listed = (j: number, year: number): boolean => names !== null && names.year[j] <= year
  const current = (j: number, c: number, year: number): boolean => listed(j, year) && chainAt(names!, j, year) === c
  const entry = (j: number, c: number, year: number): NameEntry => {
    const kind = NAME_KINDS[names!.kind[j]]
    const chain = names!.chain[j]
    // Its older names, the latest first; its exonyms by then.
    // An older name's `how`: what the people after did with it.
    const older: OtherName[] = chain.slice(0, c).map((e, i) => ({ name: e.form, language: nodeIdOf(tree, e.namer), how: NAME_HOW[chain[i + 1].how] })).reverse()
    const exonyms: OtherName[] = names!.exonyms[j].filter((e) => e.year <= year).map((e) => ({ name: formIn(e, year), language: nodeIdOf(tree, e.namer), how: NAME_HOW[e.how] }))
    return { name: nameAt(names!, j, year) ?? '', kind: kind === 'village' && names!.town[j] ? 'town' : kind, language: nodeIdOf(tree, chain[c].namer), cell: names!.cell[j], given: chain[c].year, older, exonyms, index: j, head: chain[c].head }
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
      const list = (namesOf.get(id) ?? []).filter(([j, c]) => current(j, c, year))
      const at = Number.isFinite(year) ? year : history.end
      return { total: list.length, rows: list.slice(from, from + count).map(([j, c]) => entry(j, c, at)) }
    },
    namesFound: (query, year) => {
      const found = new Set<string>()
      if (!names || !query) return found
      for (let j = 0; j < names.kind.length; j++) {
        if (!listed(j, year)) continue
        const id = nodeIdOf(tree, names.chain[j][chainAt(names, j, year)].namer)
        if (found.has(id)) continue
        if ((nameAt(names, j, year) ?? '').toLowerCase().includes(query)) found.add(id)
      }
      return found
    },
    peopleName: (p) => made.peoples[p] || String(p + 1),
    ...(places.story ? { story: async (row: NameEntry, year: number): Promise<NameStory | null> => {
      if (row.index === undefined) return null
      const raw = await places.story!(row.index, year)
      return raw ? { language: nodeIdOf(tree, raw.namer), year: raw.year, parts: raw.parts, steps: raw.steps } : null
    } } : {}),
    ...(places.cellAt ? { cellAt: places.cellAt, aspect: places.aspect ?? 1 } : {}),
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

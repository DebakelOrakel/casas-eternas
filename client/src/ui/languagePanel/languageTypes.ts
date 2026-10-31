// The languages panel's data (LanguagePanel.ts, TEG-140, DES-0033), apart
// from the panel and its styles: a view model without a DOM. It says nothing
// of the engine that made the languages; a screen's adapter fills it
// (screens/incubator/languageView.ts), or a fixture
// (scripts/fixtures/fixtureView.ts).
//
// The names and the words are the world's content: they come spelt and do
// not go through i18n. The meanings are ids (`language.meaning.<id>`).

export type LanguageLevel = 'family' | 'language' | 'dialect'

export interface LanguageNode {
  id: string
  level: LanguageLevel
  // The node above; null for a family.
  parent: string | null
  // Spelt: the world's content.
  name: string
  // The family's root language (the panel writes it "Proto-<name>").
  proto: boolean
  // Years, as the view's times. `ended`: when it died out (the end of its
  // last people), null while it lives.
  born: number
  ended: number | null
  // Its speakers at each of the view's times.
  speakers: Float32Array
  // The big peoples who speak it, by people id.
  peoples: readonly number[]
}

export interface Sound {
  ipa: string
  spelt: string
  kind: 'consonant' | 'vowel'
}

export interface SoundChange {
  year: number
  // The rule as the kit writes it ("p > f / #_").
  rule: string
  // The id of the kit's change (changes.json): the key of its sentence,
  // later.
  template: string
  example: { before: string; after: string }
}

export interface LexEntry {
  // A meaning id of the kit (meanings.json): `language.meaning.<id>`.
  meaning: string
  word: string
  // TEG-141, the comparison: the year the language's line took a new word
  // for the meaning (not inherited), null for an inherited one; the sound
  // changes that changed it, by index in the detail's `line`; an inherited
  // word's form in the family's proto-language (null for a new one).
  new?: number | null
  changes?: readonly number[]
  proto?: string | null
}

// A sound change of a language's line, from its family's proto-language
// on (`LanguageDetail.line`).
export interface LineChange {
  year: number
  rule: string
  template: string
}

export interface NamePattern {
  order: 'modifierFirst' | 'headFirst'
  // The joining sound, or null for none.
  joint: string | null
  heads: readonly string[]
  samples: readonly { name: string; meanings: readonly string[] }[]
}

export type PlaceKind = 'village' | 'town' | 'river' | 'mountain' | 'lake' | 'landmass'

export interface NameEntry {
  name: string
  kind: PlaceKind
  // The node of the language that gave it.
  language: string
  cell: number
  // The year it was given.
  given: number
  // Its older names (the peoples before gave them; the latest first), and
  // what other languages call it: each with the node of its language.
  older?: readonly OtherName[]
  exonyms?: readonly OtherName[]
  // TEG-141, the names tab: the name's index, for its story
  // (`LanguageView.story`), and the meaning of its head word (null for
  // none), for the same pattern nearby.
  index?: number
  head?: string | null
}

// How a name came (the crate's place_names.rs `how`): an older name, the
// people that took the place renamed it or kept it; an exonym, a
// neighbour borrowed it, translated it, or gave it a name of its own.
export type NameHow = 'renamed' | 'kept' | 'borrowed' | 'translated' | 'own'

export interface OtherName {
  name: string
  language: string
  how?: NameHow
}

// A part of a name (`NameStory.parts`): its role, its meaning (null for a
// word of its own and an ending), its word spelt alone.
export type NamePartRole = 'head' | 'modifier' | 'own' | 'ending'
export interface NamePart {
  role: NamePartRole
  meaning: string | null
  spelt: string
}

// THE STORY of a name (TEG-141, the names tab): its parts as the namer
// said them, and its form over time up to the year asked for: the form
// as given first, then each later form with the rules of the sound
// changes that made it ("p > f / #_", the kit's notation).
export interface NameStory {
  // The node that gave it, and the year.
  language: string
  year: number
  parts: readonly NamePart[]
  steps: readonly { year: number; form: string; rules: readonly string[] }[]
}

export interface LanguageDetail {
  id: string
  sounds: readonly Sound[]
  syllables: readonly string[]
  // Each 0..1.
  character: { hardness: number; length: number; vowels: number }
  spelling: string
  changes: readonly SoundChange[]
  // An extract, or the whole; `lexiconSize` is how many meanings it has.
  lexicon: readonly LexEntry[]
  lexiconSize: number
  pattern: NamePattern
  // Every sound change of its line, from its family's proto-language on,
  // in their order (TEG-141); the lexicon's `changes` index it.
  line?: readonly LineChange[]
}

export interface LanguageView {
  // The times the speakers are given at, years, rising.
  times: Float32Array
  nodes: readonly LanguageNode[]
  // Asked for when a node is shown; null where there is none (a dialect,
  // or an engine that does not make one).
  detail(id: string): LanguageDetail | null
  // The names given in a node's language or below it, from `from`, `count`
  // of them, and how many there are: those given by `year` (all where
  // none), each in its form of that year.
  names(id: string, from: number, count: number, year?: number): { total: number; rows: readonly NameEntry[] }
  // The nodes that gave a name holding `query` (lower case) by `year`, in
  // its form of that year: the search finds them.
  namesFound(query: string, year: number): ReadonlySet<string>
  // A people's name: the world's content.
  peopleName(people: number): string
  // A name's story in `year` (TEG-141), asked for when the names tab shows
  // it; null where there is none. Absent: no stories.
  story?(entry: NameEntry, year: number): Promise<NameStory | null>
  // Where a cell is on the world's flat torus, each 0..1 (u across, v
  // down), and the torus's width over its height: for the names nearby.
  // Absent: no names nearby.
  cellAt?(cell: number): { u: number; v: number } | null
  aspect?: number
}

// --- derived (no DOM) ---------------------------------------------------------

// The index of the time sample at `year`: the last time not after it (the
// speakers hold until the next sample, as the kept states of a history do).
export function sampleAt(times: Float32Array, year: number): number {
  let k = 0
  while (k + 1 < times.length && times[k + 1] <= year) k++
  return k
}

// A view's nodes by id and by parent, in the view's order.
export interface LanguageIndex {
  byId: Map<string, LanguageNode>
  children: Map<string | null, LanguageNode[]>
}

export function indexOf(view: LanguageView): LanguageIndex {
  const byId = new Map<string, LanguageNode>()
  const children = new Map<string | null, LanguageNode[]>()
  for (const node of view.nodes) {
    byId.set(node.id, node)
    const list = children.get(node.parent)
    if (list) list.push(node)
    else children.set(node.parent, [node])
  }
  return { byId, children }
}

// Whether a node exists at `year` (born), and whether it is extinct then.
export const bornBy = (node: LanguageNode, year: number): boolean => node.born <= year
export const extinctBy = (node: LanguageNode, year: number): boolean => node.ended !== null && node.ended <= year

// The distance of two points on the flat torus (`LanguageView.cellAt`),
// in the torus's heights: each axis wraps.
export function torusDistance(a: { u: number; v: number }, b: { u: number; v: number }, aspect: number): number {
  const wrap = (d: number): number => {
    const x = Math.abs(d) % 1
    return Math.min(x, 1 - x)
  }
  return Math.hypot(wrap(a.u - b.u) * aspect, wrap(a.v - b.v))
}

// THE SAME PATTERN NEARBY (TEG-141, the names tab): of `candidates` (the
// names of the family of `name`), those with its head word's meaning,
// nearest first, `count` of them at most; not the name itself (by its
// cell and kind). None without a head or without the cells' places.
export function samePatternNearby(name: NameEntry, candidates: readonly NameEntry[], cellAt: ((cell: number) => { u: number; v: number } | null) | undefined, aspect: number, count: number): NameEntry[] {
  const at = cellAt?.(name.cell)
  if (!name.head || !at || !cellAt) return []
  const near: { entry: NameEntry; d: number }[] = []
  for (const entry of candidates) {
    if (entry.head !== name.head || (entry.cell === name.cell && entry.kind === name.kind)) continue
    const where = cellAt(entry.cell)
    if (where) near.push({ entry, d: torusDistance(at, where, aspect) })
  }
  near.sort((x, y) => x.d - y.d || x.entry.name.localeCompare(y.entry.name))
  return near.slice(0, count).map((x) => x.entry)
}

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
}

export interface NamePattern {
  order: 'modifierFirst' | 'headFirst'
  // The joining sound, or null for none.
  joint: string | null
  heads: readonly string[]
  samples: readonly { name: string; meanings: readonly string[] }[]
}

export type PlaceKind = 'village' | 'town' | 'river' | 'mountain' | 'lake'

export interface NameEntry {
  name: string
  kind: PlaceKind
  // The node of the language that gave it.
  language: string
  cell: number
  // The year it was given.
  given: number
}

export interface LanguageDetail {
  id: string
  sounds: readonly Sound[]
  syllables: readonly string[]
  // Each 0..1.
  character: { hardness: number; length: number; vowels: number }
  spelling: string
  changes: readonly SoundChange[]
  // An extract; `lexiconSize` is how many meanings it has.
  lexicon: readonly LexEntry[]
  lexiconSize: number
  pattern: NamePattern
}

export interface LanguageView {
  // The times the speakers are given at, years, rising.
  times: Float32Array
  nodes: readonly LanguageNode[]
  // Asked for when a node is shown; null where there is none (a dialect,
  // or an engine that does not make one).
  detail(id: string): LanguageDetail | null
  // The names given in a node's language, from `from`, `count` of them,
  // and how many there are.
  names(id: string, from: number, count: number): { total: number; rows: readonly NameEntry[] }
  // A people's name: the world's content.
  peopleName(people: number): string
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

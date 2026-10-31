import { getLocale, t, type TKey } from '../../i18n/i18n'
import { button, el, nodeName, yearNumber } from './languageDom'
import { bornBy, type LanguageDetail, type LanguageIndex, type LanguageNode, type LanguageView, type LexEntry, type LineChange, type NameEntry } from './languageTypes'

// THE COMPARISON (LanguagePanel.ts, TEG-141): languages of one family side
// by side, after the design canvas (Sprachen.dc.html C, Sprachen-Voll.dc.html
// B). The languages chosen as chips; how their kinship shows (the
// proto-language's word they all go back to, a sound change some took
// part in and the others did not, on a line of years); their words by
// meaning, with the proto-language's (`*`) and the sound changes that tell
// them apart (the "Change" column); the names one area has in each.
//
// A word is the proto-language's through the sound changes of its line
// unless its line took a new word for the meaning (`LexEntry.new`): that
// one is marked, not inherited, unless all the chosen took it (their
// common forebear did: the same year in one family). A sound change is told by its year, its
// template and its rule: the same change in two lines is one their common
// forebear went through.

// How many languages the comparison starts with, how many meanings show
// before "the whole lexicon", how many sound changes the line of years
// shows, how many names of the first language are looked through for the
// same area, and how many of those rows show.
export const FIRST_COMPARED = 3
const FIRST_ROWS = 8
const TIMELINE_CHANGES = 4
const AREA_NAMES = 500
const AREA_ROWS = 3

export interface CompareState {
  view: LanguageView
  index: LanguageIndex
  year: number
  sample: number
  // The family compared in, and its languages chosen, in their order.
  family: string | null
  compared: readonly string[]
  menuOpen: boolean
  whole: boolean
}

export interface CompareActions {
  add(id: string): void
  remove(id: string): void
  toggleMenu(): void
  whole(): void
  // A name of the same area chosen: the names tab shows it.
  name(entry: NameEntry): void
}

// The family of a node (null for none).
export function familyOf(index: LanguageIndex, id: string | null): string | null {
  let at = id === null ? undefined : index.byId.get(id)
  while (at && at.parent !== null) at = index.byId.get(at.parent)
  return at?.id ?? null
}

// The family's languages that can be compared at `year`: born, not its
// proto-language.
export function languagesOf(index: LanguageIndex, family: string, year: number): LanguageNode[] {
  return (index.children.get(family) ?? []).filter((n) => n.level === 'language' && !n.proto && bornBy(n, year))
}

// The languages a comparison starts with for a node: its language (a
// dialect's), then its family's biggest at the time, FIRST_COMPARED in all.
export function defaultCompared(index: LanguageIndex, id: string | null, year: number, sample: number): string[] {
  const family = familyOf(index, id)
  if (family === null) return []
  let own = id === null ? undefined : index.byId.get(id)
  if (own?.level === 'dialect' && own.parent !== null) own = index.byId.get(own.parent)
  const list = languagesOf(index, family, year).sort((a, b) => (b.speakers[sample] ?? 0) - (a.speakers[sample] ?? 0))
  const out = own && own.level === 'language' && !own.proto && bornBy(own, year) ? [own.id] : []
  for (const n of list) if (out.length < FIRST_COMPARED && !out.includes(n.id)) out.push(n.id)
  return out
}

const changeKey = (c: LineChange): string => `${c.year}|${c.template}|${c.rule}`

interface Column {
  node: LanguageNode
  detail: LanguageDetail
  byMeaning: Map<string, LexEntry>
  // The keys of its line's changes.
  line: Set<string>
}

// The changes of `entry` (its line's keys).
const changedBy = (column: Column, entry: LexEntry | undefined): string[] => (entry?.changes ?? []).map((i) => column.detail.line?.[i]).filter((c): c is LineChange => !!c).map(changeKey)

const listText = (names: readonly string[]): string => new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(names)

function section(title: string): { element: HTMLElement; body: HTMLElement } {
  const element = el('section', 'language-overview__section')
  const head = el('h3', 'language-overview__heading', title)
  const body = el('div', 'language-overview__body')
  element.append(head, body)
  return { element, body }
}

function chooser(state: CompareState, actions: CompareActions): HTMLElement {
  const { index } = state
  const box = el('div', 'language-compare__chosen')
  box.append(el('span', 'language-compare__label', t('language.compare.chosen')))
  const chips = el('div', 'language-compare__chips')
  for (const id of state.compared) {
    const node = index.byId.get(id)
    if (!node) continue
    const chip = el('button', 'language-compare__chip')
    chip.type = 'button'
    chip.title = t('language.compare.remove', { name: node.name })
    chip.setAttribute('aria-label', chip.title)
    chip.append(el('span', '', node.name), el('span', 'language-compare__chip-x', '×'))
    chip.addEventListener('click', () => actions.remove(id))
    chips.append(chip)
  }
  const candidates = state.family === null ? [] : languagesOf(index, state.family, state.year).filter((n) => !state.compared.includes(n.id))
  if (candidates.length > 0) {
    const add = button('language-compare__add', t('language.compare.add'), actions.toggleMenu)
    add.setAttribute('aria-expanded', String(state.menuOpen))
    chips.append(add)
  }
  box.append(chips)
  if (state.menuOpen && candidates.length > 0) {
    const menu = el('div', 'language-compare__menu')
    for (const n of candidates) menu.append(button('language-compare__menu-item', n.name, () => actions.add(n.id)))
    box.append(menu)
  }
  return box
}

export function renderCompare(state: CompareState, actions: CompareActions): HTMLElement {
  const { view, index } = state
  const root = el('div', 'language-overview language-compare')
  root.append(chooser(state, actions))

  const columns: Column[] = []
  for (const id of state.compared) {
    const node = index.byId.get(id)
    const detail = node ? view.detail(id) : null
    if (!node || !detail) continue
    columns.push({ node, detail, byMeaning: new Map(detail.lexicon.map((e) => [e.meaning, e])), line: new Set((detail.line ?? []).map(changeKey)) })
  }
  if (columns.length < 2 || state.family === null) {
    root.append(el('p', 'language-panel__hint', t('language.compare.empty')))
    return root
  }
  const familyNode = index.byId.get(state.family)!
  const proto = (index.children.get(state.family) ?? []).find((n) => n.proto) ?? null
  const protoDetail = proto ? view.detail(proto.id) : null
  const protoByMeaning = new Map((protoDetail?.lexicon ?? []).map((e) => [e.meaning, e]))
  // A meaning's word in the proto-language, as an inherited word gives it.
  const protoWord = (meaning: string): string | null => {
    for (const c of columns) {
      const e = c.byMeaning.get(meaning)
      if (e && e.new === null && e.proto) return e.proto
    }
    const e = protoByMeaning.get(meaning)
    return e && e.new === null && e.proto ? e.proto : null
  }
  const gloss = (meaning: string): string => t(`language.meaning.${meaning}` as TKey)

  // The changes that tell the chosen apart: in some of their lines, not in
  // all; by key, its change, and the chosen that took part.
  const parting = new Map<string, { change: LineChange; some: Column[] }>()
  for (const c of columns) {
    for (const change of c.detail.line ?? []) {
      const key = changeKey(change)
      if (columns.every((o) => o.line.has(key))) continue
      const known = parting.get(key)
      if (known) known.some.push(c)
      else parting.set(key, { change, some: [c] })
    }
  }

  // The rows: the first language's meanings, then the others' it lacks.
  const meanings: string[] = []
  for (const c of columns) for (const e of c.detail.lexicon) if (!meanings.includes(e.meaning)) meanings.push(e.meaning)

  // THE KINSHIP: a word all inherited (one that differs among them where
  // there is one), a change some took part in, the line of years.
  const kinship = section(t('language.compare.kinship'))
  const inherited = meanings.filter((m) => protoWord(m) !== null && columns.every((c) => c.byMeaning.get(m)?.new === null))
  const telling = inherited.find((m) => new Set(columns.map((c) => c.byMeaning.get(m)!.word)).size > 1) ?? inherited[0]
  const text: string[] = []
  if (telling !== undefined) text.push(t('language.compare.root', { proto: `*${protoWord(telling)}`, meaning: gloss(telling) }))
  // The earliest parting change that changed a word of the table.
  const changedWords = (key: string): boolean => columns.some((c) => meanings.some((m) => changedBy(c, c.byMeaning.get(m)).includes(key)))
  const partings = [...parting.entries()].sort(([, a], [, b]) => a.change.year - b.change.year)
  const split = partings.find(([key]) => changedWords(key))
  if (split) {
    const [, { change, some }] = split
    const others = columns.filter((c) => !some.includes(c))
    text.push(t('language.compare.split', { some: listText(some.map((c) => c.node.name)), rule: change.rule, others: listText(others.map((c) => c.node.name)) }))
  }
  if (text.length > 0) kinship.body.append(el('p', 'language-overview__text', text.join(' ')))
  const timeline = el('div', 'language-compare__timeline')
  const point = (label: string): void => {
    if (timeline.childElementCount > 0) timeline.append(el('span', 'language-compare__span'))
    timeline.append(el('span', 'language-compare__point', label))
  }
  point(yearNumber(familyNode.born))
  for (const [, { change }] of partings.filter(([key]) => changedWords(key)).slice(0, TIMELINE_CHANGES)) point(`${yearNumber(change.year)} · ${change.rule}`)
  point(t('language.compare.today'))
  kinship.body.append(timeline)
  root.append(kinship.element)

  // THE TABLE.
  const table = el('div', 'language-compare__table')
  table.style.setProperty('--language-compare-columns', String(columns.length + 1))
  table.setAttribute('role', 'table')
  const row = (cells: HTMLElement[], className = ''): void => {
    const line = el('div', `language-compare__row ${className}`.trim())
    line.setAttribute('role', 'row')
    line.append(...cells)
    table.append(line)
  }
  const cell = (text: string, className = ''): HTMLElement => {
    const made = el('span', `language-compare__cell ${className}`.trim(), text)
    made.setAttribute('role', 'cell')
    return made
  }
  row([
    cell(t('language.compare.meaning'), 'language-compare__head'),
    cell(proto ? nodeName(proto) : '', 'language-compare__head language-compare__proto'),
    ...columns.map((c) => cell(c.node.name, 'language-compare__head')),
    cell(t('language.compare.change'), 'language-compare__head'),
  ], 'language-compare__row--head')
  let anyReplaced = false
  for (const m of state.whole ? meanings : meanings.slice(0, FIRST_ROWS)) {
    const words = columns.map((c) => {
      const e = c.byMeaning.get(m)
      if (!e) return cell('—', 'language-compare__word')
      const replaced = e.new !== null && e.new !== undefined && !columns.every((o) => o.byMeaning.get(m)?.new === e.new)
      const made = cell(e.word, `language-compare__word${replaced ? ' language-compare__word--new' : ''}`)
      if (replaced) made.title = `${t('language.compare.newWord')} (${yearNumber(e.new!)})`
      anyReplaced ||= replaced
      return made
    })
    const origin = protoWord(m)
    const rules: string[] = []
    for (const c of columns) {
      for (const key of changedBy(c, c.byMeaning.get(m))) {
        const p = parting.get(key)
        if (p && !rules.includes(p.change.rule)) rules.push(p.change.rule)
      }
    }
    row([cell(gloss(m)), cell(origin ? `*${origin}` : '—', 'language-compare__word language-compare__proto'), ...words, cell(rules.join(' · '), 'language-compare__rule')])
  }
  root.append(table)
  // The mark of a new word, said once.
  if (anyReplaced) {
    const legend = el('p', 'language-compare__legend')
    legend.append(el('span', 'language-compare__swatch'), document.createTextNode(t('language.compare.newWord')))
    root.append(legend)
  }
  if (!state.whole && meanings.length > FIRST_ROWS) root.append(button('language-overview__link', t('language.lexicon.showAll'), actions.whole))

  // THE SAME AREA: names of the first language that the others call by
  // names of their own, a row each.
  const first = columns[0]
  const columnOf = (language: string): Column | undefined => {
    for (let at = index.byId.get(language); at; at = at.parent === null ? undefined : index.byId.get(at.parent)) {
      const c = columns.find((x) => x.node.id === at!.id)
      if (c) return c
    }
    return undefined
  }
  const area: { entry: NameEntry; by: Map<Column, { name: string; how?: string }> }[] = []
  for (const entry of view.names(first.node.id, 0, AREA_NAMES, state.year).rows) {
    const by = new Map<Column, { name: string; how?: string }>()
    for (const o of entry.exonyms ?? []) {
      const c = columnOf(o.language)
      if (c && c !== first && !by.has(c)) by.set(c, { name: o.name, how: o.how })
    }
    if (by.size > 0) area.push({ entry, by })
    if (area.length >= AREA_ROWS) break
  }
  if (area.length > 0) {
    const { element, body } = section(t('language.compare.samePlace', { count: columns.length }))
    const names = el('div', 'language-compare__table language-compare__area')
    for (const { entry, by } of area) {
      const line = el('button', 'language-compare__row language-compare__area-row')
      line.type = 'button'
      line.addEventListener('click', () => actions.name(entry))
      line.append(cell(t(`language.place.${entry.kind}` as TKey)), cell('', 'language-compare__proto'), cell(entry.name, 'language-compare__word'))
      for (const c of columns.slice(1)) {
        const other = by.get(c)
        const made = cell(other?.name ?? '—', 'language-compare__word')
        if (other?.how) made.title = t(`language.name.how.${other.how}` as TKey)
        line.append(made)
      }
      line.append(cell(''))
      names.append(line)
    }
    names.style.setProperty('--language-compare-columns', String(columns.length + 1))
    body.append(names)
    root.append(element)
  }
  return root
}

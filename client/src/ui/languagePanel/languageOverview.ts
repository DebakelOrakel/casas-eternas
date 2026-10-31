import { t, type TKey } from '../../i18n/i18n'
import { formatCount } from '../format'
import { button, el, nodeName, speakersText, yearNumber } from './languageDom'
import { countsBelow } from './languageTree'
import { bornBy, extinctBy, type LanguageDetail, type LanguageIndex, type LanguageNode, type LanguageView } from './languageTypes'

// THE OVERVIEW of one language (LanguagePanel.ts): the narrow layout's
// second tab, the full layout's middle column. Who speaks it and since
// when, then what the engine made of it (its sounds, its character, its
// spelling, its sound changes, its words, the pattern of its names), then
// its daughters. Read only.
//
// Two heads, one for each layout (the CSS shows one): the narrow one says
// it in a line, the full one in four figures.

// How many daughters show before the "more" row, and how many words of the
// lexicon before "the whole lexicon".
const FIRST_DAUGHTERS = 2
const FIRST_WORDS = 6

export interface OverviewState {
  view: LanguageView
  index: LanguageIndex
  node: LanguageNode
  year: number
  sample: number
  lexiconWhole: boolean
  daughtersWhole: boolean
}

export interface OverviewActions {
  select(id: string): void
  lexiconWhole(): void
  daughtersWhole(): void
}

const section = (titleKey: TKey, extra?: string): { element: HTMLElement; body: HTMLElement } => {
  const element = el('section', 'language-overview__section')
  const head = el('h3', 'language-overview__heading', t(titleKey))
  if (extra) head.append(el('span', 'language-overview__aside', extra))
  const body = el('div', 'language-overview__body')
  element.append(head, body)
  return { element, body }
}

function figure(label: string, value: string, hint: string): HTMLElement {
  const tile = el('div', 'language-overview__figure')
  tile.append(el('span', 'language-overview__figure-label', label), el('span', 'language-overview__figure-value', value), el('span', 'language-overview__figure-hint', hint))
  return tile
}

function chips(values: readonly string[], className = ''): HTMLElement {
  const list = el('div', 'language-overview__chips')
  for (const value of values) list.append(el('span', `language-overview__chip ${className}`.trim(), value))
  return list
}

function sounds(detail: LanguageDetail): HTMLElement {
  const { element, body } = section('language.sounds.title')
  body.append(
    chips(detail.sounds.filter((s) => s.kind === 'consonant').map((s) => s.spelt)),
    chips(detail.sounds.filter((s) => s.kind === 'vowel').map((s) => s.spelt), 'language-overview__chip--vowel'),
    chips(detail.syllables, 'language-overview__chip--form'),
  )
  return element
}

function character(detail: LanguageDetail): HTMLElement {
  const { element, body } = section('language.character.title')
  const bars: [TKey, TKey, number][] = [
    ['language.character.hardness', 'language.character.hardnessRange', detail.character.hardness],
    ['language.character.length', 'language.character.lengthRange', detail.character.length],
    ['language.character.vowels', 'language.character.vowelsRange', detail.character.vowels],
  ]
  for (const [label, range, value] of bars) {
    const line = el('div', 'language-overview__trait')
    const bar = el('span', 'language-overview__bar')
    const fill = el('span', 'language-overview__bar-fill')
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
    bar.append(fill)
    line.append(el('span', 'language-overview__trait-label', t(label)), bar, el('span', 'language-overview__trait-range', t(range)))
    body.append(line)
  }
  return element
}

function changes(detail: LanguageDetail): HTMLElement {
  const { element, body } = section('language.changes.title')
  for (const change of detail.changes) {
    const line = el('div', 'language-overview__change')
    const text = el('div', 'language-overview__change-text')
    text.append(el('span', 'language-overview__rule', change.rule), el('span', 'language-overview__example', `${change.example.before} → ${change.example.after}`))
    line.append(el('span', 'language-overview__year', yearNumber(change.year)), text)
    body.append(line)
  }
  return element
}

function lexicon(detail: LanguageDetail, state: OverviewState, actions: OverviewActions): HTMLElement {
  const { element, body } = section('language.lexicon.title', t('language.lexicon.count', { count: detail.lexiconSize }))
  const words = el('div', 'language-overview__words')
  for (const entry of state.lexiconWhole ? detail.lexicon : detail.lexicon.slice(0, FIRST_WORDS)) {
    words.append(el('span', 'language-overview__word', entry.word), el('span', 'language-overview__gloss', t(`language.meaning.${entry.meaning}` as TKey)))
  }
  body.append(words)
  if (!state.lexiconWhole && detail.lexicon.length > FIRST_WORDS) body.append(button('language-overview__link', t('language.lexicon.showAll'), actions.lexiconWhole))
  return element
}

function pattern(detail: LanguageDetail): HTMLElement {
  const { element, body } = section('language.pattern.title')
  const p = detail.pattern
  body.append(el('p', 'language-overview__text', `${t(p.order === 'modifierFirst' ? 'language.pattern.modifierFirst' : 'language.pattern.headFirst')}, ${p.joint === null ? t('language.pattern.noJoint') : t('language.pattern.joint', { joint: p.joint })}.`))
  const heads = el('div', 'language-overview__heads')
  heads.append(el('span', 'language-overview__text', t('language.pattern.heads')), chips(p.heads.map((h) => `-${h}`), 'language-overview__chip--form'))
  body.append(heads)
  const samples = el('div', 'language-overview__samples')
  for (const sample of p.samples) {
    const one = el('div', 'language-overview__sample')
    one.append(el('span', 'language-overview__sample-name', sample.name), el('span', 'language-overview__gloss', sample.meanings.map((m) => t(`language.meaning.${m}` as TKey)).join(' · ')))
    samples.append(one)
  }
  body.append(samples)
  return element
}

function daughters(state: OverviewState, actions: OverviewActions): HTMLElement | null {
  const list = (state.index.children.get(state.node.id) ?? [])
    .filter((c) => !c.proto && bornBy(c, state.year))
    .sort((a, b) => (b.speakers[state.sample] ?? 0) - (a.speakers[state.sample] ?? 0))
  if (list.length === 0) return null
  const { element, body } = section('language.daughters.title')
  const all = state.daughtersWhole || list.length <= FIRST_DAUGHTERS + 1
  for (const child of all ? list : list.slice(0, FIRST_DAUGHTERS)) {
    const line = el('button', 'language-overview__daughter')
    line.type = 'button'
    line.addEventListener('click', () => actions.select(child.id))
    const extinct = extinctBy(child, state.year)
    line.append(
      el('span', 'language-overview__daughter-name', extinct ? `${child.name} †` : child.name),
      el('span', 'language-overview__daughter-value', extinct ? t('language.tree.extinct') : `${speakersText(child, state.sample)} · ${t('language.overview.peoples', { count: child.peoples.length })}`),
    )
    body.append(line)
  }
  if (!all) body.append(button('language-overview__link', t(state.node.level === 'family' ? 'language.tree.moreLanguages' : 'language.tree.moreDialects', { count: list.length - FIRST_DAUGHTERS }), actions.daughtersWhole))
  return element
}

// The node it came from, as the panel names it: a family's language comes
// from the family's root language where there is one.
function origin(state: OverviewState): LanguageNode | null {
  const parent = state.node.parent === null ? null : state.index.byId.get(state.node.parent) ?? null
  if (!parent || parent.level !== 'family') return parent
  return (state.index.children.get(parent.id) ?? []).find((c) => c.proto && c.id !== state.node.id) ?? parent
}

export function renderOverview(state: OverviewState, actions: OverviewActions): HTMLElement {
  const { node, view, index, sample } = state
  const root = el('div', 'language-overview')

  const crumbs: string[] = []
  for (let at = node.parent === null ? undefined : index.byId.get(node.parent); at; at = at.parent === null ? undefined : index.byId.get(at.parent)) crumbs.unshift(nodeName(at))
  if (crumbs.length > 0) root.append(el('div', 'language-overview__crumbs', `${crumbs.join(' › ')} ›`))

  const extinct = extinctBy(node, state.year)
  const title = el('div', 'language-overview__title')
  title.append(el('h2', 'language-overview__name', nodeName(node)), el('span', 'language-overview__tag', t(`language.level.${node.level}` as TKey)))
  title.append(el('span', `language-overview__status${extinct ? ' language-overview__status--extinct' : ''} language-panel__full-only`, extinct ? t('language.tree.extinct') : t('language.overview.living')))
  root.append(title)

  const speakers = speakersText(node, sample)
  const peoples = t('language.overview.peoples', { count: node.peoples.length })
  // The narrow head: one line.
  root.append(el('p', 'language-overview__line language-panel__narrow-only', [
    `${t('language.overview.since')} ${yearNumber(node.born)}`,
    extinct ? t('language.tree.extinct') : `${t('language.overview.speakers')} ${speakers}`,
    peoples,
  ].join(' · ')))
  // The full head: four figures.
  const from = origin(state)
  const below = countsBelow(index, node.id, { year: state.year, extinct: true })
  let world = 0
  for (const n of view.nodes) if (n.level === 'dialect' && bornBy(n, state.year) && !extinctBy(n, state.year)) world++
  const figures = el('div', 'language-overview__figures language-panel__full-only')
  figures.append(
    figure(t('language.overview.speakers'), extinct ? '†' : speakers, peoples),
    figure(t('language.overview.since'), yearNumber(node.born), from ? t('language.overview.from', { name: nodeName(from) }) : ''),
    figure(t('language.filter.dialects'), String(below.dialects), t('language.overview.dialectsWorld', { count: world })),
    figure(t('language.overview.names'), formatCount(view.names(node.id, 0, 0, state.year).total), t('language.overview.namesKinds')),
  )
  root.append(figures)

  const detail = view.detail(node.id)
  if (detail) {
    root.append(sounds(detail), character(detail))
    const { element, body } = section('language.spelling.title')
    body.append(el('p', 'language-overview__text language-overview__mono', detail.spelling))
    root.append(element)
    root.append(lexicon(detail, state, actions))
    if (detail.changes.length > 0) root.append(changes(detail))
    root.append(pattern(detail))
  }
  const daughterList = daughters(state, actions)
  if (daughterList) root.append(daughterList)
  return root
}

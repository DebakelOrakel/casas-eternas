import { t } from '../../i18n/i18n'
import { button, el, nodeName, speakersText, yearText } from './languageDom'
import { bornBy, extinctBy, type LanguageIndex, type LanguageNode, type LanguageView } from './languageTypes'

// THE TREE of the languages panel (LanguagePanel.ts): the families, their
// languages, the languages' dialects. The narrow layout's first tab, the
// full layout's left column; the same rows in both.
//
// What a row shows depends on the time: a node born later is not there; one
// extinct by then shows only "With †" (a family and a family's root
// language always show: they are the frame of the rest). The dialects show
// only with their switch on. A list of languages or of dialects shows its
// largest few and a row for the rest. A search keeps the nodes whose name,
// the name of one of whose peoples, or a name of a place given in it by
// the time, holds it, with the nodes above them, unfolded.

// How many languages of a family, and dialects of a language, show before
// the "more" row.
const FIRST_LANGUAGES = 3
const FIRST_DIALECTS = 2
// The family swatches' colours, by the family's place (languagePanel.css).
const SWATCHES = 6

export interface TreeState {
  view: LanguageView
  index: LanguageIndex
  year: number
  sample: number
  selected: string | null
  // The nodes unfolded, and those whose whole list shows.
  expanded: ReadonlySet<string>
  whole: ReadonlySet<string>
  // "With †", the dialects' switch, the search (lower case; '' for none).
  extinct: boolean
  dialects: boolean
  query: string
}

export interface TreeActions {
  select(id: string): void
  toggle(id: string): void
  whole(id: string): void
}

// Whether a node shows under the time and the filters (the search apart).
export function shownByFilter(node: LanguageNode, state: Pick<TreeState, 'year' | 'extinct' | 'dialects'>): boolean {
  if (!bornBy(node, state.year)) return false
  if (node.level === 'dialect' && !state.dialects) return false
  if (node.level === 'family' || node.proto) return true
  return state.extinct || !extinctBy(node, state.year)
}

// The languages and the dialects below a node that are there at the time,
// extinct or not as the filter says (the dialects' switch apart: a count is
// of what there is). The roots of the families are not counted.
export function countsBelow(index: LanguageIndex, id: string, state: Pick<TreeState, 'year' | 'extinct'>): { languages: number; dialects: number } {
  let languages = 0
  let dialects = 0
  const walk = (parent: string): void => {
    for (const child of index.children.get(parent) ?? []) {
      if (!shownByFilter(child, { ...state, dialects: true })) continue
      if (child.level === 'language' && !child.proto) languages++
      if (child.level === 'dialect') dialects++
      walk(child.id)
    }
  }
  walk(id)
  return { languages, dialects }
}

// The nodes the search finds, with every node above them; null without a
// search.
function searchHits(state: TreeState): Set<string> | null {
  if (!state.query) return null
  const hits = new Set<string>()
  const named = state.view.namesFound(state.query, state.year)
  for (const node of state.view.nodes) {
    const found = nodeName(node).toLowerCase().includes(state.query) || node.peoples.some((p) => state.view.peopleName(p).toLowerCase().includes(state.query)) || named.has(node.id)
    if (!found) continue
    for (let at: LanguageNode | undefined = node; at && !hits.has(at.id); at = at.parent === null ? undefined : state.index.byId.get(at.parent)) hits.add(at.id)
  }
  return hits
}

export function renderTree(state: TreeState, actions: TreeActions): HTMLElement[] {
  const hits = searchHits(state)
  const rows: HTMLElement[] = []
  const shown = (node: LanguageNode): boolean => shownByFilter(node, state) && (hits === null || hits.has(node.id))
  // The roots first, then the living by their speakers, then the extinct.
  const order = (a: LanguageNode, b: LanguageNode): number =>
    Number(b.proto) - Number(a.proto) ||
    Number(extinctBy(a, state.year)) - Number(extinctBy(b, state.year)) ||
    (b.speakers[state.sample] ?? 0) - (a.speakers[state.sample] ?? 0)
  const childrenOf = (id: string): LanguageNode[] => (state.index.children.get(id) ?? []).filter(shown).sort(order)
  const open = (id: string): boolean => hits !== null || state.expanded.has(id)

  function row(node: LanguageNode, depth: number, foldable: boolean): void {
    const extinct = extinctBy(node, state.year)
    const line = el('div', `language-tree__row language-tree__row--${node.level} language-tree__row--depth${depth}`)
    line.classList.toggle('language-tree__row--selected', node.id === state.selected)
    line.classList.toggle('language-tree__row--extinct', extinct)
    line.classList.toggle('language-tree__row--proto', node.proto)
    line.setAttribute('role', 'treeitem')
    line.setAttribute('aria-selected', String(node.id === state.selected))
    if (foldable) line.setAttribute('aria-expanded', String(open(node.id)))
    const chevron = el('button', 'language-tree__chevron')
    chevron.type = 'button'
    chevron.tabIndex = -1
    chevron.setAttribute('aria-hidden', 'true')
    chevron.hidden = !foldable
    chevron.addEventListener('click', (e) => {
      e.stopPropagation()
      actions.toggle(node.id)
    })
    const main = el('button', 'language-tree__main')
    main.type = 'button'
    main.addEventListener('click', () => actions.select(node.id))
    if (node.level === 'family') {
      const families = state.index.children.get(null) ?? []
      main.append(el('span', `language-tree__swatch language-tree__swatch--${families.indexOf(node) % SWATCHES}`))
    }
    main.append(el('span', 'language-tree__name', extinct ? `${nodeName(node)} †` : nodeName(node)))
    if (node.level === 'family') {
      const counts = countsBelow(state.index, node.id, state)
      main.append(el('span', 'language-tree__counts', t('language.tree.counts', { languages: counts.languages, dialects: counts.dialects })))
    }
    main.append(el('span', 'language-tree__value', node.proto ? yearText(node.born) : extinct ? t('language.tree.extinct') : speakersText(node, state.sample)))
    line.append(chevron, main)
    rows.push(line)
  }

  function more(parent: string, count: number, dialects: boolean, depth: number): void {
    const line = el('div', `language-tree__row language-tree__row--more language-tree__row--depth${depth}`)
    line.append(button('language-tree__more', t(dialects ? 'language.tree.moreDialects' : 'language.tree.moreLanguages', { count }), () => actions.whole(parent)))
    rows.push(line)
  }

  function list(parent: LanguageNode, depth: number): void {
    const children = childrenOf(parent.id)
    const roots = children.filter((c) => c.proto)
    const rest = children.filter((c) => !c.proto)
    const first = parent.level === 'family' ? FIRST_LANGUAGES : FIRST_DIALECTS
    const all = hits !== null || state.whole.has(parent.id) || rest.length <= first + 1
    const showing = all ? rest : rest.slice(0, first)
    for (const child of [...roots, ...showing]) node(child, depth)
    if (!all) more(parent.id, rest.length - showing.length, parent.level !== 'family', depth)
  }

  function node(at: LanguageNode, depth: number): void {
    const foldable = childrenOf(at.id).length > 0
    row(at, depth, foldable)
    if (foldable && open(at.id)) list(at, depth + 1)
  }

  for (const family of (state.index.children.get(null) ?? []).filter(shown)) node(family, 0)
  return rows
}

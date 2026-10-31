import { t } from '../../i18n/i18n'
import { el, iconOf, LANGUAGES_ICON, yearText } from './languageDom'
import { renderOverview } from './languageOverview'
import { renderTree } from './languageTree'
import { indexOf, sampleAt, bornBy, type LanguageIndex, type LanguageView } from './languageTypes'
import { FIRST_NAMES, NAMES_PAGE, renderWorld } from './languageWorld'
import '../theme/design.css'
import './languagePanel.css'

export { LANGUAGES_ICON }

// THE LANGUAGES PANEL (2026-10-31, TEG-140, DES-0033): the languages of a
// world's peoples, read only, after the design canvas (Sprachen.dc.html,
// Sprachen-Voll.dc.html), light. A pure widget as the layer panel: it
// imports the catalog and the other widgets only, and is given its data as
// a view model (languageTypes.ts); it knows nothing of the engine that made
// the languages.
//
// One panel, two layouts, one DOM; a class says which:
//
// - NARROW: a column at the right, beside the chronicle, shown and hidden
//   by the screen (its switch in the title bar). Two tabs: the tree, and
//   the language selected (its overview, then who speaks it).
// - FULL: a window over the work area, as the artifacts and the jobs
//   (ui/windows/windowSet.ts): three columns, the tree, the language's
//   overview, its world side. Escape, or "back to the panel", folds it.
//
// The selection, the tab, the filters, the search and what is unfolded
// stay as they are across the two. The screen asks for the layout: the
// panel's buttons and Escape only say what the viewer wants (`onLayout`),
// and the screen opens or closes the window through its window set, which
// calls `open` or `close` here.

export type LanguageLayout = 'narrow' | 'full'

export interface LanguagePanel {
  element: HTMLElement
  // null: no languages (yet).
  setView(view: LanguageView | null): void
  // The chronicle's time, years.
  setTime(year: number): void
  select(id: string | null): void
  layout(): LanguageLayout
  relabel(): void
  // The narrow layout shown or not; the full one shows while it is open.
  setVisible(visible: boolean): void
  // The full layout, as a window (ui/windows/windowSet.ts AppWindow).
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

// Published on the document element, as the chronicle's width
// (chroniclePanel.ts): the canvas and the map's furniture give it up.
const WIDTH_VAR = '--right-panel-width'
const WIDTH = '360px'

type Tab = 'tree' | 'language'

export function createLanguagePanel(host: HTMLElement, options: {
  // The node selected, for the screen to colour its peoples on the map.
  onSelect: (id: string | null) => void
  onShowOnMap: (target: { language: string } | { cell: number }) => void
  // The layout the viewer asks for.
  onLayout: (layout: LanguageLayout) => void
}): LanguagePanel {
  const aside = el('aside', 'language-panel language-panel--narrow language-panel--tab-tree design-light')
  aside.inert = true
  aside.tabIndex = -1

  const head = el('header', 'language-panel__head')
  const mark = el('span', 'language-panel__mark')
  mark.append(iconOf(`<path d="${LANGUAGES_ICON}"/>`))
  const title = el('span', 'language-panel__title')
  const summary = el('span', 'language-panel__summary')
  const unfold = el('button', 'language-panel__action language-panel__narrow-only')
  unfold.type = 'button'
  unfold.addEventListener('click', () => options.onLayout('full'))
  const fold = el('button', 'language-panel__action language-panel__full-only')
  fold.type = 'button'
  fold.addEventListener('click', () => options.onLayout('narrow'))
  head.append(mark, title, summary, unfold, fold)

  const when = el('div', 'language-panel__when')

  const tabs = el('div', 'language-panel__tabs language-panel__narrow-only')
  tabs.setAttribute('role', 'tablist')
  const tabButtons = (['tree', 'language'] as const).map((id) => {
    const b = el('button', 'language-panel__tab')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => {
      tab = id
      paint()
    })
    tabs.append(b)
    return { id, button: b }
  })

  const empty = el('p', 'language-panel__empty')

  const columns = el('div', 'language-panel__columns')
  const treeColumn = el('section', 'language-panel__column language-panel__column--tree')
  const search = el('label', 'language-panel__search')
  search.append(iconOf('<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>', 14))
  const input = el('input', 'language-panel__input')
  input.type = 'search'
  input.addEventListener('input', () => {
    query = input.value.trim().toLowerCase()
    paintTree()
  })
  search.append(input)
  const filters = el('div', 'language-panel__filters')
  const seen = el('div', 'language-panel__segments')
  const today = el('button', 'language-panel__segment')
  today.type = 'button'
  today.addEventListener('click', () => {
    extinct = false
    paintTree()
  })
  const withExtinct = el('button', 'language-panel__segment')
  withExtinct.type = 'button'
  withExtinct.addEventListener('click', () => {
    extinct = true
    paintTree()
  })
  seen.append(today, withExtinct)
  const dialectSwitch = el('button', 'language-panel__switch-row')
  dialectSwitch.type = 'button'
  dialectSwitch.setAttribute('role', 'switch')
  const dialectLabel = el('span', 'language-panel__switch-label')
  dialectSwitch.append(dialectLabel, el('span', 'language-panel__switch'))
  dialectSwitch.addEventListener('click', () => {
    dialects = !dialects
    paintTree()
  })
  filters.append(seen, el('span', 'language-panel__grow'), dialectSwitch)
  const tree = el('div', 'language-panel__tree')
  tree.setAttribute('role', 'tree')
  const hint = el('p', 'language-panel__hint')
  treeColumn.append(search, filters, tree, hint)

  const mainColumn = el('section', 'language-panel__column language-panel__column--main')
  const mainTabs = el('div', 'language-panel__main-tabs language-panel__full-only')
  const overviewTab = el('span', 'language-panel__main-tab')
  mainTabs.append(overviewTab)
  const overview = el('div', 'language-panel__overview')
  mainColumn.append(mainTabs, overview)
  const worldColumn = el('section', 'language-panel__column language-panel__column--world')

  columns.append(treeColumn, mainColumn, worldColumn)
  aside.append(head, when, tabs, empty, columns)
  aside.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && layoutNow === 'full') options.onLayout('narrow')
  })
  host.appendChild(aside)

  // --- state ------------------------------------------------------------------

  let view: LanguageView | null = null
  let index: LanguageIndex | null = null
  let year = 0
  let selected: string | null = null
  let tab: Tab = 'tree'
  let layoutNow: LanguageLayout = 'narrow'
  let visible = false
  const expanded = new Set<string>()
  const whole = new Set<string>()
  let extinct = false
  let dialects = true
  let query = ''
  // What one language's view has unfolded; again as it starts on another.
  let lexiconWhole = false
  let daughtersWhole = false
  let peoplesWhole = false
  let namesShown = FIRST_NAMES

  // The time shown: the chronicle's, within the view's times.
  const shownYear = (): number => (view && view.times.length > 0 ? Math.min(year, view.times[view.times.length - 1]) : year)
  const sample = (): number => (view ? sampleAt(view.times, shownYear()) : 0)

  function selectNode(id: string | null): void {
    if (id === selected) return
    selected = id
    lexiconWhole = false
    daughtersWhole = false
    peoplesWhole = false
    namesShown = FIRST_NAMES
    // The node shows in the tree: the nodes above it unfold.
    for (let at = id && index ? index.byId.get(id) : undefined; at && at.parent !== null; at = index!.byId.get(at.parent)) expanded.add(at.parent)
    paint()
    options.onSelect(id)
  }

  function paintTree(): void {
    today.setAttribute('aria-pressed', String(!extinct))
    withExtinct.setAttribute('aria-pressed', String(extinct))
    dialectSwitch.setAttribute('aria-checked', String(dialects))
    dialectSwitch.classList.toggle('language-panel__switch-row--on', dialects)
    if (!view || !index) {
      tree.replaceChildren()
      return
    }
    tree.replaceChildren(...renderTree({ view, index, year: shownYear(), sample: sample(), selected, expanded, whole, extinct, dialects, query }, {
      // A click on the row selected folds or unfolds it; on another, it
      // is selected and unfolds.
      select: (id) => {
        if (id === selected) {
          if (expanded.has(id)) expanded.delete(id)
          else expanded.add(id)
          paintTree()
          return
        }
        expanded.add(id)
        selectNode(id)
      },
      toggle: (id) => {
        if (expanded.has(id)) expanded.delete(id)
        else expanded.add(id)
        paintTree()
      },
      whole: (id) => {
        whole.add(id)
        paintTree()
      },
    }))
  }

  function paintLanguage(): void {
    const node = selected && index ? index.byId.get(selected) : undefined
    if (!view || !index || !node || !bornBy(node, shownYear())) {
      overview.replaceChildren(el('p', 'language-panel__hint', t('language.tree.hint')))
      worldColumn.replaceChildren()
      return
    }
    overview.replaceChildren(renderOverview({ view, index, node, year: shownYear(), sample: sample(), lexiconWhole, daughtersWhole }, {
      select: (id) => selectNode(id),
      lexiconWhole: () => {
        lexiconWhole = true
        paintLanguage()
      },
      daughtersWhole: () => {
        daughtersWhole = true
        paintLanguage()
      },
    }))
    worldColumn.replaceChildren(renderWorld({ view, node, peoplesWhole, namesShown }, {
      showOnMap: options.onShowOnMap,
      peoplesWhole: () => {
        peoplesWhole = true
        paintLanguage()
      },
      moreNames: () => {
        namesShown += NAMES_PAGE
        paintLanguage()
      },
    }))
  }

  function paint(): void {
    title.textContent = t('language.panel.title')
    unfold.textContent = t('language.panel.unfold')
    fold.textContent = t('language.panel.fold')
    tabButtons[0].button.textContent = t('language.tab.tree')
    tabButtons[1].button.textContent = t('language.tab.language')
    for (const { id, button } of tabButtons) button.setAttribute('aria-selected', String(id === tab))
    aside.classList.toggle('language-panel--tab-tree', tab === 'tree')
    aside.classList.toggle('language-panel--tab-language', tab === 'language')
    input.placeholder = t('language.search.placeholder')
    today.textContent = t('language.filter.today')
    withExtinct.textContent = t('language.filter.extinct')
    dialectLabel.textContent = t('language.filter.dialects')
    hint.textContent = t('language.tree.hint')
    overviewTab.textContent = t('language.tab.overview')
    empty.textContent = t('language.panel.empty')
    aside.classList.toggle('language-panel--empty', view === null)
    if (view) {
      const at = shownYear()
      let families = 0
      let languages = 0
      let dialectCount = 0
      for (const node of view.nodes) {
        if (!bornBy(node, at)) continue
        if (node.level === 'family') families++
        else if (node.level === 'language' && !node.proto) languages++
        else if (node.level === 'dialect') dialectCount++
      }
      summary.textContent = t('language.panel.summary', { families, languages, dialects: dialectCount })
      when.textContent = yearText(at)
    } else {
      summary.textContent = ''
      when.textContent = ''
    }
    paintTree()
    paintLanguage()
  }

  function applyLayout(): void {
    aside.classList.toggle('language-panel--narrow', layoutNow === 'narrow')
    aside.classList.toggle('language-panel--full', layoutNow === 'full')
    const shown = layoutNow === 'full' || visible
    aside.inert = !shown
    document.documentElement.style.setProperty(WIDTH_VAR, layoutNow === 'narrow' && visible ? WIDTH : '0px')
  }

  paint()

  return {
    element: aside,
    setView(next) {
      view = next
      index = next ? indexOf(next) : null
      if (selected && !index?.byId.has(selected)) selected = null
      paint()
    },
    setTime(next) {
      if (next === year) return
      const before = sample()
      const beforeYear = shownYear()
      year = next
      // While the chronicle plays, most times change only the year: the
      // rest is drawn again when the sample changes, or a node is born or
      // dies between two.
      if (view && sample() === before && !view.nodes.some((n) => (n.born > beforeYear) !== (n.born > shownYear()) || (n.ended !== null && (n.ended > beforeYear) !== (n.ended > shownYear())))) {
        when.textContent = yearText(shownYear())
        return
      }
      paint()
    },
    select: selectNode,
    layout: () => layoutNow,
    relabel: paint,
    setVisible(next) {
      visible = next
      applyLayout()
    },
    open() {
      layoutNow = 'full'
      applyLayout()
      // Last in its host, over the other windows' layer.
      host.appendChild(aside)
      aside.focus()
    },
    close() {
      layoutNow = 'narrow'
      applyLayout()
    },
    isOpen: () => layoutNow === 'full',
    dispose() {
      aside.remove()
      document.documentElement.style.removeProperty(WIDTH_VAR)
    },
  }
}

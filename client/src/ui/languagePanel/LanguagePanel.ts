import { t, type TKey } from '../../i18n/i18n'
import { defaultCompared, familyOf, renderCompare } from './languageCompare'
import { el, iconOf, LANGUAGES_ICON, yearText } from './languageDom'
import { renderName } from './languageName'
import { renderOverview } from './languageOverview'
import { renderTree } from './languageTree'
import { indexOf, sampleAt, bornBy, type LanguageIndex, type LanguageView, type NameEntry, type NameStory, type PlaceKind } from './languageTypes'
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
//   by the screen (its switch in the title bar). Four tabs: the tree; the
//   language selected (its overview, then who speaks it); the comparison
//   of languages of its family (languageCompare.ts); one name
//   (languageName.ts).
// - FULL: a window over the work area, as the artifacts and the jobs
//   (ui/windows/windowSet.ts): three columns, the tree, the work (tabs:
//   the language's overview, the comparison, one name), the language's
//   world side. Escape, or "back to the panel", folds it.
//
// The selection, the tab, the filters, the search, what is unfolded, the
// languages compared and the name chosen stay as they are across the two
// (the narrow language tab is the full overview tab). The screen asks for
// the layout: the panel's buttons and Escape only say what the viewer
// wants (`onLayout`), and the screen opens or closes the window through
// its window set, which calls `open` or `close` here.

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

// The work shown: the narrow layout's tabs but the tree, the full
// layout's middle column's tabs.
type Work = 'overview' | 'compare' | 'names'
const WORKS: readonly Work[] = ['overview', 'compare', 'names']
const WORK_KEYS: Record<Work, TKey> = { overview: 'language.tab.overview', compare: 'language.tab.compare', names: 'language.tab.names' }
// The narrow tabs: the tree, then the works ("language" for the overview).
type Tab = 'tree' | Work
const TABS: readonly Tab[] = ['tree', 'overview', 'compare', 'names']
const TAB_KEYS: Record<Tab, TKey> = { tree: 'language.tab.tree', overview: 'language.tab.language', compare: 'language.tab.compare', names: 'language.tab.names' }

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
  const tabButtons = TABS.map((id) => {
    const b = el('button', 'language-panel__tab')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => {
      treeShown = id === 'tree'
      if (id !== 'tree') work = id
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
  mainTabs.setAttribute('role', 'tablist')
  const mainTabButtons = WORKS.map((id) => {
    const b = el('button', 'language-panel__main-tab')
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => {
      work = id
      treeShown = false
      paint()
    })
    mainTabs.append(b)
    return { id, button: b }
  })
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
  let work: Work = 'overview'
  let treeShown = true
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
  // The comparison: its family, its languages, its menu, its rows.
  let compareFamily: string | null = null
  let compared: string[] = []
  let compareMenu = false
  let compareWhole = false
  // The name chosen (its index where the view gives one, else its cell and
  // kind; the family it was found in), and its story for the key asked.
  let chosen: { index?: number; cell: number; kind: PlaceKind; family: string | null } | null = null
  let story: NameStory | null = null
  let storyKey = ''

  // The time shown: the chronicle's, within the view's times.
  const shownYear = (): number => (view && view.times.length > 0 ? Math.min(year, view.times[view.times.length - 1]) : year)
  const sample = (): number => (view ? sampleAt(view.times, shownYear()) : 0)

  function selectNode(id: string | null): void {
    if (id === selected) return
    selected = id
    // A language chosen in the tree is to be seen: away from a name shown
    // (the names tab keeps it for a return).
    if (work === 'names') work = 'overview'
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
      // A click on the row selected clears the choice (the map shows all
      // the languages again; the arrow folds); on another, it is selected
      // and unfolds.
      select: (id) => {
        if (id === selected) {
          selectNode(null)
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

  function paintMain(): void {
    const node = selected && index ? index.byId.get(selected) : undefined
    const at = shownYear()
    const shown = !!node && bornBy(node, at)
    if (view && index && shown) {
      worldColumn.replaceChildren(renderWorld({ view, node: node!, year: at, peoplesWhole, namesShown }, {
        showOnMap: options.onShowOnMap,
        chooseName,
        peoplesWhole: () => {
          peoplesWhole = true
          paintMain()
        },
        moreNames: () => {
          namesShown += NAMES_PAGE
          paintMain()
        },
      }))
    } else worldColumn.replaceChildren()
    if (!view || !index) {
      overview.replaceChildren(el('p', 'language-panel__hint', t('language.tree.hint')))
      return
    }
    if (work === 'compare') {
      // A family other than the one compared: its languages, afresh.
      const family = familyOf(index, selected)
      if (family !== null && family !== compareFamily) {
        compareFamily = family
        compared = defaultCompared(index, selected, at, sample())
        compareMenu = false
        compareWhole = false
      }
      overview.replaceChildren(renderCompare({ view, index, year: at, sample: sample(), family: compareFamily, compared, menuOpen: compareMenu, whole: compareWhole }, {
        add: (id) => {
          compared = [...compared, id]
          compareMenu = false
          paintMain()
        },
        remove: (id) => {
          compared = compared.filter((x) => x !== id)
          paintMain()
        },
        toggleMenu: () => {
          compareMenu = !compareMenu
          paintMain()
        },
        whole: () => {
          compareWhole = true
          paintMain()
        },
        name: chooseName,
      }))
      return
    }
    if (work === 'names') {
      const { name, family } = chosenName()
      askStory(name)
      overview.replaceChildren(renderName({ view, index, year: at, name, family, story, selected: shown ? node! : null }, {
        choose: chooseName,
        showOnMap: (cell) => options.onShowOnMap({ cell }),
      }))
      return
    }
    if (!shown) {
      overview.replaceChildren(el('p', 'language-panel__hint', t('language.tree.hint')))
      return
    }
    overview.replaceChildren(renderOverview({ view, index, node: node!, year: at, sample: sample(), lexiconWhole, daughtersWhole }, {
      select: (id) => selectNode(id),
      lexiconWhole: () => {
        lexiconWhole = true
        paintMain()
      },
      daughtersWhole: () => {
        daughtersWhole = true
        paintMain()
      },
    }))
  }

  // A name chosen (in the world side's list, the comparison's same area,
  // the names nearby): the names tab shows it, the map goes to it.
  function chooseName(entry: NameEntry): void {
    chosen = { index: entry.index, cell: entry.cell, kind: entry.kind, family: index ? familyOf(index, entry.language) : null }
    work = 'names'
    treeShown = false
    paint()
    options.onShowOnMap({ cell: entry.cell })
  }

  // The name chosen in its form of the time shown, and the names of its
  // family then (the candidates nearby): looked for in the family it was
  // found in, then in all (another people may have taken it since).
  function chosenName(): { name: NameEntry | null; family: NameEntry[] } {
    if (!chosen || !view || !index) return { name: null, family: [] }
    const want = chosen
    const same = (r: NameEntry): boolean => (want.index !== undefined ? r.index === want.index : r.cell === want.cell && r.kind === want.kind)
    const families = view.nodes.filter((n) => n.level === 'family').map((n) => n.id)
    for (const family of [want.family, ...families.filter((f) => f !== want.family)]) {
      if (family === null) continue
      const rows = view.names(family, 0, Infinity, shownYear()).rows
      const name = rows.find(same)
      if (name) return { name, family: [...rows] }
    }
    return { name: null, family: [] }
  }

  // The story of the name shown, asked for once a name and year; painted
  // when it comes, if it is still the one asked for.
  function askStory(name: NameEntry | null): void {
    const key = name && view?.story ? `${name.index ?? `${name.cell}:${name.kind}`}@${shownYear()}` : ''
    if (key === storyKey) return
    storyKey = key
    story = null
    if (!name || !view?.story) return
    void view.story(name, shownYear()).then((next) => {
      if (storyKey !== key) return
      story = next
      paintMain()
    })
  }

  function paint(): void {
    title.textContent = t('language.panel.title')
    unfold.textContent = t('language.panel.unfold')
    fold.textContent = t('language.panel.fold')
    const tab: Tab = treeShown ? 'tree' : work
    for (const { id, button } of tabButtons) {
      button.textContent = t(TAB_KEYS[id])
      button.setAttribute('aria-selected', String(id === tab))
    }
    for (const { id, button } of mainTabButtons) {
      button.textContent = t(WORK_KEYS[id])
      button.setAttribute('aria-selected', String(id === work))
    }
    for (const id of TABS) aside.classList.toggle(`language-panel--tab-${id}`, id === tab)
    input.placeholder = t('language.search.placeholder')
    today.textContent = t('language.filter.today')
    withExtinct.textContent = t('language.filter.extinct')
    dialectLabel.textContent = t('language.filter.dialects')
    hint.textContent = t('language.tree.hint')
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
    paintMain()
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
      // Another view: its own comparison and names.
      compareFamily = null
      compared = []
      chosen = null
      storyKey = ''
      story = null
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

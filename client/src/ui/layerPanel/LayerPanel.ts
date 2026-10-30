import { t, type TKey } from '../../i18n/i18n'
import type { LayerGroup, LayerPanelTexts, LayerRow, LayerState } from './layerTypes'
import '../theme/design.css'
import './layerPanel.css'

// THE LAYER PANEL (2026-10-26): a screen's overlays in a column of their
// own beside the left one, after the design canvas (Overlays.dc.html,
// "Overlays in Gruppen"), light; shown and hidden by the screen. The
// incubator's first, the generator's too since 2026-10-28. It holds every
// overlay of the world; a row is greyed out only while its data is not
// there, never because of the step.
//
// The groups come in two kinds: of one choice ('one'), radio rows with
// "none" among them; of switches ('any'), each on or off by itself. A
// group folds. A group's heading has a number in a circle: how many of
// its layers are on, in the accent; with none on, how many have their
// data, in grey. The panel's head counts what is on and offers "all off"
// and the defaults. A group starts folded unless it says
// it starts open; the viewer's folding is kept, by the group's title, in
// the browser (2026-10-30, TEG-107: a viewer's convenience, as the title
// bar's panel switches; one state for every screen, as the overlay list is
// one; without storage a group starts as it says). A row's mark is its
// icon. The legend stays the screen's own box (ui/legend); no keyboard
// shortcuts.
//
// THE FAVOURITES (2026-10-28): a group at the top without a heading, set by
// the screen (setFavourites). Its rows are LINKS to rows of the groups: the
// same id, icon, label and help, the same state, and a click does what the
// row's own click does (a pick picks within its own group). Hidden while
// there are none. They are not counted a second time.

export interface LayerPanel {
  element: HTMLElement
  // The groups, in their order.
  setGroups(groups: readonly LayerGroup[]): void
  // The favourites, by row id, in this order; an id that is no row of the
  // groups is left out.
  setFavourites(ids: readonly string[]): void
  refresh(stateOf: (id: string) => LayerState): void
  relabel(): void
  setVisible(visible: boolean): void
  dispose(): void
}

// Published on the document element, as the left column's width
// (Sidebar.ts): the canvas and the map's furniture give it up.
const WIDTH_VAR = '--left-panel-width'
const WIDTH = '300px'

export function createLayerPanel(host: HTMLElement, options: {
  texts: LayerPanelTexts
  onToggle: (id: string) => void
  onPick: (id: string) => void
  onAllOff: () => void
  onDefaults: () => void
}): LayerPanel {
  const aside = document.createElement('aside')
  aside.className = 'layer-panel design-light'
  aside.inert = true

  const head = document.createElement('div')
  head.className = 'layer-panel__head'
  const title = document.createElement('span')
  title.className = 'layer-panel__title'
  const count = document.createElement('span')
  count.className = 'layer-panel__count'
  head.append(title, count)

  const actions = document.createElement('div')
  actions.className = 'layer-panel__actions'
  const allOff = document.createElement('button')
  allOff.type = 'button'
  allOff.className = 'layer-panel__action'
  allOff.addEventListener('click', options.onAllOff)
  const defaults = document.createElement('button')
  defaults.type = 'button'
  defaults.className = 'layer-panel__action'
  defaults.addEventListener('click', options.onDefaults)
  actions.append(allOff, defaults)

  const body = document.createElement('div')
  body.className = 'layer-panel__body'
  aside.append(head, actions, body)
  host.appendChild(aside)

  // A row's elements; `pick` whether it is a pick of one (a radio) or a
  // switch.
  interface Row { id: string; helpBase: string; pick: boolean; element: HTMLElement; mark: HTMLElement; label: HTMLElement }
  // A group's heading, its rows; folded or not, by
  // its title, kept across steps (`folded`, what the viewer chose; a group
  // not in it as it starts).
  interface Group {
    // The catalog key of its name: a pick group's title with `.label`.
    titleKey: TKey
    pick: boolean
    section: HTMLElement
    heading: HTMLButtonElement
    name: HTMLElement
    badge: HTMLElement
    rows: Row[]
  }
  let groups: Group[] = []
  // The groups as given, to find a favourite's row and its kind by.
  let given: readonly LayerGroup[] = []
  let favouriteIds: readonly string[] = []
  let favourites: Row[] = []
  const folded = new Map<string, boolean>()
  const foldedKeyOf = (titleKey: TKey): string => `layerPanel.${titleKey}.folded`
  let lastState: ((id: string) => LayerState) | null = null

  // The favourites' section, first in the body: no heading, only rows.
  const favouriteSection = document.createElement('section')
  favouriteSection.className = 'layer-panel__group layer-panel__favourites'
  const favouriteList = document.createElement('div')
  favouriteList.className = 'layer-panel__rows'
  favouriteList.setAttribute('role', 'group')
  favouriteSection.append(favouriteList)
  favouriteSection.hidden = true

  function rowOf(row: LayerRow, pick: boolean): Row {
    const element: HTMLElement = document.createElement(pick ? 'button' : 'label')
    element.className = 'layer-panel__row'
    element.dataset.help = row.helpBase
    const mark = document.createElement('span')
    mark.className = pick ? 'layer-panel__radio' : 'layer-panel__switch'
    const icon = document.createElement('img')
    icon.className = 'layer-panel__icon'
    icon.src = row.icon
    icon.alt = ''
    const label = document.createElement('span')
    label.className = 'layer-panel__label'
    if (pick) {
      (element as HTMLButtonElement).type = 'button'
      element.setAttribute('role', 'radio')
      // The mark at the end, as a switch's: one column of marks.
      element.append(icon, label, mark)
      element.addEventListener('click', () => options.onPick(row.id))
    } else {
      element.setAttribute('role', 'switch')
      element.tabIndex = 0
      element.append(icon, label, mark)
      element.addEventListener('click', (e) => {
        e.preventDefault()
        if (element.getAttribute('aria-disabled') !== 'true') options.onToggle(row.id)
      })
      element.addEventListener('keydown', (e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        if (element.getAttribute('aria-disabled') !== 'true') options.onToggle(row.id)
      })
    }
    return { id: row.id, helpBase: row.helpBase, pick, element, mark, label }
  }

  function groupOf(titleKey: TKey, helpBase: string | undefined, pick: boolean, open: boolean, rows: readonly LayerRow[]): Group {
    const section = document.createElement('section')
    section.className = 'layer-panel__group'
    const heading = document.createElement('button')
    heading.type = 'button'
    heading.className = 'layer-panel__heading'
    if (helpBase) heading.dataset.help = helpBase
    const chevron = document.createElement('span')
    chevron.className = 'layer-panel__chevron'
    chevron.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'layer-panel__name'
    const badge = document.createElement('span')
    badge.className = 'layer-panel__badge'
    // As wide as a row's switch and as far in, so the circle stands over
    // the switches' middle.
    const badgeSlot = document.createElement('span')
    badgeSlot.className = 'layer-panel__badge-slot'
    badgeSlot.append(badge)
    heading.append(chevron, name, badgeSlot)
    const list = document.createElement('div')
    list.className = 'layer-panel__rows'
    list.setAttribute('role', pick ? 'radiogroup' : 'group')
    const group: Group = { titleKey, pick, section, heading, name, badge, rows: [] }
    for (const row of rows) {
      const made = rowOf(row, pick)
      list.append(made.element)
      group.rows.push(made)
    }
    if (!folded.has(titleKey)) {
      try {
        const kept = localStorage.getItem(foldedKeyOf(titleKey))
        if (kept !== null) folded.set(titleKey, kept === '1')
      } catch {
        // No storage: as the group starts.
      }
    }
    const isFolded = (): boolean => folded.get(titleKey) ?? !open
    heading.addEventListener('click', () => {
      const nowFolded = !isFolded()
      folded.set(titleKey, nowFolded)
      try {
        localStorage.setItem(foldedKeyOf(titleKey), nowFolded ? '1' : '0')
      } catch {
        // Not kept: it stays so until the page closes.
      }
      section.classList.toggle('layer-panel__group--folded', isFolded())
    })
    section.classList.toggle('layer-panel__group--folded', isFolded())
    section.append(heading, list)
    return group
  }

  // The favourites' rows again, from the groups given: a link is a row of
  // its own made from the same LayerRow, so it says and does the same.
  function buildFavourites(): void {
    favourites = favouriteIds.flatMap((id) => {
      for (const g of given) {
        const row = g.rows.find((r) => r.id === id)
        if (row) return [rowOf(row, g.kind === 'one')]
      }
      return []
    })
    favouriteList.replaceChildren(...favourites.map((r) => r.element))
    favouriteSection.hidden = favourites.length === 0
  }

  function say(): void {
    title.textContent = t(options.texts.title)
    allOff.textContent = t(options.texts.allOff)
    defaults.textContent = t(options.texts.defaults)
    favouriteList.setAttribute('aria-label', t(options.texts.favourites))
    for (const r of favourites) r.label.textContent = t(`${r.helpBase}.label` as TKey)
    for (const g of groups) {
      g.name.textContent = t(g.titleKey)
      for (const r of g.rows) r.label.textContent = t(`${r.helpBase}.label` as TKey)
    }
    if (lastState) refresh(lastState)
  }

  function refresh(stateOf: (id: string) => LayerState): void {
    lastState = stateOf
    let on = 0
    const show = (r: Row): LayerState => {
      const state = stateOf(r.id)
      r.element.setAttribute('aria-checked', String(state.on))
      r.element.setAttribute('aria-disabled', String(!state.available))
      if (r.pick) (r.element as HTMLButtonElement).disabled = !state.available
      r.element.classList.toggle('layer-panel__row--on', state.on)
      return state
    }
    for (const g of groups) {
      // The head's number: what is on, in the accent; with nothing on,
      // how many have their data, in grey. "None" is a choice, not a layer.
      let groupOn = 0
      let groupAvailable = 0
      for (const r of g.rows) {
        const state = show(r)
        if (r.helpBase === 'overlay.none') continue
        if (state.on) groupOn++
        if (state.available) groupAvailable++
      }
      on += groupOn
      g.badge.textContent = String(groupOn > 0 ? groupOn : groupAvailable)
      g.badge.classList.toggle('layer-panel__badge--on', groupOn > 0)
    }
    // Links, not layers of their own: not counted again.
    for (const r of favourites) show(r)
    count.textContent = t(options.texts.active, { count: String(on) })
  }

  return {
    element: aside,
    setGroups(list) {
      body.replaceChildren(favouriteSection)
      given = list
      groups = list.map((g) => groupOf(g.title, g.helpBase, g.kind === 'one', g.open === true, g.rows))
      for (const g of groups) body.append(g.section)
      buildFavourites()
      say()
    },
    setFavourites(ids) {
      favouriteIds = [...ids]
      buildFavourites()
      say()
    },
    refresh,
    relabel: say,
    setVisible(visible) {
      aside.inert = !visible
      document.documentElement.style.setProperty(WIDTH_VAR, visible ? WIDTH : '0px')
    },
    dispose() {
      aside.remove()
      document.documentElement.style.removeProperty(WIDTH_VAR)
    },
  }
}

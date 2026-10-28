import { t, type TKey } from '../../i18n/i18n'
import type { OverlayListRow, OverlayListState } from '../generator/OverlayList'
import '../../ui/theme/design.css'
import './layerPanel.css'

// THE INCUBATOR'S LAYER PANEL (2026-10-26): its overlays in a column of
// their own beside the left one, after the design canvas
// (Overlays.dc.html, "Overlays in Gruppen"), light; shown and hidden by the
// screen. The incubator's alone: the generator keeps its OverlayList.
//
// The groups come in two kinds: of one choice ('one'), radio rows with
// "none" among them, the head saying of how many; of switches ('any'),
// each on or off by itself (the global group, the volcanoes and the
// plumes). A group folds. The head counts what is on and offers "all off" and the
// defaults. A row's mark is its icon, as OverlayList's. The legend stays
// the screen's own box (ui/legend); no keyboard shortcuts.

export interface LayerGroup {
  // Its name's catalog key.
  title: TKey
  kind: 'one' | 'any'
  rows: readonly OverlayListRow[]
}

export interface LayerPanel {
  element: HTMLElement
  // The groups, in their order.
  setGroups(groups: readonly LayerGroup[]): void
  refresh(stateOf: (id: string) => OverlayListState): void
  relabel(): void
  setVisible(visible: boolean): void
  dispose(): void
}

// Published on the document element, as the left column's width
// (Sidebar.ts): the canvas and the map's furniture give it up.
const WIDTH_VAR = '--left-panel-width'
const WIDTH = '300px'

export function createLayerPanel(host: HTMLElement, options: {
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

  // A group's heading, its rows; folded or not, by
  // its title, kept across steps.
  interface Group {
    // The catalog key of its name: a pick group's title with `.label`.
    titleKey: TKey
    pick: boolean
    section: HTMLElement
    heading: HTMLButtonElement
    name: HTMLElement
    badge: HTMLElement
    rows: { id: string; helpBase: string; element: HTMLElement; mark: HTMLElement; label: HTMLElement }[]
  }
  let groups: Group[] = []
  const folded = new Set<string>()
  let lastState: ((id: string) => OverlayListState) | null = null

  function groupOf(titleKey: TKey, pick: boolean, rows: readonly OverlayListRow[]): Group {
    const section = document.createElement('section')
    section.className = 'layer-panel__group'
    const heading = document.createElement('button')
    heading.type = 'button'
    heading.className = 'layer-panel__heading'
    const chevron = document.createElement('span')
    chevron.className = 'layer-panel__chevron'
    chevron.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.className = 'layer-panel__name'
    const badge = document.createElement('span')
    badge.className = 'layer-panel__badge'
    badge.hidden = !pick
    heading.append(chevron, name, badge)
    const list = document.createElement('div')
    list.className = 'layer-panel__rows'
    list.setAttribute('role', pick ? 'radiogroup' : 'group')
    const group: Group = { titleKey, pick, section, heading, name, badge, rows: [] }
    for (const row of rows) {
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
        element.append(mark, icon, label)
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
      list.append(element)
      group.rows.push({ id: row.id, helpBase: row.helpBase, element, mark, label })
    }
    heading.addEventListener('click', () => {
      if (folded.has(titleKey)) folded.delete(titleKey)
      else folded.add(titleKey)
      section.classList.toggle('layer-panel__group--folded', folded.has(titleKey))
    })
    section.classList.toggle('layer-panel__group--folded', folded.has(titleKey))
    section.append(heading, list)
    return group
  }

  function say(): void {
    title.textContent = t('incubator.layers.title')
    allOff.textContent = t('incubator.layers.allOff')
    defaults.textContent = t('incubator.layers.defaults')
    for (const g of groups) {
      g.name.textContent = t(g.titleKey)
      // Of how many layers, "none" not one.
      g.badge.textContent = t('incubator.layers.oneOf', { count: String(g.rows.filter((r) => r.helpBase !== 'overlay.none').length) })
      for (const r of g.rows) r.label.textContent = t(`${r.helpBase}.label` as TKey)
    }
    if (lastState) refresh(lastState)
  }

  function refresh(stateOf: (id: string) => OverlayListState): void {
    lastState = stateOf
    let on = 0
    for (const g of groups) {
      for (const r of g.rows) {
        const state = stateOf(r.id)
        r.element.setAttribute('aria-checked', String(state.on))
        r.element.setAttribute('aria-disabled', String(!state.available))
        if (g.pick && 'disabled' in r.element) (r.element as HTMLButtonElement).disabled = !state.available
        r.element.classList.toggle('layer-panel__row--on', state.on)
        // "None" is a choice, not a layer on.
        const none = r.helpBase === 'overlay.none'
        if (state.on && !none) on++
      }
    }
    count.textContent = t('incubator.layers.active', { count: String(on) })
  }

  return {
    element: aside,
    setGroups(list) {
      body.replaceChildren()
      groups = list.map((g) => groupOf(g.title, g.kind === 'one', g.rows))
      for (const g of groups) body.append(g.section)
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

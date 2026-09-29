import { t, type TKey } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import './overlayList.css'

// The sidebar's map-layer sections — from the design canvas (Main.dc.html, the
// first `<section>` in the `<aside>`): Overlays, a heading with a hover card and
// a count, then one row per layer the step you are on offers; and, for a step
// that paints a resource field, Resources under it, as picks.
//
// The step decides the list (see steps.ts), as the canvas does: a layer belongs
// to the steps it is useful in, and the fifteen-icon wall over the map showed
// you mostly layers of a step you were not looking at.
//
// The row's mark is the layer's ICON, where the canvas draws a colour swatch.
// Most of these layers have no one colour — they are gradients, and three of
// them are shapes on the map, not a tint — while the icon already stands for
// the layer everywhere else in this screen.

export interface OverlayListRow {
  id: string
  // The catalog base: `.label` names the row, `.help` fills the hover card the
  // delegated `data-help` listener shows.
  helpBase: string
  icon: string
}

// A pick group: radios, one of which is on. `title` and `help` are catalog
// bases for its heading and the heading's hover card.
export interface OverlayPickGroup {
  title?: string
  help?: string
  rows: readonly OverlayListRow[]
}

export interface OverlayListState {
  on: boolean
  available: boolean
}

export interface OverlayList {
  element: HTMLElement
  // The rows of the step just entered. Each pick group is mutually exclusive
  // within itself — radios in a section of their own, not switches — and
  // the groups combine (2026-09-29: several groups per step). An empty list
  // hides its section; nothing at all hides the lot.
  setRows(rows: readonly OverlayListRow[], groups?: readonly OverlayPickGroup[]): void
  // Switch positions and the unavailable look, read from the same state the map
  // is drawn from rather than kept a second time here.
  //
  refresh(stateOf: (id: string) => OverlayListState): void
  // Every string again, in the language that is active now — see i18n/relabel.
  relabel(): void
}

// Picks are a grid of icon tiles, however few (2026-09-29: the rule that
// kept groups of up to three as a list of words is gone). A resource step
// offers fourteen fields, and fourteen full rows are two thirds of the
// column; the name beside each icon says nothing the icon and its hover card
// do not, and one look for every group reads better than two.

export function createOverlayList(options: {
  onToggle: (id: string) => void
  onPick: (id: string) => void
}): OverlayList {
  // TWO SECTIONS, not one with a heading in the middle. The switches and the
  // picks are different questions — which layers do I combine, and which single
  // field do I paint — and they read as far apart as any two sections of the
  // column do. When they shared one box that distance was a margin on the
  // heading, which is a layout rule standing in for a structure that was not
  // there; now the column's own gap does it, for free and once.
  const host = document.createElement('div')
  host.className = 'gen-layers'
  host.hidden = true
  host.innerHTML = `
    <section class="gen-overlays">
      <div class="gen-overlays__head">
        <h2 class="gen-section-title" data-t="generator.section.overlays.label" data-help="generator.section.overlays"></h2>
        <span class="gen-overlays__count"></span>
      </div>
      <div class="gen-overlays__rows"></div>
    </section>
  `
  const overlaySection = host.querySelector<HTMLElement>('.gen-overlays')!
  const rowHost = host.querySelector<HTMLElement>('.gen-overlays__rows')!
  const count = host.querySelector<HTMLElement>('.gen-overlays__count')!
  relabel(host)

  const boxes = new Map<string, HTMLInputElement>()
  let rows: readonly OverlayListRow[] = []
  let picks: readonly OverlayListRow[] = []

  // One row. A switch stands for a layer that combines with the others; a radio
  // stands for a pick where only one answer can be on the map at a time, and
  // the control says which it is rather than leaving you to find out.
  function buildRow(row: OverlayListRow, kind: 'checkbox' | 'radio', onChange: () => void, group = 0): HTMLElement {
    const label = document.createElement('label')
    label.className = 'gen-overlay'
    label.dataset.help = row.helpBase
    const icon = document.createElement('img')
    icon.className = 'gen-overlay__icon'
    icon.src = row.icon
    icon.alt = ''
    const name = document.createElement('span')
    name.className = 'gen-overlay__label'
    name.dataset.t = `${row.helpBase}.label`
    const text = t(`${row.helpBase}.label` as TKey)
    name.textContent = text
    const box = document.createElement('input')
    box.type = kind
    // The control carries the name as well, because the grid below hides the
    // written one and a tile with only a picture in it has nothing to read out.
    box.dataset.tAria = `${row.helpBase}.label`
    box.setAttribute('aria-label', text)
    box.className = kind === 'radio' ? 'gen-overlay__pick' : 'gen-overlay__switch'
    // One radio set per group, so a pick in one leaves the others alone.
    if (kind === 'radio') box.name = `gen-overlay-pick-${group}`
    box.addEventListener('change', onChange)
    boxes.set(row.id, box)
    label.append(icon, name, box)
    return label
  }

  // A group's `title` is its heading's catalog base, which the step names
  // because each group asks its own question; a group without one gets no
  // heading, and is still its own box, spaced by the column's gap.
  let pickSections: HTMLElement[] = []
  function setRows(nextRows: readonly OverlayListRow[], groups: readonly OverlayPickGroup[] = []): void {
    rows = nextRows
    picks = groups.flatMap((g) => g.rows)
    boxes.clear()
    rowHost.replaceChildren(...rows.map((row) => buildRow(row, 'checkbox', () => options.onToggle(row.id))))
    for (const old of pickSections) old.remove()
    pickSections = groups.filter((g) => g.rows.length > 0).map((g, index) => {
      const section = document.createElement('section')
      section.className = 'gen-overlays gen-picks'
      if (g.title !== undefined) {
        const heading = document.createElement('h2')
        heading.className = 'gen-section-title'
        heading.dataset.t = `${g.title}.label`
        heading.dataset.help = g.help ?? g.title
        heading.textContent = t(`${g.title}.label` as TKey)
        section.appendChild(heading)
      }
      const list = document.createElement('div')
      list.className = 'gen-overlays__picks'
      list.classList.add('is-compact')
      list.replaceChildren(...g.rows.map((row) => buildRow(row, 'radio', () => options.onPick(row.id), index)))
      section.appendChild(list)
      host.appendChild(section)
      return section
    })
    overlaySection.hidden = rows.length === 0
    host.hidden = rows.length === 0 && picks.length === 0
  }

  return {
    element: host,
    setRows,
    refresh(stateOf) {
      let on = 0
      for (const row of [...rows, ...picks]) {
        const state = stateOf(row.id)
        const box = boxes.get(row.id)!
        box.checked = state.on && state.available
        box.disabled = !state.available
        box.parentElement!.classList.toggle('is-disabled', !state.available)
        if (box.checked && box.type === 'checkbox') on += 1
      }
      // Numbers and a slash, the same as the canvas — it needs no catalog key,
      // and it says at a glance how much of the step the map is showing.
      count.textContent = `${on} / ${rows.length}`
    },
    relabel: () => relabel(host),
  }
}

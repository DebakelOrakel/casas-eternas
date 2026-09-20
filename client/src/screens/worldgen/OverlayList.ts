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

export interface OverlayListState {
  on: boolean
  available: boolean
}

export interface OverlayList {
  element: HTMLElement
  // The rows of the step just entered. `picks` are mutually exclusive — one
  // resource field paints, so they are radios in a section of their own, not
  // switches. Either list empty hides its section; both empty hides the lot.
  setRows(rows: readonly OverlayListRow[], picks?: readonly OverlayListRow[]): void
  // Switch positions and the unavailable look, read from the same state the map
  // is drawn from rather than kept a second time here.
  refresh(stateOf: (id: string) => OverlayListState): void
  // Every string again, in the language that is active now — see i18n/relabel.
  relabel(): void
}

// Above this many picks the list becomes a grid of icon tiles. A resource step
// offers fourteen fields; fourteen full rows are two thirds of the column, and
// the name beside each icon says nothing the icon and its hover card do not.
// Below it a list reads better, because a short list of words is faster than a
// short row of pictures.
const PICK_GRID_MIN = 6

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
  host.className = 'wg-layers'
  host.hidden = true
  host.innerHTML = `
    <section class="wg-overlays">
      <div class="wg-overlays__head">
        <h2 class="wg-section-title" data-t="generator.overlays.label" data-help="generator.overlays"></h2>
        <span class="wg-overlays__count"></span>
      </div>
      <div class="wg-overlays__rows"></div>
    </section>
    <section class="wg-overlays wg-picks" hidden>
      <h2 class="wg-section-title" data-t="world.overlay.resources.label" data-help="world.overlay.resources"></h2>
      <div class="wg-overlays__picks"></div>
    </section>
  `
  const overlaySection = host.querySelector<HTMLElement>('.wg-overlays')!
  const pickSection = host.querySelector<HTMLElement>('.wg-picks')!
  const rowHost = host.querySelector<HTMLElement>('.wg-overlays__rows')!
  const pickHost = host.querySelector<HTMLElement>('.wg-overlays__picks')!
  const count = host.querySelector<HTMLElement>('.wg-overlays__count')!
  relabel(host)

  const boxes = new Map<string, HTMLInputElement>()
  let rows: readonly OverlayListRow[] = []
  let picks: readonly OverlayListRow[] = []

  // One row. A switch stands for a layer that combines with the others; a radio
  // stands for a pick where only one answer can be on the map at a time, and
  // the control says which it is rather than leaving you to find out.
  function buildRow(row: OverlayListRow, kind: 'checkbox' | 'radio', onChange: () => void): HTMLElement {
    const label = document.createElement('label')
    label.className = 'wg-overlay'
    label.dataset.help = row.helpBase
    const icon = document.createElement('img')
    icon.className = 'wg-overlay__icon'
    icon.src = row.icon
    icon.alt = ''
    const name = document.createElement('span')
    name.className = 'wg-overlay__label'
    name.dataset.t = `${row.helpBase}.label`
    const text = t(`${row.helpBase}.label` as TKey)
    name.textContent = text
    const box = document.createElement('input')
    box.type = kind
    // The control carries the name as well, because the grid below hides the
    // written one and a tile with only a picture in it has nothing to read out.
    box.dataset.tAria = `${row.helpBase}.label`
    box.setAttribute('aria-label', text)
    box.className = kind === 'radio' ? 'wg-overlay__pick' : 'wg-overlay__switch'
    if (kind === 'radio') box.name = 'wg-overlay-pick'
    box.addEventListener('change', onChange)
    boxes.set(row.id, box)
    label.append(icon, name, box)
    return label
  }

  function setRows(nextRows: readonly OverlayListRow[], nextPicks: readonly OverlayListRow[] = []): void {
    rows = nextRows
    picks = nextPicks
    boxes.clear()
    rowHost.replaceChildren(...rows.map((row) => buildRow(row, 'checkbox', () => options.onToggle(row.id))))
    pickHost.replaceChildren(...picks.map((row) => buildRow(row, 'radio', () => options.onPick(row.id))))
    pickHost.classList.toggle('is-compact', picks.length >= PICK_GRID_MIN)
    overlaySection.hidden = rows.length === 0
    pickSection.hidden = picks.length === 0
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

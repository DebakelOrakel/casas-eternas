import { t, type TKey } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import './overlayList.css'

// The sidebar's Overlays section — from the design canvas (Main.dc.html, the
// first `<section>` in the `<aside>`): a heading with a hover card and a count,
// then one row per layer the step you are on offers.
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
  // resource field paints, so they are radios under their own heading, not
  // switches. No rows at all = no section.
  setRows(rows: readonly OverlayListRow[], picks?: readonly OverlayListRow[]): void
  // Switch positions and the unavailable look, read from the same state the map
  // is drawn from rather than kept a second time here.
  refresh(stateOf: (id: string) => OverlayListState): void
  // Every string again, in the language that is active now — see i18n/relabel.
  relabel(): void
}

export function createOverlayList(options: {
  onToggle: (id: string) => void
  onPick: (id: string) => void
}): OverlayList {
  const section = document.createElement('section')
  section.className = 'wg-overlays'
  section.hidden = true
  section.innerHTML = `
    <div class="wg-overlays__head">
      <h2 class="wg-section-title" data-t="generator.overlays.label" data-help="generator.overlays"></h2>
      <span class="wg-overlays__count"></span>
    </div>
    <div class="wg-overlays__rows"></div>
    <h2 class="wg-section-title wg-overlays__picktitle" data-t="world.overlay.resources.label" data-help="world.overlay.resources" hidden></h2>
    <div class="wg-overlays__picks"></div>
  `
  const rowHost = section.querySelector<HTMLElement>('.wg-overlays__rows')!
  const pickHost = section.querySelector<HTMLElement>('.wg-overlays__picks')!
  const pickTitle = section.querySelector<HTMLElement>('.wg-overlays__picktitle')!
  const count = section.querySelector<HTMLElement>('.wg-overlays__count')!
  relabel(section)

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
    name.textContent = t(`${row.helpBase}.label` as TKey)
    const box = document.createElement('input')
    box.type = kind
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
    pickTitle.hidden = picks.length === 0
    section.hidden = rows.length === 0 && picks.length === 0
  }

  return {
    element: section,
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
    relabel: () => relabel(section),
  }
}

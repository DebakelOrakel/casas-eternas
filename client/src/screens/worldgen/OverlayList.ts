import { t, type TKey } from '../../i18n/i18n'
import { relabel } from '../../i18n/relabel'
import './overlayList.css'

// The sidebar's Overlays section — from the design canvas (Main.dc.html, the
// first `<section>` in the `<aside>`): a heading with a hover card and a count,
// then one row per overlay of the step you are on.
//
// The step decides the list, as the canvas does: an overlay belongs to the
// stage that computes it, and the fifteen-icon wall over the map showed you
// mostly layers of a step you were not looking at.
//
// The row's mark is the overlay's ICON, where the canvas draws a colour swatch.
// Most of these layers have no one colour — they are gradients, and three of
// them are shapes on the map, not a tint — while the icon already names the
// layer in the bar above the map.

export interface OverlayListRow {
  id: string
  // `world.overlay.<slug>`: `.label` names the row, `.help` fills the hover
  // card the delegated `data-help` listener shows.
  helpBase: string
  icon: string
}

export interface OverlayListState {
  on: boolean
  available: boolean
}

export interface OverlayList {
  element: HTMLElement
  // The rows of the step just entered. No rows = no section.
  setRows(rows: readonly OverlayListRow[]): void
  // Switch positions and the unavailable look, read from the same state the map
  // is drawn from rather than kept a second time here.
  refresh(stateOf: (id: string) => OverlayListState): void
  // Every string again, in the language that is active now — see i18n/relabel.
  relabel(): void
}

export function createOverlayList(options: { onToggle: (id: string) => void }): OverlayList {
  const section = document.createElement('section')
  section.className = 'wg-overlays'
  section.hidden = true
  section.innerHTML = `
    <div class="wg-overlays__head">
      <h2 class="wg-overlays__title" data-t="generator.overlays.label" data-help="generator.overlays"></h2>
      <span class="wg-overlays__count mono"></span>
    </div>
    <div class="wg-overlays__rows"></div>
  `
  const rowHost = section.querySelector<HTMLElement>('.wg-overlays__rows')!
  const count = section.querySelector<HTMLElement>('.wg-overlays__count')!
  relabel(section)

  const switches = new Map<string, HTMLInputElement>()
  let rows: readonly OverlayListRow[] = []

  function setRows(next: readonly OverlayListRow[]): void {
    rows = next
    switches.clear()
    rowHost.replaceChildren()
    section.hidden = rows.length === 0
    for (const row of rows) {
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
      box.type = 'checkbox'
      box.className = 'wg-overlay__switch'
      box.addEventListener('change', () => options.onToggle(row.id))
      switches.set(row.id, box)
      label.append(icon, name, box)
      rowHost.appendChild(label)
    }
  }

  return {
    element: section,
    setRows,
    refresh(stateOf) {
      let on = 0
      for (const row of rows) {
        const state = stateOf(row.id)
        const box = switches.get(row.id)!
        box.checked = state.on && state.available
        box.disabled = !state.available
        box.parentElement!.classList.toggle('is-disabled', !state.available)
        if (box.checked) on += 1
      }
      // Numbers and a slash, the same as the canvas — it needs no catalog key,
      // and it says at a glance how much of the step the map is showing.
      count.textContent = `${on} / ${rows.length}`
    },
    relabel: () => relabel(section),
  }
}

import { t } from '../../i18n/i18n'
import './legendPanel.css'

// THE MAP LEGEND: the legends of the layers on the map, as a collapsible
// panel at the map's left edge, beside the column — a header button that
// names it and counts what is in it, and a body that opens under it.
// COLLAPSED BY DEFAULT: the map is the thing being looked at, and a standing
// column of swatches is an answer to a question most hovers do not ask.
// Taken out of the generator (2026-10-25) for the incubator; the screen
// says what is in it, this module how it looks.
//
// It stays at the left edge of the map rather than moving to the bottom-left
// corner the design puts it in: that corner is the generator's parameter
// panel's, and its step title already sits there.

// A row: a colour and its label. The shape matches the mark the map draws
// (a flat square by default, a volcano's cone, a plume's ring, a drawn line).
export type LegendItem = { label: string; rgb: [number, number, number]; shape?: 'square' | 'cone' | 'ring' | 'line'; dash?: 'solid' | 'dashed' | 'dotted' }

// 'gradient' = a continuous colour ramp with value labels; 'swatches' =
// discrete colour+label rows. A gradient may carry items under its bar: a
// mark the same layer draws over its ramp (the salinity's sinking water).
export type LegendSpec =
  | { type: 'gradient'; title: string; unit: string; stops: { value: number; rgb: [number, number, number] }[]; items?: LegendItem[] }
  | { type: 'swatches'; title: string; items: LegendItem[] }

export interface LegendPanelOptions {
  // What the legend holds now: how many blocks, and the blocks. `build` is
  // called only while the panel is open, so a closed legend costs nothing.
  content: () => { count: number; build: () => LegendSpec[] }
}

export interface LegendPanel {
  element: HTMLElement
  // Build it again from `content` — call when the layers or their data
  // changed, and on a language change.
  refresh(): void
  dispose(): void
}

export function createLegendPanel(host: HTMLElement, options: LegendPanelOptions): LegendPanel {
  const panel = document.createElement('section')
  panel.className = 'overlay-legend'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'legend-toggle'
  const toggleLabel = document.createElement('span')
  toggleLabel.className = 'legend-toggle-label'
  const count = document.createElement('span')
  count.className = 'legend-toggle-count'
  const chevron = document.createElement('span')
  chevron.className = 'legend-toggle-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  toggle.append(toggleLabel, count, chevron)
  const body = document.createElement('div')
  body.className = 'legend-body'
  panel.append(toggle, body)
  host.appendChild(panel)

  let open = false
  toggle.addEventListener('click', () => {
    open = !open
    refresh()
  })

  function refresh(): void {
    const content = options.content()
    toggleLabel.textContent = t('overlay.legend.title')
    count.textContent = String(content.count)
    toggle.setAttribute('aria-expanded', String(open))
    panel.classList.toggle('overlay-legend--open', open)
    if (!open) {
      body.replaceChildren()
      return
    }
    if (content.count === 0) {
      // Open and empty says something the closed button cannot: the layers on
      // the map are ones whose colours explain themselves.
      const empty = document.createElement('div')
      empty.className = 'legend-empty'
      empty.textContent = t('overlay.legend.empty')
      body.replaceChildren(empty)
      return
    }
    body.replaceChildren(...content.build().map(buildBlock))
  }

  return {
    element: panel,
    refresh,
    dispose(): void {
      panel.remove()
    },
  }
}

function buildBlock(spec: LegendSpec): HTMLElement {
  const block = document.createElement('div')
  block.className = 'legend-block'
  const title = document.createElement('div')
  title.className = 'legend-title'
  title.textContent = spec.type === 'gradient' && spec.unit ? `${spec.title} (${spec.unit})` : spec.title
  block.appendChild(title)
  if (spec.type === 'gradient') {
    const min = spec.stops[0].value
    const max = spec.stops[spec.stops.length - 1].value
    const span = max - min || 1
    const css = spec.stops.map((s) => `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]}) ${(((s.value - min) / span) * 100).toFixed(1)}%`).join(', ')
    const row = document.createElement('div')
    row.className = 'legend-gradient-row'
    const bar = document.createElement('div')
    bar.className = 'legend-gradient-bar'
    bar.style.background = `linear-gradient(to right, ${css})`
    const labels = document.createElement('div')
    labels.className = 'legend-gradient-labels'
    const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1))
    for (const v of [min, (min + max) / 2, max]) {
      const l = document.createElement('span')
      l.textContent = fmt(v)
      labels.appendChild(l)
    }
    row.append(bar, labels)
    block.appendChild(row)
  }
  if (spec.items && spec.items.length > 0) block.appendChild(buildSwatches(spec.items))
  return block
}

function buildSwatches(items: LegendItem[]): HTMLElement {
  const list = document.createElement('div')
  list.className = 'legend-swatches'
  for (const it of items) {
    const r = document.createElement('div')
    r.className = 'legend-swatch-row'
    const sw = document.createElement('span')
    if (it.shape === 'cone') {
      // Match the map's volcano marker (an upward cone), not a flat square.
      sw.className = 'legend-cone'
      sw.style.borderBottomColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
    } else if (it.shape === 'ring') {
      // Match the map's hotspot-plume marker (an orange ring).
      sw.className = 'legend-ring'
      sw.style.borderColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
    } else if (it.shape === 'line') {
      // A drawn line: the rivers' regimes (solid, dashed, dotted — the
      // ribbon shader's convention) and the coast's cliff line.
      sw.className = 'legend-line'
      sw.style.borderTopStyle = it.dash ?? 'solid'
      sw.style.borderTopColor = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
    } else {
      sw.className = 'legend-swatch'
      sw.style.background = `rgb(${it.rgb[0]},${it.rgb[1]},${it.rgb[2]})`
    }
    const lb = document.createElement('span')
    lb.textContent = it.label
    r.append(sw, lb)
    list.appendChild(r)
  }
  return list
}

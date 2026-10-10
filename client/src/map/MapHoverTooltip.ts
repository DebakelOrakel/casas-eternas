import type { ChartPoint } from './worldView'
import { createFloatingCard } from '../ui/tooltip/floatingCard'

export interface MapHoverTooltipOptions {
  // What lies under the pointer: a world view's groundAt (worldView.ts), in
  // canvas pixels. The pointer is followed on `surface`, the canvas.
  locate: (screenX: number, screenY: number) => ChartPoint | null
  surface: HTMLElement
  // The tooltip element is appended here (position: fixed, so this only scopes
  // its lifetime/cleanup — any on-screen container works).
  host: HTMLElement
  // Full-resolution map dimensions the returned cell is expressed in — the same
  // texture the map plane samples, so `cellX ∈ [0,textureWidth)` etc.
  textureWidth: number
  textureHeight: number
  // Describe the map cell under the cursor, or return null/'' to hide the
  // card. Kept caller-supplied so this module stays domain-agnostic (the
  // generator passes a built card, the world map a few lines of text).
  // cellX/cellY are integer texel coordinates.
  //
  // Text (\n = line break) is the short form. An element is the rich form: the
  // caller builds it (ui/mapProbe) and this module only places it, because
  // WHAT a cell means was never this module's business and a card with charts
  // is not expressible as lines.
  describe: (cellX: number, cellY: number) => string | HTMLElement | null
}

export interface MapHoverTooltip {
  // Probing is on by default; disable it where a hover readout makes no sense
  // (e.g. off the relevant panel). Disabling also hides a visible tooltip.
  setEnabled(enabled: boolean): void
  // Re-run `describe` at the last cursor position — call when the underlying
  // data changed (e.g. climate recomputed) so a stationary tooltip updates.
  refresh(): void
  dispose(): void
}

// A hover tooltip for a world view: converts the pointer to a map texel
// through the view's own pick (worldView.ts, groundAt — on the flat map the
// plane's UVs, shared by every wrap copy and the relief), then shows a
// caller-described readout following the cursor. Reusable by any full-surface
// map screen (worldgen now, game later). Babylon-side only knows "cursor → cell";
// the meaning of a cell is entirely the `describe` callback's.
export function createMapHoverTooltip(options: MapHoverTooltipOptions): MapHoverTooltip {
  const { locate, surface, host, textureWidth, textureHeight, describe } = options

  // The shared white floating card, following the cursor (see floatingCard.ts).
  const card = createFloatingCard(host, 'tooltip-card--readout')

  let enabled = true
  // Last resolved cell + client position, so refresh() can re-describe in place.
  let lastCellX = -1
  let lastCellY = -1
  let lastClientX = 0
  let lastClientY = 0

  function hide(): void {
    card.hide()
    lastCellX = -1
    lastCellY = -1
  }

  function show(cellX: number, cellY: number, clientX: number, clientY: number): void {
    const described = describe(cellX, cellY)
    if (!described) {
      hide()
      return
    }
    card.el.textContent = ''
    if (typeof described === 'string') {
      // \n → separate lines; textContent per line keeps caller strings inert.
      for (const line of described.split('\n')) {
        const row = document.createElement('div')
        row.textContent = line
        card.el.appendChild(row)
      }
    } else {
      card.el.appendChild(described)
    }
    card.showAtPoint(clientX, clientY)
  }

  function probe(clientX: number, clientY: number): void {
    if (!enabled) return
    lastClientX = clientX
    lastClientY = clientY
    const rect = surface.getBoundingClientRect()
    const at = locate(clientX - rect.left, clientY - rect.top)
    if (!at) {
      hide()
      return
    }
    const cellX = Math.min(textureWidth - 1, Math.max(0, Math.floor(at.u * textureWidth)))
    const cellY = Math.min(textureHeight - 1, Math.max(0, Math.floor(at.v * textureHeight)))
    lastCellX = cellX
    lastCellY = cellY
    show(cellX, cellY, clientX, clientY)
  }

  const onMove = (event: PointerEvent): void => probe(event.clientX, event.clientY)
  const onLeave = (): void => hide()
  surface.addEventListener('pointermove', onMove)
  surface.addEventListener('pointerleave', onLeave)

  return {
    setEnabled(next: boolean): void {
      enabled = next
      if (!next) hide()
    },
    refresh(): void {
      if (!enabled || lastCellX < 0) return
      show(lastCellX, lastCellY, lastClientX, lastClientY)
    },
    dispose(): void {
      surface.removeEventListener('pointermove', onMove)
      surface.removeEventListener('pointerleave', onLeave)
      card.dispose()
    },
  }
}

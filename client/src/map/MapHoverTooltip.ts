import { PointerEventTypes, Scene } from '@babylonjs/core'
import type { Observer, PointerInfo } from '@babylonjs/core'
import './mapTooltip.css'

export interface MapHoverTooltipOptions {
  scene: Scene
  // The tooltip element is appended here (position: fixed, so this only scopes
  // its lifetime/cleanup — any on-screen container works).
  host: HTMLElement
  // Full-resolution map dimensions the returned cell is expressed in — the same
  // texture the map plane samples, so `cellX ∈ [0,textureWidth)` etc.
  textureWidth: number
  textureHeight: number
  // Describe the map cell under the cursor. Return the tooltip text (\n = line
  // break) or null/'' to hide it. Kept caller-supplied so this module stays
  // domain-agnostic (worldgen passes climate/biome readouts; the game screen
  // can pass whatever it wants). cellX/cellY are integer texel coordinates.
  describe: (cellX: number, cellY: number) => string | null
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

// A hover tooltip for the flat map: converts the pointer to a map texel via
// Babylon picking (the map plane's UVs map straight onto the data texture, and
// every wrapped tile instance shares those UVs, so a hover over any copy — or
// the debug relief mesh — resolves to the right cell), then shows a
// caller-described readout following the cursor. Reusable by any full-surface
// map screen (worldgen now, game later). Babylon-side only knows "cursor → cell";
// the meaning of a cell is entirely the `describe` callback's.
export function createMapHoverTooltip(options: MapHoverTooltipOptions): MapHoverTooltip {
  const { scene, host, textureWidth, textureHeight, describe } = options

  const el = document.createElement('div')
  el.className = 'map-tooltip'
  el.hidden = true
  host.appendChild(el)

  let enabled = true
  // Last resolved cell + client position, so refresh() can re-describe in place.
  let lastCellX = -1
  let lastCellY = -1
  let lastClientX = 0
  let lastClientY = 0

  function hide(): void {
    el.hidden = true
    lastCellX = -1
    lastCellY = -1
  }

  // Position near the cursor, nudged so the box never sits under the pointer or
  // runs off the right/bottom edge.
  function place(clientX: number, clientY: number): void {
    const pad = 14
    const rect = el.getBoundingClientRect()
    let x = clientX + pad
    let y = clientY + pad
    if (x + rect.width > window.innerWidth) x = clientX - pad - rect.width
    if (y + rect.height > window.innerHeight) y = clientY - pad - rect.height
    el.style.left = `${Math.max(0, x)}px`
    el.style.top = `${Math.max(0, y)}px`
  }

  function show(cellX: number, cellY: number, clientX: number, clientY: number): void {
    const text = describe(cellX, cellY)
    if (!text) {
      hide()
      return
    }
    // \n → separate lines; textContent per line keeps caller strings inert.
    el.textContent = ''
    for (const line of text.split('\n')) {
      const row = document.createElement('div')
      row.textContent = line
      el.appendChild(row)
    }
    el.hidden = false
    place(clientX, clientY)
  }

  function probe(clientX: number, clientY: number): void {
    if (!enabled) return
    lastClientX = clientX
    lastClientY = clientY
    const pick = scene.pick(scene.pointerX, scene.pointerY)
    const uv = pick?.hit ? pick.getTextureCoordinates() : null
    if (!uv) {
      hide()
      return
    }
    // UVs are 0..1 across the plane; v runs top→bottom in step with the texture
    // data's row order (RawTexture uploaded invertY=false), so no flip.
    const cellX = Math.min(textureWidth - 1, Math.max(0, Math.floor(uv.x * textureWidth)))
    const cellY = Math.min(textureHeight - 1, Math.max(0, Math.floor(uv.y * textureHeight)))
    lastCellX = cellX
    lastCellY = cellY
    show(cellX, cellY, clientX, clientY)
  }

  const observer: Observer<PointerInfo> | null = scene.onPointerObservable.add((info) => {
    if (info.type === PointerEventTypes.POINTERMOVE) {
      probe(info.event.clientX, info.event.clientY)
    }
  })

  // Babylon's pointer observable only fires over the canvas, so a plain leave
  // never arrives — hide explicitly when the cursor exits.
  const canvas = scene.getEngine().getRenderingCanvas()
  const onLeave = (): void => hide()
  canvas?.addEventListener('pointerleave', onLeave)

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
      scene.onPointerObservable.remove(observer)
      canvas?.removeEventListener('pointerleave', onLeave)
      el.remove()
    },
  }
}

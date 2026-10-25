import type { AbstractEngine } from '@babylonjs/core'
import { temperatureColor } from '../generator/climate/climateColors'
import { t } from '../i18n/i18n'
import { createGlobeScaleArc } from './globeScaleArc'
import { createGlobeTemperatureArc } from './globeTemperatureArc'
import { createScaleBar } from './ScaleBar'
import type { GlobeWorldView } from './sphereView'
import type { WorldView } from './worldView'
import './mapScales.css'

// THE MAP'S SCALES: the distance and the temperature beside the map, as the
// generator shows them since 2026-09-26 (the strip) and 2026-10-11 (the
// arcs). Out of the generator screen since 2026-10-25, when the incubator
// came to show the same map.
//
// - The distance: on the globe a curved scale beside it (globeScaleArc.ts)
//   while it fits and the camera looks at the globe's centre, else the
//   corner bar (ScaleBar.ts), which then measures at the screen's centre.
//   On the flat map the bar.
// - The temperature: the sea-level band of the latitude each screen row
//   looks at, by the climate's own function with the world's levers and
//   nothing of the terrain. A reading aid, not a field. On the flat map a
//   strip between the column and the map; on the globe an arc on its left
//   (globeTemperatureArc.ts).
// - The free area: the canvas less the title bar above it, the step bar
//   below it and the column if it lies over it, as fractions of the
//   canvas. The globe's far shot fits into it (GlobeWorldView.setFreeArea),
//   and the arcs stand inside it.
//
// The bar and the strip follow the camera only once it has come to rest:
// both read the map through ground picks, and doing that every frame of a
// pan made the pan crawl (picture check 2026-09-27). The view's key is
// compared per frame, which is cheap; the redraw waits VIEW_SETTLE_MS after
// the last change. The arcs read no pick and follow at once.

export interface FreeArea {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MapScalesOptions {
  engine: AbstractEngine
  canvas: HTMLCanvasElement
  // The view on screen, and the globe when it is one.
  view(): WorldView | null
  globe(): GlobeWorldView | null
  // The sea-level temperature by chart row, v 0 to 1 (climate/temperature
  // seaLevelTemperatureBand), with a key that changes when it does; null
  // for no temperature scale.
  band(): { values: ArrayLike<number>; key: string } | null
  // The bars round the map, for the free area.
  bars: { title: HTMLElement; steps: HTMLElement; column: HTMLElement }
  // The free area changed: the screen passes it on to its globe.
  onFreeArea(area: FreeArea): void
}

export interface MapScales {
  freeArea(): FreeArea | null
  // Draw again now: the band or the view changed outside the camera.
  redraw(): void
  relabel(): void
  dispose(): void
}

const VIEW_SETTLE_MS = 60
const TEMP_SCALE_SAMPLES = 64

export function createMapScales(host: HTMLElement, options: MapScalesOptions): MapScales {
  const { canvas } = options
  const strip = document.createElement('div')
  strip.className = 'temp-scale'
  const stripCanvas = document.createElement('canvas')
  stripCanvas.setAttribute('role', 'img')
  stripCanvas.setAttribute('aria-label', t('overlay.temperature.scale'))
  strip.appendChild(stripCanvas)
  host.appendChild(strip)

  const scaleBar = createScaleBar(host, {
    measure: (ax, ay, bx, by) => {
      const view = options.view()
      if (!view) return null
      const a = view.chartAt(ax, ay)
      const b = view.chartAt(bx, by)
      return a && b ? view.metresBetween(a, b) : null
    },
    at: () => (options.globe() ? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } : null),
  })
  const scaleArc = createGlobeScaleArc(host)
  const temperatureArc = createGlobeTemperatureArc(host, t('overlay.temperature.scale'))

  let free: FreeArea | null = null
  let freeKey = ''
  // arcShows counts the arc's appearances: the bar's key holds it, so that
  // a bar hidden under the arc measures again when the arc goes, even at a
  // view it measured before.
  let arcShown = false
  let arcShows = 0
  let stripSeen = ''

  function renderArcs(): void {
    const globe = options.globe()
    let input: Parameters<typeof scaleArc.update>[0] = null
    if (globe) {
      const rect = canvas.getBoundingClientRect()
      const area = free ?? { left: 0, top: 0, right: 1, bottom: 1 }
      input = {
        silhouette: globe.silhouette(),
        free: { left: area.left * rect.width, top: area.top * rect.height, right: area.right * rect.width, bottom: area.bottom * rect.height },
        canvas: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      }
    }
    const shown = scaleArc.update(input)
    const band = options.band()
    temperatureArc.update(input && globe && band ? { ...input, limbV: (psi) => globe.limbChartAt(psi)?.v ?? null, band: band.values } : null)
    if (shown && !arcShown) arcShows++
    arcShown = shown
    if (shown) scaleBar.element.hidden = true
  }

  function renderBar(): void {
    const view = options.view()
    if (!view) { scaleBar.element.hidden = true; return }
    if (arcShown) return
    scaleBar.update(`${view.viewKey()},${window.innerWidth},${window.innerHeight},${freeKey},${arcShows}`)
  }

  // The strip: the band at the latitude a row looks at, just right of it.
  function renderStrip(force = false): void {
    const view = options.view()
    const band = options.band()
    strip.hidden = !view || !band || options.globe() !== null
    if (strip.hidden || !view || !band) return
    const key = `${view.viewKey()},${band.key},${stripCanvas.clientHeight}`
    if (!force && key === stripSeen) return
    stripSeen = key
    const rect = stripCanvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (stripCanvas.width !== w || stripCanvas.height !== h) { stripCanvas.width = w; stripCanvas.height = h }
    const c = stripCanvas.getContext('2d')
    if (!c) return
    c.clearRect(0, 0, w, h)
    const bandW = Math.round(10 * dpr)
    const pickX = rect.right + 2
    const values: (number | null)[] = []
    for (let i = 0; i <= TEMP_SCALE_SAMPLES; i++) {
      const screenY = rect.top + (rect.height * i) / TEMP_SCALE_SAMPLES
      const at = view.chartAt(pickX, screenY)
      if (!at) { values.push(null); continue }
      const row = Math.min(band.values.length - 1, Math.max(0, Math.floor(at.v * band.values.length)))
      values.push(band.values[row])
    }
    const step = h / TEMP_SCALE_SAMPLES
    for (let i = 0; i < TEMP_SCALE_SAMPLES; i++) {
      const v = values[i]
      if (v === null) continue
      const [r, g, b] = temperatureColor(v)
      c.fillStyle = `rgb(${r},${g},${b})`
      c.fillRect(0, Math.floor(i * step), bandW, Math.ceil(step) + 1)
    }
    // Ticks where the band crosses a multiple of 10 °C between two samples.
    c.fillStyle = 'rgba(31, 35, 40, 0.85)'
    c.font = `${Math.round(9 * dpr)}px 'IBM Plex Sans', system-ui, sans-serif`
    c.textBaseline = 'middle'
    for (let i = 0; i < TEMP_SCALE_SAMPLES; i++) {
      const a = values[i]
      const b = values[i + 1]
      if (a === null || b === null) continue
      const lo = Math.ceil(Math.min(a, b) / 10) * 10
      if (lo > Math.max(a, b) || lo === Math.min(a, b)) continue
      const y = Math.round(step * (i + (lo - a) / (b - a || 1)))
      c.fillRect(bandW, y, Math.round(4 * dpr), 1)
      c.fillText(String(lo), bandW + Math.round(6 * dpr), y)
    }
  }

  let viewKeySeen = ''
  let viewChangedAt = 0
  let viewDirty = true
  // On the engine's frame, not a scene's: the view on screen is the flat
  // one or the globe, each with its own scene.
  const settle = options.engine.onBeginFrameObservable.add(() => {
    const view = options.view()
    const key = `${view?.viewKey() ?? ''},${window.innerWidth},${window.innerHeight},${freeKey}`
    if (key !== viewKeySeen) {
      viewKeySeen = key
      viewChangedAt = performance.now()
      viewDirty = true
      // The globe's curved scales read no pick: they follow at once, and
      // do not stand beside a globe that has grown over them.
      renderArcs()
      return
    }
    if (viewDirty && performance.now() - viewChangedAt >= VIEW_SETTLE_MS) {
      viewDirty = false
      renderStrip()
      renderBar()
    }
  })

  // A hidden bar measures zero and covers nothing.
  function measureFreeArea(): void {
    const canvasRect = canvas.getBoundingClientRect()
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return
    const shown = (el: HTMLElement): DOMRect | null => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? r : null
    }
    const title = shown(options.bars.title)
    const steps = shown(options.bars.steps)
    const column = shown(options.bars.column)
    const clamp = (value: number): number => Math.min(1, Math.max(0, value))
    free = {
      left: column ? clamp((column.right - canvasRect.left) / canvasRect.width) : 0,
      top: title ? clamp((title.bottom - canvasRect.top) / canvasRect.height) : 0,
      right: 1,
      bottom: steps ? clamp((steps.top - canvasRect.top) / canvasRect.height) : 1,
    }
    freeKey = `${free.left.toFixed(4)},${free.top.toFixed(4)},${free.bottom.toFixed(4)}`
    options.onFreeArea(free)
  }
  const observer = new ResizeObserver(measureFreeArea)
  for (const el of [canvas, options.bars.title, options.bars.steps, options.bars.column]) observer.observe(el)

  return {
    freeArea: () => free,
    redraw() {
      renderArcs()
      renderStrip(true)
      renderBar()
    },
    relabel() {
      stripCanvas.setAttribute('aria-label', t('overlay.temperature.scale'))
      temperatureArc.element.setAttribute('aria-label', t('overlay.temperature.scale'))
    },
    dispose() {
      options.engine.onBeginFrameObservable.remove(settle)
      observer.disconnect()
      strip.remove()
      scaleBar.element.remove()
      scaleArc.element.remove()
      temperatureArc.element.remove()
    },
  }
}

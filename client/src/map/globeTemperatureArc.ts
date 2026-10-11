import { temperatureColor } from '../generator/climate/climateColors'
import { ARC_GAP, EDGE_MARGIN, HYSTERESIS, LABEL_GAP, LABEL_SPACING, MIN_HALF_HEIGHT, TICK_MAJOR, type CanvasRect, type GlobeSilhouette } from './globeScaleArc'
import './scaleBar.css'

// THE GLOBE'S TEMPERATURE SCALE (2026-10-11): an arc beside the globe, on
// the left, concentric with the globe's outline on the screen, as the
// distance arc on the right (globeScaleArc.ts). It is the globe's form of
// the strip beside the flat map (GeneratorScreen.renderTemperatureScale):
// the strip gives each row the sea-level temperature of the latitude that
// the map shows in that row; the arc gives each of its points the
// sea-level temperature of the latitude of the LIMB point (the globe's
// visible edge) at the same screen angle round the outline's centre. The
// same band (climate/temperature.ts seaLevelTemperatureBand, one value per
// climate row, the row from the chart's v as the strip finds it) and the
// same colour ramp (climateColors.ts temperatureColor).
//
// THE EXTENT, "pole to pole". Along the limb circle the sine of the
// latitude is a + b · cos(ψ − ψN): the limb point nearest the north pole
// is at the screen angle ψN, the one nearest the south pole at ψN + π,
// opposite it, and between them the latitude falls monotonically on both
// halves of the circle. The rule:
//   1. ψN from the limb's latitude at four screen angles (0, π/2, π, 3π/2):
//      b · cos ψN and b · sin ψN are half the differences of the opposite
//      sines. With b near 0 (the camera on the axis: the limb is all at one
//      latitude) there is no pole-to-pole extent, and no arc.
//   2. The window: the left half of the outline (π/2 ≤ ψ ≤ 3π/2), less
//      what is nearer to the free area's top or bottom than WINDOW_MARGIN
//      (room for an end's label).
//   3. The arc is the longer of the two half circles from ψN to ψN + π,
//      held POLE_MARGIN short of both pole sides (it stands off a pole
//      rather than touching it, the user's check 2026-10-11), cut to the
//      window.
// Side on to the axis (the planet step's profile view) the poles are on
// the limb, and the arc runs from the north pole to the south pole, less
// what the window cuts. From above the northern half (the overview) the
// north pole is inside the disc: then the arc runs from the top of the
// left limb, its highest latitude, down to the lowest it reaches. The
// labels at the two ends give the temperature of the limb at the ends,
// whether an end is a pole, the limb's extreme or a cut.
//
// The arc shows while the camera looks at the globe's centre (silhouette
// not null) and while it fits to the left of the globe inside the free
// area, with the distance arc's hysteresis.

// The coloured band's width, pixels, and the most and the least segments
// the arc is drawn in (one per SEGMENT_PX of its length).
const BAND_WIDTH = 6
const SEGMENT_PX = 3
const MIN_SEGMENTS = 8
const MAX_SEGMENTS = 256
// The least amplitude of the sine of the limb's latitude along the limb
// (about 0.6° of latitude): below it, the limb is at one latitude.
const MIN_LATITUDE_AMPLITUDE = 0.01
// The window's margin off the free area's top and bottom, pixels: the
// distance arc's EDGE_MARGIN, plus the room an end's label takes outward
// (the band's outer half, a tick, the gap and half a label's height), since
// near the top and the bottom a label stands above or below its end.
const LABEL_HALF_HEIGHT = 7
// How far short of a pole side the arc ends, as a screen angle about the
// outline's centre.
export const POLE_MARGIN = (5 * Math.PI) / 180
export const WINDOW_MARGIN = EDGE_MARGIN + BAND_WIDTH / 2 + TICK_MAJOR + LABEL_GAP + LABEL_HALF_HEIGHT
// The round temperatures that get a tick: multiples of this, °C (the
// strip's 10).
const TICK_STEP_C = 10

export interface TemperatureArcSegment {
  // Screen angles, radians (globeScaleArc.ts's ψ), from < to.
  from: number
  to: number
  // The angle the temperature is read at (the segment's middle), and the
  // temperature, °C.
  psi: number
  celsius: number
}

export interface TemperatureArcTick {
  psi: number
  celsius: number
  // An end of the arc (its temperature, rounded) or a round value.
  end: boolean
  labelled: boolean
}

export interface TemperatureArcLayout {
  x: number
  y: number
  radius: number
  // The arc's ends as screen angles, from < to: from is the upper end.
  from: number
  to: number
  // The screen angle of the limb point nearest the north pole.
  northPsi: number
  segments: TemperatureArcSegment[]
  ticks: TemperatureArcTick[]
}

// The text of a temperature label: the strip's, a bare whole number.
export const temperatureLabel = (celsius: number): string => String(Math.round(celsius))

// The temperature of the band at the chart's v: the row the strip takes.
export function bandAt(band: ArrayLike<number>, v: number): number {
  const row = Math.min(band.length - 1, Math.max(0, Math.floor(v * band.length)))
  return band[row]
}

// The arc for the globe's outline in the free area, or null where there is
// none (see the rule above). `limbV` gives the chart's v of the limb point
// at a screen angle (GlobeWorldView.limbChartAt); `band` the sea-level
// temperature per climate row; `labelWidth` a label's width in pixels;
// `wasShown` whether the arc showed the last time (the hysteresis).
export function globeTemperatureArcLayout(
  silhouette: GlobeSilhouette,
  free: CanvasRect,
  limbV: (psi: number) => number | null,
  band: ArrayLike<number>,
  labelWidth: (text: string) => number,
  wasShown: boolean,
): TemperatureArcLayout | null {
  const { x, y } = silhouette
  const radius = silhouette.radius + ARC_GAP
  // 1. The limb point nearest the north pole.
  const sines: number[] = []
  for (let k = 0; k < 4; k++) {
    const v = limbV((k * Math.PI) / 2)
    if (v === null) return null
    sines.push(Math.sin((0.5 - v) * Math.PI))
  }
  const bCos = (sines[0] - sines[2]) / 2
  const bSin = (sines[1] - sines[3]) / 2
  if (Math.hypot(bCos, bSin) < MIN_LATITUDE_AMPLITUDE) return null
  const northPsi = Math.atan2(bSin, bCos)
  // 2. The window on the left half of the outline.
  const reach = (room: number): number => Math.asin(Math.max(-1, Math.min(1, room / radius)))
  const windowFrom = Math.PI - reach(y - free.top - WINDOW_MARGIN)
  const windowTo = Math.PI + reach(free.bottom - WINDOW_MARGIN - y)
  // 3. The longer of the two half circles, cut to the window.
  let from = 0
  let to = 0
  for (const start of [northPsi, northPsi + Math.PI]) {
    for (let turn = -2; turn <= 2; turn++) {
      const a = Math.max(start + POLE_MARGIN + 2 * Math.PI * turn, windowFrom)
      const b = Math.min(start + Math.PI - POLE_MARGIN + 2 * Math.PI * turn, windowTo)
      if (b - a > to - from) {
        from = a
        to = b
      }
    }
  }
  // Shorter than the distance arc's least height, it says too little.
  if (radius * (Math.sin(from) - Math.sin(to)) < 2 * MIN_HALF_HEIGHT) return null

  const temperatureAt = (psi: number): number | null => {
    const v = limbV(psi)
    return v === null ? null : bandAt(band, v)
  }
  const count = Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.ceil((radius * (to - from)) / SEGMENT_PX)))
  const segments: TemperatureArcSegment[] = []
  for (let i = 0; i < count; i++) {
    const a = from + ((to - from) * i) / count
    const b = from + ((to - from) * (i + 1)) / count
    const psi = (a + b) / 2
    const celsius = temperatureAt(psi)
    if (celsius === null) return null
    segments.push({ from: a, to: b, psi, celsius })
  }
  // The ticks: the two ends, then (as the strip) where the band crosses a
  // multiple of TICK_STEP_C between two segments. Labels LABEL_SPACING
  // apart along the arc, the ends first.
  const fromC = temperatureAt(from)
  const toC = temperatureAt(to)
  if (fromC === null || toC === null) return null
  const ticks: TemperatureArcTick[] = [
    { psi: from, celsius: fromC, end: true, labelled: true },
    { psi: to, celsius: toC, end: true, labelled: true },
  ]
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i].celsius
    const b = segments[i + 1].celsius
    const lo = Math.ceil(Math.min(a, b) / TICK_STEP_C) * TICK_STEP_C
    if (lo > Math.max(a, b) || lo === Math.min(a, b)) continue
    const psi = segments[i].psi + (segments[i + 1].psi - segments[i].psi) * ((lo - a) / (b - a || 1))
    const clear = ticks.every((tick) => !tick.labelled || radius * Math.abs(tick.psi - psi) >= LABEL_SPACING)
    ticks.push({ psi, celsius: lo, end: false, labelled: clear })
  }
  // The room: the arc's leftmost point, the band's outer half, a tick and
  // the widest label (conservatively all at the horizontal), against the
  // free area's left.
  let widest = 0
  for (const tick of ticks) if (tick.labelled) widest = Math.max(widest, labelWidth(temperatureLabel(tick.celsius)))
  const needed = x - radius - BAND_WIDTH / 2 - TICK_MAJOR - LABEL_GAP - widest - EDGE_MARGIN
  if (needed < free.left + (wasShown ? 0 : HYSTERESIS)) return null
  ticks.sort((p, q) => p.psi - q.psi)
  return { x, y, radius, from, to, northPsi, segments, ticks }
}

export interface GlobeTemperatureArc {
  element: SVGSVGElement
  // Draw the arc (null: no globe, or the camera does not look at its
  // centre) over the canvas at `canvas` (page pixels). Says whether the arc
  // shows.
  update(input: {
    silhouette: GlobeSilhouette | null
    free: CanvasRect
    canvas: { left: number; top: number; width: number; height: number }
    limbV: (psi: number) => number | null
    band: ArrayLike<number>
  } | null): boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function createGlobeTemperatureArc(host: HTMLElement, ariaLabel: string): GlobeTemperatureArc {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'scale-arc scale-arc--temperature')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', ariaLabel)
  svg.style.display = 'none'
  host.appendChild(svg)
  let shown = false
  let drawn = ''

  // The labels' widths, from the arc's own font, measured once per text.
  const widths = new Map<string, number>()
  let measureContext: CanvasRenderingContext2D | null = null
  const labelWidth = (text: string): number => {
    let w = widths.get(text)
    if (w === undefined) {
      measureContext ??= document.createElement('canvas').getContext('2d')
      const style = getComputedStyle(svg)
      if (measureContext) measureContext.font = `${style.fontSize} ${style.fontFamily}`
      w = measureContext ? Math.ceil(measureContext.measureText(text).width) : text.length * 7
      widths.set(text, w)
    }
    return w
  }

  const hide = (): boolean => {
    shown = false
    drawn = ''
    svg.style.display = 'none'
    return false
  }

  function update(input: Parameters<GlobeTemperatureArc['update']>[0]): boolean {
    if (!input?.silhouette) return hide()
    // Measured while shown: a hidden SVG has no font to measure with.
    svg.style.display = ''
    const layout = globeTemperatureArcLayout(input.silhouette, input.free, input.limbV, input.band, labelWidth, shown)
    if (!layout) return hide()
    shown = true
    const { canvas } = input
    const at = (psi: number, r: number): string => `${(layout.x + r * Math.cos(psi)).toFixed(1)} ${(layout.y - r * Math.sin(psi)).toFixed(1)}`
    const r = layout.radius.toFixed(1)
    // ψ grows counterclockwise on the screen: sweep 0, from the upper end
    // down the left.
    const arcPath = (a: number, b: number): string => `M ${at(a, layout.radius)} A ${r} ${r} 0 0 0 ${at(b, layout.radius)}`
    // Each segment a little longer than its share (half a pixel each way),
    // so that no seam shows between two.
    const overlap = 0.5 / layout.radius
    let segments = ''
    for (const s of layout.segments) {
      const [cr, cg, cb] = temperatureColor(s.celsius)
      segments += `<path d="${arcPath(Math.max(layout.from, s.from - overlap), Math.min(layout.to, s.to + overlap))}" stroke="rgb(${cr},${cg},${cb})"/>`
    }
    const outer = layout.radius + BAND_WIDTH / 2
    let ticks = ''
    let labels = ''
    for (const tick of layout.ticks) {
      ticks += ` M ${at(tick.psi, outer)} L ${at(tick.psi, outer + TICK_MAJOR)}`
      if (!tick.labelled) continue
      const [lx, ly] = at(tick.psi, outer + TICK_MAJOR + LABEL_GAP).split(' ')
      labels += `<text x="${lx}" y="${ly}">${temperatureLabel(tick.celsius)}</text>`
    }
    const key = `${canvas.left},${canvas.top},${canvas.width},${canvas.height},${segments},${ticks},${labels}`
    if (key === drawn) return true
    drawn = key
    svg.style.left = `${canvas.left}px`
    svg.style.top = `${canvas.top}px`
    svg.setAttribute('width', String(canvas.width))
    svg.setAttribute('height', String(canvas.height))
    svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`)
    const whole = arcPath(layout.from, layout.to)
    svg.innerHTML = `<path class="scale-arc__halo scale-arc__band-halo" d="${whole}"/><path class="scale-arc__halo" d="${ticks}"/><g class="scale-arc__band">${segments}</g><path class="scale-arc__line" d="${ticks}"/><g class="scale-arc__labels">${labels}</g>`
    return true
  }

  return { element: svg, update }
}

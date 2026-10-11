import { formatKilometres, ROUND_LENGTHS_KM } from './ScaleBar'
import './scaleBar.css'

// THE GLOBE'S CURVED SCALE (2026-10-11): an arc beside the globe, on the
// right, concentric with the globe's outline on the screen, with ticks at
// round distances ALONG THE VISIBLE LIMB. The corner scale bar (ScaleBar.ts)
// measures one place; the globe's scale changes across the disc, and at
// the limb a bar reads up to 2.3 times the centre's value. The limb is the
// one line on the globe whose scale is the same everywhere along it, and the
// arc follows it.
//
// The geometry, with the camera at distance d from the globe's centre and
// looking at that centre: the limb is the small circle at the angle α from
// the point under the camera, cos α = R / d, of radius R · sin α. The view
// is symmetric about the camera's axis, so the outline on the screen is a
// circle about the screen's centre, and a screen angle ψ round that centre
// is the same angle round the limb circle: R · sin α · ψ along the limb.
// With the tilt on, the camera looks past the centre, the outline is no
// longer a circle, and the corner bar takes over.
//
// The arc shows while it fits to the right of the globe inside the free
// area (the canvas less the bars over it), with a hysteresis so that a slow
// zoom does not make it flicker. The screen shows the corner bar while the
// arc does not show (GeneratorScreen.ts).

// The globe's outline on the screen while the camera looks at its centre,
// in canvas pixels, and the metres along the limb per radian of screen angle
// round the outline's centre.
export interface GlobeSilhouette {
  x: number
  y: number
  radius: number
  limbMetresPerRadian: number
}

// A rectangle of the canvas, in canvas pixels.
export interface CanvasRect {
  left: number
  top: number
  right: number
  bottom: number
}

// The outline of a globe of `radius` (scene units, `radiusMetres` on the
// world) seen from `distance` from its centre by a camera that looks at the
// centre, with the vertical field of view `fov` (radians), on a viewport of
// `width` × `height` canvas pixels. Null with the camera inside the globe.
//
// From the eye the limb is at the half-angle θ off the axis, sin θ = R / d.
// On the image plane at unit focal length that is tan θ = R / √(d² − R²)
// from the centre, and the viewport's half height is tan(fov / 2) there:
// the projection itself, not an approximation of it
// (scripts/globeGrab.mjs projects limb points with Babylon and compares).
export function globeSilhouette(view: { distance: number; radius: number; fov: number; width: number; height: number; radiusMetres: number }): GlobeSilhouette | null {
  const { distance, radius, fov, width, height, radiusMetres } = view
  if (!(distance > radius)) return null
  const cosAlpha = radius / distance
  const sinAlpha = Math.sqrt(1 - cosAlpha * cosAlpha)
  const rim = cosAlpha / sinAlpha
  return {
    x: width / 2,
    y: height / 2,
    radius: (rim * height) / 2 / Math.tan(fov / 2),
    limbMetresPerRadian: radiusMetres * sinAlpha,
  }
}

// The arc's measures, canvas pixels: its gap off the outline, the ticks'
// lengths (outward), the gap between a major tick and its label, the arc's
// least distance to the free area's right edge (the bar's 1rem), and the
// hysteresis: the arc comes back only with this much more room than it
// needs, so that a slow zoom past the limit does not flicker.
const ARC_GAP = 24
const TICK_MAJOR = 7
const TICK_MINOR = 4
const LABEL_GAP = 4
const EDGE_MARGIN = 16
const HYSTERESIS = 24
// The part of the free area's height the arc spans, and the least half
// height it may have (shorter, it says too little).
const ARC_HEIGHT_FRACTION = 2 / 3
const MIN_HALF_HEIGHT = 40
// The most of the arc's radius its half height may take: the arc stays on
// the right of the outline, never round its top and bottom.
const MAX_HALF_SINE = 0.9
// The number of steps the arc holds: the round step that gives a number in
// this range, nearest to the preferred one. Nine, not eight, at the top:
// from 2 to 5 × 10ⁿ the step grows 2.5 times, and with at most eight steps
// an arc of 18 to 20 × 10ⁿ km would have no step (the arc went and came
// back in a slow zoom, scripts/globeScale.mjs).
const MIN_STEPS = 4
const MAX_STEPS = 9
const PREFERRED_STEPS = 6
// The least distance between two labels along the arc, pixels: a label's
// height and a gap.
const LABEL_SPACING = 28

export interface GlobeArcTick {
  // The screen angle round the outline's centre, radians, upward from the
  // horizontal to the right.
  psi: number
  // The distance along the limb from the arc's lower end.
  km: number
  major: boolean
  labelled: boolean
}

export interface GlobeArcLayout {
  // The arc's centre and radius, canvas pixels, and its ends as screen
  // angles (from < 0 < to).
  x: number
  y: number
  radius: number
  from: number
  to: number
  stepKm: number
  ticks: GlobeArcTick[]
}

// The arc for the globe's outline in the free area, or null where it does
// not fit (the corner bar then). `labelWidth` gives a label's width in
// pixels; `wasShown` says whether the arc showed the last time (the
// hysteresis).
//
// The arc spans about ARC_HEIGHT_FRACTION of the free height, centred on
// the outline's vertical middle; the step is the round length (1, 2 or 5 ×
// 10ⁿ km) that gives MIN_STEPS to MAX_STEPS steps over it, about six, and the arc is
// cut to a whole number of steps: from 0 at its lower end up, a major tick
// at each step and a minor tick between.
export function globeArcLayout(silhouette: GlobeSilhouette, free: CanvasRect, labelWidth: (km: number) => number, wasShown: boolean): GlobeArcLayout | null {
  const { x, y, limbMetresPerRadian } = silhouette
  if (!(limbMetresPerRadian > 0)) return null
  const radius = silhouette.radius + ARC_GAP
  const halfHeight = Math.min(
    (ARC_HEIGHT_FRACTION * (free.bottom - free.top)) / 2,
    y - free.top - EDGE_MARGIN,
    free.bottom - y - EDGE_MARGIN,
    radius * MAX_HALF_SINE,
  )
  if (halfHeight < MIN_HALF_HEIGHT) return null
  const kmPerRadian = limbMetresPerRadian / 1000
  const spanKm = 2 * Math.asin(halfHeight / radius) * kmPerRadian
  let stepKm = 0
  let steps = 0
  for (const km of ROUND_LENGTHS_KM) {
    const n = Math.floor(spanKm / km + 1e-9)
    if (n < MIN_STEPS || n > MAX_STEPS) continue
    if (steps === 0 || Math.abs(n - PREFERRED_STEPS) < Math.abs(steps - PREFERRED_STEPS)) {
      stepKm = km
      steps = n
    }
  }
  if (steps === 0) return null
  const half = (steps * stepKm) / kmPerRadian / 2
  // Every labelEvery-th major tick carries its label, counted down from
  // the upper end (which always does), so that labels stay LABEL_SPACING
  // apart; 0 at the lower end carries none.
  const stepPx = (radius * stepKm) / kmPerRadian
  const labelEvery = Math.max(1, Math.ceil(LABEL_SPACING / stepPx))
  const ticks: GlobeArcTick[] = []
  let widest = 0
  for (let i = 0; i <= 2 * steps; i++) {
    const km = (i * stepKm) / 2
    const major = i % 2 === 0
    const labelled = major && i > 0 && (steps - i / 2) % labelEvery === 0
    if (labelled) widest = Math.max(widest, labelWidth(km))
    ticks.push({ psi: -half + km / kmPerRadian, km, major, labelled })
  }
  // The room: the arc's rightmost point, its tick and the widest label
  // (conservatively all at the horizontal), against the free area's right.
  const needed = x + radius + TICK_MAJOR + LABEL_GAP + widest + EDGE_MARGIN
  if (needed > free.right - (wasShown ? 0 : HYSTERESIS)) return null
  return { x, y, radius, from: -half, to: half, stepKm, ticks }
}

export interface GlobeScaleArc {
  element: SVGSVGElement
  // Draw the arc for the globe's outline (null: the camera does not look
  // at the centre) in the free area, over the canvas at `canvas` (page
  // pixels); null for no globe. Says whether the arc shows.
  update(input: { silhouette: GlobeSilhouette | null; free: CanvasRect; canvas: { left: number; top: number; width: number; height: number } } | null): boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function createGlobeScaleArc(host: HTMLElement): GlobeScaleArc {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'scale-arc')
  svg.setAttribute('role', 'img')
  svg.style.display = 'none'
  host.appendChild(svg)
  let shown = false
  let drawn = ''

  // The labels' widths, from the arc's own font, measured once per text.
  const widths = new Map<string, number>()
  let measureContext: CanvasRenderingContext2D | null = null
  const labelWidth = (km: number): number => {
    const text = formatKilometres(km)
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

  function update(input: Parameters<GlobeScaleArc['update']>[0]): boolean {
    if (!input?.silhouette) return hide()
    // Measured while shown: a hidden SVG has no font to measure with.
    svg.style.display = ''
    const layout = globeArcLayout(input.silhouette, input.free, labelWidth, shown)
    if (!layout) return hide()
    shown = true
    const { canvas } = input
    const at = (psi: number, r: number): string => `${(layout.x + r * Math.cos(psi)).toFixed(1)} ${(layout.y - r * Math.sin(psi)).toFixed(1)}`
    // From the lower end up: counterclockwise on the screen, sweep 0.
    const arc = `M ${at(layout.from, layout.radius)} A ${layout.radius.toFixed(1)} ${layout.radius.toFixed(1)} 0 0 0 ${at(layout.to, layout.radius)}`
    let ticks = ''
    let labels = ''
    for (const tick of layout.ticks) {
      ticks += ` M ${at(tick.psi, layout.radius)} L ${at(tick.psi, layout.radius + (tick.major ? TICK_MAJOR : TICK_MINOR))}`
      if (!tick.labelled) continue
      const [lx, ly] = at(tick.psi, layout.radius + TICK_MAJOR + LABEL_GAP).split(' ')
      labels += `<text x="${lx}" y="${ly}">${formatKilometres(tick.km)}</text>`
    }
    const key = `${canvas.left},${canvas.top},${canvas.width},${canvas.height},${arc},${ticks},${labels}`
    if (key === drawn) return true
    drawn = key
    svg.style.left = `${canvas.left}px`
    svg.style.top = `${canvas.top}px`
    svg.setAttribute('width', String(canvas.width))
    svg.setAttribute('height', String(canvas.height))
    svg.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`)
    svg.setAttribute('aria-label', formatKilometres(layout.stepKm))
    const lines = `${arc}${ticks}`
    svg.innerHTML = `<path class="scale-arc__halo" d="${lines}"/><path class="scale-arc__line" d="${lines}"/><g class="scale-arc__labels">${labels}</g>`
    return true
  }

  return { element: svg, update }
}

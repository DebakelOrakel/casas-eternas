import { Matrix, type Scene } from '@babylonjs/core'
import { formatValue } from '../i18n/i18n'
import './scaleBar.css'

// THE SCALE BAR at the map's lower right (2026-09-27): a bar of a round
// length — 1, 2 or 5 × 10ⁿ km — sized to the metres a screen pixel spans
// where the bar stands. The span is read from a ground pick at two points a
// hundred pixels apart on the bar's row (the torus's shorter way between
// them), so the bar is right at any zoom, tilt and place, and says nothing
// while the ray misses the plane. Moved out of the generator screen
// 2026-09-30, so that the incubator shows the same bar.

// The map's PLANE (y = 0), met by the picking ray analytically —
// microseconds, where a mesh pick against the fine relief and its wrapped
// copies cost milliseconds each and made a slow pan stutter at high zoom
// (2026-09-27). For a latitude and for a map scale the plane is the right
// reference anyway; the relief's exaggeration is a view property.
export function pickMapPlane(scene: Scene, screenX: number, screenY: number): { x: number; z: number } | null {
  const camera = scene.activeCamera
  if (!camera) return null
  const ray = scene.createPickingRay(screenX, screenY, Matrix.Identity(), camera)
  if (Math.abs(ray.direction.y) < 1e-6) return null
  const t = -ray.origin.y / ray.direction.y
  if (t <= 0) return null
  return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t }
}

export interface ScaleBarOptions {
  // Metres on the world between two screen points (canvas pixels), or null
  // where either is off it: a world view's metresBetween over its chartAt,
  // or planeMeasure below.
  measure(ax: number, ay: number, bx: number, by: number): number | null
  // Where the bar measures: the canvas pixel at the middle of a horizontal
  // probe, or null for the bar's own row at its right end (the default).
  // The globe measures at the screen's centre (2026-10-11): there the
  // camera looks at the globe straight, and with the tilt on the
  // horizontal is still not foreshortened. At the bar's own corner, near
  // the limb, it read up to 2.3 times the centre's value.
  at?(): { x: number; y: number } | null
}

// The round lengths a scale gives, in kilometres: 1, 2 and 5 × 10ⁿ, from
// 1 km to 500 000 km, smallest first. The bar and the globe's curved scale
// (globeScaleArc.ts) pick from them.
export const ROUND_LENGTHS_KM: readonly number[] = [0, 1, 2, 3, 4, 5].flatMap((exp) => [1, 2, 5].map((m) => m * 10 ** exp))

// A length in kilometres as a scale writes it: the number and the unit.
export function formatKilometres(km: number): string {
  return formatValue(km, 'common.unit.kilometres')
}

// The measure of a flat map's plane, for a screen that draws without a
// world view (the incubator): one toroidal period in world units, and what
// one unit is on the world.
export function planeMeasure(scene: Scene, worldWidth: number, worldHeight: number, metresPerWorldUnit: number): ScaleBarOptions['measure'] {
  return (ax, ay, bx, by) => {
    const a = pickMapPlane(scene, ax, ay)
    const b = pickMapPlane(scene, bx, by)
    if (!a || !b) return null
    let dx = Math.abs(b.x - a.x) % worldWidth
    if (dx > worldWidth / 2) dx = worldWidth - dx
    let dz = Math.abs(b.z - a.z) % worldHeight
    if (dz > worldHeight / 2) dz = worldHeight - dz
    return Math.hypot(dx, dz) * metresPerWorldUnit
  }
}

export interface ScaleBar {
  element: HTMLElement
  // Measure and draw again. Cheap when the view has not changed (the
  // caller's key below), so a screen may call it whenever the view settles.
  update(viewKey: string): void
}

const PROBE_PX = 100
// The probe at a given place (`at`) is short: there the bar says the scale
// AT that place, and on the globe a 100 px probe at the centre read 0.4 %
// above it (the scale grows away from the centre). The view's chartAt is
// analytic, so 10 px are exact enough (scripts/globeScale.mjs).
const PROBE_AT_PX = 10
const MIN_PX = 70
const MAX_PX = 170

export function createScaleBar(host: HTMLElement, options: ScaleBarOptions): ScaleBar {
  const { measure, at } = options
  const bar = document.createElement('div')
  bar.className = 'scale-bar'
  bar.setAttribute('role', 'img')
  bar.hidden = true
  const label = document.createElement('span')
  label.className = 'scale-bar__label'
  const line = document.createElement('span')
  line.className = 'scale-bar__bar'
  bar.append(label, line)
  host.appendChild(bar)

  let seen = ''
  function update(viewKey: string): void {
    if (viewKey === seen) return
    seen = viewKey
    const probe = at?.() ?? null
    let metresPerPx: number | null
    if (probe) {
      const metres = measure(probe.x - PROBE_AT_PX / 2, probe.y, probe.x + PROBE_AT_PX / 2, probe.y)
      metresPerPx = metres === null ? null : metres / PROBE_AT_PX
    } else {
      const rect = bar.getBoundingClientRect()
      const y = bar.hidden ? window.innerHeight - 40 : rect.top + rect.height / 2
      const xRight = bar.hidden ? window.innerWidth - 24 : rect.right - 8
      const metres = measure(xRight - PROBE_PX, y, xRight, y)
      metresPerPx = metres === null ? null : metres / PROBE_PX
    }
    if (metresPerPx === null || !(metresPerPx > 0)) { bar.hidden = true; return }
    // The round length whose bar fits the band, the largest such.
    const lengthKm = ROUND_LENGTHS_KM.find((km) => {
      const px = (km * 1000) / metresPerPx
      return px >= MIN_PX && px <= MAX_PX
    })
    if (lengthKm === undefined) { bar.hidden = true; return }
    bar.hidden = false
    line.style.width = `${Math.round((lengthKm * 1000) / metresPerPx)}px`
    label.textContent = formatKilometres(lengthKm)
    bar.setAttribute('aria-label', formatKilometres(lengthKm))
  }

  return { element: bar, update }
}

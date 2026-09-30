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
  scene: Scene
  // One toroidal period of the map, world units, and what one unit is.
  worldWidth: number
  worldHeight: number
  metresPerWorldUnit: number
}

export interface ScaleBar {
  element: HTMLElement
  // Measure and draw again. Cheap when the view has not changed (the
  // caller's key below), so a screen may call it whenever the view settles.
  update(viewKey: string): void
}

const PROBE_PX = 100
const MIN_PX = 70
const MAX_PX = 170

export function createScaleBar(host: HTMLElement, options: ScaleBarOptions): ScaleBar {
  const { scene, worldWidth, worldHeight, metresPerWorldUnit } = options
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
    const rect = bar.getBoundingClientRect()
    const y = bar.hidden ? window.innerHeight - 40 : rect.top + rect.height / 2
    const xRight = bar.hidden ? window.innerWidth - 24 : rect.right - 8
    const a = pickMapPlane(scene, xRight - PROBE_PX, y)
    const b = pickMapPlane(scene, xRight, y)
    if (!a || !b) { bar.hidden = true; return }
    let dx = Math.abs(b.x - a.x) % worldWidth
    if (dx > worldWidth / 2) dx = worldWidth - dx
    let dz = Math.abs(b.z - a.z) % worldHeight
    if (dz > worldHeight / 2) dz = worldHeight - dz
    const metresPerPx = (Math.hypot(dx, dz) * metresPerWorldUnit) / PROBE_PX
    if (!(metresPerPx > 0)) { bar.hidden = true; return }
    // The round length whose bar fits the band, the largest such.
    let lengthKm = 0
    for (let exp = 0; exp <= 5 && lengthKm === 0; exp++) {
      for (const m of [1, 2, 5]) {
        const km = m * 10 ** exp
        const px = (km * 1000) / metresPerPx
        if (px >= MIN_PX && px <= MAX_PX) { lengthKm = km; break }
        if (px > MAX_PX) break
      }
    }
    if (lengthKm === 0) { bar.hidden = true; return }
    bar.hidden = false
    line.style.width = `${Math.round((lengthKm * 1000) / metresPerPx)}px`
    label.textContent = formatValue(lengthKm, 'common.unit.kilometres')
    bar.setAttribute('aria-label', formatValue(lengthKm, 'common.unit.kilometres'))
  }

  return { element: bar, update }
}

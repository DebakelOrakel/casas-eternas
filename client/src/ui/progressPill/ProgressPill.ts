import './progressPill.css'

// THE PROGRESS PILL over the map — design canvas Fortschritt.dc.html,
// variant C "Plume und Füllstand" (2026-09-26): what runs, a line under it,
// a disc. Endless states let rings rise out of the centre; measured ones
// fill the disc from the bottom under a wave. Taken out of the generator
// (2026-10-25) for the incubator: the screen says what runs and how far,
// this module how it looks and moves.

export interface ProgressState {
  label: string
  // The line under the label; null for none.
  sub: string | null
  // How far, 0 … 1; null for an endless state (the plume).
  fraction: number | null
  // The fill's colour by a three-stage judgement (generator.css's former
  // stages: grey early, green in the window, amber late); none: the accent.
  stage?: 'early' | 'window' | 'late' | null
  // A measured run that stands still: the wave holds its phase, and goes
  // on from it.
  paused?: boolean
  // What a screen reader says.
  aria: string
}

export interface ProgressPill {
  element: HTMLElement
  show(state: ProgressState): void
  hide(): void
  dispose(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const R = 44
const CY = 60
// The wave's phase runs on the clock, not on the updates: drawn every
// frame while the disc shows a fill, so it moves smoothly whatever the run
// reports and however often. Its speed is the 0.6 rad a second it stepped
// by when it was redrawn once a second.
const WAVE_RAD_PER_MS = 0.6 / 1000
// The plume's rings drawn here rather than by a CSS animation: Safari does
// not animate an SVG circle's `r` from keyframes, so the rings stayed round
// the dot (2026-10-02). The design canvas's curve: r 8 → 42 and opacity
// 0.85 → 0 over 1.8 s, eased out, the three rings 0.55 s apart.
const PLUME_CYCLE_MS = 1800
const PLUME_OFFSETS_MS = [0, 550, 1100]

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

// The fill: the disc below a wavy water line at `fraction` of its height,
// as one closed path — the wave across the chord, the circle's lower arc
// back to the start.
function fillPath(fraction: number, phase: number): string {
  const f = Math.min(0.985, Math.max(0.015, fraction))
  const level = CY + R - 2 * R * f
  const half = Math.sqrt(Math.max(0, R * R - (level - CY) * (level - CY)))
  const x0 = 60 - half
  const x1 = 60 + half
  const amplitude = Math.min(3.5, half * 0.12)
  const points: string[] = []
  const steps = 24
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps
    const y = level + amplitude * Math.sin(((x - 60) / 22) + phase)
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  const yEnd = level + amplitude * Math.sin(((x1 - 60) / 22) + phase)
  const yStart = level + amplitude * Math.sin(((x0 - 60) / 22) + phase)
  return `${points.join(' ')} L${x1.toFixed(2)} ${yEnd.toFixed(2)} A${R} ${R} 0 0 1 60 ${CY + R} A${R} ${R} 0 0 1 ${x0.toFixed(2)} ${yStart.toFixed(2)} Z`
}

export function createProgressPill(host: HTMLElement): ProgressPill {
  const pill = document.createElement('div')
  pill.className = 'compute-progress'
  pill.setAttribute('role', 'status')
  pill.hidden = true
  const text = document.createElement('span')
  text.className = 'compute-progress__text'
  const label = document.createElement('span')
  label.className = 'compute-progress__label'
  const sub = document.createElement('span')
  sub.className = 'compute-progress__sub'
  sub.hidden = true
  text.append(label, sub)
  const disc = svg('svg', { class: 'compute-progress__disc', viewBox: '0 0 120 120', 'aria-hidden': 'true' })
  disc.append(svg('circle', { class: 'compute-progress__track', cx: '60', cy: '60', r: String(R) }))
  const plume = svg('g', {})
  const rings = [0, 1, 2].map(() => svg('circle', { class: 'compute-progress__pulse', cx: '60', cy: '60', r: '10' }))
  plume.append(...rings, svg('circle', { class: 'compute-progress__core', cx: '60', cy: '60', r: '7' }))
  const fill = svg('path', { class: 'compute-progress__fill', d: '' })
  disc.append(plume, fill)
  pill.append(text, disc)
  host.appendChild(pill)

  let disposed = false
  let fraction: number | null = null
  let paused = false
  let frameId: number | null = null
  // Where the wave stood when it last stopped, so it starts again from
  // there rather than jumping.
  let phaseHeld = 0
  let clockStart = performance.now()
  const phaseNow = (): number => (paused ? phaseHeld : phaseHeld + (performance.now() - clockStart) * WAVE_RAD_PER_MS)

  const drawPlume = (now: number): void => {
    rings.forEach((ring, i) => {
      const t = (((now - PLUME_OFFSETS_MS[i]) % PLUME_CYCLE_MS) + PLUME_CYCLE_MS) % PLUME_CYCLE_MS / PLUME_CYCLE_MS
      const eased = 1 - (1 - t) * (1 - t)
      ring.setAttribute('r', (8 + 34 * eased).toFixed(2))
      ring.setAttribute('opacity', (0.85 * (1 - eased)).toFixed(3))
    })
  }
  const frame = (): void => {
    frameId = null
    if (pill.hidden || disposed) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (fraction !== null) fill.setAttribute('d', fillPath(fraction, phaseNow()))
    else if (!still) drawPlume(performance.now())
    if (!still && !(paused && fraction !== null)) frameId = requestAnimationFrame(frame)
  }

  return {
    element: pill,
    show(state: ProgressState): void {
      if (disposed) return
      const nowPaused = state.paused === true
      // The wave holds its phase through a pause and goes on from it.
      if (nowPaused && !paused) phaseHeld += (performance.now() - clockStart) * WAVE_RAD_PER_MS
      if (!nowPaused && paused) clockStart = performance.now()
      paused = nowPaused
      pill.hidden = false
      label.textContent = state.label
      sub.textContent = state.sub ?? ''
      sub.hidden = state.sub === null
      fraction = state.fraction
      pill.setAttribute('aria-label', state.aria)
      if (fraction === null) {
        plume.style.display = ''
        fill.setAttribute('d', '')
        delete pill.dataset.stage
      } else {
        plume.style.display = 'none'
        fill.setAttribute('d', fillPath(fraction, phaseNow()))
        if (state.stage) pill.dataset.stage = state.stage
        else delete pill.dataset.stage
      }
      if (frameId === null) frameId = requestAnimationFrame(frame)
    },
    hide(): void {
      pill.hidden = true
      fraction = null
    },
    dispose(): void {
      disposed = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      pill.remove()
    },
  }
}

import { getLocale, t } from '../../i18n/i18n'
import './chronicle.css'

// THE INCUBATOR'S CHRONICLE (2026-10-26, docs/design/incubator-chronicle.md):
// the right column, after the design canvas (Inkubator.dc.html), light. The
// time shown, counted up from the people's departure, with the playback;
// the counts at that time; the events from the top down, beside an axis
// with the people's number over the span and a handle at the time shown.
// A click on an event goes to its time (and the screen to its place).
//
// It owns the playback: the screen hears the time through `onTime` and
// gives the events, the counts and the curve, their text already said.

export interface ChronicleEvent {
  // Years after the departure.
  time: number
  icon: string
  rgb: readonly [number, number, number]
  title: string
  detail: string
}

export interface ChroniclePanel {
  element: HTMLElement
  // The time shown, and set it (onTime is told).
  time(): number
  show(time: number): void
  stop(): void
  setEvents(events: readonly ChronicleEvent[]): void
  setStats(rows: readonly { label: string; value: string }[]): void
  // The people over the span, evenly spaced from the departure on; null,
  // none.
  setCurve(values: Float32Array | null): void
  // The epochs, each from its year on to the next's, their names said; the
  // first from 0.
  setEpochs(epochs: readonly { from: number; name: string }[]): void
  relabel(): void
  setVisible(visible: boolean): void
  dispose(): void
}

// Published on the document element, as the left column's width
// (Sidebar.ts): the canvas gives it up.
const WIDTH_VAR = '--right-sidebar-width'
const WIDTH = '392px'
// Playing: at 1× YEARS_A_SECOND years a second, a frame every FRAME_MS.
const YEARS_A_SECOND = 100
const FRAME_MS = 250
const SPEEDS = [1, 4, 16]
// The axis's width, px.
const AXIS_WIDTH = 26
const PREVIOUS_PATH = 'M16 5 8 12l8 7M5 5v14'
const NEXT_PATH = 'M8 5l8 7-8 7M19 5v14'

const svgIcon = (path: string): string =>
  `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`

export function createChroniclePanel(host: HTMLElement, options: { span: number; onTime: (time: number) => void; onEvent: (event: ChronicleEvent) => void }): ChroniclePanel {
  const { span } = options
  const aside = document.createElement('aside')
  aside.className = 'chronicle design-light'

  const head = document.createElement('div')
  head.className = 'chronicle__head'
  const title = document.createElement('span')
  title.className = 'chronicle__title'
  const count = document.createElement('span')
  count.className = 'chronicle__count'
  head.append(title, count)

  // The present: the year, the playback, the slider.
  const present = document.createElement('div')
  present.className = 'chronicle__present'
  const year = document.createElement('span')
  year.className = 'chronicle__year'
  // The epoch of the time shown, over the year.
  const epoch = document.createElement('span')
  epoch.className = 'chronicle__epoch'
  const controls = document.createElement('div')
  controls.className = 'chronicle__controls'
  const previous = document.createElement('button')
  previous.type = 'button'
  previous.className = 'chronicle__button'
  previous.innerHTML = svgIcon(PREVIOUS_PATH)
  const play = document.createElement('button')
  play.type = 'button'
  play.className = 'chronicle__button'
  play.dataset.help = 'incubator.people.play'
  const playIcon = document.createElement('img')
  playIcon.alt = ''
  play.append(playIcon)
  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'chronicle__button'
  next.innerHTML = svgIcon(NEXT_PATH)
  const speeds = document.createElement('div')
  speeds.className = 'chronicle__speeds'
  speeds.setAttribute('role', 'group')
  speeds.dataset.help = 'incubator.people.speed'
  let speedIndex = 0
  const speedButtons = SPEEDS.map((speed, k) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = `${speed}×`
    b.addEventListener('click', () => {
      speedIndex = k
      saySpeeds()
    })
    speeds.append(b)
    return b
  })
  controls.append(previous, play, next, speeds)
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.className = 'chronicle__slider'
  slider.min = '0'
  slider.max = String(span)
  slider.step = '100'
  const when = document.createElement('div')
  when.className = 'chronicle__when-now'
  when.append(epoch, year)
  present.append(when, controls, slider)

  const stats = document.createElement('div')
  stats.className = 'chronicle__stats'

  // The events beside the axis.
  const body = document.createElement('div')
  body.className = 'chronicle__body'
  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  axis.classList.add('chronicle__axis')
  axis.setAttribute('viewBox', `0 0 ${AXIS_WIDTH} 1000`)
  axis.setAttribute('preserveAspectRatio', 'none')
  axis.setAttribute('aria-hidden', 'true')
  // The handle apart from the stretched axis, so it stays round.
  const handle = document.createElement('span')
  handle.className = 'chronicle__handle'
  const axisBox = document.createElement('div')
  axisBox.className = 'chronicle__axis-box'
  axisBox.append(axis, handle)
  const list = document.createElement('div')
  list.className = 'chronicle__list'
  body.append(axisBox, list)

  aside.append(head, present, stats, body)
  host.appendChild(aside)
  document.documentElement.style.setProperty(WIDTH_VAR, WIDTH)

  let time = span
  let timer: ReturnType<typeof setInterval> | null = null
  let events: readonly ChronicleEvent[] = []
  let rows: HTMLButtonElement[] = []
  let curve: Float32Array | null = null
  let epochs: readonly { from: number; name: string }[] = []

  function saySpeeds(): void {
    speedButtons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === speedIndex)))
    speeds.setAttribute('aria-label', t('incubator.people.speed.label'))
  }
  function sayPlay(): void {
    const key = timer ? 'incubator.people.play.labelActive' : 'incubator.people.play.label'
    play.setAttribute('aria-label', t(key))
    play.setAttribute('aria-pressed', String(timer !== null))
    playIcon.src = timer ? '/icons/stop.png' : '/icons/play.png'
  }
  function sayTime(): void {
    year.textContent = t('incubator.chronicle.year', { year: (Math.round(time / 10) * 10).toLocaleString(getLocale()) })
    epoch.textContent = [...epochs].reverse().find((e) => e.from <= time)?.name ?? ''
    slider.value = String(time)
    // The last event by now is "now", the ones after it "later".
    let now = -1
    for (let k = 0; k < events.length; k++) if (events[k].time <= time) now = k
    rows.forEach((row, k) => {
      row.classList.toggle('chronicle__event--later', k > now)
      const tag = row.querySelector<HTMLElement>('.chronicle__tag')!
      tag.hidden = k < now
      tag.textContent = k === now ? t('incubator.chronicle.now') : t('incubator.chronicle.later')
      tag.classList.toggle('chronicle__tag--now', k === now)
    })
    drawAxis()
  }
  function drawAxis(): void {
    const parts: string[] = []
    // The epochs as bands, every second one toned, a line at each border.
    epochs.forEach((e, k) => {
      const y0 = (1000 * e.from) / span
      const y1 = k + 1 < epochs.length ? (1000 * epochs[k + 1].from) / span : 1000
      if (k % 2 === 1) parts.push(`<rect x="0" y="${y0.toFixed(1)}" width="${AXIS_WIDTH}" height="${(y1 - y0).toFixed(1)}" class="chronicle__axis-band"/>`)
      if (k > 0) parts.push(`<line x1="0" y1="${y0.toFixed(1)}" x2="${AXIS_WIDTH}" y2="${y0.toFixed(1)}" class="chronicle__axis-border"/>`)
    })
    parts.push(`<line x1="13" y1="0" x2="13" y2="1000" class="chronicle__axis-line"/>`)
    if (curve && curve.length > 1) {
      // The people on a logarithmic scale over the axis's width.
      let top = 0
      for (const v of curve) top = Math.max(top, v)
      const floor = Math.max(1, top / 1e5)
      const x = (v: number): number => (v > floor ? (AXIS_WIDTH - 2) * (Math.log(v / floor) / Math.log(top / floor)) : 0)
      const points = Array.from(curve, (v, k) => `${x(v).toFixed(1)} ${((1000 * k) / (curve!.length - 1)).toFixed(1)}`)
      parts.push(`<path d="M0 0 L${points.join(' L')} L0 1000 Z" class="chronicle__axis-curve"/>`)
    }
    const y = (1000 * time) / span
    parts.push(`<line x1="13" y1="0" x2="13" y2="${y.toFixed(1)}" class="chronicle__axis-done"/>`)
    axis.innerHTML = parts.join('')
    handle.style.top = `${(100 * time) / span}%`
  }
  // The list: under each epoch's heading the events from its year to the
  // next's; a click on a heading goes to the epoch's start.
  function layOut(): void {
    list.replaceChildren()
    let k = 0
    epochs.forEach((e, n) => {
      const until = n + 1 < epochs.length ? epochs[n + 1].from : Infinity
      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'chronicle__epoch-head'
      head.textContent = e.name
      head.addEventListener('click', () => {
        stop()
        show(e.from)
      })
      list.append(head)
      for (; k < events.length && events[k].time < until; k++) list.append(rows[k])
    })
    for (; k < events.length; k++) list.append(rows[k])
  }
  function say(): void {
    title.textContent = t('incubator.chronicle.title')
    count.textContent = t('incubator.chronicle.count', { count: events.length.toLocaleString(getLocale()) })
    previous.setAttribute('aria-label', t('incubator.chronicle.previous'))
    next.setAttribute('aria-label', t('incubator.chronicle.next'))
    sayPlay()
    saySpeeds()
    sayTime()
  }

  function show(at: number): void {
    time = Math.min(span, Math.max(0, at))
    sayTime()
    options.onTime(time)
  }
  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    sayPlay()
  }
  play.addEventListener('click', () => {
    if (timer) {
      stop()
      return
    }
    if (time >= span) show(0)
    timer = setInterval(() => {
      show(time + YEARS_A_SECOND * (FRAME_MS / 1000) * SPEEDS[speedIndex])
      if (time >= span) stop()
    }, FRAME_MS)
    sayPlay()
  })
  slider.addEventListener('input', () => {
    stop()
    show(Number(slider.value))
  })
  previous.addEventListener('click', () => {
    stop()
    const before = [...events].reverse().find((e) => e.time < time - 1e-6)
    show(before ? before.time : 0)
  })
  next.addEventListener('click', () => {
    stop()
    const after = events.find((e) => e.time > time + 1e-6)
    if (after) show(after.time)
  })

  say()
  return {
    element: aside,
    time: () => time,
    show,
    stop,
    setEvents(list_) {
      events = [...list_].sort((a, b) => a.time - b.time)
      list.replaceChildren()
      rows = events.map((event) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'chronicle__event'
        const dot = document.createElement('span')
        dot.className = 'chronicle__dot'
        dot.style.background = `rgb(${event.rgb.join(',')})`
        const when = document.createElement('span')
        when.className = 'chronicle__when'
        when.textContent = Math.round(event.time).toLocaleString(getLocale())
        const text = document.createElement('span')
        text.className = 'chronicle__text'
        const line = document.createElement('span')
        line.className = 'chronicle__line'
        const icon = document.createElement('img')
        icon.className = 'chronicle__icon'
        icon.src = event.icon
        icon.alt = ''
        const name = document.createElement('span')
        name.className = 'chronicle__name'
        name.textContent = event.title
        const tag = document.createElement('span')
        tag.className = 'chronicle__tag'
        line.append(icon, name, tag)
        const detail = document.createElement('span')
        detail.className = 'chronicle__detail'
        detail.textContent = event.detail
        text.append(line, detail)
        row.append(dot, when, text)
        row.addEventListener('click', () => {
          stop()
          show(event.time)
          options.onEvent(event)
        })
        return row
      })
      layOut()
      say()
    },
    setStats(statRows) {
      stats.replaceChildren(...statRows.map((r) => {
        const cell = document.createElement('div')
        cell.className = 'chronicle__stat'
        const label = document.createElement('span')
        label.className = 'chronicle__stat-label'
        label.textContent = r.label
        const value = document.createElement('span')
        value.className = 'chronicle__stat-value'
        value.textContent = r.value
        cell.append(label, value)
        return cell
      }))
    },
    setCurve(values) {
      curve = values
      drawAxis()
    },
    setEpochs(list_) {
      epochs = list_
      layOut()
      sayTime()
    },
    relabel: say,
    setVisible(visible) {
      aside.hidden = !visible
      document.documentElement.style.setProperty(WIDTH_VAR, visible ? WIDTH : '0px')
      if (!visible) stop()
    },
    dispose() {
      stop()
      aside.remove()
      document.documentElement.style.removeProperty(WIDTH_VAR)
    },
  }
}

import './mapProbe.css'

// The content of the map readout: a heading, a kind line, label/value rows and
// optional yearly charts. A DATA shape, not DOM — the screen says what the
// hovered cell is, this module says how it looks. Kept out of the screen so the
// game map can show the same card later, and out of MapHoverTooltip so that one
// stays "cursor → cell" only.
export interface ProbeRow {
  label: string
  // Left out where the bearing IS the whole answer, and a row may equally carry
  // a value with no bearing. Both are optional because a row says as much as its
  // field knows and no more.
  value?: string
  // Screen bearing in degrees, clockwise from up. The card draws a little arrow
  // at it — and NO letters, because this world is a flat torus with no poles and
  // no meridian, so "SW" would be a word borrowed from a sphere. The arrow says
  // the whole of what is true: that way, across the map in front of you.
  bearing?: number
}

// A year in twelve values. `line` draws a curve with a dashed zero line (a
// temperature runs below zero and the reader needs to see where); `bars` draws
// twelve columns from the baseline (a rainfall total has no negative half).
export interface ProbeChart {
  label: string
  kind: 'line' | 'bars'
  values: number[]
}

export interface ProbeContent {
  // The one number the cell is about, big: the height in metres.
  heading: string
  // Land / Ocean, with the dot that says which.
  kind: string
  land: boolean
  // What the cell IS, under the height in a larger type (the climate class
  // and the biome). Empty on the sea and in the steps before the climate.
  highlights: string[]
  rows: ProbeRow[]
  // Month initials for the axis under the charts, already split by the caller
  // (one catalog key holds all twelve, comma separated).
  months: readonly string[]
  charts: ProbeChart[]
}

const CHART_W = 240
const CHART_H = 40
// Half a column either side, so the first and last month sit inside the box
// rather than on its edge.
const STEP = CHART_W / 12
const SVG_NS = 'http://www.w3.org/2000/svg'

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

// Map twelve values onto the chart box. The scale is the series' own range,
// padded so a flat year is a flat line in the middle rather than a line stuck
// to an edge; `zero` says whether 0 falls inside it and where.
function scaleOf(values: number[], forceZero: boolean): { y: (v: number) => number; zeroY: number | null } {
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (forceZero) {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  if (hi - lo < 1e-6) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  lo -= pad
  hi += pad
  const y = (v: number): number => CHART_H - ((v - lo) / (hi - lo)) * CHART_H
  return { y, zeroY: lo <= 0 && hi >= 0 ? y(0) : null }
}

function buildChart(chart: ProbeChart): SVGElement {
  const box = svg('svg', {
    viewBox: `0 0 ${CHART_W} ${CHART_H}`,
    class: 'probe-chart',
    'aria-hidden': 'true',
  })
  if (chart.kind === 'bars') {
    // Bars grow from the bottom of the box, so the baseline is the box itself
    // and zero needs no line of its own.
    const max = Math.max(...chart.values, 1e-6)
    chart.values.forEach((v, i) => {
      const h = Math.max(0, (v / max) * CHART_H)
      box.appendChild(svg('rect', {
        x: (i * STEP + STEP * 0.2).toFixed(1),
        y: (CHART_H - h).toFixed(1),
        width: (STEP * 0.6).toFixed(1),
        height: h.toFixed(1),
        class: 'probe-chart-bar',
      }))
    })
    return box
  }
  const { y, zeroY } = scaleOf(chart.values, true)
  if (zeroY !== null) {
    box.appendChild(svg('line', {
      x1: '0', x2: String(CHART_W), y1: zeroY.toFixed(1), y2: zeroY.toFixed(1),
      class: 'probe-chart-zero',
    }))
  }
  const d = chart.values
    .map((v, i) => `${i ? 'L' : 'M'}${(i * STEP + STEP / 2).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(' ')
  box.appendChild(svg('path', { d, class: 'probe-chart-line' }))
  return box
}

// The direction arrow: drawn pointing up (north) and rotated into the bearing,
// so the one path serves all eight and any angle between them.
function buildArrow(bearing: number): SVGElement {
  const box = svg('svg', { viewBox: '0 0 24 24', class: 'probe-arrow', 'aria-hidden': 'true' })
  const g = svg('g', { transform: `rotate(${bearing.toFixed(1)} 12 12)` })
  g.appendChild(svg('path', { d: 'M12 20V5M12 4l-5.5 6.5M12 4l5.5 6.5', class: 'probe-arrow-path' }))
  box.appendChild(g)
  return box
}

function buildAxis(months: readonly string[]): HTMLElement {
  const axis = document.createElement('div')
  axis.className = 'probe-chart-axis'
  for (const m of months) {
    const cell = document.createElement('span')
    cell.textContent = m
    axis.appendChild(cell)
  }
  return axis
}

// Build the card body. Returns a detached element the tooltip puts in its card.
export function buildProbeCard(content: ProbeContent): HTMLElement {
  const root = document.createElement('div')
  root.className = 'probe'

  const head = document.createElement('div')
  head.className = 'probe-head'
  const heading = document.createElement('span')
  heading.className = 'probe-heading'
  heading.textContent = content.heading
  head.appendChild(heading)
  const kind = document.createElement('span')
  kind.className = content.land ? 'probe-kind probe-kind--land' : 'probe-kind probe-kind--ocean'
  kind.textContent = content.kind
  head.appendChild(kind)
  root.appendChild(head)

  if (content.highlights.length > 0) {
    const what = document.createElement('div')
    what.className = 'probe-highlights'
    for (const h of content.highlights) {
      const line = document.createElement('span')
      line.className = 'probe-highlight'
      line.textContent = h
      what.appendChild(line)
    }
    root.appendChild(what)
  }

  if (content.rows.length > 0) {
    const rows = document.createElement('div')
    rows.className = 'probe-rows'
    for (const r of content.rows) {
      const label = document.createElement('span')
      label.className = 'probe-row-label'
      label.textContent = r.label
      const value = document.createElement('span')
      value.className = 'probe-row-value'
      if (r.value !== undefined) value.appendChild(document.createTextNode(r.value))
      if (r.bearing !== undefined) value.appendChild(buildArrow(r.bearing))
      rows.append(label, value)
    }
    root.appendChild(rows)
  }

  if (content.charts.length > 0) {
    const charts = document.createElement('div')
    charts.className = 'probe-charts'
    for (const c of content.charts) {
      const label = document.createElement('span')
      label.className = 'probe-chart-label'
      label.textContent = c.label
      charts.append(label, buildChart(c))
    }
    charts.appendChild(buildAxis(content.months))
    root.appendChild(charts)
  }

  return root
}

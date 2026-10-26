import type { SymbolPicture, WorldSymbol } from '../../map/worldView'
import { GOOD_COLOURS, LIFEWAY_COLOURS } from './incubatorOverlay'
import { LIFEWAY } from './settleShared'
import type { RouteLine } from './peopleArrows'

// THE INCUBATOR'S MARKS (2026-10-26): the places the people step shows —
// the villages, the farming's and the herding's centres, the origin, the sources of the
// goods — as symbols the views lay in their surface (map/worldView.ts,
// WorldSymbols), round on the globe and sharp at any zoom, as the
// generator's volcanoes, not painted into the overlay. A picture's size is
// on the world, in km: it zooms with it.

// Canvas pixels per km of a picture.
const PIXELS_PER_KM = 1.5

// A picture `km` wide and high; `draw` draws in km, its origin at the
// picture's centre.
function picture(km: number, draw: (c: CanvasRenderingContext2D) => void): SymbolPicture {
  const image = document.createElement('canvas')
  image.width = image.height = Math.max(2, Math.ceil(km * PIXELS_PER_KM))
  const c = image.getContext('2d')!
  c.setTransform(PIXELS_PER_KM, 0, 0, PIXELS_PER_KM, image.width / 2, image.height / 2)
  draw(c)
  return { image, width: km * 1000, height: km * 1000 }
}

const rgb = (c: readonly [number, number, number]): string => `rgb(${c[0]},${c[1]},${c[2]})`

// A cell's centre as a chart point (the habitat's centres, cells.ts).
export const cellPoint = (cell: number, u: Float32Array, v: Float32Array): WorldSymbol['at'] => ({ u: u[cell], v: v[cell] })

// THE VILLAGES: a dot in its lifeway's colour on a dark rim, three sizes by
// the density there. Picture (lifeway − 1) · 3 + size.
const VILLAGE_KM = [18, 26, 36]
export const villagePictures = (): SymbolPicture[] => [1, 2, 3, 4].flatMap((way) => VILLAGE_KM.map((km) => picture(km, (c) => {
  c.beginPath()
  c.arc(0, 0, km / 2 - 2, 0, Math.PI * 2)
  c.fillStyle = rgb(LIFEWAY_COLOURS[way])
  c.fill()
  c.lineWidth = 3
  c.strokeStyle = 'rgb(25,25,25)'
  c.stroke()
})))
// The camps in the villages' lists are not villages (campSymbols).
export function villageSymbols(villages: Int32Array, density: Float32Array, u: Float32Array, v: Float32Array): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  for (let k = 0; k < villages.length; k += 2) {
    if (isCampWay(villages[k + 1])) continue
    const d = density[villages[k]]
    const size = d >= 10 ? 2 : d >= 2 ? 1 : 0
    symbols.push({ at: cellPoint(villages[k], u, v), picture: (villages[k + 1] - 1) * VILLAGE_KM.length + size })
  }
  return symbols
}

// THE CAMPS (2026-10-26): the foragers' and the herders' meeting places
// (simulation.ts, THE CAMPS), kept in the villages' lists: a tent, a
// triangle in the lifeway's colour on a dark rim. Picture 0 the
// foragers', 1 the herders'.
export const isCampWay = (way: number): boolean => way === LIFEWAY.foragers || way === LIFEWAY.herders
const CAMP_KM = 16
export const campPictures = (): SymbolPicture[] => [LIFEWAY.foragers, LIFEWAY.herders].map((way) => picture(CAMP_KM, (c) => {
  const r = CAMP_KM / 2 - 1.5
  c.beginPath()
  c.moveTo(0, -r)
  c.lineTo(r * 0.95, r * 0.7)
  c.lineTo(-r * 0.95, r * 0.7)
  c.closePath()
  c.fillStyle = rgb(LIFEWAY_COLOURS[way])
  c.fill()
  c.lineWidth = 2
  c.strokeStyle = 'rgb(25,25,25)'
  c.stroke()
}))
export function campSymbols(villages: Int32Array, u: Float32Array, v: Float32Array): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  for (let k = 0; k < villages.length; k += 2) if (isCampWay(villages[k + 1])) symbols.push({ at: cellPoint(villages[k], u, v), picture: villages[k + 1] === LIFEWAY.herders ? 1 : 0 })
  return symbols
}

// THE HAMLETS (2026-10-26): the many small settlements around the central
// places, one for HAMLET_PEOPLE of the settled (the fishers and the
// farmers); counted, not placed one by one — a cell's dot is larger the
// more it holds (HAMLET_KM by HAMLET_CLASSES), in the colour of the
// larger of the two lifeways. None under half a hamlet. Picture
// (fishers 0, farmers 1) · 3 + size.
const HAMLET_PEOPLE = 150
const HAMLET_KM = [4, 6, 8]
const HAMLET_CLASSES = [3, 8]
export const hamletPictures = (): SymbolPicture[] => [LIFEWAY.fishers, LIFEWAY.farmers].flatMap((way) => HAMLET_KM.map((km) => picture(km, (c) => {
  c.beginPath()
  c.arc(0, 0, km / 2 - 0.5, 0, Math.PI * 2)
  c.fillStyle = rgb(LIFEWAY_COLOURS[way])
  c.fill()
  c.lineWidth = 1
  c.strokeStyle = 'rgb(25,25,25)'
  c.stroke()
})))
// `shares`: the lifeways' shares, 4 a cell (1 … 4), in 255ths.
export function hamletSymbols(density: Float32Array, shares: Uint8Array, areaKm2: Float32Array, u: Float32Array, v: Float32Array): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  for (let i = 0; i < density.length; i++) {
    if (density[i] <= 0) continue
    const fishers = shares[4 * i + LIFEWAY.fishers - 1]
    const farmers = shares[4 * i + LIFEWAY.farmers - 1]
    const count = (density[i] * areaKm2[i] * (fishers + farmers)) / 255 / HAMLET_PEOPLE
    if (count < 0.5) continue
    const size = count >= HAMLET_CLASSES[1] ? 2 : count >= HAMLET_CLASSES[0] ? 1 : 0
    symbols.push({ at: cellPoint(i, u, v), picture: (farmers >= fishers ? 1 : 0) * HAMLET_KM.length + size })
  }
  return symbols
}

// THE CENTRES: a disc in the lifeway's colour in a white ring on a dark
// rim. Picture 0 the farming's, 1 the herding's.
export const centrePictures = (): SymbolPicture[] => [4, 3].map((way) => picture(70, (c) => {
  c.beginPath()
  c.arc(0, 0, 30, 0, Math.PI * 2)
  c.fillStyle = 'white'
  c.fill()
  c.lineWidth = 4
  c.strokeStyle = 'rgb(25,25,25)'
  c.stroke()
  c.beginPath()
  c.arc(0, 0, 20, 0, Math.PI * 2)
  c.fillStyle = rgb(LIFEWAY_COLOURS[way])
  c.fill()
}))

// THE ORIGIN: a red dot in a dark ring with crosshairs, on a white rim, so
// it stands out on any ground.
export const originPictures = (): SymbolPicture[] => [picture(260, (c) => {
  const stroke = (width: number, colour: string, path: () => void): void => {
    c.beginPath()
    path()
    c.lineWidth = width
    c.strokeStyle = colour
    c.stroke()
  }
  const ring = (): void => c.arc(0, 0, 70, 0, Math.PI * 2)
  const ticks = (): void => {
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      c.moveTo(x * 80, y * 80)
      c.lineTo(x * 125, y * 125)
    }
  }
  stroke(28, 'white', ring)
  stroke(28, 'white', ticks)
  stroke(16, 'rgb(25,25,25)', ring)
  stroke(16, 'rgb(25,25,25)', ticks)
  c.beginPath()
  c.arc(0, 0, 30, 0, Math.PI * 2)
  c.fillStyle = 'rgb(220,30,30)'
  c.fill()
  c.lineWidth = 8
  c.strokeStyle = 'white'
  c.stroke()
})]

// THE SOURCES of the goods: a square in the good's colour on a dark rim.
// Picture: the good's index.
export const sourcePictures = (): SymbolPicture[] => GOOD_COLOURS.map((colour) => picture(40, (c) => {
  c.fillStyle = rgb(colour)
  c.fillRect(-15, -15, 30, 30)
  c.lineWidth = 4
  c.strokeStyle = 'rgb(25,25,25)'
  c.strokeRect(-15, -15, 30, 30)
}))

// LINES AS SYMBOLS (2026-10-26): a line is pieces of it, each `pieceKm`
// long every `stepKm` so that they join, along its points; an arrow has a
// head at its last point, its tip there. The pieces lie in the views'
// surface as the other marks, sharp at any zoom: the routes, the trade and
// the crossings, painted into the overlay before.
type At = WorldSymbol['at']
export interface LineStyle {
  widthKm: number
  pieceKm: number
  stepKm: number
  // 0: no head.
  headKm: number
}
// `km`: the distance between two chart points; `direction`: the true
// direction from one to the next (WorldSymbol.angle).
export interface LineGeometry {
  km: (a: At, b: At) => number
  direction: (a: At, b: At) => number
}

export const lineStyle = (widthKm: number, head: boolean): LineStyle => {
  const pieceKm = Math.max(10, 1.5 * widthKm)
  return { widthKm, pieceKm, stepKm: 0.7 * pieceKm, headKm: head ? 2.4 * widthKm : 0 }
}

// A style's pictures: the piece, then the head if it has one, pointing
// along +x with its tip at the picture's edge.
export function linePictures(style: LineStyle, colour: readonly [number, number, number]): SymbolPicture[] {
  const piece = picture(style.pieceKm, (c) => {
    c.fillStyle = rgb(colour)
    c.fillRect(-style.pieceKm / 2, -style.widthKm / 2, style.pieceKm, style.widthKm)
  })
  if (style.headKm === 0) return [piece]
  const head = picture(style.headKm, (c) => {
    const h = style.headKm / 2
    c.beginPath()
    c.moveTo(h, 0)
    c.lineTo(-h, -h)
    c.lineTo(-h * 0.6, 0)
    c.lineTo(-h, h)
    c.closePath()
    c.fillStyle = rgb(colour)
    c.fill()
  })
  return [piece, head]
}

// A walk along `points`: its length, km, and the point `d` km along it with
// the direction there.
function walkAlong(points: readonly At[], g: LineGeometry): { total: number; along: (d: number) => { at: At; angle: number } } {
  const lengths = points.slice(1).map((p, j) => g.km(points[j], p))
  const total = lengths.reduce((a, b) => a + b, 0)
  const along = (d: number): { at: At; angle: number } => {
    let j = 0
    while (j < lengths.length - 1 && d > lengths[j]) d -= lengths[j++]
    const f = lengths[j] > 0 ? Math.max(0, Math.min(1, d / lengths[j])) : 0
    const a = points[j]
    const b = points[j + 1]
    // The shorter way round in u.
    const du = b.u - a.u - Math.round(b.u - a.u)
    return { at: { u: (((a.u + du * f) % 1) + 1) % 1, v: a.v + (b.v - a.v) * f }, angle: g.direction(a, b) }
  }
  return { total, along }
}

// The symbols of a line in `style` along `points`, its pictures from
// `first` on (linePictures' order).
export function lineSymbols(points: readonly At[], style: LineStyle, first: number, g: LineGeometry): WorldSymbol[] {
  if (points.length < 2) return []
  const { total, along } = walkAlong(points, g)
  const symbols: WorldSymbol[] = []
  // The shaft up to the head's back, the head with its tip on the last
  // point.
  const shaft = Math.max(0, total - style.headKm * 0.7)
  for (let d = style.pieceKm / 2; d < shaft; d += style.stepKm) symbols.push({ ...along(d), picture: first })
  if (style.headKm > 0) symbols.push({ ...along(Math.max(0, total - style.headKm / 2)), picture: first + 1 })
  return symbols
}

// THE ROUTES: the spread's lines (peopleArrows.ts) as far as the people
// came by `t`, as continuous lines of the route's colour: sampled every
// ROUTE_SAMPLE cells and smoothed (Chaikin, twice), so the cells' zigzag
// does not show (5 cells until 2026-10-26: a history's lines still bent), then laid with round-ended pieces close enough to join.
// A piece is the line's width there (`widthOf`, km) in ROUTE_WIDTHS_KM
// classes, so the line thins toward the front. A head where a line ends
// by then with nothing going on from it: at a tip, and at the front while
// the people spread. Over a crossing the chronicle tells (`sea`) the line
// is blue (CROSSING_RGB); a separate blue arrow until 2026-10-26.
// Pictures four a class: the piece, the head, then both blue; the head as
// the generator's migration arrows (GeneratorScreen
// drawMigrationArrows). Chevrons, framed, were tried the same day and were
// hard to read.
const ROUTE_WIDTHS_KM = [8, 12, 17, 23, 30, 39, 50]
const ROUTE_SAMPLE = 10
// The pieces' spacing, a share of the width, ROUTE_STEP_LEAST km at least:
// a piece is its spacing and its width long, so they always join.
const ROUTE_STEP = 1
const ROUTE_STEP_LEAST = 8
const ROUTE_HEAD = 2.2
const ROUTE_HEAD_LEAST = 40
const routeClass = (widthKm: number): number => ROUTE_WIDTHS_KM.reduce((best, w, k) => (Math.abs(w - widthKm) < Math.abs(ROUTE_WIDTHS_KM[best] - widthKm) ? k : best), 0)
const routeStep = (k: number): number => Math.max(ROUTE_STEP_LEAST, ROUTE_STEP * ROUTE_WIDTHS_KM[k])
export const routePictures = (colour: readonly [number, number, number]): SymbolPicture[] => ROUTE_WIDTHS_KM.flatMap((_, k) => [...routeClassPictures(k, colour), ...routeClassPictures(k, CROSSING_RGB)])
function routeClassPictures(k: number, colour: readonly [number, number, number]): SymbolPicture[] {
  const w = ROUTE_WIDTHS_KM[k]
  const length = routeStep(k)
  const piece = picture(length + w, (c) => {
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(-length / 2, 0)
    c.lineTo(length / 2, 0)
    c.lineWidth = w
    c.strokeStyle = rgb(colour)
    c.stroke()
  })
  // The tip `head` ahead of the line's end, the back corners 0.6 head out
  // at ±2.5 rad.
  const head = Math.max(ROUTE_HEAD_LEAST, ROUTE_HEAD * w)
  const tip = picture(2 * head, (c) => {
    c.beginPath()
    c.moveTo(head, 0)
    c.lineTo(Math.cos(2.5) * head * 0.6, Math.sin(2.5) * head * 0.6)
    c.lineTo(Math.cos(-2.5) * head * 0.6, Math.sin(-2.5) * head * 0.6)
    c.closePath()
    c.fillStyle = rgb(colour)
    c.fill()
  })
  return [piece, tip]
}
// `sea`: 1 on the cells of the crossings drawn blue, or null.
export function routeSymbols(lines: readonly RouteLine[], t: number, arrival: Float32Array, widthOf: (cell: number) => number, sea: Uint8Array | null, u: Float32Array, v: Float32Array, g: LineGeometry): WorldSymbol[] {
  // How far each line is on by `t`; the lines going on from a cell.
  const shownOf = lines.map(({ cells }) => {
    let shown = 0
    while (shown < cells.length && arrival[cells[shown]] <= t) shown++
    return shown
  })
  // A line is on once it is past its parting.
  const goesOn = new Set<number>()
  lines.forEach(({ cells, lead }, k) => {
    if (shownOf[k] >= lead + 2) goesOn.add(cells[lead])
  })
  const symbols: WorldSymbol[] = []
  const heads: WorldSymbol[] = []
  lines.forEach(({ cells: line, lead }, n) => {
    const shown = shownOf[n]
    if (shown < lead + 2) return
    // Sampled, unwrapped in u, with the width there and whether it is over
    // a crossing (1) or not (0).
    const sample = (cell: number): { u: number; v: number; w: number; s: number } => ({ u: u[cell], v: v[cell], w: widthOf(cell), s: sea?.[cell] ?? 0 })
    let points: { u: number; v: number; w: number; s: number }[] = []
    for (let j = 0; j < shown; j += ROUTE_SAMPLE) points.push(sample(line[j]))
    if ((shown - 1) % ROUTE_SAMPLE !== 0) points.push(sample(line[shown - 1]))
    for (let j = 1; j < points.length; j++) points[j].u -= Math.round(points[j].u - points[j - 1].u)
    // Chaikin's corners cut, the ends kept.
    for (let pass = 0; pass < 2 && points.length > 2; pass++) {
      const cut = [points[0]]
      for (let j = 0; j < points.length - 1; j++) {
        const a = points[j]
        const b = points[j + 1]
        const mix = (f: number): { u: number; v: number; w: number; s: number } => ({ u: a.u + (b.u - a.u) * f, v: a.v + (b.v - a.v) * f, w: a.w + (b.w - a.w) * f, s: a.s + (b.s - a.s) * f })
        cut.push(mix(0.25), mix(0.75))
      }
      cut.push(points[points.length - 1])
      points = cut
    }
    const at = points.map((p) => ({ u: ((p.u % 1) + 1) % 1, v: p.v }))
    for (let j = 0; j < at.length - 1; j++) {
      const a = at[j]
      const b = at[j + 1]
      const km = g.km(a, b)
      const angle = g.direction(a, b)
      const du = b.u - a.u - Math.round(b.u - a.u)
      for (let d = 0; d < km; ) {
        const f = km > 0 ? d / km : 0
        const k = routeClass(points[j].w + (points[j + 1].w - points[j].w) * f)
        const blue = points[j].s + (points[j + 1].s - points[j].s) * f >= 0.5 ? 2 : 0
        symbols.push({ at: { u: (((a.u + du * f) % 1) + 1) % 1, v: a.v + (b.v - a.v) * f }, angle, picture: 4 * k + blue })
        d += routeStep(k)
      }
    }
    // A head at its end, unless a line goes on from there by now.
    const end = line[shown - 1]
    if (shown === line.length && goesOn.has(end)) return
    const last = points[points.length - 1]
    heads.push({ at: at[at.length - 1], angle: g.direction(at[at.length - 2], at[at.length - 1]), picture: 4 * routeClass(last.w) + 1 + (last.s >= 0.5 ? 2 : 0) })
  })
  // The thin lines' pieces are as many as the broad ones': the heads on top.
  return [...symbols, ...heads]
}

// THE TRADE: the links between villages that carry goods (settle.ts),
// wider the more, in TRADE_WIDTHS_KM classes; one picture a class.
const TRADE_WIDTHS_KM = [4, 8, 14]
export const tradePictures = (colour: readonly [number, number, number]): SymbolPicture[] => TRADE_WIDTHS_KM.flatMap((w) => linePictures(lineStyle(w, false), colour))
export function tradeSymbols(villages: Int32Array, links: Float32Array, u: Float32Array, v: Float32Array, g: LineGeometry): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  for (let k = 0; k < links.length; k += 3) {
    const w = links[k + 2]
    if (w < 0.05) continue
    const c = w < 1 ? 0 : w < 4 ? 1 : 2
    const a = cellPoint(villages[2 * links[k]], u, v)
    const b = cellPoint(villages[2 * links[k + 1]], u, v)
    symbols.push(...lineSymbols([a, b], lineStyle(TRADE_WIDTHS_KM[c], false), c, g))
  }
  return symbols
}

// THE CROSSINGS (2026-10-26): the year people first landed on a landmass
// over the sea (people.ts, crossings), as text at the middle of the way,
// upright; the way itself is the routes', blue there. One picture a year,
// in the order given.
// 70 km at first (2026-10-26): too small to read.
const CROSSING_TEXT_KM = 250
const CROSSING_RGB: readonly [number, number, number] = [40, 90, 150]
export function crossingPictures(years: readonly string[]): SymbolPicture[] {
  return years.map((text) => {
    // As wide as the text, CROSSING_TEXT_KM high.
    const probe = document.createElement('canvas').getContext('2d')!
    const font = `600 ${CROSSING_TEXT_KM * 0.6}px 'IBM Plex Sans', system-ui, sans-serif`
    probe.font = font
    const km = Math.ceil(probe.measureText(text).width + CROSSING_TEXT_KM * 0.4)
    const image = document.createElement('canvas')
    image.width = Math.ceil(km * PIXELS_PER_KM)
    image.height = Math.ceil(CROSSING_TEXT_KM * PIXELS_PER_KM)
    const c = image.getContext('2d')!
    c.setTransform(PIXELS_PER_KM, 0, 0, PIXELS_PER_KM, image.width / 2, image.height / 2)
    c.font = font
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.lineJoin = 'round'
    c.lineWidth = CROSSING_TEXT_KM * 0.14
    c.strokeStyle = 'white'
    c.strokeText(text, 0, 0)
    c.fillStyle = rgb(CROSSING_RGB)
    c.fillText(text, 0, 0)
    return { image, width: km * 1000, height: CROSSING_TEXT_KM * 1000 }
  })
}

// The year of each crossing at the middle of its way: `paths` the cells
// from the coast left to the cell landed on.
export function crossingSymbols(paths: readonly number[][], u: Float32Array, v: Float32Array, g: LineGeometry): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  paths.forEach((path, k) => {
    if (path.length < 2) return
    const walk = walkAlong(path.map((cell) => cellPoint(cell, u, v)), g)
    symbols.push({ at: walk.along(walk.total / 2).at, picture: k })
  })
  return symbols
}

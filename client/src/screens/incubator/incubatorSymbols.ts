import type { SymbolPicture, WorldSymbol } from '../../map/worldView'
import { GOOD_COLOURS, LIFEWAY_COLOURS } from './incubatorOverlay'

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
export function villageSymbols(villages: Int32Array, density: Float32Array, u: Float32Array, v: Float32Array): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  for (let k = 0; k < villages.length; k += 2) {
    const d = density[villages[k]]
    const size = d >= 10 ? 2 : d >= 2 ? 1 : 0
    symbols.push({ at: cellPoint(villages[k], u, v), picture: (villages[k + 1] - 1) * VILLAGE_KM.length + size })
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

// THE CROSSINGS (2026-10-26): the way people first came over the sea to a
// landmass (people.ts, crossings) as a blue arrow — pieces of a line, each
// CROSSING_PIECE_KM long every CROSSING_STEP_KM so that they join, along
// the way smoothed over every CROSSING_SMOOTH cells, a head at the cell
// landed on — and the year they landed as text at its middle, upright.
// Picture 0 the piece, 1 the head, 2 … the years, in the order given.
const CROSSING_PIECE_KM = 14
const CROSSING_STEP_KM = 10
const CROSSING_WIDTH_KM = 6
const CROSSING_HEAD_KM = 36
const CROSSING_SMOOTH = 4
const CROSSING_TEXT_KM = 70
export function crossingPictures(years: readonly string[]): SymbolPicture[] {
  const piece = picture(CROSSING_PIECE_KM, (c) => {
    c.fillStyle = rgb(CROSSING_RGB)
    c.fillRect(-CROSSING_PIECE_KM / 2, -CROSSING_WIDTH_KM / 2, CROSSING_PIECE_KM, CROSSING_WIDTH_KM)
  })
  // Pointing along +x, its tip at the picture's edge.
  const head = picture(CROSSING_HEAD_KM, (c) => {
    const h = CROSSING_HEAD_KM / 2
    c.beginPath()
    c.moveTo(h, 0)
    c.lineTo(-h, -h * 0.75)
    c.lineTo(-h * 0.55, 0)
    c.lineTo(-h, h * 0.75)
    c.closePath()
    c.fillStyle = rgb(CROSSING_RGB)
    c.fill()
  })
  const labels = years.map((text) => {
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
  return [piece, head, ...labels]
}
const CROSSING_RGB: readonly [number, number, number] = [40, 90, 150]

// The arrow and the year of each crossing: `paths` the cells from the
// coast left to the cell landed on; `km` the distance between two chart
// points, `direction` the true direction from one to the next
// (WorldSymbol.angle).
export function crossingSymbols(paths: readonly number[][], u: Float32Array, v: Float32Array, km: (a: WorldSymbol['at'], b: WorldSymbol['at']) => number, direction: (a: WorldSymbol['at'], b: WorldSymbol['at']) => number): WorldSymbol[] {
  const symbols: WorldSymbol[] = []
  paths.forEach((path, k) => {
    // Every CROSSING_SMOOTH-th cell, and the last: the cells' zigzag gone.
    const cells = path.filter((_, j) => j % CROSSING_SMOOTH === 0 || j === path.length - 1)
    const points = cells.map((cell) => cellPoint(cell, u, v))
    const lengths = points.slice(1).map((p, j) => km(points[j], p))
    const total = lengths.reduce((a, b) => a + b, 0)
    // A point `d` km along the way, and the direction there.
    const along = (d: number): { at: WorldSymbol['at']; angle: number } => {
      let j = 0
      while (j < lengths.length - 1 && d > lengths[j]) d -= lengths[j++]
      const f = lengths[j] > 0 ? Math.min(1, d / lengths[j]) : 0
      const a = points[j]
      const b = points[j + 1]
      // The shorter way round in u.
      const du = b.u - a.u - Math.round(b.u - a.u)
      return { at: { u: (((a.u + du * f) % 1) + 1) % 1, v: a.v + (b.v - a.v) * f }, angle: direction(a, b) }
    }
    if (points.length < 2) return
    // The shaft up to the head's back, the head with its tip on the cell.
    const shaft = Math.max(0, total - CROSSING_HEAD_KM * 0.7)
    for (let d = CROSSING_PIECE_KM / 2; d < shaft; d += CROSSING_STEP_KM) symbols.push({ ...along(d), picture: 0 })
    symbols.push({ ...along(Math.max(0, total - CROSSING_HEAD_KM / 2)), picture: 1 })
    symbols.push({ at: along(total / 2).at, picture: k + 2 })
  })
  return symbols
}

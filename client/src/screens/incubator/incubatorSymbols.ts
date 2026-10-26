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

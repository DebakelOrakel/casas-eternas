import { type ContinentLabelPlacement, continentLabelSag, drawContinentLabel, fitContinentLabel } from '../../generator/render/continentLabelRenderer'
import type { SimEvent } from '../../generator/tectonics/plateSimulation'
import type { VectorMark } from '../../map/vectorMarks'
import type { SymbolPicture, WorldSymbol } from '../../map/worldView'

// THE GENERATOR'S SYMBOLS AND NAMES as the world view places them
// (map/worldView.ts, WorldSymbols): the pictures, drawn as the map texture
// drew them until 2026-10-10 — same colours, shapes and sizes in chart
// texels — and the symbols at the chart points. A picture's size on the
// world is its size in texels at the equator, METERS_PER_CELL each; it no
// longer stretches toward the globe's poles as a painted circle did.
//
// Each picture is drawn UPRIGHT (its top the top of the view, north up),
// not in the chart's own orientation: the view turns it. That removes the
// texture's vertical mirror the cones and names used to undo by hand.

// Canvas pixels per chart texel: the symbols are small, the names large.
const SYMBOL_RESOLUTION = 4
const NAME_RESOLUTION = 2

// A picture of `width` × `height` texels; `draw` draws in texels, its origin
// at the picture's centre, y down the canvas.
function picture(width: number, height: number, metresPerTexel: number, resolution: number, draw: (c: CanvasRenderingContext2D) => void): SymbolPicture {
  const image = document.createElement('canvas')
  image.width = Math.max(1, Math.ceil(width * resolution))
  image.height = Math.max(1, Math.ceil(height * resolution))
  const c = image.getContext('2d')!
  c.setTransform(resolution, 0, 0, resolution, image.width / 2, image.height / 2)
  draw(c)
  return { image, width: (image.width / resolution) * metresPerTexel, height: (image.height / resolution) * metresPerTexel }
}

const chartPoint = (x: number, y: number, chartWidth: number, chartHeight: number): WorldSymbol['at'] => ({ u: x / chartWidth, v: y / chartHeight })

export interface ChartSize {
  width: number
  height: number
  metresPerTexel: number
}

// --- the plume sources (the hotspots layer) ---------------------------------

export function hotspotSymbols(hotspots: { x: number; y: number }[], chart: ChartSize): { pictures: SymbolPicture[]; symbols: WorldSymbol[] } {
  const disc = picture(24, 24, chart.metresPerTexel, SYMBOL_RESOLUTION, (c) => {
    c.beginPath()
    c.arc(0, 0, 9, 0, Math.PI * 2)
    c.fillStyle = 'rgba(255, 140, 0, 0.9)'
    c.fill()
    c.lineWidth = 3
    c.strokeStyle = 'rgba(90, 30, 0, 0.95)'
    c.stroke()
  })
  return { pictures: [disc], symbols: hotspots.map((hs) => ({ at: chartPoint(hs.x, hs.y, chart.width, chart.height), picture: 0 })) }
}

// --- the volcanoes ----------------------------------------------------------

export type VolcanoMark = { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }

// The cone's size steps by this many texels: one picture per kind and step,
// not one per volcano.
const CONE_SIZE_STEP = 0.5

export function volcanoSymbols(volcanoes: VolcanoMark[], chart: ChartSize): { pictures: SymbolPicture[]; symbols: WorldSymbol[] } {
  const pictures: SymbolPicture[] = []
  const byKey = new Map<string, number>()
  const symbols = volcanoes.map((v): WorldSymbol => {
    // Arc volcanoes are smaller (individual cones in a chain); hotspot cones and
    // flood-basalt provinces are larger single edifices. Cone height ∝ thickness.
    const isArc = v.kind === 'arc'
    const raw = isArc ? Math.max(3, Math.min(9, 2 + v.thickness * 0.25)) : Math.max(4, Math.min(15, 3 + v.thickness * 0.35))
    const s = Math.round(raw / CONE_SIZE_STEP) * CONE_SIZE_STEP
    const key = `${v.kind}:${s}`
    let index = byKey.get(key)
    if (index === undefined) {
      index = pictures.length
      byKey.set(key, index)
      pictures.push(picture(2 * s + 4, 2 * s + 4, chart.metresPerTexel, SYMBOL_RESOLUTION, (c) => {
        // The apex up; the picture's centre is the volcano's point.
        c.beginPath()
        c.moveTo(0, -s)
        c.lineTo(-s * 0.85, s * 0.6)
        c.lineTo(s * 0.85, s * 0.6)
        c.closePath()
        // flood = dark maroon province, hotspot = bright red cone, arc = orange cone.
        c.fillStyle = v.kind === 'flood' ? 'rgba(120, 25, 20, 0.85)' : v.kind === 'arc' ? 'rgba(235, 120, 30, 0.9)' : 'rgba(220, 55, 30, 0.9)'
        c.fill()
        c.lineWidth = isArc ? 1 : 1.5
        c.strokeStyle = 'rgba(60, 12, 0, 0.9)'
        c.stroke()
      }))
    }
    return { at: chartPoint(v.x, v.y, chart.width, chart.height), picture: index }
  })
  return { pictures, symbols }
}

// --- the tectonic events ----------------------------------------------------
//
// A suture band (collision), a dashed rift axis (breakup), or a ring
// (supercontinent / an event without a direction), faded by its symbol's
// alpha. The band and the axis are pictures turned along the event's
// direction.

export interface EventMarkStyle {
  halfLength: number
  collisionColor: string
  breakupColor: string
}

const EVENT_BAND = 0
const EVENT_RIFT = 1
const EVENT_SUPERCONTINENT = 2
const EVENT_RING_COLLISION = 3
const EVENT_RING_BREAKUP = 4

export function eventPictures(style: EventMarkStyle, chart: ChartSize): SymbolPicture[] {
  const hl = style.halfLength
  const line = (width: number, color: string, dash: number[]): SymbolPicture =>
    picture(2 * hl + width + 2, width + 2, chart.metresPerTexel, SYMBOL_RESOLUTION, (c) => {
      c.strokeStyle = `rgb(${color})`
      c.lineCap = 'round'
      c.lineWidth = width
      c.setLineDash(dash)
      c.beginPath()
      c.moveTo(-hl, 0)
      c.lineTo(hl, 0)
      c.stroke()
    })
  const ring = (r: number, width: number, color: string): SymbolPicture =>
    picture(2 * r + width + 2, 2 * r + width + 2, chart.metresPerTexel, SYMBOL_RESOLUTION, (c) => {
      c.strokeStyle = `rgb(${color})`
      c.lineWidth = width
      c.beginPath()
      c.arc(0, 0, r, 0, Math.PI * 2)
      c.stroke()
    })
  const pictures: SymbolPicture[] = []
  pictures[EVENT_BAND] = line(8, style.collisionColor, [])
  pictures[EVENT_RIFT] = line(5, style.breakupColor, [14, 10])
  pictures[EVENT_SUPERCONTINENT] = ring(26, 5, style.collisionColor)
  pictures[EVENT_RING_COLLISION] = ring(12, 3, style.collisionColor)
  pictures[EVENT_RING_BREAKUP] = ring(12, 3, style.breakupColor)
  return pictures
}

// The event's symbol, or null for an event without a place.
export function eventSymbol(ev: SimEvent, alpha: number, chart: ChartSize): WorldSymbol | null {
  if (ev.x === undefined || ev.y === undefined) return null
  const at = chartPoint(ev.x, ev.y, chart.width, chart.height)
  if (ev.dirX && ev.dirY) {
    // Drawn from −dir to +dir, so the rift's dashes start at the −dir end.
    return { at, picture: ev.type === 'continent_broke_up' ? EVENT_RIFT : EVENT_BAND, angle: Math.atan2(ev.dirY, ev.dirX), alpha }
  }
  const picture = ev.type === 'supercontinent_formed' ? EVENT_SUPERCONTINENT : ev.type === 'continent_broke_up' ? EVENT_RING_BREAKUP : EVENT_RING_COLLISION
  return { at, picture, alpha }
}

// --- the migration's origins ------------------------------------------------

// A disc in each race's hue; `origins` in chart texels.
export function originSymbols(origins: { x: number; y: number; race: number }[], raceRgb: [number, number, number][], chart: ChartSize): { pictures: SymbolPicture[]; symbols: WorldSymbol[] } {
  const pictures = raceRgb.map(([r, g, b]) => picture(40, 40, chart.metresPerTexel, SYMBOL_RESOLUTION, (c) => {
    c.beginPath()
    c.arc(0, 0, 16, 0, Math.PI * 2)
    c.fillStyle = `rgb(${r},${g},${b})`
    c.fill()
    c.lineWidth = 4
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.stroke()
  }))
  return { pictures, symbols: origins.map((o) => ({ at: chartPoint(o.x, o.y, chart.width, chart.height), picture: o.race })) }
}

// --- the continent names ----------------------------------------------------

// One picture per name, drawn by the label renderer (generator/render/
// continentLabelRenderer.ts) at its own size and on its own arc. The
// renderer draws for the map texture, which is shown mirrored top to
// bottom, and so draws mirrored itself; the picture's canvas is mirrored
// back, which leaves the name upright. The symbol runs along the name's
// axis and reads left to right whichever way the axis points.
//
// The placement is in the generator's local units (one texel at the
// equator, true lengths on the sphere), so METERS_PER_CELL each is the
// name's true size on either shape.
//
// The picture holds the name as drawn, not the continent's whole extent:
// the font is capped (46 units), so on a large continent the extent is many
// times the name. A picture of the extent was up to a whole globe long, and
// the globe cut it into quads too long to follow the curve (2026-10-11).
// The name keeps its place and size; only the empty margin goes.
const NAME_MARGIN = 6
const NAME_HALO = 0.25

export function nameSymbols(placements: ContinentLabelPlacement[], chart: ChartSize): { pictures: SymbolPicture[]; symbols: WorldSymbol[] } {
  const pictures: SymbolPicture[] = []
  const symbols: WorldSymbol[] = []
  const measure = document.createElement('canvas').getContext('2d')!
  for (const placement of placements) {
    const fit = fitContinentLabel(measure, placement)
    if (!fit) continue
    // The name's width, its arc's sag to each side of its middle (the
    // picture's centre is the name's middle, so the sag counts twice), the
    // font, and a margin for the halo (its stroke and its blur, NAME_HALO of
    // the font in all) and the glyphs the arc turns.
    const halo = fit.fontSize * NAME_HALO + NAME_MARGIN
    const width = fit.textWidth + 2 * halo
    const height = 2 * continentLabelSag(fit) + fit.fontSize + 2 * halo
    pictures.push(picture(width, height, chart.metresPerTexel, NAME_RESOLUTION, (c) => {
      c.scale(1, -1)
      drawContinentLabel(c, { ...placement, centerX: 0, centerY: 0, angle: 0 })
    }))
    symbols.push({ at: chartPoint(placement.centerX, placement.centerY, chart.width, chart.height), picture: pictures.length - 1, angle: placement.angle, readable: true })
  }
  return { pictures, symbols }
}

// --- the wind and the ocean currents ----------------------------------------
//
// The marks of a vector field (map/vectorMarks.ts), drawn as the map texture
// drew them until 2026-10-11 — same colours, widths and lengths in chart
// texels — but straight: a painted mark followed its flow line's curve, a
// picture cannot. Each picture points along its x axis, tail at the left,
// head at the right; the symbol's angle turns it along the field. A small
// set of pictures, by length and speed (and class for the currents), not
// one per mark.

// Canvas pixels per chart texel: the strokes are thin, the arrows broad.
const WIND_RESOLUTION = 4
const CURRENT_RESOLUTION = 2

// The wind: tapered strokes, a thin faint tail to a bolder head, faster air
// bolder. A faint dark stroke under each pale one, so it holds on light
// ground. Bands along the stroke and speed classes as the painting had.
const WIND_BANDS = 6
const WIND_SPEEDS = 3
// Lengths step by this many texels, up to WIND_LENGTH (a flow line's
// pieces are at most that long, the globe's marks are that long).
const WIND_LENGTH_STEP = 2
export const WIND_LENGTH = 26
export const WIND_GAP = 14
const WIND_LENGTHS = WIND_LENGTH / WIND_LENGTH_STEP
const WIND_STROKES: { color: [number, number, number]; maxWidth: number; opacity: number }[] = [
  { color: [20, 35, 50], maxWidth: 3.2, opacity: 0.55 },
  { color: [255, 255, 255], maxWidth: 1.8, opacity: 1 },
]

export function windPictures(chart: ChartSize): SymbolPicture[] {
  const pictures: SymbolPicture[] = []
  for (let sl = 0; sl < WIND_SPEEDS; sl++) {
    const speed = (sl + 1) / WIND_SPEEDS
    for (let b = 1; b <= WIND_LENGTHS; b++) {
      const length = b * WIND_LENGTH_STEP
      pictures.push(picture(length + 4, 6, chart.metresPerTexel, WIND_RESOLUTION, (c) => {
        c.lineCap = 'round'
        for (const stroke of WIND_STROKES) {
          const [r, g, bl] = stroke.color
          for (let band = 0; band < WIND_BANDS; band++) {
            const t = (band + 1) / WIND_BANDS
            c.strokeStyle = `rgba(${r}, ${g}, ${bl}, ${stroke.opacity * (0.12 + 0.78 * t) * (0.4 + 0.6 * speed)})`
            c.lineWidth = 0.4 + stroke.maxWidth * t * (0.4 + 0.6 * speed)
            c.beginPath()
            c.moveTo(-length / 2 + (band / WIND_BANDS) * length, 0)
            c.lineTo(-length / 2 + ((band + 1) / WIND_BANDS) * length, 0)
            c.stroke()
          }
        }
      }))
    }
  }
  return pictures
}

export function windSymbols(marks: VectorMark[]): WorldSymbol[] {
  return marks.map((m) => {
    const sl = Math.min(WIND_SPEEDS - 1, Math.floor(m.speed * WIND_SPEEDS))
    const b = Math.max(1, Math.min(WIND_LENGTHS, Math.round(m.length / WIND_LENGTH_STEP)))
    return { at: m.at, picture: sl * WIND_LENGTHS + b - 1, angle: m.angle }
  })
}

// The currents: broad arrows, a shaft that widens from its tail and a head
// wider than the shaft, the width by the speed. A piece of a gyre keeps its
// full width at the tail: the pieces meet head to tail round the circuit.
// Filled by class — warm, cold, neutral, the screen decides — with a pale
// outline.
const CURRENT_CLASSES = 3
const CURRENT_SPEEDS = 3
const CURRENT_LENGTH_STEP = 8
export const CURRENT_LENGTH = 64
export const CURRENT_GAP = 26
const CURRENT_LENGTHS = CURRENT_LENGTH / CURRENT_LENGTH_STEP
const CURRENT_HALF_WIDTH = 4.5
const CURRENT_FILLS = ['rgba(205, 65, 50, 0.7)', 'rgba(40, 95, 185, 0.7)', 'rgba(120, 130, 140, 0.55)']
const CURRENT_OUTLINE = 'rgba(255, 255, 255, 0.55)'

const currentIndex = (cls: number, speed: number, loop: boolean, lengthBucket: number): number =>
  ((cls * CURRENT_SPEEDS + speed) * 2 + (loop ? 1 : 0)) * CURRENT_LENGTHS + lengthBucket - 1

export function currentPictures(chart: ChartSize): SymbolPicture[] {
  const pictures: SymbolPicture[] = []
  for (let cls = 0; cls < CURRENT_CLASSES; cls++) {
    for (let sb = 0; sb < CURRENT_SPEEDS; sb++) {
      const speed = 0.35 + 0.65 * ((sb + 1) / CURRENT_SPEEDS)
      for (const loop of [false, true]) {
        for (let b = 1; b <= CURRENT_LENGTHS; b++) {
          const length = b * CURRENT_LENGTH_STEP
          const head = Math.min(CURRENT_HALF_WIDTH * 2.6, 0.8 * length)
          const width = (t: number): number => CURRENT_HALF_WIDTH * (loop ? 1 : 0.35 + 0.65 * t) * speed
          const headHalf = width(1) * 2.1
          pictures[currentIndex(cls, sb, loop, b)] = picture(length + 2, 2 * headHalf + 2, chart.metresPerTexel, CURRENT_RESOLUTION, (c) => {
            const tail = -length / 2
            const base = length / 2 - head
            const steps = 8
            c.beginPath()
            // The shaft: its upper edge forward, its lower edge back.
            for (let i = 0; i <= steps; i++) c.lineTo(tail + (i / steps) * (base - tail), -width(i / steps))
            for (let i = steps; i >= 0; i--) c.lineTo(tail + (i / steps) * (base - tail), width(i / steps))
            c.closePath()
            // The head: a triangle wider than the shaft.
            c.moveTo(base, -headHalf)
            c.lineTo(length / 2, 0)
            c.lineTo(base, headHalf)
            c.closePath()
            c.fillStyle = CURRENT_FILLS[cls]
            c.fill('nonzero')
            c.lineJoin = 'round'
            c.lineWidth = 1
            c.strokeStyle = CURRENT_OUTLINE
            c.stroke()
          })
        }
      }
    }
  }
  return pictures
}

// `classify`: a mark's class, 0 warm, 1 cold, 2 neutral.
export function currentSymbols(marks: VectorMark[], classify: (mark: VectorMark) => number): WorldSymbol[] {
  return marks.map((m) => {
    const sb = Math.min(CURRENT_SPEEDS - 1, Math.floor(m.speed * CURRENT_SPEEDS))
    const b = Math.max(1, Math.min(CURRENT_LENGTHS, Math.round(m.length / CURRENT_LENGTH_STEP)))
    return { at: m.at, picture: currentIndex(classify(m), sb, m.loop, b), angle: m.angle }
  })
}

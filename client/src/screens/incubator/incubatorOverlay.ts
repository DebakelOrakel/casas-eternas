import { drawArrows, type PeopleArrow } from './peopleArrows'
import type { PeopleResult } from './peopleWorker'

// THE INCUBATOR'S OVERLAY (2026-10-25): what the steps draw over the chart
// — the plants', the trees' and the animals' ranges, the people's spread,
// the catchments — on a raster of its own, RGBA with its alpha, laid over
// the map by the views (map/overlayMaterialPlugin.ts). Painting it touches
// neither the chart nor its textures, so a frame of an animation costs the
// overlay alone. It is half the chart's size (OVERLAY_DIVISOR): a world
// cell is some 2 × 2 of its texels.

export const OVERLAY_DIVISOR = 2

export interface OverlayRaster {
  data: Uint8ClampedArray
  width: number
  height: number
}

export function clearOverlay(o: OverlayRaster): void {
  o.data.fill(0)
}

// A colour onto a texel, over what is there (the "over" of two alphas).
function put(o: OverlayRaster, i: number, r: number, g: number, b: number, a: number): void {
  const d = o.data
  const under = d[i + 3] / 255
  const out = a + under * (1 - a)
  if (out <= 0) return
  d[i] = (r * a + d[i] * under * (1 - a)) / out
  d[i + 1] = (g * a + d[i + 1] * under * (1 - a)) / out
  d[i + 2] = (b * a + d[i + 2] * under * (1 - a)) / out
  d[i + 3] = out * 255
}

// A colour for each layer of a group, told apart (Trubetskoy's twenty
// distinct colours, 2017): a group holds at most sixteen.
export const PLANT_PALETTE: readonly (readonly [number, number, number])[] = [
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [67, 99, 216], [245, 130, 49], [145, 30, 180], [70, 240, 240], [240, 50, 230],
  [188, 246, 12], [0, 128, 128], [154, 99, 36], [128, 0, 0], [128, 128, 0], [0, 0, 117], [250, 190, 190], [170, 255, 195],
  [230, 190, 255], [255, 216, 177], [255, 250, 200], [128, 128, 128],
]

// A layer's code from which its niche suits a cell (niche.ts: SUITABLE
// 0.3, the niche coded 2 … 255).
export const PLANT_SUITS = 2 + Math.round(253 * 0.3)

// A cell holds at most this many of a group in its stripes, the ones that
// suit it best; and a stripe is this many overlay texels wide, across the
// diagonal (a trial, 2026-10-25).
const STRIPES_MAX = 3
const STRIPE_TEXELS = 3

// A group of layers (the plants of a use, the trees of a wood, the
// animals) on the world raster (`width` × `height`), onto the overlay: per
// cell the ones that live there in diagonal stripes, each in its colour,
// as strong as its code there; grey where one would suit but none came.
// The stripes go in the layers' order, not by their codes, so they run on
// across the cells. `from`: the code from which a layer is drawn (a
// plant's niche from PLANT_SUITS, an animal's numbers from 2).
export function paintGroup(o: OverlayRaster, layers: readonly { codes: Uint8Array; colour: number }[], width: number, height: number, from = PLANT_SUITS): void {
  const n = width * height
  // Per cell its layers (by index, ascending) and how many; an empty
  // niche marks grey.
  const pick = new Uint8Array(n * STRIPES_MAX)
  const count = new Uint8Array(n)
  const empty = new Uint8Array(n)
  const best: number[] = []
  for (let i = 0; i < n; i++) {
    best.length = 0
    for (let k = 0; k < layers.length; k++) {
      const c = layers[k].codes[i]
      if (c >= from) best.push(k)
      else if (c === 1) empty[i] = 1
    }
    if (best.length > STRIPES_MAX) {
      best.sort((p, q) => layers[q].codes[i] - layers[p].codes[i])
      best.length = STRIPES_MAX
    }
    best.sort((p, q) => p - q)
    count[i] = best.length
    for (let j = 0; j < best.length; j++) pick[i * STRIPES_MAX + j] = best[j]
  }
  for (let y = 0; y < o.height; y++) {
    const row = Math.min(height - 1, Math.floor((y * height) / o.height)) * width
    for (let x = 0; x < o.width; x++) {
      const cell = row + Math.min(width - 1, Math.floor((x * width) / o.width))
      const m = count[cell]
      const i = 4 * (y * o.width + x)
      if (m > 0) {
        const k = pick[cell * STRIPES_MAX + (Math.floor((x + y) / STRIPE_TEXELS) % m)]
        const [r, g, b] = PLANT_PALETTE[layers[k].colour % PLANT_PALETTE.length]
        put(o, i, r, g, b, 0.35 + 0.55 * ((layers[k].codes[cell] - from) / (255 - from)))
      } else if (empty[cell]) put(o, i, 120, 120, 120, 0.45)
    }
  }
}

// An RGBA raster of the overlay's size (the catchments, regionWorker.ts)
// onto it.
export function paintRaster(o: OverlayRaster, rgba: Uint8ClampedArray): void {
  for (let i = 0; i < o.data.length; i += 4) if (rgba[i + 3] > 0) put(o, i, rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3] / 255)
}

// The people's colours: the land by when it was settled, years before the
// game, dark the first, light the last (a ramp); the arrows. The first try
// drew the front bright and the land behind it in one colour.
export const PEOPLE_AGE_STOPS: readonly { value: number; rgb: [number, number, number] }[] = [
  { value: 5_000, rgb: [250, 225, 120] },
  { value: 25_000, rgb: [240, 150, 55] },
  { value: 45_000, rgb: [200, 75, 40] },
  { value: 70_000, rgb: [110, 25, 35] },
]
export const PEOPLE_ROUTE: readonly [number, number, number] = [90, 40, 25]
// The years before the game the people set out (SPAN_YEARS later, they
// stand 5 000 years before it).
export const PEOPLE_AGO_AT_START = 70_000

function ageColour(ago: number): [number, number, number] {
  const stops = PEOPLE_AGE_STOPS
  if (ago <= stops[0].value) return stops[0].rgb
  for (let k = 1; k < stops.length; k++) {
    if (ago <= stops[k].value) {
      const f = (ago - stops[k - 1].value) / (stops[k].value - stops[k - 1].value)
      const a = stops[k - 1].rgb
      const b = stops[k].rgb
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
    }
  }
  return stops[stops.length - 1].rgb
}

// The origin's mark, overlay texels: a red dot in a dark ring, crosshairs
// out to ORIGIN_TICK, each on a white rim, so it stands out on any ground
// (the first, a small dark ring, was easy to miss).
const ORIGIN_RING = 23
const ORIGIN_RING_WIDTH = 5
const ORIGIN_DOT = 9
const ORIGIN_TICK = 45
const ORIGIN_TICK_WIDTH = 4
const ORIGIN_RIM = 2

// The people at `t` years after their departure, on the world raster
// (`width` × `height`), onto the overlay: the land they reached by then,
// by when they came; the arrows of the way they took; where they set out.
export function paintPeople(o: OverlayRaster, people: PeopleResult, arrows: readonly PeopleArrow[], t: number, spread: boolean, routes: boolean, width: number, height: number): void {
  if (spread) {
    for (let y = 0; y < o.height; y++) {
      const row = Math.min(height - 1, Math.floor((y * height) / o.height)) * width
      for (let x = 0; x < o.width; x++) {
        const cell = row + Math.min(width - 1, Math.floor((x * width) / o.width))
        const at = people.arrival[cell]
        if (!(at <= t) || !people.land[cell]) continue
        const [r, g, b] = ageColour(PEOPLE_AGO_AT_START - at)
        put(o, 4 * (y * o.width + x), r, g, b, 0.7)
      }
    }
  }
  if (routes) {
    const [r, g, b] = PEOPLE_ROUTE
    drawArrows((x, y) => put(o, 4 * (y * o.width + x), r, g, b, 0.85), arrows, t, o.width, o.height)
  }
  if (people.origin < 0) return
  const ox = ((people.origin % width) + 0.5) * (o.width / width)
  const oy = (Math.floor(people.origin / width) + 0.5) * (o.height / height)
  const half = ORIGIN_RING_WIDTH / 2
  const tick = ORIGIN_TICK_WIDTH / 2
  // What a texel of the mark is: 0 none, 1 rim, 2 dark, 3 the dot.
  const markAt = (dx: number, dy: number): number => {
    const d = Math.hypot(dx, dy)
    if (d <= ORIGIN_DOT) return 3
    if (Math.abs(d - ORIGIN_RING) <= half) return 2
    if (d > ORIGIN_RING + half && d <= ORIGIN_TICK && (Math.abs(dx) <= tick || Math.abs(dy) <= tick)) return 2
    if (d <= ORIGIN_DOT + ORIGIN_RIM || Math.abs(d - ORIGIN_RING) <= half + ORIGIN_RIM) return 1
    if (d > ORIGIN_RING && d <= ORIGIN_TICK + ORIGIN_RIM && (Math.abs(dx) <= tick + ORIGIN_RIM || Math.abs(dy) <= tick + ORIGIN_RIM)) return 1
    return 0
  }
  const reach = ORIGIN_TICK + ORIGIN_RIM
  for (let dy = -reach; dy <= reach; dy++) {
    const y = Math.round(oy + dy)
    if (y < 0 || y >= o.height) continue
    for (let dx = -reach; dx <= reach; dx++) {
      const m = markAt(dx, dy)
      if (m === 0) continue
      const i = 4 * (y * o.width + (((Math.round(ox + dx) % o.width) + o.width) % o.width))
      if (m === 3) put(o, i, 220, 30, 30, 1)
      else if (m === 2) put(o, i, 25, 25, 25, 1)
      else put(o, i, 255, 255, 255, 1)
    }
  }
}

import { drawArrows, type PeopleArrow } from './peopleArrows'
import type { PeopleResult } from './people'
import { PLANT_SUITS_CODE } from './settleShared'

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
  // The habitat's cell each texel shows (cells.ts), and the cells' centres
  // on the chart as fractions.
  owners: Int32Array
  count: number
  u: Float32Array
  v: Float32Array
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
export const PLANT_SUITS = PLANT_SUITS_CODE

// A cell holds at most this many of a group in its stripes, the ones that
// suit it best; and a stripe is this many overlay texels wide, across the
// diagonal (a trial, 2026-10-25).
const STRIPES_MAX = 3
const STRIPE_TEXELS = 3

// A group of layers (the plants of a use, the trees of a wood, the
// animals) on the habitat's cells, onto the overlay: per
// cell the ones that live there in diagonal stripes, each in its colour,
// as strong as its code there; grey where one would suit but none came.
// The stripes go in the layers' order, not by their codes, so they run on
// across the cells. `from`: the code from which a layer is drawn (a
// plant's niche from PLANT_SUITS, an animal's numbers from 2).
export function paintGroup(o: OverlayRaster, layers: readonly { codes: Uint8Array; colour: number }[], from = PLANT_SUITS): void {
  const n = o.count
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
    for (let x = 0; x < o.width; x++) {
      const t = y * o.width + x
      const cell = o.owners[t]
      const m = count[cell]
      const i = 4 * t
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
// The spread's colour by the year people came (years after the departure):
// the earliest dark, the latest light.
export const PEOPLE_AGE_STOPS: readonly { value: number; rgb: [number, number, number] }[] = [
  { value: 0, rgb: [110, 25, 35] },
  { value: 25_000, rgb: [200, 75, 40] },
  { value: 45_000, rgb: [240, 150, 55] },
  { value: 65_000, rgb: [250, 225, 120] },
]
export const PEOPLE_ROUTE: readonly [number, number, number] = [90, 40, 25]

function ageColour(year: number): [number, number, number] {
  const stops = PEOPLE_AGE_STOPS
  if (year <= stops[0].value) return stops[0].rgb
  for (let k = 1; k < stops.length; k++) {
    if (year <= stops[k].value) {
      const f = (year - stops[k - 1].value) / (stops[k].value - stops[k - 1].value)
      const a = stops[k - 1].rgb
      const b = stops[k].rgb
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
    }
  }
  return stops[stops.length - 1].rgb
}

// The people at `t` years after their departure, on the world raster
// cells, onto the overlay: the land they reached by then,
// by when they came; the arrows of the way they took. Where they set out
// is a mark (incubatorSymbols.ts).
export function paintPeople(o: OverlayRaster, people: PeopleResult, arrows: readonly PeopleArrow[], t: number, spread: boolean, routes: boolean): void {
  if (spread) {
    for (let k = 0; k < o.owners.length; k++) {
      const cell = o.owners[k]
      const at = people.arrival[cell]
      if (!(at <= t) || !people.land[cell]) continue
      const [r, g, b] = ageColour(at)
      put(o, 4 * k, r, g, b, 0.7)
    }
  }
  if (routes) {
    const [r, g, b] = PEOPLE_ROUTE
    drawArrows((x, y) => put(o, 4 * (y * o.width + x), r, g, b, 0.85), arrows, t, o.width, o.height)
  }

}

// THE SETTLEMENT (settle.ts, a proof of concept): the lifeways, the
// density, the villages and the trade, onto the overlay.
export const LIFEWAY_COLOURS: Record<number, readonly [number, number, number]> = {
  1: [150, 140, 110],
  2: [40, 120, 190],
  3: [215, 160, 40],
  4: [60, 150, 60],
}
export const DENSITY_STOPS: readonly { value: number; rgb: [number, number, number] }[] = [
  { value: 0.01, rgb: [245, 240, 220] },
  { value: 0.3, rgb: [240, 180, 90] },
  { value: 3, rgb: [210, 90, 50] },
  { value: 30, rgb: [110, 20, 40] },
]
export const GOOD_COLOURS: readonly (readonly [number, number, number])[] = [[60, 60, 60], [240, 240, 240], [200, 110, 40]]
export const TRADE_COLOUR: readonly [number, number, number] = [120, 40, 140]


// The lifeways' shares (settleShared.ts sharesAt), as diagonal stripes, each
// lifeway's as wide as its share of LIFEWAY_PERIOD texels; a share under
// LIFEWAY_LEAST left out. `shares`: 4 a cell, the lifeways 1 … 4, 0 … 255.
const LIFEWAY_PERIOD = 12
const LIFEWAY_LEAST = 0.1 * 255
export function paintLifeways(o: OverlayRaster, shares: Uint8Array): void {
  for (let y = 0; y < o.height; y++) {
    for (let x = 0; x < o.width; x++) {
      const t = y * o.width + x
      const at = 4 * o.owners[t]
      let sum = 0
      for (let w = 0; w < 4; w++) if (shares[at + w] >= LIFEWAY_LEAST) sum += shares[at + w]
      if (sum === 0) continue
      let phase = (((x + y) % LIFEWAY_PERIOD) + 0.5) / LIFEWAY_PERIOD * sum
      let way = 0
      for (let w = 0; w < 4 && phase >= 0; w++) {
        if (shares[at + w] < LIFEWAY_LEAST) continue
        phase -= shares[at + w]
        way = w
      }
      const c = LIFEWAY_COLOURS[way + 1]
      put(o, 4 * t, c[0], c[1], c[2], 0.6)
    }
  }
}

// The density on a logarithmic ramp (DENSITY_STOPS).
export function paintDensity(o: OverlayRaster, density: Float32Array): void {
  const logs = DENSITY_STOPS.map((s) => Math.log10(s.value))
  for (let t = 0; t < o.owners.length; t++) {
    {
      const d = density[o.owners[t]]
      if (!(d > 0)) continue
      const l = Math.log10(d)
      let k = 1
      while (k < logs.length - 1 && l > logs[k]) k++
      const f = Math.min(1, Math.max(0, (l - logs[k - 1]) / (logs[k] - logs[k - 1])))
      const a = DENSITY_STOPS[k - 1].rgb
      const b = DENSITY_STOPS[k].rgb
      put(o, 4 * t, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 0.7)
    }
  }
}

const centre = (cell: number, o: OverlayRaster): [number, number] => [o.u[cell] * o.width, o.v[cell] * o.height]

// The trade: the links that carry goods, wider the more. The sources are
// marks (incubatorSymbols.ts).
export function paintTrade(o: OverlayRaster, villages: Int32Array, links: Float32Array): void {
  const [cr, cg, cb] = TRADE_COLOUR
  for (let k = 0; k < links.length; k += 3) {
    const w = links[k + 2]
    if (w < 0.05) continue
    const half = Math.min(3, 0.6 + Math.sqrt(w)) / 2
    const [ax, ay] = centre(villages[2 * links[k]], o)
    let [bx, by] = centre(villages[2 * links[k + 1]], o)
    if (bx - ax > o.width / 2) bx -= o.width
    else if (ax - bx > o.width / 2) bx += o.width
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay))
    for (let s = 0; s <= steps; s++) {
      const px = ax + ((bx - ax) * s) / Math.max(1, steps)
      const py = ay + ((by - ay) * s) / Math.max(1, steps)
      for (let dy = Math.floor(py - half); dy <= Math.ceil(py + half); dy++) {
        if (dy < 0 || dy >= o.height) continue
        for (let dx = Math.floor(px - half); dx <= Math.ceil(px + half); dx++) put(o, 4 * (dy * o.width + (((dx % o.width) + o.width) % o.width)), cr, cg, cb, 0.8)
      }
    }
  }

}


import type { WashTarget } from '../../map/climateLayers'
import type { PeopleResult } from './cellsShared'
import { LANGUAGE_LEVEL, type LanguagesTree } from './historyPack'
import { PLANT_SUITS_CODE } from './settleShared'

// THE INCUBATOR'S OVERLAY (2026-10-25): what the steps draw over the chart
// — the plants', the trees' and the animals' ranges, the people's spread —
// on a raster of its own, RGBA with its alpha, laid over
// the map by the views (map/overlayMaterialPlugin.ts). Painting it touches
// neither the chart nor its textures, so a frame of an animation costs the
// overlay alone. It is half the chart's size (OVERLAY_DIVISOR): a world
// cell is some 2 × 2 of its texels.

export { OVERLAY_DIVISOR } from './historyInput'

export interface OverlayRaster {
  data: Uint8ClampedArray
  width: number
  height: number
  // The habitat's cell each texel shows (casas-incubator/habitat.rs), and the
  // cells' centres on the chart as fractions.
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

// A layer's code from which its niche suits a cell (casas-incubator/niche.rs:
// SUITABLE 0.3, the niche coded 2 … 255).
export const PLANT_SUITS = PLANT_SUITS_CODE

// A cell holds at most this many of a group in its stripes, the ones that
// suit it best; and a stripe is this many overlay texels wide, across the
// diagonal (a trial, 2026-10-25).
const STRIPES_MAX = 3
const STRIPE_TEXELS = 3
// What people keep (a crop sown, a herd kept; casas-incubator/simulation.rs,
// the domesticates) is hatched across the stripes, a line every HATCH_TEXELS
// texels, its colour HATCH_SHADE as bright; outside its niche it counts as
// KEPT_CODE.
const HATCH_TEXELS = 4
const HATCH_SHADE = 0.45
const KEPT_CODE = 200

// A group of layers (the plants of a use, the trees of a wood, the
// animals) on the habitat's cells, onto the overlay: per
// cell the ones that live there in diagonal stripes, each in its colour,
// as strong as its code there; grey where one would suit but none came.
// The stripes go in the layers' order, not by their codes, so they run on
// across the cells. `from`: the code from which a layer is drawn (a
// plant's niche from PLANT_SUITS, an animal's numbers from 2).
export function paintGroup(o: OverlayRaster, layers: readonly { codes: Uint8Array; colour: number; kept?: Uint8Array | null }[], from = PLANT_SUITS): void {
  const n = o.count
  // A layer's weight in a cell: its code where it suits, KEPT_CODE where
  // people keep it outside that (a crop sown, a herd kept), 0 elsewhere.
  const weight = (k: number, i: number): number => {
    const c = layers[k].codes[i]
    const kept = layers[k].kept?.[i] ? KEPT_CODE : 0
    return Math.max(c >= from ? c : 0, kept)
  }
  // Per cell its layers (by index, ascending) and how many; an empty
  // niche marks grey.
  const pick = new Uint8Array(n * STRIPES_MAX)
  const count = new Uint8Array(n)
  const empty = new Uint8Array(n)
  const best: number[] = []
  for (let i = 0; i < n; i++) {
    best.length = 0
    for (let k = 0; k < layers.length; k++) {
      if (weight(k, i) > 0) best.push(k)
      else if (layers[k].codes[i] === 1) empty[i] = 1
    }
    if (best.length > STRIPES_MAX) {
      best.sort((p, q) => weight(q, i) - weight(p, i))
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
        // Kept by people: hatched across the stripes, darker.
        if (layers[k].kept?.[cell] && (((x - y) % HATCH_TEXELS) + HATCH_TEXELS) % HATCH_TEXELS === 0) put(o, i, r * HATCH_SHADE, g * HATCH_SHADE, b * HATCH_SHADE, 0.95)
        else put(o, i, r, g, b, 0.35 + 0.55 * ((weight(k, cell) - from) / (255 - from)))
      } else if (empty[cell]) put(o, i, 120, 120, 120, 0.45)
    }
  }
}

// The people's colours: the land by when it was settled, years before the
// game, dark the first, light the last (a ramp); the arrows. The first try
// drew the front bright and the land behind it in one colour.
// The spread's colour by the year people came (years after the departure):
// the earliest dark, the latest light.
export const PEOPLE_AGE_STOPS: readonly { value: number; rgb: [number, number, number] }[] = [
  { value: 0, rgb: [110, 25, 35] },
  { value: 40_000, rgb: [200, 75, 40] },
  { value: 70_000, rgb: [240, 150, 55] },
  { value: 100_000, rgb: [250, 225, 120] },
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

// The people at `t` years after their departure, on the habitat's cells,
// onto the overlay: the land they reached by then, by when they came.
// Where they set out, the ways they took (the routes, the crossings) are
// marks (incubatorSymbols.ts).
// `living`: the people a km² at the time (a history's kept state), or null:
// with it a cell people have left (the ice, the sea over the shelf) is not
// drawn.
export function paintPeople(o: OverlayRaster, people: PeopleResult, t: number, living: Float32Array | null = null): void {
  for (let k = 0; k < o.owners.length; k++) {
    const cell = o.owners[k]
    const at = people.arrival[cell]
    if (!(at <= t) || !people.land[cell] || (living && !(living[cell] > 0))) continue
    const [r, g, b] = ageColour(at)
    put(o, 4 * k, r, g, b, 0.7)
  }
}

// The old stone age's groups (casas-incubator peopling.rs) at `t`: the land
// reached by then in its group's colour, the plants' palette over again.
export function paintGroups(o: OverlayRaster, people: PeopleResult, group: Int32Array, t: number): void {
  for (let k = 0; k < o.owners.length; k++) {
    const cell = o.owners[k]
    if (!(people.arrival[cell] <= t) || !people.land[cell] || group[cell] < 0) continue
    const [r, g, b] = PLANT_PALETTE[group[cell] % PLANT_PALETTE.length]
    put(o, 4 * k, r, g, b, 0.7)
  }
}

// THE PEOPLES (2026-10-29; casas-incubator peoples.rs, historyPack.ts
// PeoplesTree): a colour per people id, 3 bytes each. Related peoples have
// alike colours: the hue from step 1's group the people came from (its
// parent's, so a people's descent keeps it), the golden angle apart from
// group to group; each people's own a step of hue (±PEOPLE_HUE_STEP), a
// saturation and a lightness, from its id (the golden ratio's and the
// plastic number's fractions, spread and repeatable), so the neighbours of
// one group are told apart. A people of no group takes a hue of its id.
const PEOPLE_HUE_STEP = 15
export function peopleColours(group: Int32Array): Uint8Array {
  const out = new Uint8Array(3 * group.length)
  for (let id = 0; id < group.length; id++) {
    const a = (id * 0.618034) % 1
    const b = (id * 0.754878) % 1
    const base = group[id] >= 0 ? group[id] * 137.508 : id * 137.508
    const hue = (((base + (2 * a - 1) * PEOPLE_HUE_STEP) % 360) + 360) % 360
    out.set(hsl(hue, 0.45 + 0.45 * b, 0.34 + 0.32 * a), 3 * id)
  }
  return out
}

// HSL (hue in degrees, the rest 0 … 1) as RGB, 0 … 255.
function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [Math.round(255 * (r + m)), Math.round(255 * (g + m)), Math.round(255 * (b + m))]
}

// The peoples of a kept state (`ids`, each cell's; `none` where it has no
// people) onto the overlay, each in its colour (`peopleColours`).
export function paintPeoples(o: OverlayRaster, ids: Uint16Array, colours: Uint8Array, none: number): void {
  for (let k = 0; k < o.owners.length; k++) {
    const id = ids[o.owners[k]]
    if (id === none || 3 * id >= colours.length) continue
    put(o, 4 * k, colours[3 * id], colours[3 * id + 1], colours[3 * id + 2], 0.75)
  }
}

// THE LANGUAGES (2026-10-31, TEG-148; historyPack.ts LanguagesTree): a
// colour per tree node, 3 bytes each. A family has a hue of its own, the
// golden angle apart from family to family in the tree's order; its
// proto-language and its languages are shades of it, the lightness
// stepping through LANGUAGE_LIGHTNESS by the language's index in its
// family (the proto-language first), over again past its end; a dialect
// takes its language's colour (the borders tell the dialects apart).
const LANGUAGE_LIGHTNESS = [0.45, 0.32, 0.58, 0.26, 0.65, 0.38, 0.52]
const LANGUAGE_SATURATION = 0.6
export function languageColours(tree: LanguagesTree): Uint8Array {
  const count = tree.parent.length
  const out = new Uint8Array(3 * count)
  const hue = new Float32Array(count)
  const index = new Int32Array(count)
  let families = 0
  for (let k = 0; k < count; k++) {
    if (tree.level[k] === LANGUAGE_LEVEL.family) {
      hue[k] = (families++ * 137.508) % 360
      index[k] = 1
      out.set(hsl(hue[k], LANGUAGE_SATURATION, LANGUAGE_LIGHTNESS[0]), 3 * k)
    } else if (tree.level[k] === LANGUAGE_LEVEL.language) {
      let family = k
      while (tree.parent[family] >= 0) family = tree.parent[family]
      hue[k] = hue[family]
      out.set(hsl(hue[k], LANGUAGE_SATURATION, LANGUAGE_LIGHTNESS[index[family]++ % LANGUAGE_LIGHTNESS.length]), 3 * k)
    } else {
      out.copyWithin(3 * k, 3 * tree.parent[k], 3 * tree.parent[k] + 3)
    }
  }
  return out
}

// The languages of a kept state onto the overlay: each cell of a people
// (`ids`, `none` where none) in the colour of the tree node it speaks
// (`spoken`, by people id: languageView.ts spokenNode; -1 for none). A
// texel whose right or lower neighbour is a cell of another node is
// darkened: the thin lines between the dialects. `chosen`, by tree node,
// 1 where the node is the one chosen in the languages window or below it
// (languageView.ts speakersOf): those stand out, the rest fade; null for
// no choice.
const LANGUAGE_ALPHA = 0.75
const LANGUAGE_CHOSEN_ALPHA = 0.85
const LANGUAGE_FADED_ALPHA = 0.2
const LANGUAGE_BORDER = 0.55
export function paintLanguages(o: OverlayRaster, ids: Uint16Array, none: number, spoken: Int32Array, colours: Uint8Array, chosen: Uint8Array | null): void {
  const nodeOf = (t: number): number => {
    const id = ids[o.owners[t]]
    return id === none || id >= spoken.length ? -1 : spoken[id]
  }
  const { width, height } = o
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = y * width + x
      const k = nodeOf(t)
      if (k < 0 || 3 * k >= colours.length) continue
      // The world wraps: the last column's right is the first.
      const right = nodeOf(y * width + ((x + 1) % width))
      const below = nodeOf(((y + 1) % height) * width + x)
      const edge = (right >= 0 && right !== k) || (below >= 0 && below !== k) ? LANGUAGE_BORDER : 1
      const alpha = chosen === null ? LANGUAGE_ALPHA : chosen[k] ? LANGUAGE_CHOSEN_ALPHA : LANGUAGE_FADED_ALPHA
      put(o, 4 * t, colours[3 * k] * edge, colours[3 * k + 1] * edge, colours[3 * k + 2] * edge, alpha)
    }
  }
}

// THE SETTLEMENT (casas-incubator/settle.rs, a proof of concept): the
// lifeways and the density, onto the overlay; the villages, the trade and the
// sources are marks (incubatorSymbols.ts).
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

// The overlay as a wash's target (map/climateLayers.ts).
export const washTarget = (o: OverlayRaster): WashTarget => ({ width: o.width, height: o.height, blend: (t, rgb, a) => put(o, 4 * t, rgb[0], rgb[1], rgb[2], a) })

// A colour onto an overlay texel, over what is there.
export const putTexel = (o: OverlayRaster, t: number, rgb: readonly [number, number, number], a: number): void => put(o, 4 * t, rgb[0], rgb[1], rgb[2], a)

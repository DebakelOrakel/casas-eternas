import type { EcologyFieldId } from './ecologyField'

type Rgb = [number, number, number]

export interface EcologyFieldMeta {
  // Carrying capacity is shown on an ABSOLUTE scale (its gain knob must be
  // visible as the whole map dimming/greening). Per-resource fields are relative
  // abundance maps → normalised to their own land-max at paint time.
  absolute: boolean
  // Deposit-style fields (metals, gems): fade to fully transparent as the value
  // approaches 0, so barren land shows terrain instead of the ramp's pale end.
  // Broad gradient fields (arable, game, …) keep painting 0 — "nothing here" is
  // the information there.
  fadeZero?: boolean
  // Colour ramp on a 0..1 input (fraction); clamped past the ends.
  stops: { c: number; rgb: Rgb }[]
}

// The registry the overlay paint, legend and tooltip read; the selector's
// order and labels come from the catalog (ecologyInputParams' groups).
export const ECOLOGY_FIELD_META: Record<EcologyFieldId, EcologyFieldMeta> = {
  carryingCapacity: {
    absolute: true,
    stops: [
      { c: 0.0, rgb: [222, 210, 180] }, { c: 0.25, rgb: [206, 200, 128] },
      { c: 0.5, rgb: [150, 190, 96] }, { c: 0.75, rgb: [74, 158, 78] }, { c: 1.0, rgb: [22, 104, 58] },
    ],
  },
  arable: {
    absolute: false,
    stops: [
      { c: 0.0, rgb: [214, 196, 158] }, { c: 0.5, rgb: [176, 190, 96] }, { c: 1.0, rgb: [70, 150, 60] },
    ],
  },
  fish: {
    absolute: false,
    stops: [
      { c: 0.0, rgb: [206, 224, 226] }, { c: 0.5, rgb: [96, 174, 200] }, { c: 1.0, rgb: [30, 96, 168] },
    ],
  },
  game: {
    absolute: false,
    stops: [
      { c: 0.0, rgb: [206, 200, 176] }, { c: 0.5, rgb: [150, 168, 100] }, { c: 1.0, rgb: [58, 118, 66] },
    ],
  },
  pasture: {
    absolute: false,
    stops: [
      { c: 0.0, rgb: [228, 216, 150] }, { c: 0.5, rgb: [206, 198, 96] }, { c: 1.0, rgb: [150, 180, 78] },
    ],
  },
  timber: {
    absolute: false,
    stops: [{ c: 0.0, rgb: [214, 206, 180] }, { c: 0.5, rgb: [140, 138, 82] }, { c: 1.0, rgb: [72, 92, 40] }],
  },
  salt: {
    absolute: false,
    stops: [{ c: 0.0, rgb: [236, 232, 238] }, { c: 0.5, rgb: [186, 150, 202] }, { c: 1.0, rgb: [120, 72, 150] }],
  },
  toolStone: {
    absolute: false,
    stops: [{ c: 0.0, rgb: [214, 214, 218] }, { c: 0.5, rgb: [126, 126, 134] }, { c: 1.0, rgb: [52, 52, 60] }],
  },
  copper: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [232, 214, 194] }, { c: 0.5, rgb: [210, 140, 80] }, { c: 1.0, rgb: [176, 84, 40] }],
  },
  tin: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [226, 228, 232] }, { c: 0.5, rgb: [168, 178, 190] }, { c: 1.0, rgb: [104, 116, 134] }],
  },
  iron: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [230, 212, 202] }, { c: 0.5, rgb: [200, 118, 88] }, { c: 1.0, rgb: [148, 54, 38] }],
  },
  gold: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [240, 232, 198] }, { c: 0.5, rgb: [228, 196, 84] }, { c: 1.0, rgb: [198, 150, 24] }],
  },
  silver: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [240, 242, 245] }, { c: 0.5, rgb: [198, 204, 212] }, { c: 1.0, rgb: [150, 160, 176] }],
  },
  gems: {
    absolute: false, fadeZero: true,
    stops: [{ c: 0.0, rgb: [240, 222, 236] }, { c: 0.5, rgb: [214, 108, 170] }, { c: 1.0, rgb: [166, 38, 112] }],
  },
}

function rampColor(stops: { c: number; rgb: Rgb }[], value: number): Rgb {
  if (value <= stops[0].c) return stops[0].rgb
  if (value >= stops[stops.length - 1].c) return stops[stops.length - 1].rgb
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i].c) {
      const a = stops[i - 1]
      const b = stops[i]
      const t = (value - a.c) / (b.c - a.c)
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
      ]
    }
  }
  return stops[stops.length - 1].rgb
}

// Colour for a field at `fraction` (0..1: absolute value for carrying capacity,
// value/land-max for the relative resource fields).
export function ecologyFieldColor(id: EcologyFieldId, fraction: number): Rgb {
  return rampColor(ECOLOGY_FIELD_META[id].stops, fraction)
}

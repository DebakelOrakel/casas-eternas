import type { EcologyFieldId } from './ecologyField'

type Rgb = [number, number, number]

export type EcologyRole = 'aggregate' | 'subsistence' | 'material' | 'prestige'

export interface EcologyFieldMeta {
  label: string
  role: EcologyRole
  // Carrying capacity is shown on an ABSOLUTE scale (its gain knob must be
  // visible as the whole map dimming/greening). Per-resource fields are relative
  // abundance maps → normalised to their own land-max at paint time.
  absolute: boolean
  // Colour ramp on a 0..1 input (fraction); clamped past the ends.
  stops: { c: number; rgb: Rgb }[]
}

// The registry the selector, overlay paint, legend and tooltip all read. Grows as
// later sub-steps add fields (fish, material, prestige) — order here is the
// selector's display order within each role group.
export const ECOLOGY_FIELD_META: Record<EcologyFieldId, EcologyFieldMeta> = {
  carryingCapacity: {
    label: 'Carrying capacity', role: 'aggregate', absolute: true,
    stops: [
      { c: 0.0, rgb: [222, 210, 180] }, { c: 0.25, rgb: [206, 200, 128] },
      { c: 0.5, rgb: [150, 190, 96] }, { c: 0.75, rgb: [74, 158, 78] }, { c: 1.0, rgb: [22, 104, 58] },
    ],
  },
  arable: {
    label: 'Arable land', role: 'subsistence', absolute: false,
    stops: [
      { c: 0.0, rgb: [214, 196, 158] }, { c: 0.5, rgb: [176, 190, 96] }, { c: 1.0, rgb: [70, 150, 60] },
    ],
  },
  game: {
    label: 'Game / forage', role: 'subsistence', absolute: false,
    stops: [
      { c: 0.0, rgb: [206, 200, 176] }, { c: 0.5, rgb: [150, 168, 100] }, { c: 1.0, rgb: [58, 118, 66] },
    ],
  },
  pasture: {
    label: 'Pasture', role: 'subsistence', absolute: false,
    stops: [
      { c: 0.0, rgb: [228, 216, 150] }, { c: 0.5, rgb: [206, 198, 96] }, { c: 1.0, rgb: [150, 180, 78] },
    ],
  },
}

// Selector groups, in display order.
export const ECOLOGY_ROLE_LABELS: Record<EcologyRole, string> = {
  aggregate: 'Aggregate',
  subsistence: 'Subsistence',
  material: 'Material',
  prestige: 'Prestige',
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

// Legend gradient stops (value 0..100) matching a field's ramp, for the overlay
// legend. Both scales read 0..100 (% of the lushest swatch / of land-max).
export function ecologyFieldLegendStops(id: EcologyFieldId): { value: number; rgb: Rgb }[] {
  return ECOLOGY_FIELD_META[id].stops.map((s) => ({ value: s.c * 100, rgb: s.rgb }))
}

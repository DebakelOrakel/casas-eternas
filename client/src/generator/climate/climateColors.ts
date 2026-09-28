type Rgb = [number, number, number]

// Temperature → color ramp (°C), for the temperature overlay: deep blue (cold)
// → cyan → yellow-green (mild) → orange → red (hot). Stops in °C, linearly
// interpolated; clamped past the ends. Reusable (no Babylon) so the game
// screen can show the same legend.
const TEMPERATURE_STOPS: { c: number; rgb: Rgb }[] = [
  { c: -30, rgb: [40, 40, 120] },
  { c: -10, rgb: [60, 120, 210] },
  { c: 0, rgb: [110, 200, 230] },
  { c: 12, rgb: [160, 210, 140] },
  { c: 24, rgb: [235, 200, 90] },
  { c: 32, rgb: [220, 110, 50] },
  { c: 40, rgb: [180, 40, 40] },
]

// Precipitation → color ramp (mm/yr): arid tan → grassland yellow-green →
// green → wet teal/blue. Stops in mm/yr.
const PRECIPITATION_STOPS: { c: number; rgb: Rgb }[] = [
  { c: 0, rgb: [205, 180, 130] },
  { c: 250, rgb: [215, 205, 120] },
  { c: 600, rgb: [150, 190, 90] },
  { c: 1200, rgb: [70, 160, 80] },
  { c: 2000, rgb: [40, 140, 130] },
  { c: 3500, rgb: [40, 90, 180] },
]

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

export function temperatureColor(celsius: number): Rgb {
  return rampColor(TEMPERATURE_STOPS, celsius)
}

export function precipitationColor(mmPerYear: number): Rgb {
  return rampColor(PRECIPITATION_STOPS, mmPerYear)
}

// Seasonal temperature amplitude → color (°C annual range): stable teal → mild
// green → strong orange → extreme purple. Low = maritime/equatorial (even
// climate), high = continental/high-latitude (harsh seasons).
const AMPLITUDE_STOPS: { c: number; rgb: Rgb }[] = [
  { c: 0, rgb: [60, 160, 160] },
  { c: 10, rgb: [120, 190, 120] },
  { c: 22, rgb: [230, 200, 90] },
  { c: 34, rgb: [220, 120, 50] },
  { c: 45, rgb: [140, 50, 130] },
]

export function amplitudeColor(celsiusRange: number): Rgb {
  return rampColor(AMPLITUDE_STOPS, celsiusRange)
}

// Monsoon / precipitation-seasonality index (0..1) → color: pale neutral (even year-
// round) → green → gold → orange → deep magenta (strongly wet-dry / monsoonal).
const MONSOON_STOPS: { c: number; rgb: Rgb }[] = [
  { c: 0.0, rgb: [232, 233, 226] },
  { c: 0.2, rgb: [188, 210, 158] },
  { c: 0.4, rgb: [232, 196, 100] },
  { c: 0.6, rgb: [216, 122, 60] },
  { c: 0.85, rgb: [150, 55, 92] },
]

export function monsoonColor(index: number): Rgb {
  return rampColor(MONSOON_STOPS, index)
}

// Sea-level pressure (hPa) → colour: blue lows, pale at the standard 1013,
// amber highs.
const PRESSURE_STOPS: { c: number; rgb: Rgb }[] = [
  { c: 996, rgb: [50, 90, 190] },
  { c: 1006, rgb: [140, 175, 225] },
  { c: 1013, rgb: [236, 236, 230] },
  { c: 1020, rgb: [235, 200, 130] },
  { c: 1030, rgb: [205, 120, 45] },
]

export function pressureColor(hPa: number): Rgb {
  return rampColor(PRESSURE_STOPS, hPa)
}

// The ramps as {value, rgb} lists, for building the overlay legend gradient bars
// (same stops the paint uses, so the legend matches the map exactly).
export const temperatureLegendStops = TEMPERATURE_STOPS.map((s) => ({ value: s.c, rgb: s.rgb }))
export const precipitationLegendStops = PRECIPITATION_STOPS.map((s) => ({ value: s.c, rgb: s.rgb }))
export const amplitudeLegendStops = AMPLITUDE_STOPS.map((s) => ({ value: s.c, rgb: s.rgb }))
export const monsoonLegendStops = MONSOON_STOPS.map((s) => ({ value: s.c, rgb: s.rgb }))
export const pressureLegendStops = PRESSURE_STOPS.map((s) => ({ value: s.c, rgb: s.rgb }))

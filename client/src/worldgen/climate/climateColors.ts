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

export function temperatureColor(celsius: number): Rgb {
  const stops = TEMPERATURE_STOPS
  if (celsius <= stops[0].c) return stops[0].rgb
  if (celsius >= stops[stops.length - 1].c) return stops[stops.length - 1].rgb
  for (let i = 1; i < stops.length; i++) {
    if (celsius <= stops[i].c) {
      const a = stops[i - 1]
      const b = stops[i]
      const t = (celsius - a.c) / (b.c - a.c)
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
      ]
    }
  }
  return stops[stops.length - 1].rgb
}

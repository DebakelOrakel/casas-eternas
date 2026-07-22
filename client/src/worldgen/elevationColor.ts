type Rgb = [number, number, number]

// Hypsometric-tint style color ramp over the -1..1 (0 = sea level)
// elevation convention: dark deep ocean up through shallow water to a
// coastline band, then lowland green through highland brown to
// snow-capped peaks.
const COLOR_STOPS: { elevation: number; color: Rgb }[] = [
  { elevation: -1.0, color: [8, 28, 76] },
  { elevation: -0.3, color: [36, 88, 158] },
  { elevation: -0.05, color: [98, 160, 210] },
  { elevation: 0.0, color: [222, 208, 158] },
  { elevation: 0.15, color: [92, 150, 68] },
  { elevation: 0.45, color: [122, 108, 66] },
  { elevation: 0.75, color: [128, 118, 108] },
  { elevation: 1.0, color: [250, 250, 250] },
]

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

export function elevationToColor(elevation: number): Rgb {
  const clamped = Math.max(-1, Math.min(1, elevation))
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const from = COLOR_STOPS[i]
    const to = COLOR_STOPS[i + 1]
    if (clamped >= from.elevation && clamped <= to.elevation) {
      const t = (clamped - from.elevation) / (to.elevation - from.elevation)
      return [lerpChannel(from.color[0], to.color[0], t), lerpChannel(from.color[1], to.color[1], t), lerpChannel(from.color[2], to.color[2], t)]
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].color
}

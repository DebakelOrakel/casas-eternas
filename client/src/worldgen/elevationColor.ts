import { metersToElevation } from './elevationScale'

type Rgb = [number, number, number]

// Hypsometric-tint style color ramp: dark deep ocean up through shallow water to
// a coastline band, then lowland green through highland brown to snow-capped
// peaks.
//
// Stops are given in METRES and converted, rather than as bare -1..1 numbers.
// The old stops were spaced for a scale whose land baseline sat at 0.35, so the
// entire land ramp was tuned around terrain that is now ~1.5 km lower; carried
// over unchanged, every continent would have rendered as beach sand. Stating
// them in metres also makes them checkable against what they're meant to depict
// — a shelf really is ~140 m, a snow line really is a few km up — instead of
// being numbers that only meant something relative to each other.
//
// The shallow-water band is the one that changes most in character. It used to
// span -0.05..0 of a scale where the coast dropped ~0.8 units in a few pixels,
// so it was a couple of pixels wide and the coastline read as a hard line. With
// a real shelf (elevationScale.marginProfile) the -140..0 m band is tens of
// kilometres wide, and this is what actually paints it.
const stop = (meters: number, color: Rgb): { elevation: number; color: Rgb } => ({ elevation: metersToElevation(meters), color })

const COLOR_STOPS: { elevation: number; color: Rgb }[] = [
  stop(-9000, [8, 28, 76]), // trench
  stop(-5700, [20, 52, 112]), // abyssal plain (ABYSSAL_FLOOR)
  stop(-2600, [36, 88, 158]), // mid-ocean ridge crest (RIDGE_CREST)
  stop(-600, [70, 130, 190]), // continental slope
  stop(-140, [98, 160, 210]), // shelf break (SHELF_BREAK) — shallow water above here
  stop(0, [222, 208, 158]), // shoreline
  stop(200, [92, 150, 68]), // lowland green
  stop(1200, [72, 122, 58]), // upland
  stop(2500, [122, 108, 66]), // highland brown
  stop(4200, [128, 118, 108]), // bare rock
  stop(6000, [250, 250, 250]), // permanent snow
  stop(9000, [255, 255, 255]),
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

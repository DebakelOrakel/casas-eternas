import { ABYSSAL_FLOOR, ELEVATION_METERS, RIDGE_CREST, SEA_LEVEL, SHELF_BREAK, metersToElevation } from './elevationScale'

type Rgb = [number, number, number]

// Hypsometric-tint style color ramp: dark deep ocean up through shallow water to
// a coastline band, then lowland green through highland brown to snow-capped
// peaks.
//
// The land's stops follow an atlas's layer tints — green, yellow-green,
// khaki, ochre, brown, dark brown, rock, snow — with a distinct hue per band
// where the land is. Until 2026-09-29 the ramp had two near-identical greens
// from 200 m to 1200 m and turned brown only at 2500 m, so a 1500 m range
// read as hills; on Earth's relief a quarter of the land lies above 1500 m
// and half of it below 500 m, and the colour changes are now spent there.
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

// The stops that ARE a scale anchor read the anchor, so the palette follows
// the model when an anchor moves; the others are the palette's own.
const at = (elevation: number, color: Rgb): { elevation: number; color: Rgb } => ({ elevation, color })

const COLOR_STOPS: { elevation: number; color: Rgb }[] = [
  stop(-ELEVATION_METERS, [8, 28, 76]), // trench, the scale's floor
  at(ABYSSAL_FLOOR, [20, 52, 112]), // abyssal plain
  at(RIDGE_CREST, [36, 88, 158]), // mid-ocean ridge crest
  stop(-600, [70, 130, 190]), // continental slope
  at(SHELF_BREAK, [98, 160, 210]), // shelf break — shallow water above here
  at(SEA_LEVEL, [222, 208, 158]), // shoreline
  stop(100, [98, 156, 74]), // lowland green
  stop(400, [156, 176, 88]), // yellow-green hills
  stop(800, [206, 196, 118]), // pale khaki uplands
  stop(1300, [206, 160, 94]), // ochre — mountain country begins
  stop(2000, [172, 114, 70]), // brown mountains
  stop(3000, [128, 86, 66]), // dark brown high ranges
  stop(4200, [146, 138, 136]), // bare rock
  stop(5500, [236, 236, 238]), // permanent snow
  stop(ELEVATION_METERS, [255, 255, 255]), // the scale's ceiling
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

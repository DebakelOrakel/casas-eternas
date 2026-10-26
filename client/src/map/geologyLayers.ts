import type { Domain } from '../generator/core/domain'
import { rasteriseField } from '../generator/fields/fieldMesh'
import { mantleMesh } from '../generator/mantle/mantleField'
import { t } from '../i18n/i18n'
import type { LegendSpec } from '../ui/legend/LegendPanel'
import type { Rgb, WashTarget } from './climateLayers'

// THE GEOLOGY'S WASHES AND LEGENDS (2026-10-26): the cratons' age and the
// mantle's buoyancy as washes over an RGBA target, and the legends of the
// volcanoes and the plumes (their marks are mapSymbols.ts'). Written for
// the incubator after the generator's (GeneratorScreen paintCratonAge,
// paintMantle, CRATON_AGE_STOPS, mantleTintNorm, overlayReadout), apart
// from either screen, as climateLayers.ts.

// The craton-age ramp: pale sand for crust formed just now, deep russet
// for cores as old as the world, the age a share of the world's history.
const CRATON_AGE_STOPS: readonly (readonly [share: number, rgb: Rgb])[] = [
  [0.0, [238, 219, 176]],
  [0.5, [186, 122, 74]],
  [1.0, [104, 40, 30]],
]
const CRATON_AGE_ALPHA = 0.8
function cratonAgeColor(age: number): Rgb {
  const a = age <= 0 ? 0 : age >= 1 ? 1 : age
  for (let i = 1; i < CRATON_AGE_STOPS.length; i++) {
    const [hi, hiRgb] = CRATON_AGE_STOPS[i]
    if (a > hi && i < CRATON_AGE_STOPS.length - 1) continue
    const [lo, loRgb] = CRATON_AGE_STOPS[i - 1]
    const f = hi === lo ? 0 : (a - lo) / (hi - lo)
    return [loRgb[0] + (hiRgb[0] - loRgb[0]) * f, loRgb[1] + (hiRgb[1] - loRgb[1]) * f, loRgb[2] + (hiRgb[2] - loRgb[2]) * f]
  }
  return CRATON_AGE_STOPS[0][1]
}

// The cratons' age per target texel (`ageAt`, a share; negative where no
// crust), on the texels `keep` admits.
export function paintCratonAge(target: WashTarget, ageAt: (t: number) => number, keep: (t: number) => boolean): void {
  for (let tIndex = 0; tIndex < target.width * target.height; tIndex++) {
    if (!keep(tIndex)) continue
    const age = ageAt(tIndex)
    if (age >= 0) target.blend(tIndex, cratonAgeColor(age), CRATON_AGE_ALPHA)
  }
}

export function cratonAgeLegend(): LegendSpec {
  return {
    type: 'gradient',
    title: t('overlay.cratonAge.label'),
    unit: t('overlay.cratonAge.legend.unit'),
    stops: CRATON_AGE_STOPS.map(([share, rgb]) => ({ value: Math.round(share * 100), rgb: [rgb[0], rgb[1], rgb[2]] as [number, number, number] })),
  }
}

// The mantle's buoyancy on a raster of MANTLE_RASTER_X × _Y (the field is
// coarse; at the incubator's overlay, 4096 × 2048, it took 1.6 s), scaled so that
// ±1 is full: by its MANTLE_TINT_PERCENTILE magnitude, MANTLE_TINT_FLOOR
// at least, so a nearly flat field is not amplified into noise (the
// generator's mantleTintNorm). Null where the field does not fit the
// domain's mantle mesh.
const MANTLE_TINT_PERCENTILE = 0.9
const MANTLE_TINT_FLOOR = 0.25
const MANTLE_RASTER_X = 1024
const MANTLE_RASTER_Y = 512
export interface MantleRaster {
  width: number
  height: number
  field: Float32Array
}
export function mantleRaster(domain: Domain, values: Float64Array): MantleRaster | null {
  const { mesh } = mantleMesh(domain)
  if (mesh.count !== values.length) return null
  const magnitudes = Float64Array.from(values, Math.abs).sort()
  const scale = Math.max(MANTLE_TINT_FLOOR, magnitudes[Math.floor(magnitudes.length * MANTLE_TINT_PERCENTILE)])
  const field = rasteriseField(mesh, values, MANTLE_RASTER_X, MANTLE_RASTER_Y)
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-1, Math.min(1, field[i] / scale))
  return { width: MANTLE_RASTER_X, height: MANTLE_RASTER_Y, field }
}

// The mantle: red where it rises, blue where it sinks, stronger the more.
const MANTLE_UP: Rgb = [225, 85, 55]
const MANTLE_DOWN: Rgb = [55, 110, 210]
export function paintMantle(target: WashTarget, raster: MantleRaster): void {
  const { width: W, height: H, field } = raster
  for (let y = 0; y < target.height; y++) {
    const row = Math.min(H - 1, Math.floor((y / target.height) * H)) * W
    for (let x = 0; x < target.width; x++) {
      const v = field[row + Math.min(W - 1, Math.floor((x / target.width) * W))]
      const a = Math.abs(v) * 0.55
      if (a >= 0.01) target.blend(y * target.width + x, v >= 0 ? MANTLE_UP : MANTLE_DOWN, a)
    }
  }
}

export function mantleLegend(): LegendSpec {
  return { type: 'swatches', title: t('overlay.mantle.legend.title'), items: [
    { label: t('overlay.mantle.legend.upwelling'), rgb: [...MANTLE_UP] as [number, number, number] },
    { label: t('overlay.mantle.legend.downwelling'), rgb: [...MANTLE_DOWN] as [number, number, number] },
  ] }
}

export function volcanoLegend(): LegendSpec {
  return { type: 'swatches', title: t('overlay.volcanoes.legend.title'), items: [
    { label: t('overlay.volcanoes.legend.hotspot'), rgb: [220, 55, 30], shape: 'cone' },
    { label: t('overlay.volcanoes.legend.arc'), rgb: [235, 120, 30], shape: 'cone' },
    { label: t('overlay.volcanoes.legend.flood'), rgb: [120, 25, 20], shape: 'cone' },
  ] }
}

export function hotspotLegend(): LegendSpec {
  return { type: 'swatches', title: t('overlay.hotspots.legend.title'), items: [
    { label: t('overlay.hotspots.legend.plume'), rgb: [255, 140, 0], shape: 'ring' },
  ] }
}

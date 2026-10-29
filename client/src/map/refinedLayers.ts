import { pressureColor, pressureLegendStops, salinityColor, salinityLegendStops, upwellingColor, upwellingLegendStops, DEEP_WATER_RGB } from '../generator/climate/climateColors'
import { chartField } from '../generator/climate/climateChart'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../generator/climate/climateField'
import { climateMesh } from '../generator/climate/climateMesh'
import { OCEAN_PRECIP } from '../generator/climate/precipitation'
import { REFINED_STORMS, type RefinedClimate } from '../generator/climate/refinement'
import type { Domain } from '../generator/core/domain'
import { t, type TKey } from '../i18n/i18n'
import type { LegendSpec } from '../ui/legend/LegendPanel'
import type { Rgb, WashTarget } from './climateLayers'
import { drawIsolines, traceIsolines, type Isoline } from './isolines'
import { flowLineMarks, globeVectorMarks, type VectorMark, type VectorReader } from './vectorMarks'
import { traceFlowLines } from './flowLines'

// THE REFINED CLIMATE'S LAYERS (2026-10-26): the sea's (the upwelling, the
// salt with the sinking water), the weather's nine (fog … thunder), the
// pressure with its isobars, and the wind's and the currents' marks — from
// a save's refinement (world.refined(), per cell of the climate's field
// mesh), as the year's mean where the save holds months. Written for the
// incubator after the generator's painters, apart from either screen, as
// climateLayers.ts. The generator paints its sea, weather and pressure
// through them since 2026-10-29; its wind's calm and its marks are still
// its own (they read the static climate's wind too, and the calm is
// smoothed there).
//
// The cells are charted once (chartField) on the climate's chart; a wash
// reads it bilinearly, from the sea's texels only for a sea wash and from
// the land's for a land wash (the chart's land: its rain is not
// OCEAN_PRECIP), and paints the target's sea or land only (`keep`).

export type WeatherLayer = 'fog' | 'foehn' | 'rainVariability' | 'enso' | 'cyclone' | 'tornado' | 'blizzard' | 'dust' | 'thunder'
export const WEATHER_LAYERS: readonly WeatherLayer[] = ['fog', 'foehn', 'rainVariability', 'enso', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder']
export type SeaLayer = 'upwelling' | 'salinity'
export const SEA_LAYERS: readonly SeaLayer[] = ['upwelling', 'salinity']

// The refinement on the chart, and the field mesh's vectors for the marks.
export interface RefinedCharts {
  width: number
  height: number
  // 1 where the chart is sea.
  sea: Uint8Array
  pressure: Float32Array
  upwelling: Float32Array
  upwellingPeak: number
  salinity: Float32Array
  deepWater: Float32Array
  weather: Record<WeatherLayer, Float32Array>
  currentAnomaly: Float32Array
  // Per cell of the field mesh, east and south; the year's mean wind.
  wind: { e: Float64Array; s: Float64Array; reference: number }
  currents: { e: Float64Array; s: Float64Array; reference: number }
  // The ENSO's period, years (0: none), and its strength, 0 … 1.
  ensoPeriodYears: number
  ensoStrength: number
  domain: Domain
}

// The year's mean of a months × cells field (month-major).
function yearMean(field: Float32Array, months: number, cells: number): Float64Array {
  const mean = new Float64Array(cells)
  for (let m = 0; m < months; m++) for (let c = 0; c < cells; c++) mean[c] += field[m * cells + c] / months
  return mean
}

// The speed a mark draws at full weight: the 95th percentile of the
// magnitudes, as the generator's vectorReferenceSpeed.
function referenceSpeed(e: ArrayLike<number>, s: ArrayLike<number>): number {
  const m: number[] = []
  for (let i = 0; i < e.length; i++) {
    const v = Math.hypot(e[i], s[i])
    if (v > 0) m.push(v)
  }
  if (m.length === 0) return 1
  m.sort((p, q) => p - q)
  return m[Math.floor(m.length * 0.95)] || 1
}

// The upwelling at which the wash is full: the 98th percentile of the
// rising cells, not the strongest — a few coast cells peak at seven times
// the usual (Astrakan) and would leave everything else pale. 0: none rises.
export function upwellingPeakOf(upwelling: ArrayLike<number>): number {
  const rising = Array.from(upwelling).filter((v) => v > 0).sort((a, b) => a - b)
  return rising.length > 0 ? rising[Math.floor(0.98 * (rising.length - 1))] : 0
}

// The refinement charted; null where it does not fit the domain's mesh.
export function chartRefined(domain: Domain, refined: RefinedClimate): RefinedCharts | null {
  const cm = climateMesh(domain)
  if (cm.mesh.count !== refined.cells) return null
  const { months, cells } = refined
  const chart = (field: ArrayLike<number>): Float32Array => chartField(cm, field)
  const rain = chart(yearMean(refined.precipitation, months, cells).map((v) => (v < 0 ? OCEAN_PRECIP : v)))
  const sea = Uint8Array.from(rain, (v) => (v === OCEAN_PRECIP ? 1 : 0))
  const upwelling = chart(refined.upwelling)
  const weather = {
    fog: chart(refined.fog),
    foehn: chart(refined.foehn),
    rainVariability: chart(refined.reliability.rainVariability),
    enso: chart(refined.reliability.ensoPattern),
  } as Record<WeatherLayer, Float32Array>
  for (const storm of REFINED_STORMS) weather[storm] = chart(refined.storms[storm])
  const windE = yearMean(refined.windE, months, cells)
  const windS = yearMean(refined.windS, months, cells)
  const currentE = Float64Array.from(refined.currentE)
  const currentS = Float64Array.from(refined.currentS)
  return {
    width: CLIMATE_RES_X,
    height: CLIMATE_RES_Y,
    sea,
    pressure: chart(yearMean(refined.pressure, months, cells)),
    upwelling,
    upwellingPeak: upwellingPeakOf(refined.upwelling),
    salinity: chart(refined.salinity),
    deepWater: chart(refined.deepWater),
    weather,
    currentAnomaly: chart(refined.currentAnomaly),
    wind: { e: windE, s: windS, reference: referenceSpeed(windE, windS) },
    currents: { e: currentE, s: currentS, reference: referenceSpeed(currentE, currentS) },
    ensoPeriodYears: refined.reliability.ensoPeriodYears,
    ensoStrength: refined.reliability.ensoStrength,
    domain,
  }
}

// What a wash reads of the charts: the generator hands its own chart
// raster (the worker's), the incubator chartRefined's.
export type MaskedCharts = Pick<RefinedCharts, 'width' | 'height' | 'sea' | 'domain'>
export type WeatherCharts = MaskedCharts & Pick<RefinedCharts, 'weather'>
export type SeaCharts = MaskedCharts & Pick<RefinedCharts, 'upwelling' | 'upwellingPeak' | 'salinity' | 'deepWater'>

// Each target texel's value from the chart, bilinear over the chart's sea
// (`sea` true) or land texels only; null where none of the four is.
function washMasked(target: WashTarget, charts: MaskedCharts, sea: boolean, keep: (t: number) => boolean, paint: (tIndex: number, read: (field: Float32Array) => number) => void): void {
  const { width: W, height: H } = charts
  const sphere = charts.domain.kind === 'sphere'
  const row = (y: number): number => (sphere ? Math.max(0, Math.min(H - 1, y)) : ((y % H) + H) % H)
  const at: number[] = [0, 0, 0, 0]
  const weight: number[] = [0, 0, 0, 0]
  for (let y = 0; y < target.height; y++) {
    const fy = ((y + 0.5) / target.height) * H - 0.5
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const r0 = row(y0) * W
    const r1 = row(y0 + 1) * W
    for (let x = 0; x < target.width; x++) {
      const tIndex = y * target.width + x
      if (!keep(tIndex)) continue
      const fx = ((x + 0.5) / target.width) * W - 0.5
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const c0 = ((x0 % W) + W) % W
      const c1 = (((x0 + 1) % W) + W) % W
      at[0] = r0 + c0; weight[0] = (1 - tx) * (1 - ty)
      at[1] = r0 + c1; weight[1] = tx * (1 - ty)
      at[2] = r1 + c0; weight[2] = (1 - tx) * ty
      at[3] = r1 + c1; weight[3] = tx * ty
      let total = 0
      for (let k = 0; k < 4; k++) {
        if ((charts.sea[at[k]] === 1) !== sea) weight[k] = 0
        total += weight[k]
      }
      if (total <= 0) continue
      paint(tIndex, (field) => {
        let v = 0
        for (let k = 0; k < 4; k++) if (weight[k] > 0) v += field[at[k]] * weight[k]
        return v / total
      })
    }
  }
}

// A weather phenomenon's colour at full strength (`full`, a share of the
// year, or the world's strongest at 1 — a blizzard a third of the year is
// as bad as they come), or for the see-saw's dry side (`signed`).
const WEATHER_STYLE: Record<WeatherLayer, { rgb: Rgb; full: number; signed?: Rgb }> = {
  fog: { rgb: [120, 140, 170], full: 0.5 },
  foehn: { rgb: [215, 110, 40], full: 0.5 },
  rainVariability: { rgb: [170, 60, 120], full: 0.5 },
  enso: { rgb: [40, 110, 200], full: 1, signed: [165, 110, 45] },
  cyclone: { rgb: [120, 45, 160], full: 1 },
  tornado: { rgb: [200, 55, 55], full: 1 },
  blizzard: { rgb: [70, 130, 200], full: 0.3 },
  dust: { rgb: [190, 150, 80], full: 1 },
  thunder: { rgb: [230, 180, 30], full: 1 },
}

// The phenomenon on the land, `land(t)` the target's.
export function paintWeather(target: WashTarget, charts: WeatherCharts, layer: WeatherLayer, land: (t: number) => boolean): void {
  const style = WEATHER_STYLE[layer]
  const field = charts.weather[layer]
  washMasked(target, charts, false, land, (tIndex, read) => {
    const v = read(field)
    const k = Math.min(1, Math.abs(v) / style.full)
    if (k <= 0.02) return
    target.blend(tIndex, v < 0 && style.signed ? style.signed : style.rgb, 0.7 * k)
  })
}

// The sea's layers on the sea, `sea(t)` the target's: the upwelling, teal,
// stronger where more cold water comes up; the salt, with the sinking water
// laid over it in violet.
export function paintSea(target: WashTarget, charts: SeaCharts, layer: SeaLayer, sea: (t: number) => boolean): void {
  if (layer === 'upwelling') {
    if (charts.upwellingPeak <= 0) return
    washMasked(target, charts, true, sea, (tIndex, read) => {
      const v = read(charts.upwelling)
      if (v <= 0) return
      const k = Math.min(1, v / charts.upwellingPeak)
      target.blend(tIndex, upwellingColor(k), 0.25 + 0.5 * k)
    })
    return
  }
  washMasked(target, charts, true, sea, (tIndex, read) => {
    target.blend(tIndex, salinityColor(read(charts.salinity)), 0.6)
    const sink = 0.8 * Math.min(1, read(charts.deepWater))
    if (sink > 0.05) target.blend(tIndex, DEEP_WATER_RGB, sink)
  })
}

// The pressure: a wash, blue for the lows and amber for the highs, stronger
// the further from 1013 hPa, and isobars every 4 hPa, the 1012 and the
// 1020 line heavier — the weather map's convention. The wash (one texel a
// chart texel) and the isobars are made once a field (pressureDrawing),
// then drawn at a size onto a canvas (drawPressure): the generator's map
// directly, the incubator's through a picture laid on its target.
export interface PressureDrawing {
  resX: number
  resY: number
  wash: HTMLCanvasElement
  isobars: Isoline[]
}
export function pressureDrawing(pressure: Float32Array, W: number, H: number): PressureDrawing {
  const wash = document.createElement('canvas')
  wash.width = W
  wash.height = H
  const wc = wash.getContext('2d')!
  const img = wc.createImageData(W, H)
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = pressureColor(pressure[i])
    img.data[i * 4] = r
    img.data[i * 4 + 1] = g
    img.data[i * 4 + 2] = b
    img.data[i * 4 + 3] = Math.round(255 * (0.2 + 0.4 * Math.min(1, Math.abs(pressure[i] - 1013) / 12)))
  }
  wc.putImageData(img, 0, 0)
  const levels: number[] = []
  for (let p = 980; p <= 1048; p += 4) levels.push(p)
  return { resX: W, resY: H, wash, isobars: traceIsolines(pressure, W, H, levels) }
}
export function drawPressure(c: CanvasRenderingContext2D, drawing: PressureDrawing, width: number, height: number): void {
  c.save()
  c.imageSmoothingEnabled = true
  c.drawImage(drawing.wash, 0, 0, width, height)
  c.strokeStyle = 'rgba(40, 45, 60, 0.6)'
  // The lines' widths at the generator's map width (2048); as wide on a
  // wider one.
  const scale = width / 2048
  drawIsolines(c, drawing.isobars, { resX: drawing.resX, resY: drawing.resY, width, height, lineWidth: scale, emphasis: (level) => level === 1012 || level === 1020, emphasisWidth: 2 * scale })
  c.restore()
}
export interface PressurePicture {
  width: number
  height: number
  rgba: Uint8ClampedArray
}
export function pressurePicture(charts: RefinedCharts, width: number, height: number): PressurePicture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const c = canvas.getContext('2d')!
  drawPressure(c, pressureDrawing(charts.pressure, charts.width, charts.height), width, height)
  return { width, height, rgba: c.getImageData(0, 0, width, height).data }
}
export function paintPressure(target: WashTarget, picture: PressurePicture): void {
  if (picture.width !== target.width || picture.height !== target.height) return
  const { rgba } = picture
  for (let tIndex = 0; tIndex < target.width * target.height; tIndex++) {
    const a = rgba[4 * tIndex + 3]
    if (a > 0) target.blend(tIndex, [rgba[4 * tIndex], rgba[4 * tIndex + 1], rgba[4 * tIndex + 2]], a / 255)
  }
}

// The wind's calm belts, lightened: under WIND_CALM of the reference speed
// the air counts as calm (the generator's drawWindCalm).
const WIND_CALM = 0.2
export function paintWindCalm(target: WashTarget, charts: RefinedCharts): void {
  const { domain } = charts
  const { sampler } = climateMesh(domain)
  const v = { x: 0, y: 0 }
  // Read a cell of the chart at a time, not a texel: the calm is coarse.
  const { width: W, height: H } = charts
  const calm = new Float32Array(W * H)
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      sampler.sampleVector(charts.wind.e, charts.wind.s, domain.wrapX(((gx + 0.5) / W) * domain.width), domain.wrapY(((gy + 0.5) / H) * domain.height), -1, v)
      calm[gy * W + gx] = Math.max(0, 1 - Math.hypot(v.x, v.y) / charts.wind.reference / WIND_CALM)
    }
  }
  for (let y = 0; y < target.height; y++) {
    const gy = Math.min(H - 1, Math.floor((y / target.height) * H))
    for (let x = 0; x < target.width; x++) {
      const k = calm[gy * W + Math.min(W - 1, Math.floor((x / target.width) * W))]
      if (k > 0) target.blend(y * target.width + x, [255, 255, 255], 0.35 * k)
    }
  }
}

// A reader of a field mesh's vectors at a chart point or a world texel.
function vectorReader(domain: Domain, e: Float64Array, s: Float64Array): { atPoint: VectorReader; atPixel: (x: number, y: number) => [number, number] } {
  const { sampler } = climateMesh(domain)
  const v = { x: 0, y: 0 }
  const read = (x: number, y: number): void => sampler.sampleVector(e, s, domain.wrapX(x), domain.wrapY(y), -1, v)
  return {
    atPoint: (at, out) => {
      read(at.u * domain.width, at.v * domain.height)
      out[0] = v.x
      out[1] = v.y
      return out
    },
    atPixel: (x, y) => {
      read(x, y)
      return [v.x, v.y]
    },
  }
}

// Where the wind's streaks and the currents' arrows lie, in world texels
// (the generator's windMarks, currentMarks, their numbers): on the torus
// along evenly spaced flow lines, on the sphere the globe sampled evenly.
export function windMarks(charts: RefinedCharts, length: number, gap: number): VectorMark[] {
  const { domain } = charts
  const ref = charts.wind.reference
  const read = vectorReader(domain, charts.wind.e, charts.wind.s)
  if (domain.kind === 'sphere') return globeVectorMarks(read.atPoint, { width: domain.width, spacing: 26, length, minSpeed: ref * WIND_CALM * 0.5, refSpeed: ref })
  const lines = traceFlowLines(read.atPixel, { width: domain.width, height: domain.height, separation: 16, stopRatio: 0.5, step: 2, maxLength: 600, minSpeed: ref * WIND_CALM * 0.5, refSpeed: ref })
  return flowLineMarks(lines, { width: domain.width, height: domain.height, length, gap, closeLoops: false, minPoints: 3, speedCap: Infinity })
}
const CURRENT_MIN_SPEED = 0.1
export function currentMarks(charts: RefinedCharts, length: number, gap: number): VectorMark[] {
  const { domain } = charts
  const ref = charts.currents.reference
  const read = vectorReader(domain, charts.currents.e, charts.currents.s)
  if (domain.kind === 'sphere') return globeVectorMarks(read.atPoint, { width: domain.width, spacing: 48, length: 40, minSpeed: CURRENT_MIN_SPEED, refSpeed: ref })
  const lines = traceFlowLines(read.atPixel, { width: domain.width, height: domain.height, separation: 52, stopRatio: 0.55, step: 4, maxLength: 1800, minSpeed: CURRENT_MIN_SPEED, refSpeed: ref })
  return flowLineMarks(lines, { width: domain.width, height: domain.height, length, gap, closeLoops: true, minPoints: 4, speedCap: 1 })
}
// A current's class from the sea's anomaly under its middle: warm (0), cold
// (1), neutral (2) within CURRENT_NEUTRAL_C either way.
const CURRENT_NEUTRAL_C = 0.25
export function currentClass(charts: RefinedCharts, mark: VectorMark): number {
  const { width: W, height: H } = charts
  const gx = ((Math.floor(mark.mid.u * W) % W) + W) % W
  const gy = Math.max(0, Math.min(H - 1, Math.floor(mark.mid.v * H)))
  const a = charts.currentAnomaly[gy * W + gx]
  return a > CURRENT_NEUTRAL_C ? 0 : a < -CURRENT_NEUTRAL_C ? 1 : 2
}

// The legends, as the generator's (overlayReadout, weatherReadouts).
export function seaLegend(layer: SeaLayer): LegendSpec {
  if (layer === 'upwelling') return { type: 'gradient', title: t('overlay.upwelling.label'), unit: t('common.unit.percent'), stops: upwellingLegendStops }
  return { type: 'gradient', title: t('overlay.salinity.label'), unit: t('common.unit.psu'), stops: salinityLegendStops, items: [{ label: t('overlay.salinity.legend.deepWater'), rgb: [...DEEP_WATER_RGB] as [number, number, number] }] }
}
export function pressureLegend(): LegendSpec {
  return { type: 'gradient', title: t('overlay.pressure.label'), unit: t('common.unit.hectopascal'), stops: pressureLegendStops }
}
const PALE: [number, number, number] = [236, 236, 230]
export function weatherLegend(layer: WeatherLayer, ensoPeriodYears: number): LegendSpec {
  const style = WEATHER_STYLE[layer]
  if (layer === 'enso') {
    const title = ensoPeriodYears > 0 ? `${t('overlay.enso.label')} · ${t('overlay.enso.period', { v: ensoPeriodYears.toFixed(1) })}` : t('overlay.enso.label')
    return { type: 'gradient', title, unit: t('overlay.enso.legend.unit'), stops: [
      { value: -100, rgb: [...style.signed!] as [number, number, number] }, { value: 0, rgb: PALE }, { value: 100, rgb: [...style.rgb] as [number, number, number] },
    ] }
  }
  return { type: 'gradient', title: t(`overlay.${layer}.label` as TKey), unit: t('common.unit.percent'), stops: [
    { value: 0, rgb: PALE }, { value: style.full * 100, rgb: [...style.rgb] as [number, number, number] },
  ] }
}

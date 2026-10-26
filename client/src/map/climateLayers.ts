import { biomeColor, biomeLabelKey, biomeLegend, Biome } from '../generator/climate/biomes'
import { amplitudeColor, amplitudeLegendStops, monsoonColor, monsoonLegendStops, precipitationColor, precipitationLegendStops, temperatureColor, temperatureLegendStops } from '../generator/climate/climateColors'
import { KOPPEN_CODES, koppenCode, koppenColor, koppenLabelKey } from '../generator/climate/koppen'
import { OCEAN_PRECIP } from '../generator/climate/precipitation'
import { OCEAN_AMPLITUDE } from '../generator/climate/seasonality'
import { evaporationPotential } from '../generator/surface/hydrology'
import { t, type TKey } from '../i18n/i18n'
import type { LegendSpec } from '../ui/legend/LegendPanel'

// THE CLIMATE'S WASHES (2026-10-26): the map's climate layers — the
// temperature, the precipitation, the temperature's span, the monsoon, the
// water balance, the Köppen classes, the biomes — as washes over an RGBA
// target, with their legends. Written for the incubator after the
// generator's painters (GeneratorScreen paintTemperature … paintBiomes,
// their colours and alphas), apart from either screen so that the
// generator can take them over: a wash knows its field and its target, not
// whose they are.
//
// A field on its own raster (the climate's chart) is read at the texel
// under each target texel, the nearest; a class (Köppen, biome) comes per
// target texel from the caller. `keep(t)`: whether target texel `t` is
// washed at all — the land, for the land's washes, so that the coast is
// the target's own and not the coarse field's.

export type Rgb = readonly [number, number, number]

export interface WashTarget {
  width: number
  height: number
  // Lay `rgb` at `alpha` over target texel `t`.
  blend(t: number, rgb: Rgb, alpha: number): void
}

export type ClimateWash = 'temperature' | 'precipitation' | 'seasonality' | 'monsoon' | 'waterBalance' | 'koppen' | 'biomes'
export const CLIMATE_WASHES: readonly ClimateWash[] = ['temperature', 'precipitation', 'seasonality', 'monsoon', 'waterBalance', 'koppen', 'biomes']

// The generator's alphas.
const ALPHA: Record<ClimateWash, number> = { temperature: 0.55, precipitation: 0.6, seasonality: 0.6, monsoon: 0.6, waterBalance: 0.55, koppen: 0.7, biomes: 0.85 }

// A field of W × H, its values to a colour, or null to leave the texel.
// A kept texel (the target's land) whose texel of the field has no colour
// (the field's sea, coarser than the target's coast) takes the nearest
// that has one within FILL_RING texels of the field: without it the
// target's coast went unwashed, on Morvane level 1's 12 % of its land
// under a climate chart of 256 × 128 (2026-10-26).
const FILL_RING = 2
export function washField(target: WashTarget, field: Float32Array, width: number, height: number, colour: (value: number, i: number) => Rgb | null, alpha: number, keep?: (t: number) => boolean): void {
  // Per texel of the field, its colour or the nearest's for a kept texel;
  // made once a texel of the field.
  const own: (Rgb | null)[] = new Array(width * height)
  for (let i = 0; i < own.length; i++) own[i] = colour(field[i], i)
  const filled: (Rgb | null | undefined)[] = new Array(width * height)
  const fill = (gx: number, gy: number): Rgb | null => {
    const i = gy * width + gx
    if (filled[i] !== undefined) return filled[i]!
    let best: Rgb | null = null
    let bestD = Infinity
    for (let dy = -FILL_RING; dy <= FILL_RING; dy++) {
      const y = gy + dy
      if (y < 0 || y >= height) continue
      for (let dx = -FILL_RING; dx <= FILL_RING; dx++) {
        const c = own[y * width + (((gx + dx) % width) + width) % width]
        const d = dx * dx + dy * dy
        if (c && d < bestD) {
          best = c
          bestD = d
        }
      }
    }
    filled[i] = best
    return best
  }
  for (let y = 0; y < target.height; y++) {
    const gy = Math.min(height - 1, Math.floor((y / target.height) * height))
    for (let x = 0; x < target.width; x++) {
      const tIndex = y * target.width + x
      if (keep && !keep(tIndex)) continue
      const gx = Math.min(width - 1, Math.floor((x / target.width) * width))
      const rgb = own[gy * width + gx] ?? (keep ? fill(gx, gy) : null)
      if (rgb) target.blend(tIndex, rgb, alpha)
    }
  }
}

// The water balance's diverging ramp: rain less potential evaporation, mm a
// year, clamped at WATER_BALANCE_CLAMP — rust below zero, paper at balance,
// blue-green above.
const WATER_BALANCE_CLAMP = 1500
function waterBalanceColor(precipitation: number, temperature: number): Rgb | null {
  if (precipitation === OCEAN_PRECIP) return null
  const f = Math.max(-WATER_BALANCE_CLAMP, Math.min(WATER_BALANCE_CLAMP, precipitation - evaporationPotential(temperature))) / WATER_BALANCE_CLAMP
  return f < 0
    ? [245 + (170 - 245) * -f, 243 + (60 - 243) * -f, 238 + (40 - 238) * -f]
    : [245 + (30 - 245) * f, 243 + (110 - 243) * f, 238 + (150 - 238) * f]
}

// The climate's fields on their chart, as the save serves them
// (world/query.ts, acquire); any may be missing.
export interface ClimateFields {
  width: number
  height: number
  temperature: Float32Array | null
  precipitation: Float32Array | null
  seasonality: Float32Array | null
  monsoon: Float32Array | null
}

// The classes per target texel (0 or Biome.Ocean: none).
export interface ClimateClasses {
  koppen: (t: number) => number
  biome: (t: number) => number
}

export function climateWashAvailable(wash: ClimateWash, fields: ClimateFields | null, classes: ClimateClasses | null): boolean {
  if (wash === 'koppen' || wash === 'biomes') return classes !== null
  if (!fields) return false
  if (wash === 'waterBalance') return fields.temperature !== null && fields.precipitation !== null
  return fields[wash] !== null
}

// The wash onto the target; nothing where its data is missing.
export function paintClimateWash(target: WashTarget, wash: ClimateWash, fields: ClimateFields | null, classes: ClimateClasses | null, keep?: (t: number) => boolean): void {
  const alpha = ALPHA[wash]
  if (wash === 'koppen' || wash === 'biomes') {
    if (!classes) return
    for (let tIndex = 0; tIndex < target.width * target.height; tIndex++) {
      if (keep && !keep(tIndex)) continue
      if (wash === 'koppen') {
        const id = classes.koppen(tIndex)
        if (id > 0) target.blend(tIndex, koppenColor(id), alpha)
      } else {
        const id = classes.biome(tIndex)
        if (id !== Biome.Ocean) target.blend(tIndex, biomeColor(id), alpha)
      }
    }
    return
  }
  if (!fields) return
  const { width, height } = fields
  if (wash === 'temperature' && fields.temperature) washField(target, fields.temperature, width, height, (v) => temperatureColor(v), alpha)
  if (wash === 'precipitation' && fields.precipitation) washField(target, fields.precipitation, width, height, (v) => (v === OCEAN_PRECIP ? null : precipitationColor(v)), alpha, keep)
  if (wash === 'seasonality' && fields.seasonality) washField(target, fields.seasonality, width, height, (v) => (v === OCEAN_AMPLITUDE ? null : amplitudeColor(v)), alpha, keep)
  // The strength, not the phase: the ramp runs 0 … 1 (climate/monsoon.ts).
  if (wash === 'monsoon' && fields.monsoon) washField(target, fields.monsoon, width, height, (v) => (v === OCEAN_PRECIP ? null : monsoonColor(Math.abs(v))), alpha, keep)
  if (wash === 'waterBalance' && fields.temperature && fields.precipitation) {
    const temperature = fields.temperature
    washField(target, fields.precipitation, width, height, (v, i) => waterBalanceColor(v, temperature[i]), alpha, keep)
  }
}

// A Köppen class as the legend says it: its name, then its code.
const koppenName = (id: number): string => `${t(koppenLabelKey(id) as TKey)} (${koppenCode(id)})`

// The wash's legend, as the generator's (overlayReadout); the Köppen
// classes `present` only.
export function climateWashLegend(wash: ClimateWash, present?: ReadonlySet<number>): LegendSpec {
  switch (wash) {
    case 'temperature':
      return { type: 'gradient', title: t('overlay.temperature.label'), unit: t('common.unit.celsius'), stops: temperatureLegendStops }
    case 'precipitation':
      return { type: 'gradient', title: t('overlay.precipitation.label'), unit: t('common.unit.millimetresPerYear'), stops: precipitationLegendStops }
    case 'seasonality':
      return { type: 'gradient', title: t('overlay.seasonality.label'), unit: t('common.unit.celsius'), stops: amplitudeLegendStops }
    case 'monsoon':
      return { type: 'gradient', title: t('overlay.monsoon.legend.title'), unit: '', stops: monsoonLegendStops }
    case 'waterBalance':
      return { type: 'swatches', title: t('overlay.waterBalance.label'), items: [
        { label: t('overlay.waterBalance.legend.humid'), rgb: [30, 110, 150] },
        { label: t('overlay.waterBalance.legend.arid'), rgb: [170, 60, 40] },
      ] }
    case 'koppen': {
      const ids = KOPPEN_CODES.map((_, id) => id).filter((id) => id > 0 && (!present || present.has(id)))
      return { type: 'swatches', title: t('overlay.koppen.label'), items: ids.map((id) => ({ label: koppenName(id), rgb: [...koppenColor(id)] as [number, number, number] })) }
    }
    case 'biomes':
      return { type: 'swatches', title: t('overlay.biomes.label'), items: biomeLegend().map((b) => ({ label: t(b.labelKey as TKey), rgb: [...b.rgb] as [number, number, number] })) }
  }
}

// The class's name at a target texel, for a readout; null where none.
export function climateClassName(wash: ClimateWash, classes: ClimateClasses, tIndex: number): string | null {
  if (wash === 'koppen') {
    const id = classes.koppen(tIndex)
    return id > 0 ? t(koppenLabelKey(id) as TKey) : null
  }
  if (wash === 'biomes') {
    const id = classes.biome(tIndex)
    return id !== Biome.Ocean ? t(biomeLabelKey(id) as TKey) : null
  }
  return null
}

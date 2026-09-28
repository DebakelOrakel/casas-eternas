// The climate step's refinement in the save (formatVersion 6): its stacks
// and vectors taken apart into the one-field-per-month layers of
// fieldSpec.REFINED_FIELDS, and put back together on load. The wind goes out
// in m/s, so a reader needs no model unit; the generator's own unit comes
// back on the way in.

import { CLIMATE_TUNING } from '../../generator/climate/climateTuneParams'
import type { RefinedClimate } from '../../generator/climate/refinement'
import { REFINED_MONTHS } from '../../generator/climate/pressure'
import { refinedMonthField } from './fieldSpec'
import { restoreLandOnlySentinel } from './worldLayers'
import { OCEAN_PRECIP } from '../../generator/climate/precipitation'
import { koppenFromMonths } from '../../generator/climate/biomes'

// Each layer's values by field name, `n` cells each.
export function refinedLayerSources(r: RefinedClimate, n: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>()
  const ms = CLIMATE_TUNING.windSpeedMsPerUnit
  for (let m = 0; m < r.months; m++) {
    out.set(refinedMonthField('temperature', m + 1), r.temperature.slice(m * n, (m + 1) * n))
    out.set(refinedMonthField('precipitation', m + 1), r.precipitation.slice(m * n, (m + 1) * n))
    out.set(refinedMonthField('pressure', m + 1), r.pressure.slice(m * n, (m + 1) * n))
    const u = new Float32Array(n)
    const v = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      u[i] = r.wind[(m * n + i) * 2] * ms
      v[i] = r.wind[(m * n + i) * 2 + 1] * ms
    }
    out.set(refinedMonthField('windU', m + 1), u)
    out.set(refinedMonthField('windV', m + 1), v)
  }
  const cu = new Float32Array(n)
  const cv = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    cu[i] = r.currents[i * 2]
    cv[i] = r.currents[i * 2 + 1]
  }
  out.set('currentU', cu)
  out.set('currentV', cv)
  out.set('currentAnomaly', r.currentAnomaly)
  out.set('upwelling', r.upwelling)
  out.set('fog', r.fog)
  out.set('foehn', r.foehn)
  return out
}

// The refinement from its decoded layers, or null when any is missing — a
// partial set is not a refinement, and a save from before formatVersion 6
// has none. The rain is land-only: its sea comes back as OCEAN_PRECIP from
// the save's `landMask` (worldLayers.restoreLandOnlySentinel), which `get`
// must also answer.
export function refinedFromLayers(get: (name: string) => Float32Array | null, n: number): RefinedClimate | null {
  const ms = CLIMATE_TUNING.windSpeedMsPerUnit
  const landMask = get('landMask')
  if (!landMask || landMask.length !== n) return null
  const temperature = new Float32Array(REFINED_MONTHS * n)
  const precipitation = new Float32Array(REFINED_MONTHS * n)
  const pressure = new Float32Array(REFINED_MONTHS * n)
  const wind = new Float32Array(REFINED_MONTHS * n * 2)
  for (let m = 0; m < REFINED_MONTHS; m++) {
    const t = get(refinedMonthField('temperature', m + 1))
    const r = get(refinedMonthField('precipitation', m + 1))
    if (!t || !r || t.length !== n || r.length !== n) return null
    temperature.set(t, m * n)
    precipitation.set(restoreLandOnlySentinel(r, landMask, OCEAN_PRECIP), m * n)
    const p = get(refinedMonthField('pressure', m + 1))
    const u = get(refinedMonthField('windU', m + 1))
    const v = get(refinedMonthField('windV', m + 1))
    if (!p || !u || !v || p.length !== n || u.length !== n || v.length !== n) return null
    pressure.set(p, m * n)
    for (let i = 0; i < n; i++) {
      wind[(m * n + i) * 2] = u[i] / ms
      wind[(m * n + i) * 2 + 1] = v[i] / ms
    }
  }
  const cu = get('currentU')
  const cv = get('currentV')
  const currentAnomaly = get('currentAnomaly')
  const upwelling = get('upwelling')
  const fog = get('fog')
  const foehn = get('foehn')
  if (!cu || !cv || !currentAnomaly || !upwelling || !fog || !foehn) return null
  if (cu.length !== n || cv.length !== n || currentAnomaly.length !== n || upwelling.length !== n) return null
  const currents = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    currents[i * 2] = cu[i]
    currents[i * 2 + 1] = cv[i]
  }
  // The class is the months', so it is derived again rather than stored twice.
  const koppen = koppenFromMonths(temperature, precipitation, REFINED_MONTHS)
  return { months: REFINED_MONTHS, temperature, precipitation, koppen, fog, foehn, pressure, wind, currents, currentAnomaly, upwelling }
}

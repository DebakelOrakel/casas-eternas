import { CLIMATE_RES_X, CLIMATE_RES_Y, beltYNorm, shiftedYNorm } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { hadleyEdge } from '../planet/planetForcing'
import { downsampleBox } from '../core/field'
import type { Domain, DomainGrid } from '../core/domain'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { detCos, detHypot, detSin } from '../core/detMath'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

// Surface pressure and the wind it drives, for one month, on the climate grid
// (build step 2 of docs/design/climate-refinement.md). The climate step's
// model, not the epochs': the history keeps the banded wind of wind.ts.
//
// Pressure = the zonal bands (equatorial trough, subtropical highs, subpolar
// lows, polar highs) + a thermal part: air over ground warmer than its
// latitude's mean rises (a heat low), air over colder ground sinks (a cold
// high). The thermal part is smoothed to the scale of real heat lows and cold
// highs (1000–2000 km), because the air does not follow each coast.
//
// Wind = the banded wind of wind.ts (the cells' momentum, which a pressure
// balance alone cannot give at the equator) + the wind of the thermal part
// from the balance of pressure gradient, Coriolis and surface friction. Where
// the Coriolis parameter is large the wind turns along the isobars (around a
// low, anticlockwise in the north); near the equator and over rough land it
// flows more across them, into the low. Then a high range turns the part of
// the wind that blows up its slope.

// The refinement's months: a year, January first.
export const REFINED_MONTHS = 12

export interface PressureWind {
  // hPa, the full pressure (bands + thermal part), for the layer.
  pressure: Float32Array
  // Interleaved [u, v] in wind.ts's units (1 = 8 m/s), v toward +y.
  wind: Float32Array
}

// The zonal bands' pressure in hPa at a signed latitude (−1 top pole … +1
// bottom pole). Minimum at the equator, maximum at the Hadley edge, minimum
// at the Ferrel cell's poleward edge, a weaker maximum at the pole: the edges
// that wind.ts's cells use, so the bands and the banded wind agree.
function bandPressure(phi: number, e1: number, e2: number): number {
  const a = CLIMATE_TUNING.pressureBandHpa
  let t: number
  if (phi < e1) t = -detCos((Math.PI * phi) / e1) // −1 equator → +1 Hadley edge
  else if (phi < e2) t = detCos((Math.PI * (phi - e1)) / (e2 - e1)) // +1 → −1 subpolar low
  else t = -detCos((Math.PI * (phi - e2)) / (1 - e2)) * 0.5 - 0.5 // −1 → 0 polar high
  return 1013 + a * t
}

// Wrapped box blur on the climate grid (`grid`), in place through a scratch
// buffer; three passes approach a Gaussian of σ ≈ radius. Exported for the
// refinement's ocean highs.
//
// `radius` is in equator cells, a length. A row whose cells are narrower
// (the sphere toward a pole, DomainGrid.rowScale = cos φ) takes as many of
// its own cells as cover that length east-west, up to its whole width but
// one: a pole row is a small circle the blur's length spans many times.
// The north-south pass steps across a pole as the grid does, and the pole
// rows come out one value each (fork 5 of DEC-0035). On the torus every
// row's radius is `radius` and the pole rows are none: the arithmetic is
// the torus's, as it was.
export function blur(field: Float32Array, radius: number, grid: DomainGrid): void {
  const tmp = new Float32Array(field.length)
  const width = 2 * radius + 1
  const rowRadius = new Int32Array(RY)
  for (let gy = 0; gy < RY; gy++) rowRadius[gy] = Math.min((RX - 1) >> 1, Math.round(radius / grid.rowScale(gy)))
  for (let pass = 0; pass < 3; pass++) {
    for (let gy = 0; gy < RY; gy++) {
      const r = rowRadius[gy]
      const rowWidth = 2 * r + 1
      let sum = 0
      for (let dx = -r; dx <= r; dx++) sum += field[grid.index(dx, gy)]
      for (let gx = 0; gx < RX; gx++) {
        tmp[gy * RX + gx] = sum / rowWidth
        sum += field[grid.index(gx + r + 1, gy)] - field[grid.index(gx - r, gy)]
      }
    }
    for (let gx = 0; gx < RX; gx++) {
      let sum = 0
      for (let dy = -radius; dy <= radius; dy++) sum += tmp[grid.index(gx, dy)]
      for (let gy = 0; gy < RY; gy++) {
        field[gy * RX + gx] = sum / width
        sum += tmp[grid.index(gx, gy + radius + 1)] - tmp[grid.index(gx, gy - radius)]
      }
    }
  }
  grid.averagePoleRows(field)
}

// `temperature` is the month's air temperature reduced to sea level
// (biomes.reduceTemperatureToSeaLevel: a high range is cold by its height,
// and the pressure here is sea-level pressure), `land` 1 on
// land cells of the climate grid, `elevation` the full-res raster (for the
// relief the wind meets) over `domain` one cell per unit, `baseWind`
// wind.ts's banded wind. `rotationHours`
// scales the Coriolis parameter and moves the band edges.
export function computePressureWind(
  temperature: Float32Array, land: Uint8Array, elevation: Float32Array, domain: Domain,
  baseWind: Float32Array, equatorOffset: number, rotationHours: number,
  // The season's shift of the bands (climateField.beltYNorm), the same the
  // month's rain and `baseWind` were made with.
  beltShift = 0,
  // A further pressure part, hPa per cell, already smooth: the refinement's
  // ocean highs. Its wind is found with the thermal part's.
  extraHpa?: Float32Array,
): PressureWind {
  const n = RX * RY
  const grid = domain.grid(RX, RY)
  const e1 = hadleyEdge(rotationHours)
  const e2 = (1 + e1) / 2

  // The thermal part: the temperature's departure from its row's mean,
  // smoothed, times −hPa per °C.
  const thermal = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    let mean = 0
    for (let gx = 0; gx < RX; gx++) mean += temperature[gy * RX + gx]
    mean /= RX
    for (let gx = 0; gx < RX; gx++) thermal[gy * RX + gx] = -(temperature[gy * RX + gx] - mean) * CLIMATE_TUNING.pressureHpaPerC
  }
  blur(thermal, CLIMATE_TUNING.pressureSmoothCells, grid)
  if (extraHpa) for (let i = 0; i < n; i++) thermal[i] += extraHpa[i]

  const pressure = new Float32Array(n)
  const f = new Float32Array(RY)
  for (let gy = 0; gy < RY; gy++) {
    const sLat = (shiftedYNorm(gy, RY, equatorOffset) - 0.5) * 2 // −1 top … +1 bottom
    // The bands where the season has moved them; the Coriolis parameter
    // below stays the row's own.
    const band = bandPressure(Math.abs((beltYNorm(shiftedYNorm(gy, RY, equatorOffset), beltShift, domain.kind) - 0.5) * 2), e1, e2)
    for (let gx = 0; gx < RX; gx++) pressure[gy * RX + gx] = band + thermal[gy * RX + gx]
    // Signed so the top hemisphere is the northern one: f > 0 there.
    f[gy] = detSin((-sLat * Math.PI) / 2) * (24 / rotationHours)
  }

  // The relief the wind meets: the box mean of the full-res raster per cell,
  // in metres, land only.
  const relief = downsampleBox(elevation, domain.width, domain.height, RX, RY)
  for (let i = 0; i < n; i++) relief[i] = Math.max(0, relief[i] * ELEVATION_METERS)

  // The gradients are per LENGTH, over one equator cell each way (step 4e,
  // as the monsoon's, monsoon.computeMonsoonWind): east-west a row takes the
  // difference `reach` of its own cells apart, as many as span an equator
  // cell, over the length they span — the polar filter of fork 5 of
  // DEC-0035 (two neighbours of a pole row are a few km apart, and their
  // difference would read the coarse raster's coast as a front 80 times as
  // steep). North-south the grid steps across a pole. On the torus the reach
  // is 1 and its length 1: the torus's arithmetic, as it was.
  const wind = new Float32Array(n * 2)
  for (let gy = 0; gy < RY; gy++) {
    const s = grid.rowScale(gy)
    const reach = Math.min((RX >> 1) - 1, Math.max(1, Math.round(1 / s)))
    const gradE = 1 / (reach * s)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      // −∇p of the thermal part, in grid axes (x east, y down), per cell.
      const gx_ = -(thermal[grid.index(gx + reach, gy)] - thermal[grid.index(gx - reach, gy)]) / 2 * gradE * CLIMATE_TUNING.pressureWindPerHpa
      const gy_ = -(thermal[grid.index(gx, gy + 1)] - thermal[grid.index(gx, gy - 1)]) / 2 * CLIMATE_TUNING.pressureWindPerHpa
      // The balance G + f·(v, −u)_north − r·u = 0, solved in north-up axes
      // (the y axis flips), then back.
      const gn = -gy_
      const r = land[i] ? CLIMATE_TUNING.pressureFrictionLand : CLIMATE_TUNING.pressureFrictionSea
      const fy = f[gy]
      const d = r * r + fy * fy
      const u = (r * gx_ + fy * gn) / d
      const vn = (r * gn - fy * gx_) / d
      let wu = baseWind[i * 2] + u
      let wv = baseWind[i * 2 + 1] - vn

      // A range turns the wind: take away a part of the component up the
      // slope, more for a higher barrier.
      const hx = (relief[grid.index(gx + reach, gy)] - relief[grid.index(gx - reach, gy)]) / 2 * gradE
      const hy = (relief[grid.index(gx, gy + 1)] - relief[grid.index(gx, gy - 1)]) / 2
      const slope = detHypot(hx, hy)
      if (slope > 0) {
        const up = (wu * hx + wv * hy) / slope
        const top = Math.max(relief[i], relief[grid.index(gx + reach * Math.sign(wu), gy)], relief[grid.index(gx, gy + Math.sign(wv))])
        const block = Math.min(1, Math.max(0, (top - CLIMATE_TUNING.pressureBlockFromM) / (CLIMATE_TUNING.pressureBlockFullM - CLIMATE_TUNING.pressureBlockFromM))) * CLIMATE_TUNING.pressureBlockMax
        if (up > 0) {
          wu -= block * up * hx / slope
          wv -= block * up * hy / slope
        }
      }
      wind[i * 2] = wu
      wind[i * 2 + 1] = wv
    }
  }
  return { pressure, wind }
}

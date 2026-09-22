import { SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { downsampleBox, sampleBilinearWorld } from '../core/field'
import { CLIMATE_TUNING } from '../climate/climateTuneParams'
import { OCEAN_PRECIP } from '../climate/precipitation'
import { SURFACE_TUNING } from './surfaceTuneParams'

// ICE THICKNESS ON THE FINAL TERRAIN (ADAPTIVE_MESH_PLAN.md F4, docs/design/
// glacial.md "Forerunner"): the shallow-ice flow once, with the final
// climate, no erosion, no epoch loop — real glacier thickness where the
// climate makes ice, lying in the valleys with tongues, instead of a
// temperature threshold. At 7.8 km cells the flow sees ice sheets and the
// largest valley glaciers; the alpine glaciers appear from the 4K/8K bake.
//
// MASS BALANCE per cell, metres of ice per year, from the coarse climate
// brought to the cell's own height: the climate grid's temperature is the
// mean over its 62 km cell, so the cell's temperature is that mean minus
// the lapse over the height difference to the coarse cell's mean height —
// which is what puts the ice on the peaks of a warm cell and leaves its
// valleys bare. Accumulation is the precipitation that falls as snow (all
// of it below −5 °C, none above +5); melt a degree-day rate on the mean
// annual temperature above the `iceMeltFromC` threshold. Ice forms where
// the balance is positive and flows to where it is negative.
//
// FLOW: the steady state of the shallow-ice approximation by balance-flux
// inversion (Farinotti et al. 2009, the standard way to estimate a
// glacier's thickness from its surface and mass balance) rather than by
// time stepping, which is stiff (the SIA diffusivity goes with H⁵ and
// limits an explicit step to days at kilometre cells). Fixed point over
// the ice SURFACE s = z + H: route the balance down the steepest descent
// of s, accumulate it into a flux q (clamped at zero — where the flux is
// spent the ice ends), then H = (q / (Γ |∇s|³))^(1/5) from Glen's law with
// n = 3 and Γ = 2A(ρg)ⁿ/(n+2), and repeat with the new surface. Under-
// relaxed; a dozen rounds settle the sheets and the tongues.
export interface IceFlowInputs {
  elevation: Float32Array
  width: number
  height: number
  temperature: Float32Array
  precipitation: Float32Array
  climateResX: number
  climateResY: number
  cellM: number
}

export interface IceFlowResult {
  // Ice thickness per cell, metres, 0 where there is none.
  thickness: Float32Array
  // The net mass balance per cell, m/yr, for the harness and the picture.
  balance: Float32Array
}

const D8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]

export function computeIceThickness(input: IceFlowInputs): IceFlowResult {
  const { elevation, width, height, temperature, precipitation, climateResX, climateResY, cellM } = input
  const n = width * height
  const at = (x: number, y: number): number => ((y + height) % height) * width + ((x + width) % width)
  const t = SURFACE_TUNING

  // The coarse cell's mean height, for the lapse correction.
  const coarseZ = downsampleBox(elevation, width, height, climateResX, climateResY)

  // Balance.
  const balance = new Float32Array(n)
  let iceable = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = y * width + x
      const z = elevation[c]
      if (z <= SEA_LEVEL) continue
      const tc = sampleBilinearWorld(temperature, climateResX, climateResY, x + 0.5, y + 0.5, width, height)
      const zc = sampleBilinearWorld(coarseZ, climateResX, climateResY, x + 0.5, y + 0.5, width, height)
      const local = tc - CLIMATE_TUNING.lapseCPerElevation * (z - Math.max(SEA_LEVEL, zc))
      let p = sampleBilinearWorld(precipitation, climateResX, climateResY, x + 0.5, y + 0.5, width, height)
      if (p === OCEAN_PRECIP || p < 0) p = 0
      const snow = local <= -5 ? 1 : local >= 5 ? 0 : (5 - local) / 10
      const accumulation = (p / 1000) * snow * t.iceSnowToIce
      const melt = local > t.iceMeltFromC ? (local - t.iceMeltFromC) * t.iceMeltPerDegC : 0
      balance[c] = accumulation - melt
      if (balance[c] > 0) iceable++
    }
  }
  const thickness = new Float32Array(n)
  if (iceable === 0) return { thickness, balance }

  // The domain: cells with a positive balance and everything downslope of
  // them the flux can reach. Simpler and safe: every land cell within
  // reach of the sheets — the flux clamp keeps the ice where it belongs,
  // and the cost is one sort of the land cells per round.
  const land: number[] = []
  for (let c = 0; c < n; c++) if (elevation[c] > SEA_LEVEL) land.push(c)
  const surface = new Float32Array(n)
  const receiver = new Int32Array(n)
  const slope = new Float32Array(n)
  const flux = new Float64Array(n)
  const cellArea = cellM * cellM
  const gamma = t.iceFlowGamma
  const order = Int32Array.from(land)
  const surfaceM = new Float32Array(n)
  for (let round = 0; round < t.iceFlowRounds; round++) {
    for (let c = 0; c < n; c++) surface[c] = elevation[c] > SEA_LEVEL ? elevationToMeters(elevation[c] - SEA_LEVEL) + thickness[c] : elevationToMeters(elevation[c] - SEA_LEVEL)
    // Steepest descent on the surface (8 neighbours, the sea included as
    // a sink: ice that reaches the sea calves).
    for (const c of land) {
      const x = c % width
      const y = (c - x) / width
      let best = -1
      let bestDrop = 0
      for (let k = 0; k < 8; k++) {
        const nb = at(x + D8[k][0], y + D8[k][1])
        const dist = (D8[k][0] !== 0 && D8[k][1] !== 0) ? Math.SQRT2 : 1
        const drop = (surface[c] - surface[nb]) / (dist * cellM)
        if (drop > bestDrop) { bestDrop = drop; best = nb }
      }
      receiver[c] = best
      slope[c] = bestDrop
    }
    // Topological order: by surface height, highest first.
    for (let i = 0; i < order.length; i++) surfaceM[i] = surface[order[i]]
    order.sort((a, b) => surface[b] - surface[a])
    flux.fill(0)
    for (const c of order) {
      const q = flux[c] + balance[c] * cellArea
      flux[c] = q > 0 ? q : 0
      const r = receiver[c]
      if (q > 0 && r >= 0 && elevation[r] > SEA_LEVEL) flux[r] += q
    }
    // Thickness from the flux per unit width and the surface slope.
    for (const c of land) {
      const q = flux[c]
      let h = 0
      if (q > 0) {
        const s = Math.max(t.iceMinSlope, slope[c])
        h = Math.pow((q / cellM) / (gamma * s * s * s), 0.2)
        if (h > t.iceMaxThicknessM) h = t.iceMaxThicknessM
      }
      thickness[c] = 0.5 * thickness[c] + 0.5 * h
    }
  }
  for (let c = 0; c < n; c++) if (thickness[c] < t.iceMinThicknessM) thickness[c] = 0
  return { thickness, balance }
}

// Invariants: check name → violations.
export function iceInvariants(result: IceFlowResult, elevation: Float32Array): Record<string, number> {
  const out: Record<string, number> = { nonNegative: 0, finite: 0, onLand: 0 }
  for (let c = 0; c < result.thickness.length; c++) {
    const h = result.thickness[c]
    if (!Number.isFinite(h) || !Number.isFinite(result.balance[c])) out.finite++
    if (h < 0) out.nonNegative++
    if (h > 0 && elevation[c] <= SEA_LEVEL) out.onLand++
  }
  return out
}

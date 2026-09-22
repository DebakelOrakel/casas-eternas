import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { sampleBilinearGrid } from '../core/field'
import { wrapIndex2 } from '../core/field'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

const wrapIndex = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)

// Wind-driven ocean surface currents as gyres, on the climate grid. Solves a
// streamfunction ψ forced by the wind-stress curl with ψ=0 on land (so the
// flow is automatically tangent to coastlines and closes into basin-scale
// gyres), then derives the (non-divergent) velocity. Returns it interleaved
// [u0,v0,…], normalized to a max magnitude of 1, zero on land. The velocity
// sign is set so subtropical gyres carry WARM water poleward along western
// ocean boundaries (mild eastern continental coasts) and COLD water equatorward
// along eastern ocean boundaries (cool, upwelling western continental coasts) —
// validated against that pattern. See docs/decisions/climate-biomes.md.
export function computeOceanCurrents(elevation: Float32Array, wind: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Float32Array {
  const n = RX * RY
  const land = new Uint8Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      land[gy * RX + gx] = isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight) ? 1 : 0
    }
  }

  // Wind-stress curl. The wind is zonally uniform (banded), so ∂τ_v/∂x = 0 and
  // curl = −∂τ_u/∂y (central difference).
  const curl = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const uUp = wind[wrapIndex(gx, gy - 1) * 2]
      const uDown = wind[wrapIndex(gx, gy + 1) * 2]
      curl[gy * RX + gx] = -(uDown - uUp) / 2
    }
  }

  // ∇²ψ = curl, ψ = 0 on land, wrapped. Gauss-Seidel in place.
  const psi = new Float32Array(n)
  for (let iter = 0; iter < CLIMATE_TUNING.currentsSolveIters; iter++) {
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (land[i]) continue
        psi[i] = (psi[wrapIndex(gx - 1, gy)] + psi[wrapIndex(gx + 1, gy)] + psi[wrapIndex(gx, gy - 1)] + psi[wrapIndex(gx, gy + 1)] - curl[i]) / 4
      }
    }
  }

  // Velocity from ψ (non-divergent): u = −∂ψ/∂y, v = ∂ψ/∂x. Sign chosen so the
  // coastal warm/cold pattern comes out right (validated). Normalize to max 1.
  const current = new Float32Array(n * 2)
  let vmax = 1e-9
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const u = -(psi[wrapIndex(gx, gy + 1)] - psi[wrapIndex(gx, gy - 1)]) / 2
      const v = psi[wrapIndex(gx + 1, gy)] - psi[wrapIndex(gx - 1, gy)]
      current[i * 2] = u
      current[i * 2 + 1] = v / 2
      vmax = Math.max(vmax, Math.hypot(u, v / 2))
    }
  }
  for (let i = 0; i < current.length; i++) current[i] /= vmax
  return current
}

// Applies the ocean currents' heat transport to the temperature field (°C, in
// place): advects a sea-surface-temperature field (seeded from the latitudinal
// base) along the currents, writes it back over ocean cells, and nudges each
// coastal land cell toward the anomaly of its adjacent ocean (a cold current
// cools the coast, a warm one mildens it). `current` is the normalized field
// from computeOceanCurrents.
export function applyOceanSST(temperature: Float32Array, current: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): void {
  const n = RX * RY
  const land = new Uint8Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      land[gy * RX + gx] = isLandAtCell(elevation, dryLand, gx, gy, worldWidth, worldHeight) ? 1 : 0
    }
  }

  // Advect SST from the base. Land cells stay at base (never updated), so a
  // sample near the coast blends in a sane value rather than garbage.
  let sst = temperature.slice()
  for (let iter = 0; iter < CLIMATE_TUNING.currentsAdvectIters; iter++) {
    const next = sst.slice()
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (land[i]) continue
        const u = current[i * 2]
        const v = current[i * 2 + 1]
        const advected = sampleBilinearGrid(sst, RX, RY, gx - u * CLIMATE_TUNING.currentsAdvectStep, gy - v * CLIMATE_TUNING.currentsAdvectStep)
        next[i] = advected * (1 - CLIMATE_TUNING.currentsBaseRelax) + temperature[i] * CLIMATE_TUNING.currentsBaseRelax
      }
    }
    sst = next
  }

  // Coastal band: build the SST anomaly on ocean cells (uses the original base,
  // still in temperature[] here), then propagate it inland — each land cell
  // takes its strongest neighbour's anomaly, decayed — so the maritime
  // influence reaches a few cells past the shoreline instead of one.
  const anomaly = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) anomaly[i] = sst[i] - temperature[i]
  for (let step = 0; step < CLIMATE_TUNING.currentsCoastalSteps; step++) {
    const next = anomaly.slice()
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (!land[i]) continue
        let best = 0
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const a = anomaly[wrapIndex(gx + dx, gy + dy)]
          if (Math.abs(a) > Math.abs(best)) best = a
        }
        next[i] = best * CLIMATE_TUNING.currentsCoastalDecay
      }
    }
    for (let i = 0; i < n; i++) if (land[i]) anomaly[i] = next[i]
  }
  for (let i = 0; i < n; i++) if (land[i]) temperature[i] += CLIMATE_TUNING.currentsCoastalFactor * anomaly[i]

  // Ocean cells take the sea-surface temperature (so the temperature overlay
  // shows the current structure too).
  for (let i = 0; i < n; i++) {
    if (!land[i]) temperature[i] = sst[i]
  }
}

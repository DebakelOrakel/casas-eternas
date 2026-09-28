import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, latitudeAt } from './climateField'
import { CLIMATE_TUNING } from './climateTuneParams'
import { sampleBilinearGrid } from '../core/field'
import { wrapIndex2 } from '../core/field'

const RX = CLIMATE_RES_X
const RY = CLIMATE_RES_Y

const wrapIndex = (x: number, y: number): number => wrapIndex2(x, y, RX, RY)

// Wind-driven ocean surface currents as gyres, on the climate grid. Solves a
// streamfunction ψ forced by the wind-stress curl, then derives the
// (non-divergent) velocity. Returns it interleaved [u0,v0,…], normalized to a
// max magnitude of 1, zero on land. The velocity sign is set so subtropical
// gyres carry WARM water poleward along western ocean boundaries (mild eastern
// continental coasts) and COLD water equatorward along eastern ocean
// boundaries (cool, upwelling western continental coasts) — validated against
// that pattern. See docs/decisions/climate-biomes.md.
//
// The equation is Stommel's (2026-09-28, docs/design/climate-refinement.md):
// ∇²ψ + β·∂ψ/∂x = curl, friction 1 per cell. The β term (the Coriolis
// parameter grows toward the poles) makes the gyres asymmetric: a narrow,
// fast current on the western side of a basin (Gulf Stream, Kuroshio), broad
// slow flow on the eastern side. Before, the equation was ∇²ψ = curl and the
// gyres were symmetric.
//
// Each landmass is an island with a ψ of its own (the island rule), not ψ = 0
// for all land. The largest landmass is the reference at 0; every other one
// is one unknown, whose equation is the sum of the cell equations over its
// cells: the circulation around its coast. So net flow passes between two
// landmasses, and an open zonal band gives a circumpolar current.
// `equatorOffset` places the latitude for β (see climateField.shiftedYNorm).
export function computeOceanCurrents(elevation: Float32Array, wind: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array, equatorOffset = 0): Float32Array {
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

  // Half of β per row, for the central difference: β·cos(latitude), the same
  // sign in both hemispheres.
  const halfBeta = new Float32Array(RY)
  for (let gy = 0; gy < RY; gy++) halfBeta[gy] = CLIMATE_TUNING.currentsBeta * Math.cos(latitudeAt(gy, equatorOffset) * Math.PI / 2) / 2

  // The four wrapped neighbours of every cell are indexed once: at 700 sweeps
  // the wrapping's modulos were 0.6 s of every history epoch (profiled
  // 2026-09-26).
  const left = new Int32Array(n)
  const right = new Int32Array(n)
  const up = new Int32Array(n)
  const down = new Int32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      left[i] = wrapIndex(gx - 1, gy)
      right[i] = wrapIndex(gx + 1, gy)
      up[i] = wrapIndex(gx, gy - 1)
      down[i] = wrapIndex(gx, gy + 1)
    }
  }

  const islands = findIslands(land, left, right, up, down, halfBeta, curl)

  // Gauss-Seidel in place over the ocean cells, then one update per island.
  // An island's value is written to its coast cells only: they are the only
  // land cells an ocean cell reads.
  const psi = new Float32Array(n)
  for (let iter = 0; iter < CLIMATE_TUNING.currentsSolveIters; iter++) {
    for (let i = 0; i < n; i++) {
      if (land[i]) continue
      const b = halfBeta[(i / RX) | 0]
      psi[i] = (psi[left[i]] + psi[right[i]] + psi[up[i]] + psi[down[i]] + b * (psi[right[i]] - psi[left[i]]) - curl[i]) / 4
    }
    for (const island of islands) {
      let sum = -island.curl
      for (const j of island.faces) sum += psi[j]
      for (let k = 0; k < island.east.length; k++) sum += island.eastBeta[k] * psi[island.east[k]]
      for (let k = 0; k < island.west.length; k++) sum -= island.westBeta[k] * psi[island.west[k]]
      const value = sum / island.faces.length
      for (const c of island.coast) psi[c] = value
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

interface Island {
  // Its coast cells (land with an ocean neighbour), which carry its ψ.
  coast: Int32Array
  // One entry per face to the ocean: the ocean cell's index.
  faces: Int32Array
  // The ocean cells east and west of its cells, with half of β on their row:
  // what the β term leaves after the sum over the island telescopes.
  east: Int32Array
  eastBeta: Float32Array
  west: Int32Array
  westBeta: Float32Array
  // The wind-stress curl summed over its cells.
  curl: number
}

// The landmasses (4-connected, wrapped) except the largest, which stays the
// reference at ψ = 0. A landmass with no ocean face (the whole world) has no
// equation and is left out too.
function findIslands(land: Uint8Array, left: Int32Array, right: Int32Array, up: Int32Array, down: Int32Array, halfBeta: Float32Array, curl: Float32Array): Island[] {
  const n = land.length
  const label = new Int32Array(n).fill(-1)
  const members: number[][] = []
  const stack: number[] = []
  for (let seed = 0; seed < n; seed++) {
    if (!land[seed] || label[seed] >= 0) continue
    const id = members.length
    const cells: number[] = []
    label[seed] = id
    stack.push(seed)
    while (stack.length > 0) {
      const i = stack.pop()!
      cells.push(i)
      for (const j of [left[i], right[i], up[i], down[i]]) {
        if (land[j] && label[j] < 0) {
          label[j] = id
          stack.push(j)
        }
      }
    }
    members.push(cells)
  }
  let largest = -1
  for (let id = 0; id < members.length; id++) if (largest < 0 || members[id].length > members[largest].length) largest = id

  const islands: Island[] = []
  for (let id = 0; id < members.length; id++) {
    if (id === largest) continue
    const coast: number[] = []
    const faces: number[] = []
    const east: number[] = []
    const eastBeta: number[] = []
    const west: number[] = []
    const westBeta: number[] = []
    let curlSum = 0
    for (const i of members[id]) {
      curlSum += curl[i]
      const before = faces.length
      for (const j of [left[i], right[i], up[i], down[i]]) if (!land[j]) faces.push(j)
      if (faces.length > before) coast.push(i)
      const b = halfBeta[(i / RX) | 0]
      if (!land[right[i]]) { east.push(right[i]); eastBeta.push(b) }
      if (!land[left[i]]) { west.push(left[i]); westBeta.push(b) }
    }
    if (faces.length === 0) continue
    islands.push({
      coast: Int32Array.from(coast), faces: Int32Array.from(faces),
      east: Int32Array.from(east), eastBeta: Float32Array.from(eastBeta),
      west: Int32Array.from(west), westBeta: Float32Array.from(westBeta),
      curl: curlSum,
    })
  }
  return islands
}

// Applies the ocean currents' heat transport to the temperature field (°C, in
// place): advects a sea-surface-temperature field (seeded from the latitudinal
// base) along the currents, writes it back over ocean cells, and nudges each
// coastal land cell toward the anomaly of its adjacent ocean (a cold current
// cools the coast, a warm one mildens it). `current` is the normalized field
// from computeOceanCurrents.
// Returns the current's own mark on the sea: SST minus the base temperature,
// °C per ocean cell, 0 on land. Positive is a warm current, negative a cold
// one — what the map colours the currents by.
export function applyOceanSST(temperature: Float32Array, current: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, dryLand?: Uint8Array): Float32Array {
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
  const oceanAnomaly = anomaly.slice()
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
  return oceanAnomaly
}

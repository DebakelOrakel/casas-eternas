import { CLIMATE_RES_X, CLIMATE_RES_Y, isLandAtCell, latitudeAt, shiftedYNorm } from './climateField'
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

  // Wind-stress curl, ∂τ_v/∂x − ∂τ_u/∂y in grid axes (central differences).
  // For the history's banded wind the first term is exactly 0 (the wind is
  // the same along a row), so the epochs' result is the same bit for bit as
  // before the term (2026-09-28); the climate step's pressure wind has it.
  const curl = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const uUp = wind[wrapIndex(gx, gy - 1) * 2]
      const uDown = wind[wrapIndex(gx, gy + 1) * 2]
      const vLeft = wind[wrapIndex(gx - 1, gy) * 2 + 1]
      const vRight = wind[wrapIndex(gx + 1, gy) * 2 + 1]
      curl[gy * RX + gx] = (vRight - vLeft) / 2 - (uDown - uUp) / 2
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

// THE OVERTURNING'S SURFACE INFLOW (build step 9 of
// docs/design/climate-refinement.md): the surface water drawn toward where
// it sinks. The wind-driven currents above are a streamfunction, flow with
// no sources or sinks; a sinking sea is a sink, so its inflow is the other
// half of a velocity field, a potential: ∇²χ = −s, u = ∇χ, with the sinking
// as `s` and the water that sank coming up again spread over the whole sea
// (so the field balances), and no flow into a coast (the potential mirrors
// at land). Returns [u, v] per cell, 0 on land, scaled so its fastest cell
// is 1.
export function computeSinkInflow(sink: Float32Array, land: Uint8Array): Float32Array {
  const n = RX * RY
  let total = 0
  let sea = 0
  for (let i = 0; i < n; i++) {
    if (land[i]) continue
    total += sink[i]
    sea++
  }
  const inflow = new Float32Array(n * 2)
  if (total <= 0 || sea === 0) return inflow
  const rise = total / sea
  const source = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) source[i] = sink[i] - rise

  const neighbours = (gx: number, gy: number): [number, number, number, number] => [wrapIndex(gx - 1, gy), wrapIndex(gx + 1, gy), wrapIndex(gx, gy - 1), wrapIndex(gx, gy + 1)]
  const chi = new Float32Array(n)
  for (let iter = 0; iter < CLIMATE_TUNING.conveyorSolveIters; iter++) {
    for (let gy = 0; gy < RY; gy++) {
      for (let gx = 0; gx < RX; gx++) {
        const i = gy * RX + gx
        if (land[i]) continue
        // A land neighbour stands in with this cell's own value: no flow
        // across the coast.
        let sum = 0
        for (const j of neighbours(gx, gy)) sum += land[j] ? chi[i] : chi[j]
        chi[i] = (sum + source[i]) / 4
      }
    }
  }
  let fastest = 0
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const [l, r, u, d] = neighbours(gx, gy)
      const at = (j: number): number => (land[j] ? chi[i] : chi[j])
      const vx = (at(r) - at(l)) / 2
      const vy = (at(d) - at(u)) / 2
      inflow[i * 2] = vx
      inflow[i * 2 + 1] = vy
      fastest = Math.max(fastest, Math.hypot(vx, vy))
    }
  }
  if (fastest > 0) for (let k = 0; k < inflow.length; k++) inflow[k] /= fastest
  return inflow
}

// Ekman upwelling on the climate grid (build step 3 of
// docs/design/climate-refinement.md): the wind pushes the surface water at a
// right angle to itself, to the right in the northern hemisphere and to the
// left in the southern (transport = τ × k / f). Where that transport diverges
// — off a coast the wind runs along, and at the equator under the trade
// winds, where f changes sign — cold water comes up from below. Returns the
// divergence per ocean cell, positive where water comes up, 0 on land.
// `land` is 1 on land cells; the transport is 0 there, so a coast with the
// water moving away from it diverges.
export function computeUpwelling(wind: Float32Array, land: Uint8Array, equatorOffset: number, rotationHours: number): Float32Array {
  const n = RX * RY
  // Transport in grid axes (x east, y down).
  const ex = new Float32Array(n)
  const ey = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const sLat = (latitudeSign(gy, equatorOffset))
    // f, northern (top) hemisphere positive, held off zero near the
    // equator with its sign kept, so the transport stays finite there.
    const f = sLat * Math.max(CLIMATE_TUNING.upwellingMinF, Math.abs(Math.sin(latitudeAt(gy, equatorOffset) * Math.PI / 2))) * (24 / rotationHours)
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const u = wind[i * 2]
      const vNorth = -wind[i * 2 + 1]
      // τ × k / f in north-up axes: (τ_n, −τ_u) / f.
      ex[i] = vNorth / f
      ey[i] = u / f // −(−τ_u / f): the y axis points south
    }
  }
  // The divergence over the cell's four faces; a face with land on either
  // side carries nothing. So a coast cell with the water leaving it takes the
  // whole transport as upwelling, not half of it as a central difference
  // would give.
  const face = (a: number, b: number, fa: number, fb: number): number => (land[a] || land[b] ? 0 : (fa + fb) / 2)
  const out = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (land[i]) continue
      const r = wrapIndex(gx + 1, gy)
      const l = wrapIndex(gx - 1, gy)
      const d = wrapIndex(gx, gy + 1)
      const u = wrapIndex(gx, gy - 1)
      out[i] = face(i, r, ex[i], ex[r]) - face(l, i, ex[l], ex[i]) + face(i, d, ey[i], ey[d]) - face(u, i, ey[u], ey[i])
    }
  }
  return out
}

// How far east a sea cell lies in its basin, along its row: 0 at the western
// shore, 1 at the eastern, 0.5 where the row has no shore. The thermocline
// tilts with the trade winds — deep under the warm pool in the west, shallow
// in the east — so upwelling brings cold water only in the east (the
// equatorial cold tongue).
export function eastwardInBasin(land: Uint8Array): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n).fill(0.5)
  for (let gy = 0; gy < RY; gy++) {
    for (let x0 = 0; x0 < RX; x0++) {
      // A run of sea starts after a land cell.
      if (!land[gy * RX + x0] || land[gy * RX + (x0 + 1) % RX]) continue
      let len = 0
      while (len < RX && !land[gy * RX + (x0 + 1 + len) % RX]) len++
      for (let k = 0; k < len; k++) out[gy * RX + (x0 + 1 + k) % RX] = len > 1 ? k / (len - 1) : 0.5
    }
  }
  return out
}

// Where a sea cell lies across its basin, along its row: −1 at the western
// shore, +1 at the eastern, scaled down in a basin narrower than
// `fullWidthCells` (a sea between two coasts close together has no east and
// west of its own); 0 where the row has no shore.
export function basinFlank(land: Uint8Array, fullWidthCells: number): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    for (let x0 = 0; x0 < RX; x0++) {
      if (!land[gy * RX + x0] || land[gy * RX + (x0 + 1) % RX]) continue
      let len = 0
      while (len < RX && !land[gy * RX + (x0 + 1 + len) % RX]) len++
      if (len < 2) continue
      const width = Math.min(1, len / fullWidthCells)
      for (let k = 0; k < len; k++) out[gy * RX + (x0 + 1 + k) % RX] = (2 * k / (len - 1) - 1) * width
    }
  }
  return out
}

// The sea's anomaly on the land, °C per land cell: the air takes the anomaly
// of the sea it last crossed and loses it over land, e^(−d / L) after d cells
// (`currentsInlandDecayCells`), looked for up to `currentsInlandReachCells`
// upwind along `wind`. So the westerlies carry the North Atlantic's warmth
// deep into Europe, and a coast the wind leaves for the sea (an east coast
// in the westerlies, a west coast in the trades) gets only the breeze off
// its own shore: `currentsCoastalLeeShare` of its strongest neighbouring
// sea cell. Until 2026-09-29 every coast took its neighbour's anomaly the
// same way, four cells in, whatever the wind, and Europe's interior got
// little of the North Atlantic's (on Earth's relief Oslo's year came out
// 4 °C too cold, now 1).
export function carryInland(seaAnomaly: Float32Array, land: Uint8Array, wind: Float32Array): Float32Array {
  const n = RX * RY
  const out = new Float32Array(n)
  const reach = CLIMATE_TUNING.currentsInlandReachCells
  for (let gy = 0; gy < RY; gy++) {
    for (let gx = 0; gx < RX; gx++) {
      const i = gy * RX + gx
      if (!land[i]) continue
      let lee = 0
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const a = seaAnomaly[wrapIndex(gx + dx, gy + dy)]
        if (Math.abs(a) > Math.abs(lee)) lee = a
      }
      let carried = 0
      const u = wind[i * 2]
      const v = wind[i * 2 + 1]
      const speed = Math.hypot(u, v)
      if (speed > 0) {
        for (let k = 1; k <= reach; k++) {
          const j = wrapIndex(Math.round(gx - (u / speed) * k), Math.round(gy - (v / speed) * k))
          if (land[j]) continue
          carried = seaAnomaly[j] * Math.exp(-(k - 1) / CLIMATE_TUNING.currentsInlandDecayCells)
          break
        }
      }
      const breeze = lee * CLIMATE_TUNING.currentsCoastalLeeShare
      out[i] = Math.abs(carried) > Math.abs(breeze) ? carried : breeze
    }
  }
  return out
}

// +1 in the top (northern) hemisphere, −1 in the bottom one.
function latitudeSign(gy: number, equatorOffset: number): number {
  return shiftedYNorm(gy, RY, equatorOffset) < 0.5 ? 1 : -1
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
// base) along the currents, writes it back over ocean cells, and carries the
// sea's anomaly onto the land with the wind (a cold current cools the coast
// downwind of it, a warm one mildens it). `current` is the normalized field
// from computeOceanCurrents, `wind` the [u, v] the air moves by (see
// carryInland).
// Returns the current's own mark on the sea: SST minus the base temperature,
// °C per ocean cell, 0 on land. Positive is a warm current, negative a cold
// one — what the map colours the currents by.
export function applyOceanSST(temperature: Float32Array, current: Float32Array, elevation: Float32Array, worldWidth: number, worldHeight: number, wind: Float32Array, dryLand?: Uint8Array): Float32Array {
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

  // The SST anomaly on ocean cells (uses the original base, still in
  // temperature[] here), then onto the land with the wind (carryInland).
  const oceanAnomaly = new Float32Array(n)
  for (let i = 0; i < n; i++) if (!land[i]) oceanAnomaly[i] = sst[i] - temperature[i]
  const inland = carryInland(oceanAnomaly, land, wind)
  for (let i = 0; i < n; i++) if (land[i]) temperature[i] += CLIMATE_TUNING.currentsCoastalFactor * inland[i]

  // Ocean cells take the sea-surface temperature (so the temperature overlay
  // shows the current structure too).
  for (let i = 0; i < n; i++) {
    if (!land[i]) temperature[i] = sst[i]
  }
  return oceanAnomaly
}

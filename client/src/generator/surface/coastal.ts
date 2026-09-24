import { ELEVATION_METERS, SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { SURFACE_TUNING } from './surfaceTuneParams'

// THE COAST AS A PROCESS (ADAPTIVE_MESH_PLAN.md phase 7, docs/design/
// coast.md; decided 2026-09-24: one-dimensional transport along the
// shore, the sea level a global scalar with the relative uplift per node,
// a wave base of ten metres, tides deferred): what the sea itself shapes
// on the terrain of one epoch, on the mesh, in the coupled loop after the
// rivers ran and before the plate answers.
//
// THE SHORE is where it always was — a land node with a sea neighbour —
// and on the mesh that is the iso-line at the mesh's own resolution; its
// nodes, linked to their shore neighbours, are the one-dimensional line
// the transport runs on. The coast graph the hydrology stage builds after
// the stop (surface/coastGraph.ts, F5) stays the classification and the
// picture; this is the physics under it.
//
// WAVE EROSION: the exposure of a shore node is the wave energy from the
// wind — speed² times the fetch, the open water upwind on the climate
// raster, F5's own rule, normalised to the shore's 90th percentile. The
// sea cuts the shore node down towards the WAVE BASE at a rate that goes
// with the exposure over the rock's hardness (a soft exposed coast goes
// fast, a hard sheltered one hardly moves); a node cut under the sea is
// sea from then on — the shore has retreated, and the land behind it
// stands as a CLIFF, which is a steep gradient at the shore, not a form
// of its own. Terraces come where the uplift and the sea's stands cross,
// with no rule.
//
// THE DRIFT: the one-line model (Pelnard-Considère). Each shore node hands
// sediment to the shore neighbour that lies downdrift — the side the wind
// pushes along the shore — at most its CAPACITY, which goes with the
// exposure and the angle between the waves and the shore. What arrives
// beyond the capacity settles on the node's sea neighbours, up to the
// freeboard: a beach in a bay, and past a headland, where the capacity
// falls in the lee, land that grows in the drift direction — a spit —
// with no rule that says "spit". The supply is the cliffs' retreat and
// the rivers' loads at their mouths; what runs off the end of a line, or
// finds no room, is exported to the deep water.
//
// Not here: the shore generator below the resolution (beach profile,
// dune belt, lagoon — the tile), marshes and mangroves as biomes (a
// classification with catalog keys), tides.

export interface CoastalInputs {
  mesh: PeriodicTriangulation
  // Heights per slot, elevation units, AFTER the epoch's fluvial erosion.
  z: Float32Array
  // Voronoi areas per slot, macro cells.
  areas: Float32Array
  // The wind on the climate grid ([u, v] interleaved, climate/wind.ts) and
  // the terrain's rasterisation there, for the fetch.
  wind: Float32Array
  coarseZ: Float32Array
  climateResX: number
  climateResY: number
  width: number
  height: number
  // Metres per domain unit.
  cellM: number
  // The rock's hardness per slot (the forcing's K factor, 1 neutral).
  hardness: Float32Array
  // The rivers' loads per slot from the epoch's walk (the ξ–q flux, m³
  // per iteration) and the iterations the epoch ran: a mouth's supply.
  sedimentFlux: Float32Array
  iterations: number
  epochYears: number
}

export interface CoastalResult {
  // Per slot, metres: the wave erosion's lowering (shore nodes), the
  // drift's deposit (sea nodes beside the shore).
  cutM: Float32Array
  depositM: Float32Array
  // Per slot: the exposure of the shore nodes (0..1, else 0).
  exposure: Float32Array
  shoreNodes: number
  // The ledger, m³: what the waves cut and the rivers brought, what the
  // drift laid down, what left for the deep water; in = out.
  erodedM3: number
  suppliedM3: number
  depositedM3: number
  exportedM3: number
}

function normaliseToP90(values: Float32Array, members: Int32Array): void {
  const sorted: number[] = []
  for (let i = 0; i < members.length; i++) sorted.push(values[members[i]])
  sorted.sort((a, b) => a - b)
  const p90 = sorted.length > 0 ? sorted[Math.floor(0.9 * (sorted.length - 1))] : 0
  if (p90 <= 0) return
  for (let i = 0; i < members.length; i++) values[members[i]] = Math.min(1, values[members[i]] / p90)
}

export function computeCoastal(input: CoastalInputs): CoastalResult {
  const { mesh, z, areas, wind, coarseZ, climateResX: RX, climateResY: RY, width, height, cellM, hardness, sedimentFlux, iterations, epochYears } = input
  const T = SURFACE_TUNING
  const slots = mesh.vertexSlots
  const cutM = new Float32Array(slots)
  const depositM = new Float32Array(slots)
  const exposure = new Float32Array(slots)
  const out = new Int32Array(64)
  const cellM2 = cellM * cellM
  const empty = { cutM, depositM, exposure, shoreNodes: 0, erodedM3: 0, suppliedM3: 0, depositedM3: 0, exportedM3: 0 }

  // THE SHORE: land nodes with a sea neighbour; the landward normal from
  // the sea neighbours' mean offset.
  const isShore = new Uint8Array(slots)
  const shoreList: number[] = []
  const normalX = new Float32Array(slots)
  const normalY = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const n = mesh.outgoing(v, out)
    let nx = 0
    let ny = 0
    let seaCount = 0
    for (let k = 0; k < n; k++) {
      const u = mesh.to(out[k])
      if (z[u] > SEA_LEVEL) continue
      seaCount++
      nx += mesh.vx[v] - mesh.vx[u] > width / 2 ? mesh.vx[v] - mesh.vx[u] - width : mesh.vx[v] - mesh.vx[u] < -width / 2 ? mesh.vx[v] - mesh.vx[u] + width : mesh.vx[v] - mesh.vx[u]
      ny += mesh.vy[v] - mesh.vy[u] > height / 2 ? mesh.vy[v] - mesh.vy[u] - height : mesh.vy[v] - mesh.vy[u] < -height / 2 ? mesh.vy[v] - mesh.vy[u] + height : mesh.vy[v] - mesh.vy[u]
    }
    if (seaCount === 0) continue
    isShore[v] = 1
    shoreList.push(v)
    const len = Math.hypot(nx, ny) || 1
    normalX[v] = nx / len
    normalY[v] = ny / len
  }
  if (shoreList.length === 0) return empty
  const shore = Int32Array.from(shoreList)

  // EXPOSURE: the wind at the climate cell, the fetch upwind over the sea
  // on the climate raster (F5's rule), speed² × fetch, to the p90.
  const fetchCap = Math.max(1, Math.round((T.coastFetchCapKm * 1000) / ((width / RX) * cellM)))
  const windU = new Float32Array(slots)
  const windV = new Float32Array(slots)
  for (let i = 0; i < shore.length; i++) {
    const v = shore[i]
    const gx = Math.min(RX - 1, Math.max(0, Math.floor((mesh.vx[v] / width) * RX)))
    const gy = Math.min(RY - 1, Math.max(0, Math.floor((mesh.vy[v] / height) * RY)))
    const gi = gy * RX + gx
    const u = wind[gi * 2]
    const w = wind[gi * 2 + 1]
    windU[v] = u
    windV[v] = w
    const speed = Math.hypot(u, w)
    if (speed <= 1e-6) continue
    const dx = -u / speed
    const dy = -w / speed
    let fetch = 0
    let px = gx + 0.5
    let py = gy + 0.5
    for (let k = 0; k < fetchCap; k++) {
      px += dx
      py += dy
      const cx = ((Math.floor(px) % RX) + RX) % RX
      const cy = ((Math.floor(py) % RY) + RY) % RY
      if (coarseZ[cy * RX + cx] > SEA_LEVEL) break
      fetch++
    }
    exposure[v] = speed * speed * (fetch / fetchCap)
  }
  normaliseToP90(exposure, shore)

  // WAVE EROSION: the shore retreats at coastRetreatPerYr × exposure over
  // the hardness; a node's share of that is the retreat over its own
  // width, taken as a lowering of the node towards the wave base (a node
  // half retreated is half cut), the material into the drift's supply.
  const supply = new Float64Array(slots)
  let erodedM3 = 0
  let suppliedM3 = 0
  for (let i = 0; i < shore.length; i++) {
    const v = shore[i]
    const zM = elevationToMeters(z[v] - SEA_LEVEL)
    const room = zM + T.coastWaveBaseM
    if (room <= 0) continue
    const retreatM = ((T.coastRetreatPerYr * exposure[v]) / Math.max(0.25, hardness[v])) * epochYears
    const widthM = Math.sqrt(areas[v]) * cellM
    const cut = room * Math.min(1, retreatM / widthM)
    if (cut <= 0) continue
    cutM[v] = cut
    const volume = cut * areas[v] * cellM2
    supply[v] += volume
    erodedM3 += volume
  }
  // The rivers: a shore node's flux (the ξ–q flux through the last land
  // node before the sea) is the mouth's supply for the epoch.
  for (let i = 0; i < shore.length; i++) {
    const v = shore[i]
    const q = sedimentFlux[v]
    if (q > 0) { supply[v] += q * iterations; suppliedM3 += q * iterations }
  }

  // THE DRIFT along the shore: each shore node's downdrift shore
  // neighbour is the one whose direction from the node runs with the
  // wind's alongshore component; the capacity goes with the exposure and
  // the angle between the wind (the waves) and the shore.
  const target = new Int32Array(slots).fill(-1)
  const capacity = new Float64Array(slots)
  for (let i = 0; i < shore.length; i++) {
    const v = shore[i]
    const u = windU[v]
    const w = windV[v]
    const speed = Math.hypot(u, w)
    if (speed <= 1e-6) continue
    // The alongshore direction of the wind: the wind less its component
    // along the landward normal.
    const along = (u * normalX[v] + w * normalY[v])
    const ax = u - along * normalX[v]
    const ay = w - along * normalY[v]
    const aLen = Math.hypot(ax, ay)
    if (aLen <= 1e-6) continue
    const n = mesh.outgoing(v, out)
    let best = -1
    let bestDot = 0.2
    for (let k = 0; k < n; k++) {
      const c = mesh.to(out[k])
      if (!isShore[c]) continue
      let dx = mesh.vx[c] - mesh.vx[v]
      let dy = mesh.vy[c] - mesh.vy[v]
      if (dx > width / 2) dx -= width
      if (dx < -width / 2) dx += width
      if (dy > height / 2) dy -= height
      if (dy < -height / 2) dy += height
      const len = Math.hypot(dx, dy) || 1
      const dot = (dx * ax + dy * ay) / (len * aLen)
      if (dot > bestDot) { bestDot = dot; best = c }
    }
    target[v] = best
    // sin(2θ) of the wave's angle to the shore normal: no transport when
    // the waves come straight in or run parallel; most at 45°.
    const cosTheta = Math.min(1, Math.abs(along) / speed)
    const sin2 = 2 * cosTheta * Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta))
    capacity[v] = T.coastDriftCapacityM3PerYr * exposure[v] * sin2 * epochYears
  }

  // The transfer: what a node passes on is at most its capacity; the rest
  // settles on its sea neighbours up to the freeboard, and what finds no
  // room is exported. The targets form chains and rings (an island's
  // shore, a coast around the torus): the chains are walked in order
  // (every node after all that feed it); the rings, where the sediment
  // circulates, are swept until the flow settles — around a ring the
  // outflow saturates at the capacity and the rest is excess.
  const inDegree = new Int32Array(slots)
  for (let i = 0; i < shore.length; i++) if (target[shore[i]] >= 0) inDegree[target[shore[i]]]++
  const inflow = new Float64Array(slots)
  const outflow = new Float64Array(slots)
  const done = new Uint8Array(slots)
  const queue: number[] = []
  for (let i = 0; i < shore.length; i++) if (inDegree[shore[i]] === 0) queue.push(shore[i])
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]
    done[v] = 1
    const have = supply[v] + inflow[v]
    const q = target[v] >= 0 ? Math.min(capacity[v], have) : 0
    outflow[v] = q
    const t = target[v]
    if (t >= 0) {
      inflow[t] += q
      if (--inDegree[t] === 0) queue.push(t)
    }
  }
  const ring: number[] = []
  for (let i = 0; i < shore.length; i++) if (!done[shore[i]]) ring.push(shore[i])
  if (ring.length > 0) {
    // The rings' own inflow from the chains is in `inflow` already; the
    // ring's part is recomputed every sweep.
    const chainInflow = new Float64Array(slots)
    for (const v of ring) chainInflow[v] = inflow[v]
    for (let sweep = 0; sweep < 2 * ring.length + 2; sweep++) {
      for (const v of ring) inflow[v] = chainInflow[v]
      for (const v of ring) { const t = target[v]; if (t >= 0) inflow[t] += outflow[v] }
      let moved = 0
      for (const v of ring) {
        const q = Math.min(capacity[v], supply[v] + inflow[v])
        if (Math.abs(q - outflow[v]) > 1) moved++
        outflow[v] = q
      }
      if (moved === 0) break
    }
    for (const v of ring) inflow[v] = chainInflow[v]
    for (const v of ring) { const t = target[v]; if (t >= 0) inflow[t] += outflow[v] }
  }
  let depositedM3 = 0
  let exportedM3 = 0
  const freeboard = T.coastDepositFreeboardM / ELEVATION_METERS
  const maxDepth = -T.coastDepositMaxDepthM / ELEVATION_METERS
  for (let i = 0; i < shore.length; i++) {
    const v = shore[i]
    let excess = supply[v] + inflow[v] - outflow[v]
    if (excess <= 0) continue
    // Onto the SHALLOW sea neighbours (a beach and a spit build in the
    // nearshore; what falls off the shelf is exported).
    const n = mesh.outgoing(v, out)
    let seaCount = 0
    for (let k = 0; k < n; k++) { const u = mesh.to(out[k]); if (z[u] <= SEA_LEVEL && z[u] >= maxDepth) seaCount++ }
    if (seaCount > 0) {
      const share = excess / seaCount
      for (let k = 0; k < n; k++) {
        const u = mesh.to(out[k])
        if (z[u] > SEA_LEVEL || z[u] < maxDepth) continue
        const roomM = Math.max(0, (freeboard - z[u] - depositM[u] / ELEVATION_METERS) * ELEVATION_METERS)
        const areaM2 = areas[u] * cellM2
        const take = Math.min(share, roomM * areaM2)
        depositM[u] += take / areaM2
        depositedM3 += take
        excess -= take
      }
    }
    exportedM3 += Math.max(0, excess)
  }
  return { cutM, depositM, exposure, shoreNodes: shore.length, erodedM3, suppliedM3, depositedM3, exportedM3 }
}

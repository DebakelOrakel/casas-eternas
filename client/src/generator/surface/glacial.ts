import { ELEVATION_METERS, SEA_LEVEL, elevationToMeters } from '../elevation/elevationScale'
import { CLIMATE_TUNING } from '../climate/climateTuneParams'
import { OCEAN_PRECIP } from '../climate/precipitation'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { detExp, detPow } from '../core/detMath'

// ICE AS A PROCESS (ADAPTIVE_MESH_PLAN.md phase 6, docs/design/glacial.md;
// decided 2026-09-23: steady state per epoch, cirques as an ELA band in
// the erosion rule, the ice may rebuild the network, no sliders, the
// climate class `Ice` stays and `Glacier` is the ice body): the ice of one
// epoch's climate on the macro mesh, the erosion it does, the till it
// leaves.
//
// THE ICE is F4's balance-flux inversion (surface/iceFlow.ts, the raster
// forerunner) on the mesh: the mass balance per node from the epoch's
// coarse climate brought to the node's height by the lapse, routed down
// the steepest descent of the ice SURFACE (rock plus ice) into a flux,
// the thickness from the flux and the slope by Glen's law, a dozen rounds
// to the fixed point. Ice equilibrates in millennia and an epoch is a
// million years, so the steady state IS the epoch's ice. The equilibrium
// line (ELA) per climate cell is where that balance crosses zero.
//
// THE EROSION goes with the basal sliding, thickness × surface slope
// (Hallet): a thick glacier in a steep valley cuts, a flat sheet's
// interior does not. Its forms need no rule of their own — the trough's
// floor takes the most (a U), converging ice overdeepens (a lake when it
// is gone, a fjord when the sea comes back). The one addition is the
// BUZZSAW: an extra peak at the ice margin near the ELA, where freeze and
// thaw quarry the headwalls — cirques, and summits planed towards the
// line.
//
// THE TILL: what the ice cut travels with the flow to the terminus — the
// node where the ice ends — and is laid down there as a moraine, a layer
// of coarse and fine with the epoch's (cold) climate as its provenance;
// the water-level model of the next epoch then fills what a moraine dams.
// The fluvial erosion rests under the ice (the engine's erodibility is
// zero there); the ice is a load on the plate (the flexure).

export interface MeshIceResult {
  // Ice thickness per vertex slot, metres.
  thickness: Float32Array
  // The mass balance per slot, m/yr (accumulation − melt).
  balance: Float32Array
  // The ice-surface receiver per slot (−1 at a sink), and the surface slope.
  receiver: Int32Array
  slope: Float32Array
  // Nodes ordered by the ice surface, highest first (the flow's order).
  order: Int32Array
  // The equilibrium line altitude per slot, metres (the climate cell's).
  elaM: Float32Array
  // The ledger, m³/yr: the positive balance that fed the ice, the melt it
  // paid on the way, what left at sinks (calving into the sea or a lake) —
  // in = melt + out, the conservation the harness closes.
  massIn: number
  massMelt: number
  massOut: number
}

export interface MeshIceInputs {
  mesh: PeriodicTriangulation
  z: Float32Array
  // The climate grid's temperature, precipitation and the terrain's mean
  // height per climate cell (elevation units) — the lapse's reference.
  temperature: Float32Array
  precipitation: Float32Array
  coarseZ: Float32Array
  climateResX: number
  climateResY: number
  width: number
  height: number
  // Metres per domain unit.
  cellM: number
}

function cellOf(x: number, y: number, RX: number, RY: number, width: number, height: number): number {
  const cx = Math.min(RX - 1, Math.max(0, Math.floor((x / width) * RX)))
  const cy = Math.min(RY - 1, Math.max(0, Math.floor((y / height) * RY)))
  return cy * RX + cx
}

// The mass balance at a height, m/yr, from a climate cell's temperature
// (at its mean height) and precipitation: the snow share of the rain, the
// degree-day melt on the annual mean.
function balanceAt(zUnits: number, tc: number, zc: number, p: number): number {
  const t = SURFACE_TUNING
  const local = tc - CLIMATE_TUNING.lapseCPerElevation * (zUnits - Math.max(SEA_LEVEL, zc))
  const snow = local <= -5 ? 1 : local >= 5 ? 0 : (5 - local) / 10
  const accumulation = (p / 1000) * snow * t.iceSnowToIce
  const melt = local > t.iceMeltFromC ? (local - t.iceMeltFromC) * t.iceMeltPerDegC : 0
  return accumulation - melt
}

// The equilibrium line per climate cell, metres: the height where the
// balance crosses zero (bisection; the balance falls with warmth, so it
// rises with height). Above every height: the cell never holds ice;
// below sea level: always.
export function equilibriumLines(temperature: Float32Array, precipitation: Float32Array, coarseZ: Float32Array): Float32Array {
  const ela = new Float32Array(temperature.length)
  for (let i = 0; i < ela.length; i++) {
    let p = precipitation[i]
    if (p === OCEAN_PRECIP || p < 0) p = 0
    const tc = temperature[i]
    const zc = coarseZ[i]
    let lo = 0
    let hi = 1
    if (balanceAt(hi, tc, zc, p) <= 0) { ela[i] = ELEVATION_METERS * 2; continue }
    if (balanceAt(lo, tc, zc, p) >= 0) { ela[i] = 0; continue }
    for (let k = 0; k < 24; k++) {
      const mid = 0.5 * (lo + hi)
      if (balanceAt(mid, tc, zc, p) > 0) hi = mid
      else lo = mid
    }
    ela[i] = 0.5 * (lo + hi) * ELEVATION_METERS
  }
  return ela
}

export function computeIceOnMesh(input: MeshIceInputs): MeshIceResult {
  const { mesh, z, temperature, precipitation, coarseZ, climateResX: RX, climateResY: RY, width, height, cellM } = input
  const t = SURFACE_TUNING
  const slots = mesh.vertexSlots
  const balance = new Float32Array(slots)
  const elaM = new Float32Array(slots)
  const ela = equilibriumLines(temperature, precipitation, coarseZ)
  const thickness = new Float32Array(slots)
  const receiver = new Int32Array(slots).fill(-1)
  const slope = new Float32Array(slots)
  let iceable = 0
  const land: number[] = []
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    const c = cellOf(mesh.vx[v], mesh.vy[v], RX, RY, width, height)
    elaM[v] = ela[c]
    if (z[v] <= SEA_LEVEL) continue
    land.push(v)
    let p = precipitation[c]
    if (p === OCEAN_PRECIP || p < 0) p = 0
    balance[v] = balanceAt(z[v], temperature[c], coarseZ[c], p)
    if (balance[v] > 0) iceable++
  }
  const order = Int32Array.from(land)
  const empty = { thickness, balance, receiver, slope, order, elaM, massIn: 0, massMelt: 0, massOut: 0 }
  if (iceable === 0) return empty
  // The land nodes' Voronoi areas, once: the mesh does not change while the
  // ice finds its steady state, and the rounds below read each area twice.
  const areaOf = new Float64Array(slots)
  for (const v of land) areaOf[v] = mesh.voronoiArea(v)
  const surface = new Float32Array(slots)
  const flux = new Float64Array(slots)
  const out = new Int32Array(64)
  const gamma = t.iceFlowGamma
  // The land nodes' stars, once, in the mesh's own outgoing order (a tie in
  // the steepest descent keeps the first): the mesh does not change while
  // the ice finds its steady state, and reading the stars from the mesh in
  // every round was a third of this function's time (2026-10-02).
  const starStart = new Int32Array(land.length + 1)
  const starTo: number[] = []
  const starLength: number[] = []
  for (let i = 0; i < land.length; i++) {
    const n = mesh.outgoing(land[i], out)
    for (let k = 0; k < n; k++) {
      starTo.push(mesh.to(out[k]))
      starLength.push(mesh.edgeLength(out[k]))
    }
    starStart[i + 1] = starTo.length
  }
  const sortScratch = new Int32Array(order.length)
  let massIn = 0
  let massMelt = 0
  let massOut = 0
  for (let round = 0; round < t.iceFlowRounds; round++) {
    for (let v = 0; v < slots; v++) surface[v] = mesh.vAlive[v] ? elevationToMeters(z[v] - SEA_LEVEL) + thickness[v] : 0
    // Steepest descent on the surface over the node's star; the sea is a
    // sink (ice that reaches it calves).
    for (let i = 0; i < land.length; i++) {
      const v = land[i]
      let best = -1
      let bestDrop = 0
      for (let k = starStart[i]; k < starStart[i + 1]; k++) {
        const u = starTo[k]
        const drop = (surface[v] - surface[u]) / (starLength[k] * cellM)
        if (drop > bestDrop) { bestDrop = drop; best = u }
      }
      receiver[v] = best
      slope[v] = bestDrop
    }
    sortBySurfaceDescending(order, surface, sortScratch)
    flux.fill(0)
    massIn = 0
    massMelt = 0
    massOut = 0
    for (let i = 0; i < order.length; i++) {
      const v = order[i]
      const area = areaOf[v] * cellM * cellM
      const b = balance[v] * area
      const arriving = flux[v]
      const q = arriving + b
      if (b > 0) massIn += b
      else massMelt += Math.min(arriving, -b)
      flux[v] = q > 0 ? q : 0
      const r = receiver[v]
      if (q > 0) {
        if (r >= 0 && z[r] > SEA_LEVEL) flux[r] += q
        else massOut += q
      }
    }
    for (const v of land) {
      const q = flux[v]
      let h = 0
      if (q > 0) {
        const s = Math.max(t.iceMinSlope, slope[v])
        // The flux per unit width: over the node's cell width (its area's
        // square root), the mesh's counterpart of the raster's cell.
        const widthM = Math.sqrt(areaOf[v]) * cellM
        h = detPow((q / widthM) / (gamma * s * s * s), 0.2)
        if (h > t.iceMaxThicknessM) h = t.iceMaxThicknessM
      }
      thickness[v] = 0.5 * thickness[v] + 0.5 * h
    }
    // THE ICE AS A BODY: the inversion gives every node the thickness its
    // own flux warrants, which leaves a valley's walls bare beside a thick
    // trunk — a notch, not a glacier. An ice surface cannot fall faster
    // than iceSurfaceMaxSlope across the ice, so the trunk's surface is
    // carried out over its neighbours (highest surface first): a wall
    // node under that surface holds the ice between it and the rock. The
    // flux ledger is untouched — this is the body the flux implies.
    for (let i = 0; i < order.length; i++) {
      const v = order[i]
      if (thickness[v] <= 0) continue
      const sv = elevationToMeters(z[v] - SEA_LEVEL) + thickness[v]
      const n = mesh.outgoing(v, out)
      for (let k = 0; k < n; k++) {
        const e = out[k]
        const u = mesh.to(e)
        if (z[u] <= SEA_LEVEL) continue
        const sMin = sv - t.iceSurfaceMaxSlope * mesh.edgeLength(e) * cellM
        const zu = elevationToMeters(z[u] - SEA_LEVEL)
        const hu = sMin - zu
        if (hu > thickness[u]) thickness[u] = Math.min(t.iceMaxThicknessM, hu)
      }
    }
  }
  for (let v = 0; v < slots; v++) if (thickness[v] < t.iceMinThicknessM) thickness[v] = 0
  return { thickness, balance, receiver, slope, order, elaM, massIn, massMelt, massOut }
}

// `order.sort((a, b) => surface[b] - surface[a])`, in linear time: a stable
// LSD radix sort on the float32 surface's bits, two passes of 16 bits. The
// same permutation as the comparator sort — which the specification makes
// stable, so ties keep the order of the round before — as long as every
// surface is positive and finite, where the bits order like the numbers
// (land nodes stand above the sea, so they are; otherwise the comparator).
// The comparator sort was over half of this function's time (2026-10-02).
const RADIX = 1 << 16
const radixCount = new Int32Array(RADIX)
function sortBySurfaceDescending(order: Int32Array, surface: Float32Array, scratch: Int32Array): void {
  const bits = new Uint32Array(surface.buffer, surface.byteOffset, surface.length)
  for (let i = 0; i < order.length; i++) {
    const s = surface[order[i]]
    if (!(s > 0 && s < Infinity)) {
      order.sort((a, b) => surface[b] - surface[a])
      return
    }
  }
  let from = order
  let to = scratch
  for (let shift = 0; shift < 32; shift += 16) {
    radixCount.fill(0)
    // Descending: the complement of the bits, ascending.
    for (let i = 0; i < from.length; i++) radixCount[((~bits[from[i]]) >>> shift) & 0xffff]++
    let sum = 0
    for (let d = 0; d < RADIX; d++) { const c = radixCount[d]; radixCount[d] = sum; sum += c }
    for (let i = 0; i < from.length; i++) {
      const v = from[i]
      to[radixCount[((~bits[v]) >>> shift) & 0xffff]++] = v
    }
    const swap = from
    from = to
    to = swap
  }
  // Two passes: the result is back in `order`.
}

export interface GlacialErosionResult {
  // Per slot, metres: what the ice cut, and the till laid down (at the
  // termini). The caller moves z and the column.
  cutM: Float32Array
  tillM: Float32Array
  cutM3: number
  tillM3: number
}

// The glacial erosion of one epoch, from the ice of the epoch: the cut by
// the sliding (thickness × slope), the buzzsaw's peak near the ELA, the
// till carried down the ice's flow to the terminus. Returns per-node
// metres; the caller applies them (z and the column).
export function glacialErosionOnMesh(mesh: PeriodicTriangulation, z: Float32Array, ice: MeshIceResult, epochYears: number, cellM: number): GlacialErosionResult {
  const t = SURFACE_TUNING
  const slots = mesh.vertexSlots
  const cutM = new Float32Array(slots)
  const tillM = new Float32Array(slots)
  const carried = new Float64Array(slots)
  // Each terminus's till, in the order the ice reached it.
  const termini = new Map<number, number>()
  let cutM3 = 0
  let tillM3 = 0
  const { thickness, slope, receiver, order, elaM } = ice
  for (let i = 0; i < order.length; i++) {
    const v = order[i]
    const h = thickness[v]
    if (h < t.iceMinThicknessM) continue
    const zM = elevationToMeters(z[v] - SEA_LEVEL)
    const sliding = h * Math.max(t.iceMinSlope, slope[v])
    const nearLine = (zM - elaM[v]) / t.glacialBuzzsawBandM
    const buzzsaw = 1 + t.glacialBuzzsawBoost * detExp(-nearLine * nearLine)
    let cut = t.glacialErosionPerSliding * sliding * epochYears * buzzsaw
    if (cut > t.glacialErosionMaxM) cut = t.glacialErosionMaxM
    cutM[v] = cut
    const area = mesh.voronoiArea(v) * cellM * cellM
    cutM3 += cut * area
    carried[v] += cut * area
    // The till goes on with the ice, or stops where the ice does.
    const r = receiver[v]
    if (r >= 0 && thickness[r] >= t.iceMinThicknessM) carried[r] += carried[v]
    else {
      const at = r >= 0 && z[r] > SEA_LEVEL ? r : v
      termini.set(at, (termini.get(at) ?? 0) + carried[v])
      tillM3 += carried[v]
    }
    carried[v] = 0
  }
  for (const [at, volume] of termini) spreadTill(mesh, at, volume, cellM, tillM)
  return { cutM, tillM, cutM3, tillM3 }
}

// A terminus's till as an apron, not a pillar. A glacier's whole network
// drains to one terminus node, and all it carried went onto that node:
// every epoch with ice one node stood at the 9000 m clamp before the rivers
// ran (measured 2026-09-30 on 2048×1024, 150 of 150 epochs), the clamp
// threw the excess away, and the rivers then cut a 9 km tower. Now the
// terminus and the nodes around it, ring by ring, until the till lies no
// thicker than glacialTillMaxM; the volume is kept in full (thicker than
// the cap only when the search stops at TILL_SPREAD_MAX_NODES first).
// Ice-covered nodes take their share too: most of that till comes from
// ice sheets whose flow ends in a basin under the ice, with no ice-free
// node near (15–30 km of till on one node, 2026-10-01) — ground moraine.
const TILL_SPREAD_MAX_NODES = 4096
const spreadOut = new Int32Array(256)
function spreadTill(mesh: PeriodicTriangulation, at: number, volumeM3: number, cellM: number, tillM: Float32Array): void {
  const t = SURFACE_TUNING
  const nodes = [at]
  const seen = new Set<number>(nodes)
  let area = mesh.voronoiArea(at) * cellM * cellM
  for (let head = 0; volumeM3 / area > t.glacialTillMaxM && head < nodes.length && nodes.length < TILL_SPREAD_MAX_NODES; head++) {
    const n = mesh.neighbours(nodes[head], spreadOut)
    for (let k = 0; k < n; k++) {
      const u = spreadOut[k]
      if (seen.has(u)) continue
      seen.add(u)
      nodes.push(u)
      area += mesh.voronoiArea(u) * cellM * cellM
    }
  }
  const h = volumeM3 / area
  for (const u of nodes) tillM[u] += h
}

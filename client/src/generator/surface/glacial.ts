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
// forerunner, gone since DEC-0036 phase 7) on the mesh: the mass balance
// per node from the climate sampled at the node (climate/climatePoints.ts)
// at the node's own height by the lapse, routed down
// the steepest descent of the ice SURFACE (rock plus ice) into a flux,
// the thickness from the flux and the slope by Glen's law, a dozen rounds
// to the fixed point. Ice equilibrates in millennia and an epoch is a
// million years, so the steady state IS the epoch's ice. The equilibrium
// line (ELA) per node is where that balance crosses zero.
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
  // Per slot, the climate sampled at the nodes (climate/climatePoints.ts):
  // the air temperature reduced to sea level, °C — each node takes its own
  // lapse — and the precipitation, mm/yr (OCEAN_PRECIP on the sea).
  seaLevelTemperature: ArrayLike<number>
  precipitation: ArrayLike<number>
  // Metres per domain unit.
  cellM: number
}

// The mass balance at a height, m/yr, from a temperature `tc` at the
// height `zc` and the precipitation: the snow share of the rain, the
// degree-day melt on the annual mean.
function balanceAt(zUnits: number, tc: number, zc: number, p: number): number {
  const t = SURFACE_TUNING
  const local = tc - CLIMATE_TUNING.lapseCPerElevation * (zUnits - Math.max(SEA_LEVEL, zc))
  const snow = local <= -5 ? 1 : local >= 5 ? 0 : (5 - local) / 10
  const accumulation = (p / 1000) * snow * t.iceSnowToIce
  const melt = local > t.iceMeltFromC ? (local - t.iceMeltFromC) * t.iceMeltPerDegC : 0
  return accumulation - melt
}

// The equilibrium line under a sea-level temperature and a precipitation,
// metres: the height where the balance crosses zero (bisection; the
// balance falls with warmth, so it rises with height). Above every height:
// the place never holds ice; below sea level: always.
function equilibriumLine(seaLevelC: number, p: number): number {
  let lo = 0
  let hi = 1
  if (balanceAt(hi, seaLevelC, SEA_LEVEL, p) <= 0) return ELEVATION_METERS * 2
  if (balanceAt(lo, seaLevelC, SEA_LEVEL, p) >= 0) return 0
  for (let k = 0; k < 24; k++) {
    const mid = 0.5 * (lo + hi)
    if (balanceAt(mid, seaLevelC, SEA_LEVEL, p) > 0) hi = mid
    else lo = mid
  }
  return 0.5 * (lo + hi) * ELEVATION_METERS
}

export function computeIceOnMesh(input: MeshIceInputs): MeshIceResult {
  const { mesh, z, seaLevelTemperature, precipitation, cellM } = input
  const t = SURFACE_TUNING
  const slots = mesh.vertexSlots
  const balance = new Float32Array(slots)
  const elaM = new Float32Array(slots)
  const thickness = new Float32Array(slots)
  const receiver = new Int32Array(slots).fill(-1)
  const slope = new Float32Array(slots)
  let iceable = 0
  const land: number[] = []
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v]) continue
    let p = precipitation[v]
    if (p === OCEAN_PRECIP || p < 0) p = 0
    elaM[v] = equilibriumLine(seaLevelTemperature[v], p)
    if (z[v] <= SEA_LEVEL) continue
    land.push(v)
    balance[v] = balanceAt(z[v], seaLevelTemperature[v], SEA_LEVEL, p)
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
  // Which land node a slot is (-1: none), and the surface of the round
  // before: a node's steepest descent reads its own surface and its star's,
  // so after the first round only a node whose surface moved, and its
  // neighbours, can have a new receiver — mostly the ice and its rim, a
  // small part of the land. The full scan every round was most of this
  // function's time (profiled 2026-10-04, level 1 on 2048×1024).
  const landIndex = new Int32Array(slots).fill(-1)
  for (let i = 0; i < land.length; i++) landIndex[land[i]] = i
  const surfaceBefore = new Float32Array(slots)
  const stale = new Uint8Array(land.length)
  const descend = (i: number): void => {
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
  let massIn = 0
  let massMelt = 0
  let massOut = 0
  for (let round = 0; round < t.iceFlowRounds; round++) {
    for (let v = 0; v < slots; v++) surface[v] = mesh.vAlive[v] ? elevationToMeters(z[v] - SEA_LEVEL) + thickness[v] : 0
    // Steepest descent on the surface over the node's star; the sea is a
    // sink (ice that reaches it calves). Only a sea node's surface never
    // moves (the ice lies on land), so a moved surface is a land node's.
    if (round === 0) {
      for (let i = 0; i < land.length; i++) descend(i)
    } else {
      stale.fill(0)
      for (let i = 0; i < land.length; i++) {
        const v = land[i]
        if (surface[v] === surfaceBefore[v]) continue
        stale[i] = 1
        for (let k = starStart[i]; k < starStart[i + 1]; k++) {
          const j = landIndex[starTo[k]]
          if (j >= 0) stale[j] = 1
        }
      }
      for (let i = 0; i < land.length; i++) if (stale[i]) descend(i)
    }
    surfaceBefore.set(surface)
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

// The ice on a raster (the history's rasterised, the hydrology stage's
// map): its invariants, check name → violations. (F4's raster ice,
// surface/iceFlow.ts, whose result this checked, went with the climate's
// raster in DEC-0036 phase 7: a world's ice is the mesh's, here.)
export function iceInvariants(result: { thickness: Float32Array }, elevation: Float32Array): Record<string, number> {
  const out: Record<string, number> = { nonNegative: 0, finite: 0, onLand: 0 }
  for (let c = 0; c < result.thickness.length; c++) {
    const h = result.thickness[c]
    if (!Number.isFinite(h)) out.finite++
    if (h < 0) out.nonNegative++
    if (h > 0 && elevation[c] <= SEA_LEVEL) out.onLand++
  }
  return out
}

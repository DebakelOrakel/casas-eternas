import type { FlowRouting, MfdEdges } from './flowRouting'
import type { EngineIndex, EngineViews } from './erosionEngineState'

// EROSION V2 — the bridge to the hydrology (docs/design/erosion-v2.md,
// "Hydrology merges into the engine").
//
// The merge turned out to be an ADAPTER, not a rewrite: everything
// hydrology.ts consumes from a FlowRouting — filled, the single-flow
// receivers, the topological order — the engine already maintains as its
// own routing state. Wrapping it means discharge, lakes, salt flats and
// riparian biomes are computed from the erosion solve's OWN network, never
// from a second derivation; "consistent by construction" is this file.
//
// Since phase 0 of the adaptive-mesh plan the engine's state is in ACTIVE
// space (erosionEngineState.ts), so the bridge is also the expansion back
// to the raster the hydrology walks: a frozen ocean cell has its raw
// elevation as `filled`, no receiver, no MFD edge and no place in the pop
// order — exactly what a sea cell meant to the hydrology before (it swallows
// what reaches it and passes nothing on).
//
// (One nuance stays open for lakes-first-class: the engine's marine
// freeboard cap references SEA level, so over long transients sediment can
// aggrade a sub-sea-level terminal basin toward +2 m; its own water level
// should cap it instead.)
//
// The MFD edges convert from the engine's fixed stride-8 layout to the CSR
// form FlowRouting declares. Hydrology never reads them (it is
// deliberately single-flow), but the contract is honest rather than
// stubbed — a consumer that walks routing.mfd gets the real edges.

export function engineFlowRouting(views: EngineViews, index: EngineIndex, poppedCount: number, elevations: Float32Array): FlowRouting {
  const { width, height, active, activeCount } = index
  const n = width * height
  const filled = new Float32Array(n)
  filled.set(elevations)
  const flowTarget = new Int32Array(n).fill(-1)
  const outEdgeStart = new Int32Array(n + 1)
  for (let a = 0; a < activeCount; a++) {
    const cell = active[a]
    filled[cell] = views.filled[a]
    const t = views.flowTarget[a]
    if (t >= 0) flowTarget[cell] = active[t]
    outEdgeStart[cell + 1] = views.mfdDegree[a]
  }
  for (let cell = 0; cell < n; cell++) outEdgeStart[cell + 1] += outEdgeStart[cell]
  const total = outEdgeStart[n]
  const outEdgeDirections = new Uint8Array(total)
  const outEdgeWeights = new Float32Array(total)
  for (let a = 0; a < activeCount; a++) {
    const base = a * 8
    const start = outEdgeStart[active[a]]
    const degree = views.mfdDegree[a]
    for (let e = 0; e < degree; e++) {
      outEdgeDirections[start + e] = views.mfdDirection[base + e]
      outEdgeWeights[start + e] = views.mfdWeight[base + e]
    }
  }
  const popOrder = new Int32Array(poppedCount)
  for (let i = 0; i < poppedCount; i++) popOrder[i] = active[views.popOrder[i]]
  const mfd: MfdEdges = { outEdgeStart, outEdgeDirections, outEdgeWeights }
  return { width, height, filled, flowTarget, mfd, popOrder, poppedCount }
}

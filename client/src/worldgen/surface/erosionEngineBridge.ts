import type { FlowRouting, MfdEdges } from './flowRouting'
import type { EngineViews } from './erosionEngineState'

// EROSION V2 — the bridge to v1's hydrology (docs/design/erosion-v2.md,
// "Hydrology merges into the engine").
//
// The merge turned out to be an ADAPTER, not a rewrite: everything
// hydrology.ts consumes from a FlowRouting — filled, the single-flow
// receivers, the topological order — the engine already maintains as its
// own routing state. Wrapping it means discharge, lakes, salt flats and
// riparian biomes are computed from the erosion solve's OWN network, never
// from a second derivation; "consistent by construction" is this file.
//
// Worth stating while retiring it: v1's enclosed-water restore hack
// (erosion.ts) exists because v1 bakes the flood-FILLED surface into the
// terrain and must afterwards dig enclosed basins back out. The engine
// never writes `filled` into z — a Caspian-class basin simply stays deep —
// so under v2 that hack has nothing left to do. (One nuance stays open for
// lakes-first-class: the engine's marine freeboard cap references SEA
// level, so over long transients sediment can aggrade a sub-sea-level
// terminal basin toward +2 m; its own water level should cap it instead.)
//
// The MFD edges convert from the engine's fixed stride-8 layout to the CSR
// form FlowRouting declares. Hydrology never reads them (it is
// deliberately single-flow), but the contract is honest rather than
// stubbed — a consumer that walks routing.mfd gets the real edges.

export function engineFlowRouting(views: EngineViews, width: number, height: number, poppedCount: number): FlowRouting {
  const n = width * height
  const outEdgeStart = new Int32Array(n + 1)
  for (let cell = 0; cell < n; cell++) outEdgeStart[cell + 1] = outEdgeStart[cell] + views.mfdDegree[cell]
  const total = outEdgeStart[n]
  const outEdgeDirections = new Uint8Array(total)
  const outEdgeWeights = new Float32Array(total)
  for (let cell = 0; cell < n; cell++) {
    const base = cell * 8
    const start = outEdgeStart[cell]
    const degree = views.mfdDegree[cell]
    for (let e = 0; e < degree; e++) {
      outEdgeDirections[start + e] = views.mfdDirection[base + e]
      outEdgeWeights[start + e] = views.mfdWeight[base + e]
    }
  }
  const mfd: MfdEdges = { outEdgeStart, outEdgeDirections, outEdgeWeights, bounded: false }
  return {
    width,
    height,
    filled: views.filled,
    flowTarget: views.flowTarget,
    mfd,
    popOrder: views.popOrder,
    poppedCount,
  }
}

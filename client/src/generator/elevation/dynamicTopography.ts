import type { Domain, DomainGrid } from '../core/domain'
import { ELEVATION_TUNING } from './elevationTuneParams'

// DYNAMIC TOPOGRAPHY (ADAPTIVE_MESH_PLAN.md F3, decision 5 of
// adaptive-mesh.md): the mantle's buoyancy anomaly as a height term. A
// broad upwelling lifts the surface above it by hundreds of metres over
// thousands of kilometres (Africa's superswell, the ocean swells around
// Iceland and Hawaii); a downwelling sags it (the North American interior
// seaway sat in one). Two rules from the decision, both kept here:
//
//   - It is NOT crustal material: it enters the height and nothing else —
//     not the land budget (the rafts' area, which the crust sink balances),
//     not the uplift forcing (crust is what an orogen stacks).
//   - It is instantaneous, not history: it is evaluated from the mantle
//     field as it stands when the terrain is synthesised, so when the
//     upwelling moves on the plateau subsides with it. That is what lets it
//     be a term at the end of today's raster synthesis; phase 5 evaluates
//     it per epoch.
//
// Erosion sees it because it is height — the raw terrain the engine starts
// from carries it, so plateaus get cut and sagging basins fill, as they
// should. The term is added to the raft baseline (the smooth deck the
// features stack on), sampled bilinearly from the coarse mantle raster,
// whose cells are wider than any range. `mantleGrid`: the mantle raster's
// grid over the domain.
export function dynamicTopographyAt(mantle: Float32Array, mantleGrid: DomainGrid, x: number, y: number): number {
  return mantleGrid.sampleBilinearAt(mantle, x, y) * ELEVATION_TUNING.dynamicTopographyPerUnit
}

// The term over a `width`×`height` grid that covers the domain (a render
// grid may be coarser than the world).
export function dynamicTopographyField(mantle: Float32Array, resX: number, resY: number, width: number, height: number, domain: Domain): Float32Array {
  const out = new Float32Array(width * height)
  if (ELEVATION_TUNING.dynamicTopographyPerUnit === 0) return out
  const mantleGrid = domain.grid(resX, resY)
  const scaleX = domain.width / width
  const scaleY = domain.height / height
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      out[py * width + px] = dynamicTopographyAt(mantle, mantleGrid, px * scaleX, py * scaleY)
    }
  }
  return out
}

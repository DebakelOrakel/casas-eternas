import type { Domain } from '../core/domain'

// THE FLOW SUBSTRATE (ADAPTIVE_MESH_PLAN.md phase 4.3): what the hydrology
// and the river graph read of the thing water flows over — a set of
// ELEMENTS (the terrain mesh's nodes) with a receiver each, the flood's
// filled height and pop order, a position, an area and two
// neighbourhoods. Everything the hydrology computes — discharge, lakes,
// the channel criterion, the regime, the watersheds, the feature graph,
// the sediment basins — is written over this once. Its one instance is
// the mesh's (mesh/meshHydrology.ts, the generator's terrain, a level
// bake's, a tile's); the raster's (`rasterSubstrate` over a FlowRouting)
// went with the hydrology's last raster routing in DEC-0036 phase 7b.
//
// Positions are TEXEL coordinates (world units): `x`/`y` where an element
// is drawn, `px`/`py` where its climate is sampled — on the mesh both the
// node's own position.
export interface FlowSubstrate {
  readonly kind: 'mesh'
  // The world's extent in cells, for seam tests and climate sampling, and
  // the domain of that extent (positions are its coordinates).
  readonly width: number
  readonly height: number
  readonly domain: Domain
  readonly count: number
  readonly filled: Float32Array
  readonly flowTarget: Int32Array
  readonly popOrder: Int32Array
  readonly poppedCount: number
  x(c: number): number
  y(c: number): number
  px(c: number): number
  py(c: number): number
  // The element's area in world cells (domain units²: a node's Voronoi
  // cell).
  area(c: number): number
  // Distance from a to b in cells, across the seam (and a pole).
  step(a: number, b: number): number
  // Neighbours that share a facet (the star on the mesh) — what a basin
  // region is gathered over. Writes into `out`, returns the count.
  facetNeighbours(c: number, out: Int32Array): number
  // Every neighbour (the star on the mesh).
  rimNeighbours(c: number, out: Int32Array): number
}

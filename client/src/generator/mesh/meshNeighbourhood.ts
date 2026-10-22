import type { PeriodicTriangulation } from './periodicDelaunay'

// NEIGHBOURHOODS IN METRES ON A TERRAIN MESH (DEC-0036 phase 7, docs/
// decisions/fields-on-meshes.md fork 2): what the ecology's windows became
// when it left the 2048 raster — "is there water within reach", "how much
// of the land around is sea", a deposit's halo, a node's slope — on the
// adaptive mesh's nodes, every length in metres, both shapes (the distance
// the globe's arc on the sphere, the chart's on the torus).
//
// A node stands for its Voronoi cell, which on this mesh may be anything
// from 2 to 160 km across, so a neighbourhood is not "the nodes within r":
// it is the CELLS the disc of radius r about the node reaches, each cell
// taken as the disc of its own area (radius ρ = √(a / π)), and a mean
// weighs each by the area of that disc inside the reach (the lens of the
// two circles). On a raster of 7.8 km pixels a reach of one pixel is then
// the pixel's eight neighbours, the window the raster's maxWithin took; on
// a coarse land node a reach of 8 km is the node itself, the water the
// mesh resolves. The cells are gathered by a walk over the triangulation
// from the node, through the cells that touch the reach.

// The mesh's cells and stars in metres: what a neighbourhood walks.
export interface MeshStar {
  readonly mesh: PeriodicTriangulation
  // Metres per domain unit.
  readonly unitM: number
  // Per slot: the Voronoi area, m², and the radius of a disc of that area, m.
  readonly areaM2: Float64Array
  readonly rho: Float64Array
  // The Delaunay star per slot as a CSR table: the neighbour.
  readonly starStart: Int32Array
  readonly star: Int32Array
  // The distance between two slots, and from a slot to a point, metres.
  distanceM(a: number, b: number): number
  distanceToPointM(v: number, x: number, y: number): number
}

// The star with its edges measured: per entry of the star, the edge's
// length (m) and its Voronoi wall (m).
export interface MeshGeometry extends MeshStar {
  readonly lengthM: Float64Array
  readonly wallM: Float64Array
}

// The cells within `radiusM` of each node `centre` admits (all alive nodes
// when null), with their lens weights, m²: a CSR table per slot (an
// unadmitted slot has none). Every centre holds itself.
export interface Neighbourhoods {
  readonly start: Int32Array
  readonly member: Int32Array
  readonly weight: Float32Array
}

// The largest value over each neighbourhood ("is there water within
// reach"); 0 where a slot has none.
export function maxWithin(nb: Neighbourhoods, field: ArrayLike<number>): Float32Array {
  const slots = nb.start.length - 1
  const out = new Float32Array(slots)
  for (let i = 0; i < slots; i++) {
    let m = -Infinity
    for (let k = nb.start[i]; k < nb.start[i + 1]; k++) {
      const v = field[nb.member[k]]
      if (v > m) m = v
    }
    out[i] = m === -Infinity ? 0 : m
  }
  return out
}

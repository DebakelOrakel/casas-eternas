import type { MeshRouting } from '../mesh/meshErosion'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'

// THE MESH AS A TERRAIN: what the hydrology and the save read of it. The
// erosion stage this module used to hold (phase 4.3: one pass over a mesh
// built fresh from the synthesis, `erodeOnMesh`) went with the coupled
// history (phase 5.1, pipeline/coupledEpoch.ts) — the erosion runs inside
// the tectonics' epochs now, on the mesh those carry, and the golden
// harness gates that loop. The contract below is what survived: a mesh,
// its heights and the derived fields a consumer of the terrain needs.
//
// The mesh is always in CANONICAL form (mesh/meshSerial.ts): Hilbert
// numbered, rebuilt through the codec — the mesh a reload of the save
// produces, bit for bit.

export interface MeshTerrain {
  mesh: PeriodicTriangulation
  // Heights per vertex (canonical numbering), elevation units.
  z: Float32Array
  // The routing of `z` on the mesh (derived: the engine's last refresh, or
  // mesh/meshHydrology.meshRouting after a restore) and every node's
  // Voronoi area in cells — what the hydrology reads the mesh through
  // (meshHydrology.meshSubstrate).
  routing: MeshRouting
  areas: Float32Array
  // The last iteration's sediment flux per node, m³; empty after a
  // restore (not carried by the save).
  sedimentFlux: Float32Array
}

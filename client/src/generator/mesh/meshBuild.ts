// BUILDING A MESH from point-evaluable fields: the bootstrap lattice at the
// ocean spacing, then refinement under the density rule until no edge is
// long against its target, then one coarsen so the result is a fixed
// point of the remesh. The fields are the tectonics' — evaluable at
// any point ("tectonics evaluates its fields on the nodes", decision 3) —
// or, for the harness and the bridge from a saved raster, bilinear samples
// of a raster.
//
// The node state this creates: `z` (height, elevation units, intensive)
// and `discharge` (m³/s, intensive; zero when the sampler has none — then
// the discharge term is inert and only relief and curvature drive the
// density). Coordinates are in world cells (the domain's metresPerUnit
// each — the shape's, DEC-0035 fork 6), heights in elevation units
// (ELEVATION_METERS per unit); the density rule reads metres and the
// conversion happens in `densityTarget` and the bootstrap spacing alone.

export interface FieldSampler {
  heightAt(x: number, y: number): number
  dischargeAt?(x: number, y: number): number
}

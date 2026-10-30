// The surface's features as the stages give them and a save holds them: a
// sediment basin, a spring, a river's course. Types only — the engine
// computes them (docs/decisions/rust-engine.md); the world layer and the
// screen read them.

// SEDIMENT BASINS AS FEATURES (ADAPTIVE_MESH_PLAN.md F1, decision 4a of
// adaptive-mesh.md): where the erosion pass left material — the
// floodplains, fans and marine wedges the ξ–q routing deposited — as a
// list with provenance, so the resource layer can ask "what rock is this
// sediment made of" without the coupled model's layers (phase 5).
//
// On the terrain mesh since DEC-0036 phase 7b (the 2048 raster before):
// a basin is a connected set of nodes where the eroded terrain stands at
// least `sedimentBasinMinThicknessM` above the terrain the last epoch's
// erosion started from, covering at least `sedimentBasinMinAreaKm2`;
// marine when most of its area lies under the sea. Its PROVENANCE is the
// rock of the catchments that feed it: every river reach whose mouth or
// last node lies in the basin contributes its catchment, and over those
// nodes the craton oldness (the engine's crust/raft_field.rs, 1 = ancient core) and the
// erodibility K are averaged — old hard crust shedding into a basin is
// what makes placer gold and banded iron plausible there. Basins no river
// reaches (marine wedges off a cliff coast, deposits of hillslope creep)
// carry the mean over their own nodes.
//
// Every sum is by area — a node weighs its Voronoi cell, in km² through
// the Domain's metres per unit — so a basin's area, volume and means are
// the world's on either shape; `nodes` is the count.
export interface SedimentBasin {
  id: number
  kind: 'alluvial' | 'marine'
  nodes: number
  areaKm2: number
  volumeKm3: number
  meanThicknessM: number
  maxThicknessM: number
  // Centroid in world units (texel coordinates): the torus's circular mean
  // per axis, the sphere's mean position on the globe, both by area.
  x: number
  y: number
  // The river reaches ending in this basin.
  mouthReaches: number[]
  // Provenance over the feeding catchments (own nodes when none); the
  // catchment's area.
  catchmentKm2: number
  cratonAge: number
  hardness: number
}

// A spring: where the water table meets the surface (surface/hydrogeology).
export interface SpringFeature {
  id: number
  cell: number
  x: number
  y: number
  // Elevation units.
  elevation: number
  // A spring in an arid climate.
  oasis: boolean
}

export type RiverPattern = 'straight' | 'meandering' | 'braided' | 'anastomosing'

export interface RiverCourse {
  reach: number
  pattern: RiverPattern
  dischargeM3s: number
  // Bankfull hydraulic geometry: width and depth from discharge.
  widthM: number
  depthM: number
  slope: number
  // 0..1, from the bank biome: vegetation holds banks.
  bankStrength: number
  // Channel centrelines in texel coordinates [x, y, …]: one for a single
  // thread, several for braids and anastomosing threads; a delta's
  // distributaries are the LAST lobeAges.length lines.
  lines: Float32Array[]
  // Per line, the channel width relative to widthM (sub-channels narrower).
  lineWidth: number[]
  // Course length over the reach's straight-line (cell path) length.
  sinuosity: number
  // The migration envelope's width, metres (meandering only).
  beltWidthM: number
  // Abandoned loops, texel coordinates, meandering only.
  oxbows: Float32Array[]
  // Lobe age per distributary (0 = active), empty without a delta.
  lobeAges: number[]
}

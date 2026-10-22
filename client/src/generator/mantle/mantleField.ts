import { domainArea, type Domain } from '../core/domain'
import { sharedFieldMesh, type FieldMesh, type FieldSampler } from '../fields/fieldMesh'
import { stableDiffusionStep } from '../fields/fieldOperators'

// A coarse, evolving mantle buoyancy/temperature field under the whole
// surface — the CAUSE the plates ride on (Phase M2 of
// docs/decisions/evolving-euler-poles.md). Hot = upwelling, cold = downwelling.
// Its surface coupling closes the Wilson cycle: continents INSULATE the mantle
// (heat builds beneath them → an upwelling grows → the flow diverges under them →
// their plates are pushed apart → breakup), while ocean COOLS (downwelling →
// convergence → continents drift together → assembly). Bounded by diffusion +
// decay, so the whole thing stays stable — and the plate motions are FIT to the
// resulting flow (a bounded function of a bounded field), avoiding force-
// integration runaway.
//
// ON A FIELD MESH (DEC-0036 phase 1, docs/decisions/fields-on-meshes.md):
// the state is one Float64 value per cell of the mantle's field mesh
// (fields/fieldMesh.ts — Goldberg cells on the sphere, hexagons on the
// torus), and every operation on it is a phase-0 operator: finite-volume
// diffusion, the Poisson solve by conjugate gradients, the least-squares
// gradient. One code for both shapes, no pole rows, no line solves, no
// sub-steps. The 128 × 64 chart raster it had until 2026-10-11 survives
// only as the screen's overlay (the engine's `rasterise_mantle`); the save holds the mesh's
// own values (SavedField).
// Its readers take a value at a point through the mesh's sampler
// (the engine's `mantle_at`), the extrema searches walk the mesh's neighbour graph.
//
// LIVES IN ITS OWN MODULE because BOTH eras run on it: the Archean and the
// tectonics read this field, so filing it under either one made the other
// import across a boundary for its own substrate.
//
// The fit itself — `fitMotionsToFlow` — deliberately does NOT live here. It
// takes plate seeds and returns plate motions, so keeping it would have made
// the substrate depend on the thing riding on it. It is the engine's
// `fit_motions_to_flow`, in tectonics/plate_motion.rs with the types it
// speaks in.

// The chart raster the field is written to (the screen's overlay) and, as
// a length, the mesh's spacing: the domain's width over MANTLE_RES_X — a cell as wide as the raster's at the equator
// (156 km on the 20 000 km sphere, 125 km on the torus at 2048 × 1024).
// Counted on the domain's width as the raster was, so a harness world
// narrower than 2048 has the same number of cells, each smaller.
export const MANTLE_RES_X = 128
export const MANTLE_RES_Y = 64

// The mantle's field mesh on a domain, with its sampler and what the
// operators below need of its geometry, built once per domain shape and
// size (the mesh reads only those: the same inputs give the same bytes).
export interface MantleMesh {
  readonly mesh: FieldMesh
  readonly sampler: FieldSampler
  // The spacing, metres: the raster's cell, which the field's former
  // units were counted in (a diffusion pass's reach, the flow's scale).
  readonly cellM: number
  // The spacing in domain units.
  readonly cellUnits: number
  // The total area, m², and the largest explicit diffusion step that
  // stays a convex combination (stableDiffusionStep at κ = 1), m².
  readonly totalArea: number
  readonly stableStep: number
}

const meshes = new Map<string, MantleMesh>()
// The last domain asked for, so a reader per point (a baseline per node)
// pays a comparison, not a key.
let lastDomain: Domain | null = null
let lastMesh: MantleMesh | null = null

export function mantleMesh(domain: Domain): MantleMesh {
  if (domain === lastDomain && lastMesh) return lastMesh
  const made = mantleMeshOf(domain)
  lastDomain = domain
  lastMesh = made
  return made
}

function mantleMeshOf(domain: Domain): MantleMesh {
  const key = `${domain.kind}:${domain.width}:${domain.height}:${domain.metresPerUnit}`
  const known = meshes.get(key)
  if (known) return known
  // The spacing by the world's AREA, MANTLE_RES_X × MANTLE_RES_Y cells'
  // worth (DEC-0036 phase 8a): on the torus √(W·H / 8192) = W / 128, the
  // spacing it always had; on the sphere, whose chart width is its
  // equator, W / 128 was 156 km where the torus's is 125 km, and since the
  // field's lengths are counted in its cells (the diffusion's reach, the
  // initial noise, an extremum among its neighbours) the sphere's
  // convection cells were 25 % wider and 36 % fewer — the plate count
  // with them (convectionCellSeeds).
  const cellUnits = Math.sqrt(domainArea(domain) / (MANTLE_RES_X * MANTLE_RES_Y))
  const cellM = cellUnits * domain.metresPerUnit
  const { mesh, sampler } = sharedFieldMesh(domain, cellM)
  let totalArea = 0
  for (let i = 0; i < mesh.count; i++) totalArea += mesh.area[i]
  const made: MantleMesh = { mesh, sampler, cellM, cellUnits, totalArea, stableStep: stableDiffusionStep(mesh, 1) }
  meshes.set(key, made)
  return made
}

// Whether a saved field's mesh (its cell count and spacing) is this
// domain's — what a loader asks before it hands the save on.
export function mantleFits(domain: Domain, cells: number, spacingM: number): boolean {
  const mm = mantleMesh(domain)
  return cells === mm.mesh.count && spacingM === mm.cellM
}

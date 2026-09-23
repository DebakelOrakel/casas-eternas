import { METERS_PER_CELL } from '../core/mapConfig'
import type { Domain } from '../core/domain'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { hexLattice } from './lattice'
import { MESH_TUNING, targetSpacingM } from './meshDensity'
import { reliefAt } from './meshRelief'
import { MeshState } from './meshState'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { coarsen, refine, type RemeshStats, type TargetSpacing } from './remesh'

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
// density). Coordinates are in world cells (METERS_PER_CELL each), heights
// in elevation units (ELEVATION_METERS per unit); the density rule reads
// metres and the conversion happens in `densityTarget` alone.

export interface FieldSampler {
  heightAt(x: number, y: number): number
  dischargeAt?(x: number, y: number): number
}

export interface BuildOptions {
  seed: number
  // The density rule's budget scalar: 1 for the macro mesh.
  budget?: number
  maxRounds?: number
}

export interface BuiltMesh {
  mesh: PeriodicTriangulation
  state: MeshState
  stats: RemeshStats
}

export const MESH_Z = 'z'
export const MESH_DISCHARGE = 'discharge'

// The density rule as a target-spacing function over the mesh's own state:
// slope and curvature from the node's star, discharge from the node,
// ocean below sea level. Spacing in domain units.
export function densityTarget(state: MeshState, budget = 1, unitsToM = METERS_PER_CELL): TargetSpacing {
  const relief = new Float64Array(2)
  return (mesh, targets) => {
    const z = state.get(MESH_Z)
    const q = state.has(MESH_DISCHARGE) ? state.get(MESH_DISCHARGE) : null
    for (let v = 0; v < mesh.vertexSlots; v++) {
      if (!mesh.vAlive[v]) continue
      reliefAt(mesh, z, v, unitsToM, ELEVATION_METERS, relief)
      const h = targetSpacingM(relief[0], q ? q[v] : 0, relief[1], 0, z[v] * ELEVATION_METERS, budget)
      targets[v] = h / unitsToM
    }
  }
}

export function buildMesh(domain: Domain, sampler: FieldSampler, options: BuildOptions, unitsToM = METERS_PER_CELL): BuiltMesh {
  const budget = options.budget ?? 1
  const mesh = hexLattice(domain, (MESH_TUNING.oceanSpacingM * budget) / unitsToM)
  const state = new MeshState(mesh.vertexSlots * 4)
  state.add(MESH_Z, 'intensive')
  if (sampler.dischargeAt) state.add(MESH_DISCHARGE, 'intensive')
  const sample = (v: number, x: number, y: number): void => {
    state.get(MESH_Z)[v] = sampler.heightAt(x, y)
    if (sampler.dischargeAt) state.get(MESH_DISCHARGE)[v] = sampler.dischargeAt(x, y)
  }
  for (let v = 0; v < mesh.vertexSlots; v++) sample(v, mesh.vx[v], mesh.vy[v])
  const target = densityTarget(state, budget, unitsToM)
  const stats = refine(mesh, state, target, { seed: options.seed, sample, maxRounds: options.maxRounds })
  // The refine leaves about one node in a hundred under the removal
  // threshold (placed before a neighbour's target tightened); one coarsen
  // takes them out, so the built mesh is a fixed point of `remesh` and the
  // first epoch's remesh moves only what the epoch changed.
  const settled = coarsen(mesh, state, target)
  stats.removed = settled.removed
  stats.rounds += settled.rounds
  stats.perRound.push(...settled.perRound.map((n) => -n))
  return { mesh, state, stats }
}

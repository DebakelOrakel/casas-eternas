import { METERS_PER_CELL } from '../core/mapConfig'
import type { Domain } from '../core/domain'
import { ELEVATION_METERS } from '../elevation/elevationScale'
import { hexLattice } from './lattice'
import { COLUMN_TUNING, columnThickness, MESH_COLUMN } from './meshColumn'
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
  const star = new Int32Array(256)
  return (mesh, targets, changed) => {
    const z = state.get(MESH_Z)
    const q = state.has(MESH_DISCHARGE) ? state.get(MESH_DISCHARGE) : null
    // The sediment column (phase 5.2): where a fill lies, h_column of the
    // density rule is live. The layers in use are not known here; the
    // thickness over the whole stack is the same number, the unused layers
    // being zero.
    const column = state.has(MESH_COLUMN) ? state.get(MESH_COLUMN) : null
    const at = (v: number): void => {
      reliefAt(mesh, z, v, unitsToM, ELEVATION_METERS, relief)
      const columnM = column ? columnThickness(column, v, COLUMN_TUNING.layerCap) : 0
      const h = targetSpacingM(relief[0], q ? q[v] : 0, relief[1], columnM, z[v] * ELEVATION_METERS, budget)
      targets[v] = h / unitsToM
    }
    if (!changed) {
      for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) at(v)
      return
    }
    // The changed nodes and their neighbours, each once: the same value a
    // full pass gives them, the rest keep theirs (TargetSpacing).
    const done = new Uint8Array(mesh.vertexSlots)
    for (let i = 0; i < changed.length; i++) {
      const v = changed[i]
      if (!mesh.vAlive[v]) continue
      if (!done[v]) {
        done[v] = 1
        at(v)
      }
      const n = mesh.neighbours(v, star)
      for (let k = 0; k < n; k++) {
        const u = star[k]
        if (done[u]) continue
        done[u] = 1
        at(u)
      }
    }
  }
}

// A triangulation of a given point set — the coupled loop's rebuild after
// the nodes moved with their plates (pipeline/coupledEpoch.ts): the same
// nodes, in the given order, so vertex i of the result is point i (a
// point coinciding with an earlier one collapses onto it and maps to that
// vertex — `mapping` says which). Built by insertion into the bootstrap
// lattice in the order given, the lattice removed after; the caller runs
// the remesh for what the motion crowded or stretched.
export function triangulatePoints(domain: Domain, xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, latticeSpacing: number): { mesh: PeriodicTriangulation; mapping: Int32Array } {
  const mesh = hexLattice(domain, latticeSpacing)
  const latticeCount = mesh.vertexSlots
  const mapping = new Int32Array(count)
  for (let i = 0; i < count; i++) mapping[i] = mesh.insert(xs[i], ys[i])
  for (let v = 0; v < latticeCount; v++) if (mesh.vAlive[v]) mesh.remove(v)
  return { mesh, mapping }
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

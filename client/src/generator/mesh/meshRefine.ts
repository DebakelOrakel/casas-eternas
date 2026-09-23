import { hashSeedString } from '../core/rng'
import { sampleBilinearGrid } from '../core/field'
import { fineDetailNoise } from '../elevation/ridgedNoise'
import { CASCADE_FALLOFF, localRelief, RIDGE_FIELD_MEAN, RIDGE_STRENGTH, ridgedAt, seedCascadeScales, seedRoughnessAmplitude } from '../surface/amplify'
import { densityTarget, MESH_Z } from './meshBuild'
import { rasteriseNodeField } from './meshRaster'
import { createMeshSampler } from './meshSampler'
import { compactMesh, decodeMesh, encodeMesh, permute } from './meshSerial'
import { MeshState } from './meshState'
import type { PeriodicTriangulation } from './periodicDelaunay'
import { refine } from './remesh'

// ONE RUNG OF THE LADDER (decision 3 of docs/decisions/adaptive-mesh.md; the
// tile ladder of ADAPTIVE_MESH_PLAN.md phase 4.5): a parent mesh refined to
// a finer budget under the SAME density rule (meshDensity.ts — one function,
// the budget the only difference), with every parent node kept where it
// is and every new node given a height the parents cannot know.
//
// A new node inherits its height from the PARENT SURFACE (the parent mesh
// sampled at the node, meshSampler.ts — not from whatever neighbours it
// has at insertion time, which are new nodes with synthesis on them
// already: inheriting from those drifted the coast by a few hundred nodes
// on the first run) and then takes the amplification's two synthesis
// layers at its own position — the
// seed roughness (a noise cascade at the level's cell scale, so the erosion
// has something to bite into) and the ridging (ridged noise scaled by the
// local relief, so a range reads as crests rather than a bulge) — the same
// constants the raster bake hashes in AMPLIFY_CONSTANTS, evaluated at a
// point instead of a cell. The relief is the parent's, on the macro grid.
// The parents' own heights are not touched: a level is a constrained
// refinement of the one below it.
//
// The result is in canonical form (compactMesh), so a level rebuilt from
// its artifact is the level.

export interface RefineLevelOptions {
  // The density rule's budget scalar for this level: 0.5 halves the
  // spacing (four times the nodes).
  budget: number
  // The world's detail seed (the save's), salted per level.
  seed: number
  level: number
  // The macro raster's size in cells — the world's extent.
  width: number
  height: number
  maxRounds?: number
}

export interface RefinedLevel {
  mesh: PeriodicTriangulation
  z: Float32Array
  // Per node of the result, 1 where the node is a parent (kept), 0 where
  // it is new — the tile ladder's "parents immutable".
  parent: Uint8Array
  inserted: number
}

export function refineMeshLevel(parentMesh: PeriodicTriangulation, parentZ: Float32Array, options: RefineLevelOptions): RefinedLevel {
  const { budget, width, height } = options
  // The parent surface, before the mesh is touched: the sampler holds its
  // own hint grid and normals, and the parent's triangles are read through
  // it while the same triangulation object is being refined — a locate on
  // the sampler walks the LIVE mesh, so the parent's heights are sampled
  // from a copy of the parent instead.
  const parentSampler = createMeshSampler(decodeParent(parentMesh), parentZ)
  const mesh = parentMesh
  const state = new MeshState(mesh.vertexSlots * 4)
  const z = state.add(MESH_Z, 'intensive')
  z.set(parentZ.subarray(0, mesh.vertexSlots))
  const isParent = state.add('parent', 'intensive')
  for (let v = 0; v < mesh.vertexSlots; v++) isParent[v] = mesh.vAlive[v] ? 1 : 0
  // The relief the ridging scales by: the parent's heights on the macro
  // grid, ranged over the amplification's radius.
  const macro = rasteriseNodeField(mesh, parentZ, width, height)
  const relief = localRelief(macro, width, height)
  // The synthesis at the level's cell scale: the level's nominal grid is
  // the macro grid over the budget, and the cascade's octaves are the
  // raster bake's for that grid.
  const levelWidth = Math.round(width / budget)
  const levelHeight = Math.round(height / budget)
  const scales = seedCascadeScales(levelWidth)
  const amplitudes = scales.map((_, i) => Math.pow(CASCADE_FALLOFF, i))
  const norm = amplitudes.reduce((a, b) => a + b, 0)
  const levelSeed = (options.seed ^ hashSeedString(`mesh-level:${options.level}`)) >>> 0
  const ridgeSeed = (levelSeed ^ 0x5f356495) >>> 0
  const sample = (v: number, x: number, y: number): void => {
    // The parent's height at this point, then the two layers on top.
    const zField = state.get(MESH_Z)
    const base = parentSampler.heightAt(x, y)
    zField[v] = base
    const amplitude = seedRoughnessAmplitude(base)
    if (amplitude === 0) {
      state.get('parent')[v] = 0
      return
    }
    const px = x / budget
    const py = y / budget
    let noise = 0
    for (let i = 0; i < scales.length; i++) {
      const s = scales[i]
      noise += fineDetailNoise(px, py, levelWidth / s, levelHeight / s, (levelSeed + i * 0x9e3779b9) >>> 0) * amplitudes[i]
    }
    const ridge = (ridgedAt(px, py, levelWidth, levelHeight, ridgeSeed) - RIDGE_FIELD_MEAN) * sampleBilinearGrid(relief, width, height, x, y) * RIDGE_STRENGTH
    zField[v] = base + (noise / norm) * amplitude + ridge
    state.get('parent')[v] = 0
  }
  const stats = refine(mesh, state, densityTarget(state, budget), { seed: levelSeed, sample, maxRounds: options.maxRounds })
  const { mesh: canonical, order } = compactMesh(mesh)
  const parent = new Uint8Array(canonical.vertexSlots)
  const parentField = permute(state.get('parent'), order)
  for (let v = 0; v < parent.length; v++) parent[v] = parentField[v] > 0.5 ? 1 : 0
  return { mesh: canonical, z: permute(state.get(MESH_Z), order), parent, inserted: stats.inserted }
}

// A copy of the parent triangulation for the sampler: through the codec,
// which is what a level bake reads it from anyway.
function decodeParent(parent: PeriodicTriangulation): PeriodicTriangulation {
  const order = new Int32Array(parent.vertexSlots)
  for (let i = 0; i < order.length; i++) order[i] = i
  return decodeMesh(parent.domain, encodeMesh(parent, order))
}

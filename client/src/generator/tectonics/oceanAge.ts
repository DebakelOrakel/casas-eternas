import type { Domain } from '../core/domain'
import { rasteriseField, sharedFieldMesh, type FieldMesh, type FieldSampler, type SavedField } from '../fields/fieldMesh'
import { departures, type Departures } from '../fields/fieldOperators'

// Ocean-floor age as a coarse full-surface field (Phase 3, see
// docs/decisions/continental-crust-rafts.md). Oceanic crust deepens as it ages
// away from the ridge that formed it (the real √age depth law), so the ocean
// baseline follows GDH1's age-depth curve (elevationField.ts, the gdh1*
// entries of ELEVATION_TUNING). This is a
// deliberate, bounded exception to the "no full-surface accumulator" stance:
// it's only the ocean-age scalar, which is smooth and large-scale, so a coarse
// field is plenty. The field is carried with plate motion each epoch; the
// crust the plates open at a divergent boundary starts at half an epoch
// (advectOceanAge).
//
// ON A FIELD MESH (DEC-0036 phase 2, docs/decisions/fields-on-meshes.md):
// one Float64 value per cell of the ocean age's field mesh (fields/
// fieldMesh.ts — Goldberg cells on the sphere, hexagons on the torus), in
// epochs. One code for both shapes: no pole rows, no disc boxes. The
// 256 × 128 chart raster it had until 2026-10-11 survives only as the
// render's lookup (oceanAgeRaster); readers per point go through the
// sampler (oceanAgeAt), the save holds the mesh's own values.

// The spacing as a raster's: the domain's width over OCEAN_AGE_RES_X — a
// cell as wide as the former 256 × 128 raster's at the equator (62.4 km on
// the torus at 2048 × 1024, 78.1 km on the 20 000 km sphere). Counted on
// the width as the raster was, so a harness world narrower than 2048 has
// the same number of cells, each smaller.
export const OCEAN_AGE_RES_X = 256

// The ocean age's field mesh on a domain, with its sampler and the scratch
// one epoch's transport fills, built once per domain shape and size.
export interface OceanAgeMesh {
  readonly mesh: FieldMesh
  readonly sampler: FieldSampler
  // The spacing, metres and domain units.
  readonly cellM: number
  readonly cellUnits: number
  // Scratch: the departures, the gradient, the departure points.
  readonly dep: Departures
  readonly gradE: Float64Array
  readonly gradS: Float64Array
  readonly px: Float64Array
  readonly py: Float64Array
  // A visit stamp per cell for the resets' walk.
  readonly stamp: Int32Array
}

const meshes = new Map<string, OceanAgeMesh>()
let lastDomain: Domain | null = null
let lastMesh: OceanAgeMesh | null = null

export function oceanAgeMesh(domain: Domain): OceanAgeMesh {
  if (domain === lastDomain && lastMesh) return lastMesh
  const key = `${domain.kind}:${domain.width}:${domain.height}:${domain.metresPerUnit}`
  let made = meshes.get(key)
  if (!made) {
    const cellUnits = domain.width / OCEAN_AGE_RES_X
    const cellM = cellUnits * domain.metresPerUnit
    // Shared with the climate's, which asks for the same spacing.
    const { mesh, sampler } = sharedFieldMesh(domain, cellM)
    const n = mesh.count
    made = {
      mesh,
      sampler,
      cellM,
      cellUnits,
      dep: departures(mesh),
      gradE: new Float64Array(n),
      gradS: new Float64Array(n),
      px: new Float64Array(n),
      py: new Float64Array(n),
      stamp: new Int32Array(n),
    }
    meshes.set(key, made)
  }
  lastDomain = domain
  lastMesh = made
  return made
}

export function createOceanAgeField(initialAge: number, domain: Domain): Float64Array {
  return new Float64Array(oceanAgeMesh(domain).mesh.count).fill(initialAge)
}

// The field on a resX × resY chart raster, cell centres (the DomainGrid's
// convention, read with grid.sampleBilinearAt): the render's lookup, where
// a locate per pixel is too dear (elevationField.computeRaftBaseline).
export function oceanAgeRaster(age: ArrayLike<number>, domain: Domain, resX: number, resY: number): Float32Array {
  return rasteriseField(oceanAgeMesh(domain).mesh, age, resX, resY)
}

// THE FIELD AS A SAVE HOLDS IT (DEC-0036 phase 2): the mesh's own values,
// Float64 per cell, with the mesh's cell count and spacing — as the
// mantle's (mantle/mantleField.savedMantle).
export function savedOceanAge(age: Float64Array, domain: Domain): SavedField {
  const om = oceanAgeMesh(domain)
  return { values: age.slice(), cells: om.mesh.count, spacingM: om.cellM }
}

export function oceanAgeFits(domain: Domain, cells: number, spacingM: number): boolean {
  const om = oceanAgeMesh(domain)
  return cells === om.mesh.count && spacingM === om.cellM
}

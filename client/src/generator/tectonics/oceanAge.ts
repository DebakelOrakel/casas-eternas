import type { PlateSeed } from './plateSeeds'
import { reversePointByMotion, type PlateMotion } from './plateMotion'
import type { Domain } from '../core/domain'
import { computeMembershipAt } from '../crust/raftField'
import type { Raft } from '../crust/raftTypes'
import { rasteriseField, sharedFieldMesh, type FieldMesh, type FieldSampler, type SavedField } from '../fields/fieldMesh'
import { departures, departuresFromPoints, gradient, transportScalar, type Departures } from '../fields/fieldOperators'

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
let stampCounter = 0

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

// The age at a world point, epochs: linear in the mesh's triangle under it.
export function oceanAgeAt(age: ArrayLike<number>, domain: Domain, x: number, y: number): number {
  return oceanAgeMesh(domain).sampler.sample(age, x, y)
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

// The field back from a save. A field of another mesh is refused with an
// error that says so: values per cell mean nothing on other cells.
export function restoreOceanAge(domain: Domain, saved: SavedField): Float64Array {
  const om = oceanAgeMesh(domain)
  if (!oceanAgeFits(domain, saved.cells, saved.spacingM) || saved.values.length !== om.mesh.count) {
    throw new Error(`the saved ocean age is for a mesh of ${saved.cells} cells at ${saved.spacingM} m (${saved.values.length} values); this world's has ${om.mesh.count} at ${om.cellM} m`)
  }
  return saved.values
}

// The continental membership (crust/raftField.computeMembershipAt) at the
// mesh's cell centres — what the transport below zeroes the age under.
export function oceanAgeMembership(rafts: Raft[], domain: Domain): Float64Array {
  const { mesh } = oceanAgeMesh(domain)
  return computeMembershipAt(rafts, mesh.x, mesh.y, domain)
}

// Oldest seafloor that can exist, in epochs. Earth's oceanic crust tops out
// around 180 Ma because subduction destroys it as fast as ridges make it — there
// is no ancient ocean floor anywhere. Transport here has no such sink (a cell
// over a subduction zone just keeps sampling and incrementing), so without a cap
// the mean age climbs monotonically for the whole run: 840 epochs of age after an
// 800-epoch run, a number that describes nothing physical.
//
// The depth law in elevationField.ts saturates on its own, so this is not what
// keeps the floor off the clamp — it's what keeps the SAVED field
// (oceanAge.f64 rides along in every world save) interpretable as an age
// rather than as a runtime counter.
const MAX_SEAFLOOR_AGE = 180

// Semi-Lagrangian transport (DEC-0036 phase 2): each cell pulls its age from
// where its crust was one epoch ago and adds one epoch. The departure is
// EXACT — the cell's centre turned back by its (current nearest) plate's own
// motion (reversePointByMotion), as the raster did; a velocity field
// sampled half a step back would mix two plates across their boundary. The
// value there is the clipped Hermite interpolation (fieldOperators
// transportScalar with the gradient and `clip`, decided 2026-10-11): sharper
// than linear, which smears the ridges' young stripes away over the epochs,
// and never outside its triangle's corner range, so no age goes negative.
// Returns a fresh field; the old one is read-only during the pass.
//
// `membership` (oceanAgeMembership, at this mesh's cell centres) zeroes the
// age under continental crust. Without it, a cell that spends 200 epochs buried
// under a supercontinent still ages the whole time, so when a breakup finally
// tears the continent open, the freshly exposed basin floor reads as 200-epoch-
// old crust and renders at full abyssal depth — a brand-new Atlantic born as
// deep as the oldest Pacific. Continental crust simply isn't seafloor; when a
// rift exposes what's under it, that floor is new.
//
// `previousSeeds`, the plates' seeds where the epoch found them, make the
// RIDGES' new crust (DEC-0036 phase 8e): a cell whose departure lands on
// another plate than its own — the departure's nearest seed an epoch ago
// is not the cell's — holds crust that did not exist on its plate an epoch
// ago, so the plates opened it in this epoch at their boundary: its age is
// half an epoch, the mean of the strip. At a divergent boundary that strip
// is as wide as the two plates' opening in the epoch, the real spreading;
// at a convergent or a transform boundary no departure crosses. It replaced
// a disc of 93.6 km reset around every divergent boundary point every
// epoch, which made 2–3 × the young floor the motion opens.
export function advectOceanAge(
  age: Float64Array,
  seeds: PlateSeed[],
  motions: PlateMotion[],
  angleStep: number,
  domain: Domain,
  membership: Float64Array,
  previousSeeds: readonly { x: number; y: number }[] | null = null,
): Float64Array {
  const om = oceanAgeMesh(domain)
  const { mesh } = om
  const n = mesh.count
  const fresh = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const wx = mesh.x[i]
    const wy = mesh.y[i]
    if (membership[i] > 0.5) {
      // Zeroed below; its own centre keeps the walk cheap.
      om.px[i] = wx
      om.py[i] = wy
      continue
    }
    let nearest = 0
    let nearestDistSq = Infinity
    for (let s = 0; s < seeds.length; s++) {
      const d = domain.distanceSq(wx, wy, seeds[s].x, seeds[s].y)
      if (d < nearestDistSq) {
        nearestDistSq = d
        nearest = s
      }
    }
    const prev = reversePointByMotion(wx, wy, motions[nearest], angleStep, domain)
    om.px[i] = prev.x
    om.py[i] = prev.y
    if (previousSeeds) {
      let was = 0
      let wasSq = Infinity
      for (let s = 0; s < previousSeeds.length; s++) {
        const d = domain.distanceSq(prev.x, prev.y, previousSeeds[s].x, previousSeeds[s].y)
        if (d < wasSq) {
          wasSq = d
          was = s
        }
      }
      if (was !== nearest) fresh[i] = 1
    }
  }
  departuresFromPoints(mesh, om.sampler, om.px, om.py, om.dep)
  gradient(mesh, age, om.gradE, om.gradS)
  const next = new Float64Array(n)
  transportScalar(mesh, om.dep, age, next, om.gradE, om.gradS, true)
  for (let i = 0; i < n; i++) {
    if (membership[i] > 0.5) {
      next[i] = 0
      continue
    }
    if (fresh[i]) {
      next[i] = 0.5
      continue
    }
    const advected = next[i] + 1
    next[i] = advected > MAX_SEAFLOOR_AGE ? MAX_SEAFLOOR_AGE : advected
  }
  return next
}

// Reset the age to 0 in every cell whose centre lies within `worldRadius` of a
// world point — the fresh oceanic crust a continental breakup exposes
// (raftEvents; the ridges' crust is advectOceanAge's).
//
// A radius rather than the single containing cell this used to zero: at a
// continental breakup, splitRaftAtRift shoves the two halves a good distance
// apart in one step, and only the boundary point itself landed in the zeroed
// cell. Everything else in the gap kept whatever age it had, so the new basin
// opened with a one-cell-wide young streak down the middle of otherwise old
// floor. Sized by the caller to the gap it actually opened.
//
// The cells are found by a walk over the mesh's neighbours from the cell
// holding the point, through every cell within the radius plus one spacing
// (so a cell inside is reached even past a neighbour just outside). Round,
// not square — a square patch of fresh crust would show as one.
export function resetOceanAgeAround(age: Float64Array, x: number, y: number, worldRadius: number, domain: Domain): void {
  const om = oceanAgeMesh(domain)
  const { mesh, stamp } = om
  const radiusSq = worldRadius * worldRadius
  const reach = worldRadius + om.cellUnits
  const reachSq = reach * reach
  stampCounter += 1
  if (stampCounter === 0x7fffffff) {
    stamp.fill(0)
    stampCounter = 1
  }
  const mark = stampCounter
  const start = om.sampler.nearestCell(x, y)
  const queue = [start]
  stamp[start] = mark
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]
    const d = domain.distanceSq(mesh.x[c], mesh.y[c], x, y)
    if (d <= radiusSq) age[c] = 0
    if (d > reachSq) continue
    for (let e = mesh.nbrStart[c]; e < mesh.nbrStart[c + 1]; e++) {
      const j = mesh.nbr[e]
      if (stamp[j] === mark) continue
      stamp[j] = mark
      queue.push(j)
    }
  }
}

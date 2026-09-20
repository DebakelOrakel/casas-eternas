import type { PlateSeed } from './plateSeeds'
import { reversePointByMotion, type PlateMotion } from './plateMotion'
import { toroidalDistanceSq } from '../core/toroidal'
import { sampleBilinearWorld } from '../core/field'
import { sampleMembershipField } from '../crust/raftField'

// Ocean-floor age as a coarse full-surface field (Phase 3, see
// docs/decisions/continental-crust-rafts.md). Oceanic crust deepens as it ages
// away from the ridge that formed it (the real √age depth law), so the ocean
// baseline is OCEANIC_BASELINE − k·√age (elevationField.ts). This is a
// deliberate, bounded exception to the "no full-surface accumulator" stance:
// it's only the ocean-age scalar, which is smooth and large-scale, so a coarse
// grid is plenty. The field is advected with plate motion each epoch and reset
// to 0 at divergent boundaries (fresh crust at a ridge).
export const OCEAN_AGE_RES_X = 256
export const OCEAN_AGE_RES_Y = 128

export function createOceanAgeField(initialAge: number): Float32Array {
  const field = new Float32Array(OCEAN_AGE_RES_X * OCEAN_AGE_RES_Y)
  field.fill(initialAge)
  return field
}

// Bilinear sample of the age field at a world point, wrapped toroidally (cell
// centers sit at (i+0.5)·cellSize, hence the −0.5).
export function sampleOceanAge(age: Float32Array, x: number, y: number, worldWidth: number, worldHeight: number): number {
  return sampleBilinearWorld(age, OCEAN_AGE_RES_X, OCEAN_AGE_RES_Y, x, y, worldWidth, worldHeight)
}

// Oldest seafloor that can exist, in epochs. Earth's oceanic crust tops out
// around 180 Ma because subduction destroys it as fast as ridges make it — there
// is no ancient ocean floor anywhere. Advection here has no such sink (a cell
// over a subduction zone just keeps sampling and incrementing), so without a cap
// the mean age climbs monotonically for the whole run: 840 epochs of age after an
// 800-epoch run, a number that describes nothing physical.
//
// The depth law in elevationField.ts saturates on its own, so this is not what
// keeps the floor off the clamp — it's what keeps the SAVED field (oceanAge.f32
// rides along in every world save) interpretable as an age rather than as a
// runtime counter.
const MAX_SEAFLOOR_AGE = 180

// Semi-Lagrangian backward advection: each cell pulls its age from where its
// crust was one epoch ago — rotate the cell's world position backward by its
// (current nearest) plate's own motion, sample the old field there, and add one
// epoch. Stable (each cell reads, never scatters), and cheap (~cells × seeds).
// Returns a fresh field; the old one is read-only during the pass.
//
// `membership` (see rafts.computeMembershipField) zeroes the age under
// continental crust. Without it, a cell that spends 200 epochs buried under a
// supercontinent still ages the whole time, so when a breakup finally tears the
// continent open, the freshly exposed basin floor reads as 200-epoch-old crust
// and renders at full abyssal depth — a brand-new Atlantic born as deep as the
// oldest Pacific. Continental crust simply isn't seafloor; when a rift exposes
// what's under it, that floor is new.
export function advectOceanAge(
  age: Float32Array,
  seeds: PlateSeed[],
  motions: PlateMotion[],
  angleStep: number,
  worldWidth: number,
  worldHeight: number,
  membership: Float32Array,
  membershipResX: number,
  membershipResY: number,
): Float32Array {
  const next = new Float32Array(age.length)
  const cellW = worldWidth / OCEAN_AGE_RES_X
  const cellH = worldHeight / OCEAN_AGE_RES_Y
  for (let cy = 0; cy < OCEAN_AGE_RES_Y; cy++) {
    const wy = (cy + 0.5) * cellH
    for (let cx = 0; cx < OCEAN_AGE_RES_X; cx++) {
      const wx = (cx + 0.5) * cellW
      let nearest = 0
      let nearestDistSq = Infinity
      for (let s = 0; s < seeds.length; s++) {
        const d = toroidalDistanceSq(wx, wy, seeds[s].x, seeds[s].y, worldWidth, worldHeight)
        if (d < nearestDistSq) {
          nearestDistSq = d
          nearest = s
        }
      }
      const i = cy * OCEAN_AGE_RES_X + cx
      if (sampleMembershipField(membership, membershipResX, membershipResY, wx, wy, worldWidth, worldHeight) > 0.5) {
        next[i] = 0
        continue
      }
      const motion = motions[nearest]
      const prev = reversePointByMotion(wx, wy, motion, angleStep, worldWidth, worldHeight)
      const advected = sampleOceanAge(age, prev.x, prev.y, worldWidth, worldHeight) + 1
      next[i] = advected > MAX_SEAFLOOR_AGE ? MAX_SEAFLOOR_AGE : advected
    }
  }
  return next
}

// Reset the age to 0 in every cell within `worldRadius` of a world point — fresh
// oceanic crust formed at a divergent boundary (mid-ocean ridge / opening rift).
//
// A radius rather than the single containing cell this used to zero: at a
// continental breakup, splitRaftAtRift shoves the two halves a good distance
// apart in one step, and only the boundary point itself landed in the zeroed
// cell. Everything else in the gap kept whatever age it had, so the new basin
// opened with a one-cell-wide young streak down the middle of otherwise old
// floor. Sized by the caller to the gap it actually opened.
export function resetOceanAgeAround(age: Float32Array, x: number, y: number, worldRadius: number, worldWidth: number, worldHeight: number): void {
  const cellW = worldWidth / OCEAN_AGE_RES_X
  const cellH = worldHeight / OCEAN_AGE_RES_Y
  const spanX = Math.floor(worldRadius / cellW)
  const spanY = Math.floor(worldRadius / cellH)
  const cx = Math.floor((x / worldWidth) * OCEAN_AGE_RES_X)
  const cy = Math.floor((y / worldHeight) * OCEAN_AGE_RES_Y)
  const radiusSq = worldRadius * worldRadius
  for (let dy = -spanY; dy <= spanY; dy++) {
    const gy = ((cy + dy) % OCEAN_AGE_RES_Y + OCEAN_AGE_RES_Y) % OCEAN_AGE_RES_Y
    const wy = (gy + 0.5) * cellH
    for (let dx = -spanX; dx <= spanX; dx++) {
      const gx = ((cx + dx) % OCEAN_AGE_RES_X + OCEAN_AGE_RES_X) % OCEAN_AGE_RES_X
      const wx = (gx + 0.5) * cellW
      // Round, not square — a square patch of fresh crust would show as one.
      if (toroidalDistanceSq(wx, wy, x, y, worldWidth, worldHeight) <= radiusSq) age[gy * OCEAN_AGE_RES_X + gx] = 0
    }
  }
}

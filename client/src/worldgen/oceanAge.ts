import type { PlateSeed } from './plateSeeds'
import { reversePointByMotion, type PlateMotion } from './plateMotion'
import { toroidalDistanceSq } from './toroidal'

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
  const gx = (x / worldWidth) * OCEAN_AGE_RES_X - 0.5
  const gy = (y / worldHeight) * OCEAN_AGE_RES_Y - 0.5
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const fx = gx - x0
  const fy = gy - y0
  const x0m = ((x0 % OCEAN_AGE_RES_X) + OCEAN_AGE_RES_X) % OCEAN_AGE_RES_X
  const y0m = ((y0 % OCEAN_AGE_RES_Y) + OCEAN_AGE_RES_Y) % OCEAN_AGE_RES_Y
  const x1m = (x0m + 1) % OCEAN_AGE_RES_X
  const y1m = (y0m + 1) % OCEAN_AGE_RES_Y
  const v00 = age[y0m * OCEAN_AGE_RES_X + x0m]
  const v10 = age[y0m * OCEAN_AGE_RES_X + x1m]
  const v01 = age[y1m * OCEAN_AGE_RES_X + x0m]
  const v11 = age[y1m * OCEAN_AGE_RES_X + x1m]
  const top = v00 + (v10 - v00) * fx
  const bottom = v01 + (v11 - v01) * fx
  return top + (bottom - top) * fy
}

// Semi-Lagrangian backward advection: each cell pulls its age from where its
// crust was one epoch ago — rotate the cell's world position backward by its
// (current nearest) plate's own motion, sample the old field there, and add one
// epoch. Stable (each cell reads, never scatters), and cheap (~cells × seeds).
// Returns a fresh field; the old one is read-only during the pass.
export function advectOceanAge(
  age: Float32Array,
  seeds: PlateSeed[],
  motions: PlateMotion[],
  angleStep: number,
  worldWidth: number,
  worldHeight: number,
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
      const motion = motions[nearest]
      const prev = reversePointByMotion(wx, wy, motion, angleStep, worldWidth, worldHeight)
      next[cy * OCEAN_AGE_RES_X + cx] = sampleOceanAge(age, prev.x, prev.y, worldWidth, worldHeight) + 1
    }
  }
  return next
}

// Reset the age cell containing a world point to 0 — fresh oceanic crust formed
// at a divergent boundary (mid-ocean ridge / opening rift).
export function resetOceanAgeAt(age: Float32Array, x: number, y: number, worldWidth: number, worldHeight: number): void {
  const cx = Math.min(OCEAN_AGE_RES_X - 1, Math.max(0, Math.floor((x / worldWidth) * OCEAN_AGE_RES_X)))
  const cy = Math.min(OCEAN_AGE_RES_Y - 1, Math.max(0, Math.floor((y / worldHeight) * OCEAN_AGE_RES_Y)))
  age[cy * OCEAN_AGE_RES_X + cx] = 0
}

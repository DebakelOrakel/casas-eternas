import { toroidalDistanceSq } from '../core/toroidal'
import { MANTLE_TUNING } from './mantleTuneParams'
import { wrapValue } from '../core/field'
import { sampleMembershipField } from '../crust/raftField'

// A coarse, evolving mantle buoyancy/temperature field under the whole torus
// surface — the CAUSE the plates ride on (Phase M2 of
// docs/decisions/evolving-euler-poles.md). Hot = upwelling, cold = downwelling.
// Its surface coupling closes the Wilson cycle: continents INSULATE the mantle
// (heat builds beneath them → an upwelling grows → the flow diverges under them →
// their plates are pushed apart → breakup), while ocean COOLS (downwelling →
// convergence → continents drift together → assembly). Bounded by diffusion +
// decay, so the whole thing stays stable — and the plate motions are FIT to the
// resulting flow (a bounded function of a bounded field), avoiding force-
// integration runaway. Reuses the ocean-current streamfunction pattern
// (Gauss-Seidel Poisson).
//
// LIVES IN ITS OWN MODULE because BOTH eras run on it: five files in `archean/`
// and five in `tectonics/` read this field, so filing it under either one made
// the other import across a boundary for its own substrate. It sat in
// `tectonics/` for historical reasons only.
//
// The fit itself — `fitMotionsToFlow` — deliberately does NOT live here. It
// takes plate seeds and returns plate motions, so keeping it would have made
// the substrate depend on the thing riding on it. It is in
// `tectonics/plateMotion.ts` with the types it speaks in.

export const MANTLE_RES_X = 128
export const MANTLE_RES_Y = 64
const RX = MANTLE_RES_X
const RY = MANTLE_RES_Y

// The callers step one cell from a cell of the grid, so a compare wraps the
// integer index; wrapValue only past that. The same index either way —
// wrapValue on integers is exact — and 8 % of an epoch less (2026-10-02).
function wrapIdx(x: number, y: number): number {
  const wy = y < 0 ? (y >= -RY ? y + RY : wrapValue(y, RY)) : y < RY ? y : y < 2 * RY ? y - RY : wrapValue(y, RY)
  const wx = x < 0 ? (x >= -RX ? x + RX : wrapValue(x, RX)) : x < RX ? x : x < 2 * RX ? x - RX : wrapValue(x, RX)
  return wy * RX + wx
}

// Smoothed random initial field — a few upwelling/downwelling blobs so there's
// convection (and therefore plate motion) from epoch 0, before surface coupling
// has reshaped it.
// How many blur passes smooth the initial random field into convection cells.
//
// This was the mantle-vigour knob, on the reasoning that changing the field's
// initial characteristic scale steers the world while leaving the tuned epoch
// dynamics alone. Measurement killed it: the per-epoch diffusion below erases the
// initial smoothing within a few dozen epochs. Field roughness by starting value:
//
//     passes   epoch 0   epoch 10   epoch 40
//       10      0.353      0.249      0.167
//        1      0.894      0.336      0.189
//     spread    2.53x      1.35x      1.13x
//
// Nine tenths of the difference is gone by epoch 40, and the phase is not stopped
// before epoch 150. A sweep over the full slider range confirmed the consequence:
// craton count, plate count and land fraction all varied non-monotonically, by no
// more than they varied between two seeds at the same setting.
//
// The knob moved to the per-epoch diffusion, which cannot wash out because it is
// reapplied every epoch — see ArcheanParams.diffusion. This constant is now just
// the starting scale, with no claim to steer anything.
export const DEFAULT_INITIAL_SMOOTHING = 6

export function createMantleField(random: () => number, smoothingPasses = DEFAULT_INITIAL_SMOOTHING): Float32Array {
  let field: Float32Array = new Float32Array(RX * RY)
  for (let i = 0; i < field.length; i++) field[i] = random() * 2 - 1
  for (let pass = 0; pass < smoothingPasses; pass++) field = boxBlur(field, 0.5)
  return zeroMean(clampField(field))
}

function boxBlur(field: Float32Array, weight: number): Float32Array {
  const out = new Float32Array(RX * RY)
  for (let y = 0; y < RY; y++) {
    for (let x = 0; x < RX; x++) {
      const c = field[y * RX + x]
      const n = field[wrapIdx(x, y - 1)] + field[wrapIdx(x, y + 1)] + field[wrapIdx(x - 1, y)] + field[wrapIdx(x + 1, y)]
      out[y * RX + x] = c * (1 - weight) + (n / 4) * weight
    }
  }
  return out
}

function zeroMean(field: Float32Array): Float32Array {
  let mean = 0
  for (let i = 0; i < field.length; i++) mean += field[i]
  mean /= field.length
  for (let i = 0; i < field.length; i++) field[i] -= mean
  return field
}

function clampField(field: Float32Array): Float32Array {
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i]))
  return field
}

// One epoch of field evolution: continents heat the mantle beneath (insulation →
// the doming driver), ocean cools it (downwelling), then diffuse + decay to a
// zero mean. Mutates + returns the field.
export function evolveMantleField(
  field: Float32Array,
  membership: Float32Array,
  membershipResX: number,
  membershipResY: number,
  worldWidth: number,
  worldHeight: number,
  diffusionPasses: number = MANTLE_TUNING.diffusionPasses,
): Float32Array {
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * worldHeight
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * worldWidth
      const i = gy * RX + gx
      if (sampleMembershipField(membership, membershipResX, membershipResY, wx, wy, worldWidth, worldHeight) > 0.5) field[i] += MANTLE_TUNING.insulationRate
      else field[i] -= MANTLE_TUNING.oceanCoolRate
    }
  }
  // Fractional passes: whole ones at full weight, then a partial one for the
  // remainder. Integer passes alone would give the Archean's mixing knob three
  // usable positions (0, 1, 2 — it saturates past that), which is not a slider.
  const wholePasses = Math.floor(diffusionPasses)
  for (let p = 0; p < wholePasses; p++) field = boxBlur(field, MANTLE_TUNING.diffusionWeight)
  const remainder = diffusionPasses - wholePasses
  if (remainder > 0) field = boxBlur(field, MANTLE_TUNING.diffusionWeight * remainder)
  for (let i = 0; i < field.length; i++) field[i] *= MANTLE_TUNING.decayKeep
  return zeroMean(clampField(field))
}

// Keeps Archean convection alive by renormalising the field to a target RMS.
//
// evolveMantleField is written for a world that HAS continents: they insulate, the
// ocean cools, and the difference between the two sustains the pattern. With no
// crust at all the ocean term is uniform, zeroMean cancels it exactly, and all that
// remains is MANTLE_TUNING.decayKeep — so the field decays exponentially to nothing. Measured
// with zero crust: peak amplitude 0.443 at epoch 0, 0.007 by epoch 60.
//
// That would make the Archean impossible by construction — crust needs upwellings,
// and upwellings would need crust. The resolution is physical rather than a fudge:
// Archean convection was driven by RADIOGENIC HEAT and secular core cooling, not by
// surface insulation. Internal heating is the driver; the insulation feedback is a
// modulation on top of it, and it is the only one evolveMantleField models because
// by the time plates exist it is the only one that varies.
//
// Renormalising rather than injecting fresh noise is deliberate: it preserves the
// pattern the field has developed (cells keep their identity, drift and reorganise)
// while holding its amplitude steady, so a fixed nucleation threshold keeps meaning
// the same thing at epoch 10 and at epoch 300.
export function sustainMantleVigour(field: Float32Array, targetRms: number): Float32Array {
  let sq = 0
  for (let i = 0; i < field.length; i++) sq += field[i] * field[i]
  const rms = Math.sqrt(sq / field.length)
  if (rms < 1e-6) return field
  const scale = targetRms / rms
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-MANTLE_TUNING.clamp, Math.min(MANTLE_TUNING.clamp, field[i] * scale))
  return field
}

// Release the thermal doming at a continental breakup: subtract a broad bump of
// buoyancy around the rift point (linear falloff to 0 at `worldRadius`). Physically,
// the upwelling that built under the insulating supercontinent has now breached the
// surface (the flood-basalt eruption) and the widening gap is floored with new,
// cooling ocean — so the buoyancy that DROVE the divergence is spent. This is what
// lets the global CONT_RIFT_COOLDOWN band-aid be retired (Option C): without it, the
// broad hot dome under an assembled continent keeps many boundary points divergent,
// so one breakup fires every epoch (strobing); draining the dome at breakup collapses
// that forcing regionally, so the flow (recomputed next epoch) stops pushing the
// halves apart at that spot and the strobing stops on its own. Mutates the field;
// the next evolveMantleField re-clamps + re-zero-means it.
export function coolMantleAt(field: Float32Array, x: number, y: number, worldWidth: number, worldHeight: number, worldRadius: number, amount: number): void {
  const r2 = worldRadius * worldRadius
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * worldHeight
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * worldWidth
      const d2 = toroidalDistanceSq(wx, wy, x, y, worldWidth, worldHeight)
      if (d2 > r2) continue
      const falloff = 1 - Math.sqrt(d2) / worldRadius
      field[gy * RX + gx] = Math.max(-MANTLE_TUNING.clamp, field[gy * RX + gx] - amount * falloff)
    }
  }
}

// Surface flow from the field: solve ∇²φ = (T − mean) (zero-mean source on the
// torus, Gauss-Seidel), then u = ∇φ. u DIVERGES from hot upwellings and CONVERGES
// to cold downwellings (φ has a minimum at a hot source, so ∇φ points outward).
// Returns interleaved [ux, uy] per cell, scaled to world pixels.
export function computeMantleFlow(field: Float32Array): Float32Array {
  const n = RX * RY
  const phi = new Float32Array(n)
  for (let iter = 0; iter < MANTLE_TUNING.solveIters; iter++) {
    for (let y = 0; y < RY; y++) {
      for (let x = 0; x < RX; x++) {
        const i = y * RX + x
        const neighbors = phi[wrapIdx(x - 1, y)] + phi[wrapIdx(x + 1, y)] + phi[wrapIdx(x, y - 1)] + phi[wrapIdx(x, y + 1)]
        phi[i] = (neighbors - field[i]) / 4
      }
    }
  }
  const flow = new Float32Array(n * 2)
  for (let y = 0; y < RY; y++) {
    for (let x = 0; x < RX; x++) {
      const i = y * RX + x
      const ux = (phi[wrapIdx(x + 1, y)] - phi[wrapIdx(x - 1, y)]) / 2
      const uy = (phi[wrapIdx(x, y + 1)] - phi[wrapIdx(x, y - 1)]) / 2
      flow[i * 2] = ux * MANTLE_TUNING.flowSpeedScale
      flow[i * 2 + 1] = uy * MANTLE_TUNING.flowSpeedScale
    }
  }
  return flow
}

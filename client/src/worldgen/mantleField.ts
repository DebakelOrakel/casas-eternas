import type { PlateSeed } from './plateSeeds'
import type { PlateMotion } from './plateMotion'
import { sampleMembershipField } from './rafts'
import { toroidalDistanceSq, wrappedDelta } from './toroidal'

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

export const MANTLE_RES_X = 128
export const MANTLE_RES_Y = 64
const RX = MANTLE_RES_X
const RY = MANTLE_RES_Y

// Continents add heat under themselves each epoch; ocean removes it. The
// asymmetry (insulation vs. cooling) is what drives the cycle. Diffusion spreads
// heat into broad convection cells; decay relaxes toward a zero mean so heat
// never accumulates unbounded (and the periodic Poisson source stays solvable).
const INSULATION_RATE = 0.05
const OCEAN_COOL_RATE = 0.025
// One gentle pass — enough to make broad cells, few enough that an upwelling
// building under a continent stays peaked (over-diffusing flattened it and
// starved the doming/breakup).
const DIFFUSION_PASSES = 1
const DECAY_KEEP = 0.955
const T_CLAMP = 2.5
// Gauss-Seidel iterations for the Poisson flow solve.
const SOLVE_ITERS = 260
// Scales the raw ∇φ flow to world pixels/epoch — tuned so plate speeds land in a
// reasonable range (see plateMotion's LINEAR_SPEED_*). Calibrated by harness.
const FLOW_SPEED_SCALE = 110

function wrapIdx(x: number, y: number): number {
  return (((y % RY) + RY) % RY) * RX + (((x % RX) + RX) % RX)
}

// Smoothed random initial field — a few upwelling/downwelling blobs so there's
// convection (and therefore plate motion) from epoch 0, before surface coupling
// has reshaped it.
export function createMantleField(random: () => number): Float32Array {
  let field: Float32Array = new Float32Array(RX * RY)
  for (let i = 0; i < field.length; i++) field[i] = random() * 2 - 1
  for (let pass = 0; pass < 6; pass++) field = boxBlur(field, 0.5)
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
  for (let i = 0; i < field.length; i++) field[i] = Math.max(-T_CLAMP, Math.min(T_CLAMP, field[i]))
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
): Float32Array {
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * worldHeight
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * worldWidth
      const i = gy * RX + gx
      if (sampleMembershipField(membership, membershipResX, membershipResY, wx, wy, worldWidth, worldHeight) > 0.5) field[i] += INSULATION_RATE
      else field[i] -= OCEAN_COOL_RATE
    }
  }
  for (let p = 0; p < DIFFUSION_PASSES; p++) field = boxBlur(field, 0.5)
  for (let i = 0; i < field.length; i++) field[i] *= DECAY_KEEP
  return zeroMean(clampField(field))
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
      field[gy * RX + gx] = Math.max(-T_CLAMP, field[gy * RX + gx] - amount * falloff)
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
  for (let iter = 0; iter < SOLVE_ITERS; iter++) {
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
      flow[i * 2] = ux * FLOW_SPEED_SCALE
      flow[i * 2 + 1] = uy * FLOW_SPEED_SCALE
    }
  }
  return flow
}

// Fits each plate's rigid motion {drift, spin} to the mantle flow under its
// footprint (every coarse mantle cell assigned to its nearest plate seed →
// least-squares rigid fit about that seed). This is the TARGET motion; the caller
// blends it with the previous motion for inertia. centroid = current seed.
export function fitMotionsToFlow(seeds: PlateSeed[], flow: Float32Array, worldWidth: number, worldHeight: number): PlateMotion[] {
  const n = seeds.length
  const sumUx = new Float64Array(n)
  const sumUy = new Float64Array(n)
  const sumCross = new Float64Array(n)
  const sumRsq = new Float64Array(n)
  const count = new Int32Array(n)
  for (let gy = 0; gy < RY; gy++) {
    const wy = ((gy + 0.5) / RY) * worldHeight
    for (let gx = 0; gx < RX; gx++) {
      const wx = ((gx + 0.5) / RX) * worldWidth
      let best = 0
      let bestSq = Infinity
      for (let p = 0; p < n; p++) {
        const d = toroidalDistanceSq(wx, wy, seeds[p].x, seeds[p].y, worldWidth, worldHeight)
        if (d < bestSq) {
          bestSq = d
          best = p
        }
      }
      const i = gy * RX + gx
      const ux = flow[i * 2]
      const uy = flow[i * 2 + 1]
      const rx = wrappedDelta(wx, seeds[best].x, worldWidth)
      const ry = wrappedDelta(wy, seeds[best].y, worldHeight)
      sumUx[best] += ux
      sumUy[best] += uy
      sumCross[best] += rx * uy - ry * ux
      sumRsq[best] += rx * rx + ry * ry
      count[best] += 1
    }
  }
  return seeds.map((seed, p) => ({
    driftX: count[p] ? sumUx[p] / count[p] : 0,
    driftY: count[p] ? sumUy[p] / count[p] : 0,
    spin: sumRsq[p] > 1e-6 ? sumCross[p] / sumRsq[p] : 0,
    centroidX: seed.x,
    centroidY: seed.y,
  }))
}

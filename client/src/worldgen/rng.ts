// Deterministic string seed -> PRNG, so a given seed always reproduces the
// same plate layout (seed positions, colors).

export function hashSeedString(seed: string): number {
  let hash = 2166136261 // FNV-1a offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// A seeded PRNG that also exposes its current internal state, so a simulation
// can be serialized mid-run and resumed bit-identically (see the save/load
// world snapshot). Call it like a plain `() => number`; `state()` reads the
// counter to store, and passing that counter back to mulberry32() resumes from
// exactly there.
export interface SeededRandom {
  (): number
  state(): number
}

export function mulberry32(seed: number): SeededRandom {
  let state = seed >>> 0
  const rng = (() => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }) as SeededRandom
  rng.state = () => state
  return rng
}

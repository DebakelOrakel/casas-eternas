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
// can be serialized mid-run and resumed bit-identically (the plates' snapshot
// type; the generator is the engine's).
export interface SeededRandom {
  (): number
  state(): number
}

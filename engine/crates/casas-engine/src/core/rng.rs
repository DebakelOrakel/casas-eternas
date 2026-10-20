//! `core/rng.ts`: the seeded generators.

/// FNV-1a over a seed string's UTF-16 code units, as `hashSeedString`.
pub fn hash_seed_string(seed: &str) -> u32 {
    let mut hash: u32 = 2166136261;
    for unit in seed.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

/// mulberry32, as `core/rng.ts` writes it: a 32-bit state, each draw in
/// [0, 1).
pub struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }

    pub fn state(&self) -> u32 {
        self.state
    }

    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

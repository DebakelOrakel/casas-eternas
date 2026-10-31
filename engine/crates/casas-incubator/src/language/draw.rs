//! The draws of the languages: integers only. A draw stream is mulberry32
//! (`casas_generator::core::rng`) on a hash of the seed and a text tag.
//! Mulberry32 gives a u32 divided by 2^32; this module takes the u32 back
//! (an exact operation), and every draw after it is integer arithmetic.
//! So the native and the WASM builds get the same bits.

use casas_generator::core::rng::{Mulberry32, hash_seed_string};

/// The finaliser of MurmurHash3: a 32-bit mix.
pub fn mix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// The seed of a stream: the seed and the tag's hash, mixed.
pub fn seed_of(seed: u32, tag: &str) -> u32 {
    mix(seed ^ mix(hash_seed_string(tag)))
}

pub struct Draw(Mulberry32);

impl Draw {
    /// The stream for this seed and this tag.
    pub fn new(seed: u32, tag: &str) -> Draw {
        Draw(Mulberry32::new(seed_of(seed, tag)))
    }

    /// The next u32.
    pub fn u32(&mut self) -> u32 {
        (self.0.next() * 4_294_967_296.0) as u32
    }

    /// An integer in [0, n). n = 0 gives 0.
    pub fn below(&mut self, n: u32) -> u32 {
        ((u64::from(self.u32()) * u64::from(n)) >> 32) as u32
    }

    /// An integer in [lo, hi].
    pub fn range(&mut self, lo: u32, hi: u32) -> u32 {
        lo + self.below(hi - lo + 1)
    }

    /// True with a chance of `permille` / 1 000.
    pub fn chance(&mut self, permille: u32) -> bool {
        self.below(1000) < permille
    }

    /// An index into `weights`, by weight. None when all weights are 0.
    pub fn pick(&mut self, weights: &[u64]) -> Option<usize> {
        let total: u64 = weights.iter().sum();
        if total == 0 {
            return None;
        }
        // A 64-bit draw: two u32s, so that a total over 2^32 is fair.
        let r = ((u64::from(self.u32()) << 32) | u64::from(self.u32())) % total;
        let mut acc = 0;
        for (k, &w) in weights.iter().enumerate() {
            acc += w;
            if r < acc {
                return Some(k);
            }
        }
        None
    }

    /// An item of `items`, by the weight the closure gives.
    pub fn pick_by<T>(&mut self, items: &[T], weight: impl Fn(&T) -> u64) -> Option<usize> {
        let weights: Vec<u64> = items.iter().map(weight).collect();
        self.pick(&weights)
    }
}

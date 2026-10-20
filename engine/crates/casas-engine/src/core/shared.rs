//! Arrays that the blocks of a parallel stage write at different indices,
//! and the blocks themselves. No TypeScript counterpart: the worker pool
//! shares its state as SharedArrayBuffer views, this is the same for
//! threads.
//!
//! A shared array is a view of a `&mut [T]` as atomics, read and written
//! with relaxed ordering: on every target the engine builds for that is an
//! ordinary load and store, so the bits are those of the plain array, and
//! no access is a data race whatever the blocks do. Which block writes
//! which index is the stage's rule, stated where the stage runs.

use std::ops::Range;
use std::sync::atomic::{AtomicI32, AtomicU8, AtomicU32, AtomicU64, Ordering};

/// An f32 array shared by the blocks of a stage.
pub struct SharedF32<'a>(&'a [AtomicU32]);

impl<'a> SharedF32<'a> {
    pub fn new(values: &'a mut [f32]) -> Self {
        // SAFETY: AtomicU32 has the size of f32 and an alignment of 4,
        // which an f32 has on every target the engine builds for (checked);
        // the exclusive borrow is held for the view's lifetime, so nothing
        // else reads or writes the memory meanwhile.
        assert_eq!(align_of::<f32>(), align_of::<AtomicU32>());
        SharedF32(unsafe { std::slice::from_raw_parts(values.as_mut_ptr().cast(), values.len()) })
    }

    #[inline]
    pub fn get(&self, i: usize) -> f32 {
        f32::from_bits(self.0[i].load(Ordering::Relaxed))
    }

    #[inline]
    pub fn set(&self, i: usize, v: f32) {
        self.0[i].store(v.to_bits(), Ordering::Relaxed);
    }
}

/// An f64 array shared by the blocks of a stage.
pub struct SharedF64<'a>(&'a [AtomicU64]);

impl<'a> SharedF64<'a> {
    pub fn new(values: &'a mut [f64]) -> Self {
        // SAFETY: AtomicU64 has the size of f64 and an alignment of 8,
        // which an f64 has on every target the engine builds for (checked);
        // the exclusive borrow is held for the view's lifetime.
        assert_eq!(align_of::<f64>(), align_of::<AtomicU64>());
        SharedF64(unsafe { std::slice::from_raw_parts(values.as_mut_ptr().cast(), values.len()) })
    }

    #[inline]
    pub fn get(&self, i: usize) -> f64 {
        f64::from_bits(self.0[i].load(Ordering::Relaxed))
    }

    #[inline]
    pub fn set(&self, i: usize, v: f64) {
        self.0[i].store(v.to_bits(), Ordering::Relaxed);
    }
}

/// An i32 array shared by the blocks of a stage.
pub struct SharedI32<'a>(&'a [AtomicI32]);

impl<'a> SharedI32<'a> {
    pub fn new(values: &'a mut [i32]) -> Self {
        // SAFETY: AtomicI32 has the size of i32 and an alignment of 4,
        // which an i32 has on every target the engine builds for (checked);
        // the exclusive borrow is held for the view's lifetime.
        assert_eq!(align_of::<i32>(), align_of::<AtomicI32>());
        SharedI32(unsafe { std::slice::from_raw_parts(values.as_mut_ptr().cast(), values.len()) })
    }

    #[inline]
    pub fn get(&self, i: usize) -> i32 {
        self.0[i].load(Ordering::Relaxed)
    }

    #[inline]
    pub fn set(&self, i: usize, v: i32) {
        self.0[i].store(v, Ordering::Relaxed);
    }
}

/// A u8 array shared by the blocks of a stage.
pub struct SharedU8<'a>(&'a [AtomicU8]);

impl<'a> SharedU8<'a> {
    pub fn new(values: &'a mut [u8]) -> Self {
        // SAFETY: AtomicU8 has the size and alignment of u8; the exclusive
        // borrow is held for the view's lifetime.
        SharedU8(unsafe { std::slice::from_raw_parts(values.as_mut_ptr().cast(), values.len()) })
    }

    #[inline]
    pub fn get(&self, i: usize) -> u8 {
        self.0[i].load(Ordering::Relaxed)
    }

    #[inline]
    pub fn set(&self, i: usize, v: u8) {
        self.0[i].store(v, Ordering::Relaxed);
    }
}

/// `0..n` cut into blocks of `block`: the unit of a parallel stage, the
/// same cut for any number of threads.
pub fn block_ranges(n: usize, block: usize) -> Vec<Range<usize>> {
    (0..n)
        .step_by(block.max(1))
        .map(|b| b..(b + block).min(n))
        .collect()
}

/// Runs `f` on every range, on rayon's pool with the `parallel` feature,
/// one after another without it; the results in the ranges' order.
pub fn for_ranges<R: Send>(
    ranges: &[Range<usize>],
    f: impl Fn(Range<usize>) -> R + Sync + Send,
) -> Vec<R> {
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        ranges.par_iter().map(|r| f(r.clone())).collect()
    }
    #[cfg(not(feature = "parallel"))]
    {
        ranges.iter().map(|r| f(r.clone())).collect()
    }
}

//! The Hilbert curve index, the mesh's insertion order (decision 8 of
//! docs/decisions/adaptive-mesh.md). A total order on positions, and
//! consecutive points are neighbours.

use crate::core::js;

/// Warren's xy2d on a 2^order × 2^order grid.
pub fn hilbert_index(mut x: u32, mut y: u32, order: u32) -> u64 {
    let n = 1u32 << order;
    let mut d = 0u64;
    let mut s = n >> 1;
    while s > 0 {
        let rx = u32::from(x & s > 0);
        let ry = u32::from(y & s > 0);
        d += s as u64 * s as u64 * ((3 * rx) ^ ry) as u64;
        if ry == 0 {
            if rx == 1 {
                x = s.wrapping_sub(1).wrapping_sub(x);
                y = s.wrapping_sub(1).wrapping_sub(y);
            }
            std::mem::swap(&mut x, &mut y);
        }
        s >>= 1;
    }
    d
}

pub const HILBERT_ORDER: u32 = 16;

/// The same index four bits a step: for each of the four states (the
/// complement and the swap the loop applies to the bits still to come)
/// and each 4-bit chunk of x and y, what the loop adds to d and the state
/// it leaves. Made by the loop's own steps, so the tables cannot disagree
/// with the loop (2026-10-02: the index a bit at a time was 3 % of an
/// epoch).
const fn chunk_tables() -> ([u8; 1024], [u8; 1024]) {
    let mut table_d = [0u8; 1024];
    let mut table_state = [0u8; 1024];
    let mut state = 0;
    while state < 4 {
        let mut xc = 0;
        while xc < 16 {
            let mut yc = 0;
            while yc < 16 {
                let mut x: i32 = xc;
                let mut y: i32 = yc;
                if state & 1 != 0 {
                    x ^= 15;
                    y ^= 15;
                }
                if state & 2 != 0 {
                    let t = x;
                    x = y;
                    y = t;
                }
                let mut d = 0;
                let mut flips = 0;
                let mut s = 8;
                while s > 0 {
                    let rx = if x & s > 0 { 1 } else { 0 };
                    let ry = if y & s > 0 { 1 } else { 0 };
                    d += s * s * ((3 * rx) ^ ry);
                    if ry == 0 {
                        if rx == 1 {
                            x = s - 1 - x;
                            y = s - 1 - y;
                            flips ^= 1;
                        }
                        let t = x;
                        x = y;
                        y = t;
                        flips ^= 2;
                    }
                    s >>= 1;
                }
                let k = (state * 256 + xc * 16 + yc) as usize;
                table_d[k] = d as u8;
                table_state[k] = (state ^ flips) as u8;
                yc += 1;
            }
            xc += 1;
        }
        state += 1;
    }
    (table_d, table_state)
}

const CHUNK: u32 = 4;
const TABLES: ([u8; 1024], [u8; 1024]) = chunk_tables();

fn hilbert_index_by_chunks(x: u32, y: u32) -> u64 {
    let mut d = 0u64;
    let mut state = 0usize;
    let mut shift = HILBERT_ORDER as i32 - CHUNK as i32;
    while shift >= 0 {
        let k = state * 256 + ((x >> shift) & 15) as usize * 16 + ((y >> shift) & 15) as usize;
        d = d * 256 + TABLES.0[k] as u64;
        state = TABLES.1[k] as usize;
        shift -= CHUNK as i32;
    }
    d
}

/// The Hilbert key of a world position on a domain of the given extent.
pub fn hilbert_key(x: f64, y: f64, width: f64, height: f64) -> u64 {
    let n = (1u32 << HILBERT_ORDER) as f64;
    let gx = js::min(n - 1.0, js::max(0.0, ((x / width) * n).floor()));
    let gy = js::min(n - 1.0, js::max(0.0, ((y / height) * n).floor()));
    hilbert_index_by_chunks(js::to_int32(gx) as u32, js::to_int32(gy) as u32)
}

/// Indices 0..count sorted by the Hilbert key of (xs[i], ys[i]); ties by
/// index, so the order is total.
pub fn hilbert_order(xs: &[f64], ys: &[f64], count: usize, width: f64, height: f64) -> Vec<u32> {
    let mut keyed: Vec<(u64, u32)> = (0..count)
        .map(|i| (hilbert_key(xs[i], ys[i], width, height), i as u32))
        .collect();
    keyed.sort_unstable();
    keyed.into_iter().map(|(_, i)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chunks_give_the_loop_index() {
        let mut s = 12345u32;
        for _ in 0..100000 {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            let x = s >> 16;
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            let y = s >> 16;
            assert_eq!(
                hilbert_index_by_chunks(x, y),
                hilbert_index(x, y, HILBERT_ORDER)
            );
        }
    }
}

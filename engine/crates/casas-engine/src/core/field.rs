//! `core/field.ts`: the torus's one wrap and the raster samplers the grids
//! are built on. Outside `core` a raster is read through its
//! [`DomainGrid`](super::domain::DomainGrid), as in TypeScript.

use super::js;

/// v into [0, n) for any sign: the bits of `((v % n) + n) % n`. n > 0.
#[inline]
pub fn wrap_value(v: f64, n: f64) -> f64 {
    let m = if v >= 0.0 {
        if v < n {
            v
        } else if v < 2.0 * n {
            v - n
        } else {
            v % n
        }
    } else if v > -n {
        v
    } else {
        v % n
    };
    let t = m + n;
    if t < n {
        t
    } else if t < 2.0 * n {
        t - n
    } else {
        t % n
    }
}

/// Bilinear sample at fractional GRID coordinates (cell centres at
/// integers), wrapping in both axes.
pub fn sample_bilinear_grid(field: &[f32], res_x: usize, res_y: usize, fx: f64, fy: f64) -> f64 {
    let x = wrap_value(fx, res_x as f64);
    let y = wrap_value(fy, res_y as f64);
    let x0 = x.floor();
    let y0 = y.floor();
    let (x0i, y0i) = (x0 as usize, y0 as usize);
    let x1 = (x0i + 1) % res_x;
    let y1 = (y0i + 1) % res_y;
    let tx = x - x0;
    let ty = y - y0;
    let f = |i: usize| field[i] as f64;
    let top = f(y0i * res_x + x0i) * (1.0 - tx) + f(y0i * res_x + x1) * tx;
    let bottom = f(y1 * res_x + x0i) * (1.0 - tx) + f(y1 * res_x + x1) * tx;
    top * (1.0 - ty) + bottom * ty
}

/// Bilinear sample at WORLD coordinates, cell centres at (i + 0.5) cells.
#[allow(clippy::too_many_arguments)]
pub fn sample_bilinear_world(
    field: &[f32],
    res_x: usize,
    res_y: usize,
    x: f64,
    y: f64,
    world_width: f64,
    world_height: f64,
) -> f64 {
    let gx = (x / world_width) * res_x as f64 - 0.5;
    let gy = (y / world_height) * res_y as f64 - 0.5;
    let x0 = gx.floor();
    let y0 = gy.floor();
    let fx = gx - x0;
    let fy = gy - y0;
    let x0m = wrap_value(x0, res_x as f64) as usize;
    let y0m = wrap_value(y0, res_y as f64) as usize;
    let x1m = (x0m + 1) % res_x;
    let y1m = (y0m + 1) % res_y;
    let f = |i: usize| field[i] as f64;
    let (v00, v10, v01, v11) = (
        f(y0m * res_x + x0m),
        f(y0m * res_x + x1m),
        f(y1m * res_x + x0m),
        f(y1m * res_x + x1m),
    );
    let top = v00 + (v10 - v00) * fx;
    let bottom = v01 + (v11 - v01) * fx;
    top + (bottom - top) * fy
}

/// A whole raster resampled up onto a finer grid, bilinear and torus-
/// wrapped, the target cell's corner sampled.
pub fn upscale_bilinear_toroidal(
    src: &[f32],
    src_width: usize,
    src_height: usize,
    dst_width: usize,
    dst_height: usize,
) -> Vec<f32> {
    let mut dst = vec![0f32; dst_width * dst_height];
    let fx = src_width as f64 / dst_width as f64;
    let fy = src_height as f64 / dst_height as f64;
    let f = |i: usize| src[i] as f64;
    for y in 0..dst_height {
        let sy = y as f64 * fy;
        let y0 = sy.floor();
        let ty = sy - y0;
        let y0m = wrap_value(y0, src_height as f64) as usize;
        let y1m = (y0m + 1) % src_height;
        for x in 0..dst_width {
            let sx = x as f64 * fx;
            let x0 = sx.floor();
            let tx = sx - x0;
            let x0m = wrap_value(x0, src_width as f64) as usize;
            let x1m = (x0m + 1) % src_width;
            let (v00, v10) = (f(y0m * src_width + x0m), f(y0m * src_width + x1m));
            let (v01, v11) = (f(y1m * src_width + x0m), f(y1m * src_width + x1m));
            let top = v00 + (v10 - v00) * tx;
            let bottom = v01 + (v11 - v01) * tx;
            dst[y * dst_width + x] = (top + (bottom - top) * ty) as f32;
        }
    }
    dst
}

/// Nearest-cell sample at world coordinates, torus-wrapped.
#[allow(clippy::too_many_arguments)]
pub fn sample_nearest_world(
    field: &[f32],
    res_x: usize,
    res_y: usize,
    x: f64,
    y: f64,
    world_width: f64,
    world_height: f64,
) -> f64 {
    let gx = js::min(
        (res_x - 1) as f64,
        ((wrap_value(x, world_width) / world_width) * res_x as f64).floor(),
    );
    let gy = js::min(
        (res_y - 1) as f64,
        ((wrap_value(y, world_height) / world_height) * res_y as f64).floor(),
    );
    // A NaN point reads no cell, as the TypeScript lookup's undefined.
    if gx.is_nan() || gy.is_nan() {
        return f64::NAN;
    }
    field[gy as usize * res_x + gx as usize] as f64
}

/// A raster down to a coarse grid by the mean over each footprint.
pub fn downsample_box(
    full_res: &[f32],
    full_w: usize,
    full_h: usize,
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut out = vec![0f32; res_x * res_y];
    let fw = full_w as f64 / res_x as f64;
    let fh = full_h as f64 / res_y as f64;
    for gy in 0..res_y {
        let y0 = (gy as f64 * fh).floor() as usize;
        let y1 = ((gy + 1) as f64 * fh).floor() as usize;
        for gx in 0..res_x {
            let x0 = (gx as f64 * fw).floor() as usize;
            let x1 = ((gx + 1) as f64 * fw).floor() as usize;
            let mut sum = 0.0;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += full_res[y * full_w + x] as f64;
                }
            }
            out[gy * res_x + gx] = (sum / ((y1 - y0) * (x1 - x0)) as f64) as f32;
        }
    }
    out
}

/// A raster down to a coarse grid by the maximum over each footprint.
pub fn downsample_max(
    full_res: &[f32],
    full_w: usize,
    full_h: usize,
    res_x: usize,
    res_y: usize,
) -> Vec<f32> {
    let mut out = vec![0f32; res_x * res_y];
    let fw = full_w as f64 / res_x as f64;
    let fh = full_h as f64 / res_y as f64;
    for gy in 0..res_y {
        let y0 = (gy as f64 * fh).floor() as usize;
        let y1 = ((gy + 1) as f64 * fh).floor() as usize;
        for gx in 0..res_x {
            let x0 = (gx as f64 * fw).floor() as usize;
            let x1 = ((gx + 1) as f64 * fw).floor() as usize;
            let mut m = if x1 > x0 && y1 > y0 {
                full_res[y0 * full_w + x0]
            } else {
                0.0
            };
            for y in y0..y1 {
                for x in x0..x1 {
                    let v = full_res[y * full_w + x];
                    if v > m {
                        m = v;
                    }
                }
            }
            out[gy * res_x + gx] = m;
        }
    }
    out
}

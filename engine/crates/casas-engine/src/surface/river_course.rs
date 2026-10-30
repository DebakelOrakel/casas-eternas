//! `surface/riverCourse.ts`: what a river does below the channel head —
//! its pattern from physics, the meanders as a bend model with cutoffs,
//! the braids and the delta's distributaries drawn by rule. The
//! TypeScript port (`client/src/generator/surface/riverCourse.ts`, git
//! history) explains each rule and constant.

use std::f64::consts::PI;

use crate::core::det_math::{det_atan2, det_exp, det_hypot, det_log2, det_pow, det_sin};
use crate::core::domain::Domain;
use crate::core::js;
use crate::core::rng::Mulberry32;

use super::cover::cover_by_biome;
use super::hydrology::discharge_to_m3s;
use super::river_graph::{RiverGraph, RiverNodeKind, RiverReach, RiverReachKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiverPattern {
    Straight,
    Meandering,
    Braided,
    Anastomosing,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RiverCourse {
    pub reach: usize,
    pub pattern: RiverPattern,
    pub discharge_m3s: f64,
    pub width_m: f64,
    pub depth_m: f64,
    pub slope: f64,
    pub bank_strength: f64,
    /// Centrelines in texel coordinates [x, y, …].
    pub lines: Vec<Vec<f32>>,
    pub line_width: Vec<f64>,
    pub sinuosity: f64,
    pub belt_width_m: f64,
    pub oxbows: Vec<Vec<f32>>,
    pub lobe_ages: Vec<u32>,
}

pub struct RiverCourseOptions<'a> {
    pub cell_m: f64,
    pub seed: u32,
    pub domain: &'a Domain,
    pub min_width_m: Option<f64>,
    pub max_points_per_reach: Option<f64>,
    pub steps: Option<usize>,
}

/// The course model's own version, for the artifact key.
pub const RIVER_COURSE_MODEL_VERSION: u32 = 1;

/// Hydraulic geometry: bankfull width from discharge, metres.
pub fn channel_width_m(discharge_m3s: f64) -> f64 {
    3.5 * js::max(0.0, discharge_m3s).sqrt()
}

fn channel_depth_m(discharge_m3s: f64) -> f64 {
    0.3 * det_pow(js::max(0.0, discharge_m3s), 0.4)
}

fn braiding_slope(discharge_m3s: f64) -> f64 {
    0.0125 * det_pow(js::max(1e-3, discharge_m3s), -0.44)
}

pub fn classify_pattern(
    discharge_m3s: f64,
    slope: f64,
    length_m: f64,
    width_m: f64,
    bank_strength: f64,
    sediment_m3: f64,
) -> RiverPattern {
    let sc = braiding_slope(discharge_m3s);
    if slope > sc * (0.6 + 0.8 * bank_strength) {
        return RiverPattern::Braided;
    }
    if slope < 2e-4 && bank_strength >= 0.7 && sediment_m3 > 0.0 {
        return RiverPattern::Anastomosing;
    }
    if slope < 0.005 && length_m >= 12.0 * width_m {
        return RiverPattern::Meandering;
    }
    RiverPattern::Straight
}

/// `x || 1`: the value unless it is zero or NaN.
fn or_one(v: f64) -> f64 {
    if v == 0.0 || v.is_nan() { 1.0 } else { v }
}

/// The reach's cell path in metres, in the plane about its first cell.
fn unwrapped_path(
    graph: &RiverGraph,
    reach: &RiverReach,
    cell_m: f64,
    domain: &Domain,
) -> (Vec<f64>, (f64, f64)) {
    let mut out = vec![0.0; reach.cell_count * 2];
    let rx = graph.cell_x[reach.cell_start] as f64;
    let ry = graph.cell_y[reach.cell_start] as f64;
    for k in 0..reach.cell_count {
        let o = domain.delta(
            graph.cell_x[reach.cell_start + k] as f64,
            graph.cell_y[reach.cell_start + k] as f64,
            rx,
            ry,
        );
        out[k * 2] = (rx + o.x) * cell_m;
        out[k * 2 + 1] = (ry + o.y) * cell_m;
    }
    (out, (rx, ry))
}

fn path_length(p: &[f64], count: usize) -> f64 {
    let mut length = 0.0;
    for i in 1..count {
        length += det_hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    }
    length
}

/// The polyline resampled at a uniform spacing, both ends kept.
fn resample(p: &[f64], count: usize, spacing: f64) -> Vec<f64> {
    let total = path_length(p, count);
    let n = js::max(2.0, js::round(total / spacing) + 1.0) as usize;
    let mut out = vec![0.0; n * 2];
    let step = total / (n - 1) as f64;
    let mut seg = 0;
    let mut seg_start = 0.0;
    let mut seg_len = det_hypot(p[2] - p[0], p[3] - p[1]);
    for i in 0..n {
        let s = js::min(total, i as f64 * step);
        while seg + 2 < count && s > seg_start + seg_len {
            seg_start += seg_len;
            seg += 1;
            seg_len = det_hypot(p[seg * 2 + 2] - p[seg * 2], p[seg * 2 + 3] - p[seg * 2 + 1]);
        }
        let t = if seg_len > 0.0 {
            js::min(1.0, js::max(0.0, (s - seg_start) / seg_len))
        } else {
            0.0
        };
        out[i * 2] = p[seg * 2] + (p[seg * 2 + 2] - p[seg * 2]) * t;
        out[i * 2 + 1] = p[seg * 2 + 1] + (p[seg * 2 + 3] - p[seg * 2 + 1]) * t;
    }
    out[0] = p[0];
    out[1] = p[1];
    out[n * 2 - 2] = p[count * 2 - 2];
    out[n * 2 - 1] = p[count * 2 - 1];
    out
}

/// Distance from a point to a polyline, nearest segment.
fn distance_to_path(x: f64, y: f64, p: &[f64], count: usize) -> f64 {
    let mut best = f64::INFINITY;
    for i in 0..count.saturating_sub(1) {
        let (ax, ay, bx, by) = (p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
        let vx = bx - ax;
        let vy = by - ay;
        let len2 = vx * vx + vy * vy;
        let t = if len2 > 0.0 {
            js::min(1.0, js::max(0.0, ((x - ax) * vx + (y - ay) * vy) / len2))
        } else {
            0.0
        };
        let d = det_hypot(x - (ax + vx * t), y - (ay + vy * t));
        if d < best {
            best = d;
        }
    }
    best
}

/// A line of the plane about `r` back in texels of the domain.
fn to_texels(p: &[f64], count: usize, cell_m: f64, domain: &Domain, r: (f64, f64)) -> Vec<f32> {
    let mut out = vec![0f32; count * 2];
    for i in 0..count {
        let at = domain.from_plane(p[i * 2] / cell_m, p[i * 2 + 1] / cell_m, r.0, r.1);
        out[i * 2] = at.x as f32;
        out[i * 2 + 1] = at.y as f32;
    }
    out
}

struct Meander {
    line: Vec<f64>,
    belt_width_m: f64,
    oxbows: Vec<Vec<f64>>,
}

/// The bend model: the migrated centreline, the envelope and the oxbows,
/// metres in the plane.
fn meander(
    base: &[f64],
    base_count: usize,
    width_m: f64,
    bank_strength: f64,
    steps: usize,
    spacing: f64,
    rng: &mut Mulberry32,
) -> Meander {
    let lambda = 5.0 * width_m;
    let rate = 0.5 * (1.2 - bank_strength);
    let mut p = resample(base, base_count, spacing);
    let mut n = p.len() / 2;
    {
        let phase = rng.next() * PI * 2.0;
        let wavelength = 10.0 * width_m;
        for i in 1..n.saturating_sub(1) {
            let tx = p[i * 2 + 2] - p[i * 2 - 2];
            let ty = p[i * 2 + 3] - p[i * 2 - 1];
            let tl = or_one(det_hypot(tx, ty));
            let s = i as f64 * spacing;
            let taper = js::min(
                js::min(1.0, s / (3.0 * width_m)),
                (n - 1 - i) as f64 * spacing / (3.0 * width_m),
            );
            let a = (0.3 * det_sin((2.0 * PI * s) / wavelength + phase)
                + 0.05 * (rng.next() - 0.5))
                * width_m
                * taper;
            p[i * 2] += (-ty / tl) * a;
            p[i * 2 + 1] += (tx / tl) * a;
        }
    }
    let mut oxbows: Vec<Vec<f64>> = Vec::new();
    let kernel_length = ((4.0 * lambda) / spacing).ceil() as usize;
    let kernel: Vec<f64> = (0..kernel_length)
        .map(|k| det_exp((-(k as f64) * spacing) / lambda) * (spacing / lambda))
        .collect();
    let min_separation = ((3.0 * width_m) / spacing).ceil() as usize + 2;
    let max_separation = ((40.0 * width_m) / spacing).ceil() as usize;
    for _ in 0..steps {
        n = p.len() / 2;
        if n < 4 {
            break;
        }
        let mut kappa = vec![0.0; n];
        for i in 1..n - 1 {
            let ax = p[i * 2] - p[i * 2 - 2];
            let ay = p[i * 2 + 1] - p[i * 2 - 1];
            let bx = p[i * 2 + 2] - p[i * 2];
            let by = p[i * 2 + 3] - p[i * 2 + 1];
            let cross = ax * by - ay * bx;
            let dot = ax * bx + ay * by;
            kappa[i] = det_atan2(cross, dot) / spacing;
        }
        let mut next = p.clone();
        for i in 1..n - 1 {
            let mut u = 0.0;
            for k in 0..kernel_length.min(i + 1) {
                u += kappa[i - k] * kernel[k];
            }
            let tx = p[i * 2 + 2] - p[i * 2 - 2];
            let ty = p[i * 2 + 3] - p[i * 2 - 1];
            let tl = or_one(det_hypot(tx, ty));
            let taper = js::min(
                js::min(1.0, (i as f64 * spacing) / (2.0 * lambda)),
                ((n - 1 - i) as f64 * spacing) / (2.0 * lambda),
            );
            let mut d = -rate * width_m * u * width_m * taper;
            if d > 0.5 * width_m {
                d = 0.5 * width_m;
            } else if d < -0.5 * width_m {
                d = -0.5 * width_m;
            }
            next[i * 2] += (-ty / tl) * d;
            next[i * 2 + 1] += (tx / tl) * d;
        }
        p = next;
        // Neck cutoff.
        'cut: for i in 1..n - 1 {
            let j_end = (n - 1).min(i + max_separation);
            for j in i + min_separation..j_end {
                if det_hypot(p[i * 2] - p[j * 2], p[i * 2 + 1] - p[j * 2 + 1]) < 1.5 * width_m {
                    if oxbows.len() < 32 {
                        oxbows.push(p[i * 2..(j + 1) * 2].to_vec());
                    }
                    let mut kept = Vec::with_capacity((n - (j - i - 1)) * 2);
                    kept.extend_from_slice(&p[..(i + 1) * 2]);
                    kept.extend_from_slice(&p[j * 2..]);
                    p = kept;
                    break 'cut;
                }
            }
        }
        p = resample(&p, p.len() / 2, spacing);
    }
    let mut offset_sum = 0.0;
    let mut offset_samples = 0;
    {
        let count = p.len() / 2;
        let mut i = 1;
        while i + 1 < count {
            offset_sum += distance_to_path(p[i * 2], p[i * 2 + 1], base, base_count);
            offset_samples += 1;
            i += 2;
        }
    }
    let belt_width_m = if offset_samples > 0 {
        2.0 * (offset_sum / offset_samples as f64)
    } else {
        0.0
    };
    Meander {
        line: p,
        belt_width_m,
        oxbows,
    }
}

/// Threads weaving about the base line: braids and anastomosing channels.
#[allow(clippy::too_many_arguments)]
fn weave(
    base: &[f64],
    base_count: usize,
    width_m: f64,
    count: usize,
    amplitude: f64,
    wavelength: f64,
    spacing: f64,
    rng: &mut Mulberry32,
) -> Vec<Vec<f64>> {
    let p = resample(base, base_count, spacing);
    let n = p.len() / 2;
    let mut lines = Vec::with_capacity(count);
    for k in 0..count {
        let phase = rng.next() * PI * 2.0;
        let phase2 = rng.next() * PI * 2.0;
        let centre = (k as f64 - (count as f64 - 1.0) / 2.0) * amplitude;
        let mut line = vec![0.0; p.len()];
        for i in 0..n {
            let i0 = i.saturating_sub(1);
            let i1 = (n - 1).min(i + 1);
            let tx = p[i1 * 2] - p[i0 * 2];
            let ty = p[i1 * 2 + 1] - p[i0 * 2 + 1];
            let tl = or_one(det_hypot(tx, ty));
            let s = i as f64 * spacing;
            let taper = js::min(
                js::min(1.0, s / (4.0 * width_m)),
                ((n - 1 - i) as f64 * spacing) / (4.0 * width_m),
            );
            let offset = (centre * (0.6 + 0.4 * det_sin((2.0 * PI * s) / wavelength + phase))
                + 0.4 * width_m * det_sin((2.0 * PI * s) / (wavelength / 3.0) + phase2))
                * taper;
            line[i * 2] = p[i * 2] + (-ty / tl) * offset;
            line[i * 2 + 1] = p[i * 2 + 1] + (tx / tl) * offset;
        }
        lines.push(line);
    }
    lines
}

pub fn compute_river_courses(
    graph: &RiverGraph,
    options: &RiverCourseOptions<'_>,
) -> Vec<RiverCourse> {
    let cell_m = options.cell_m;
    let domain = options.domain;
    let min_width_m = options.min_width_m.unwrap_or(cell_m / 50.0);
    let max_points = options.max_points_per_reach.unwrap_or(4000.0);
    let steps = options.steps.unwrap_or(120);
    let mut courses = Vec::new();
    for reach in &graph.reaches {
        if reach.kind != RiverReachKind::River || reach.cell_count < 3 {
            continue;
        }
        let discharge_m3s = discharge_to_m3s(reach.discharge_out, cell_m);
        let width_m = channel_width_m(discharge_m3s);
        if width_m < min_width_m {
            continue;
        }
        let (base, r) = unwrapped_path(graph, reach, cell_m, domain);
        let length_m = path_length(&base, reach.cell_count);
        if length_m <= 0.0 {
            continue;
        }
        let bank_strength = if reach.bank >= 0 && reach.bank < 256 {
            cover_by_biome(reach.bank as u8).unwrap_or(0.5)
        } else {
            0.5
        };
        let slope = js::max(0.0, reach.slope);
        let pattern = classify_pattern(
            discharge_m3s,
            slope,
            length_m,
            width_m,
            bank_strength,
            reach.sediment_m3,
        );
        let mut rng =
            Mulberry32::new(options.seed ^ (reach.id as u32 + 1).wrapping_mul(0x9e37_79b1));
        let spacing = js::max(width_m / 2.0, length_m / max_points);
        let mut lines: Vec<Vec<f32>> = Vec::new();
        let mut line_width: Vec<f64> = Vec::new();
        let mut oxbows: Vec<Vec<f32>> = Vec::new();
        let mut sinuosity = 1.0;
        let mut belt_width_m = 0.0;
        match pattern {
            RiverPattern::Meandering => {
                let m = meander(
                    &base,
                    reach.cell_count,
                    width_m,
                    bank_strength,
                    steps,
                    spacing,
                    &mut rng,
                );
                let count = m.line.len() / 2;
                lines.push(to_texels(&m.line, count, cell_m, domain, r));
                line_width.push(1.0);
                sinuosity = path_length(&m.line, count) / length_m;
                belt_width_m = m.belt_width_m;
                for o in &m.oxbows {
                    oxbows.push(to_texels(o, o.len() / 2, cell_m, domain, r));
                }
            }
            RiverPattern::Braided | RiverPattern::Anastomosing => {
                let braided = pattern == RiverPattern::Braided;
                let sc = braiding_slope(discharge_m3s);
                let count = if braided {
                    js::min(
                        5.0,
                        js::max(2.0, 2.0 + js::round(det_log2(js::max(1.0, slope / sc)))),
                    ) as usize
                } else {
                    2 + usize::from(rng.next() < 0.4)
                };
                let threads = weave(
                    &base,
                    reach.cell_count,
                    width_m,
                    count,
                    if braided {
                        1.6 * width_m
                    } else {
                        2.0 * width_m
                    },
                    if braided {
                        8.0 * width_m
                    } else {
                        25.0 * width_m
                    },
                    spacing,
                    &mut rng,
                );
                for t in &threads {
                    lines.push(to_texels(t, t.len() / 2, cell_m, domain, r));
                    line_width.push(1.0 / (count as f64).sqrt());
                }
            }
            RiverPattern::Straight => {
                let p = resample(&base, reach.cell_count, spacing);
                lines.push(to_texels(&p, p.len() / 2, cell_m, domain, r));
                line_width.push(1.0);
            }
        }
        // A delta where a laden, flat reach meets the open sea.
        let mut lobe_ages: Vec<u32> = Vec::new();
        let mouth = &graph.nodes[reach.to];
        if mouth.kind == RiverNodeKind::Mouth
            && mouth.body == -1
            && reach.sediment_m3 > 0.0
            && slope < 1e-3
            && length_m > 40.0 * width_m
            && !lines.is_empty()
        {
            let main_first = matches!(pattern, RiverPattern::Meandering | RiverPattern::Straight);
            let apex_back = js::min(0.4 * length_m, 30.0 * width_m);
            let p = resample(&base, reach.cell_count, spacing);
            let n = p.len() / 2;
            let apex_index = js::max(1.0, (n - 1) as f64 - js::round(apex_back / spacing)) as usize;
            let (ax, ay) = (p[apex_index * 2], p[apex_index * 2 + 1]);
            let (mx, my) = (p[n * 2 - 2], p[n * 2 - 1]);
            let dx = mx - ax;
            let dy = my - ay;
            let dl = or_one(det_hypot(dx, dy));
            let count = 2 + usize::from(reach.sediment_m3 > 1e9) + usize::from(rng.next() < 0.5);
            let active = (rng.next() * count as f64).floor() as usize;
            for k in 0..count {
                let side = (k as f64 - (count as f64 - 1.0) / 2.0) * 3.0 * width_m;
                let ex = mx + (-dy / dl) * side + (dx / dl) * 2.0 * width_m;
                let ey = my + (dx / dl) * side + (dy / dl) * 2.0 * width_m;
                let line = [
                    ax,
                    ay,
                    (ax + ex) / 2.0 + (-dy / dl) * side * 0.35,
                    (ay + ey) / 2.0 + (dx / dl) * side * 0.35,
                    ex,
                    ey,
                ];
                let age = (k + count - active) % count;
                lines.push(to_texels(&line, 3, cell_m, domain, r));
                line_width.push(if age == 0 { 0.8 } else { 0.35 / age as f64 });
                lobe_ages.push(age as u32);
            }
            if main_first {
                let keep = 2.max((lines[0].len() / 2).min(apex_index + 1));
                lines[0].truncate(keep * 2);
            }
        }
        courses.push(RiverCourse {
            reach: reach.id,
            pattern,
            discharge_m3s,
            width_m,
            depth_m: channel_depth_m(discharge_m3s),
            slope,
            bank_strength,
            lines,
            line_width,
            sinuosity,
            belt_width_m,
            oxbows,
            lobe_ages,
        });
    }
    courses
}

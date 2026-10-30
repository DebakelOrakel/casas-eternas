//! How continental is the crust at a point. A raft is a set of soft
//! metaball blobs; the summed field and its threshold band, the bucket
//! index over the blobs, and the coarse fields made from them
//! (docs/decisions/continental-crust-rafts.md). The TypeScript file went on
//! 2026-10-30; the display reads the craton age and the stabilised share
//! from the engine's render.

use crate::core::domain::{Domain, DomainGrid};
use crate::core::interpolation::smoothstep_between;
use crate::core::js;
use crate::core::world_time::world_epoch_ma;
use crate::tectonics::plate_seeds::PlateSeed;
use crate::tectonics::plate_types::PlateType;

use super::raft_types::Raft;

/// Metaball kernel: (1 − (d/r)²)² inside the blob, 0 outside.
fn blob_kernel(dist_sq: f64, radius: f64) -> f64 {
    let r2 = radius * radius;
    if dist_sq >= r2 {
        return 0.0;
    }
    let s = 1.0 - dist_sq / r2;
    s * s
}

const FIELD_LO: f64 = 0.35;
const FIELD_HI: f64 = 0.65;

/// The raw summed metaball field at a world point.
pub fn raft_field(x: f64, y: f64, rafts: &[Raft], domain: &Domain) -> f64 {
    let mut field = 0.0;
    for raft in rafts {
        for blob in &raft.blobs {
            field += blob_kernel(domain.distance_sq(x, y, blob.x, blob.y), blob.radius);
        }
    }
    field
}

/// A bucket index over the blobs, for a sweep over many points: the same
/// bits as the scans. Valid only while the rafts do not change.
pub struct BlobIndex<'a> {
    pub rafts: &'a [Raft],
    pub domain: &'a Domain,
    grid: DomainGrid,
    start: Vec<u32>,
    items: Vec<u32>,
    bx: Vec<f64>,
    by: Vec<f64>,
    br: Vec<f64>,
    braft: Vec<u32>,
    /// On the sphere, each blob's place on the globe (domain units).
    bp: Option<Vec<f64>>,
}

const CHORD_MARGIN: f64 = 1.0 + 1e-9;
const INDEX_NX: usize = 32;
const INDEX_NY: usize = 16;

/// `reach` in radii: a blob is filed wherever a point within reach × its
/// radius can lie.
pub fn build_blob_index<'a>(rafts: &'a [Raft], domain: &'a Domain, reach: f64) -> BlobIndex<'a> {
    let (mut bx, mut by, mut br, mut braft) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (r, raft) in rafts.iter().enumerate() {
        for blob in &raft.blobs {
            bx.push(blob.x);
            by.push(blob.y);
            br.push(blob.radius);
            braft.push(r as u32);
        }
    }
    let total = bx.len();
    let bp = if domain.is_sphere() {
        let mut bp = vec![0.0; total * 3];
        for k in 0..total {
            let f = domain.globe_frame(bx[k], by[k]);
            bp[3 * k] = f.px;
            bp[3 * k + 1] = f.py;
            bp[3 * k + 2] = f.pz;
        }
        Some(bp)
    } else {
        None
    };
    let grid = domain.grid(INDEX_NX, INDEX_NY);
    let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); INDEX_NX * INDEX_NY];
    for k in 0..total {
        let extent = br[k] * reach;
        let e = extent * (1.0 + 1e-9) + 1e-6;
        let (x0, x1, y0, y1) = if e.is_nan() || e == f64::INFINITY {
            (0, INDEX_NX as i64 - 1, 0, INDEX_NY as i64 - 1)
        } else {
            let b = grid.disc_box(bx[k], by[k], e);
            (b.x0, b.x1, b.y0, b.y1)
        };
        for j in y0..=y1 {
            for i in x0..=x1 {
                buckets[grid.index(i, j)].push(k as u32);
            }
        }
    }
    let mut start = vec![0u32; INDEX_NX * INDEX_NY + 1];
    for b in 0..INDEX_NX * INDEX_NY {
        start[b + 1] = start[b] + buckets[b].len() as u32;
    }
    let items: Vec<u32> = buckets.into_iter().flatten().collect();
    BlobIndex {
        rafts,
        domain,
        grid,
        start,
        items,
        bx,
        by,
        br,
        braft,
        bp,
    }
}

impl BlobIndex<'_> {
    fn bucket(&self, x: f64, y: f64) -> std::ops::Range<usize> {
        let b = self.grid.cell_at(x, y);
        self.start[b] as usize..self.start[b + 1] as usize
    }

    /// The squared chord from the point (as `globe_frame` places it) to
    /// blob g.
    fn chord_sq(&self, q: (f64, f64, f64), g: usize) -> f64 {
        let bp = self.bp.as_ref().unwrap();
        let dx = bp[3 * g] - q.0;
        let dy = bp[3 * g + 1] - q.1;
        let dz = bp[3 * g + 2] - q.2;
        dx * dx + dy * dy + dz * dz
    }

    fn query_point(&self, x: f64, y: f64) -> (f64, f64, f64) {
        let f = self.domain.globe_frame(x, y);
        (f.px, f.py, f.pz)
    }
}

fn finite(x: f64, y: f64) -> bool {
    x.abs() < f64::INFINITY && y.abs() < f64::INFINITY
}

/// `raft_field` through the index: the same value, bit for bit.
pub fn raft_field_indexed(x: f64, y: f64, index: &BlobIndex) -> f64 {
    if !finite(x, y) {
        return raft_field(x, y, index.rafts, index.domain);
    }
    let range = index.bucket(x, y);
    let d = index.domain;
    let mut field = 0.0;
    if index.bp.is_some() {
        let q = index.query_point(x, y);
        for k in range {
            let g = index.items[k] as usize;
            if index.chord_sq(q, g) >= index.br[g] * index.br[g] * CHORD_MARGIN {
                continue;
            }
            field += blob_kernel(d.distance_sq(x, y, index.bx[g], index.by[g]), index.br[g]);
        }
        return field;
    }
    for k in range {
        let g = index.items[k] as usize;
        field += blob_kernel(d.distance_sq(x, y, index.bx[g], index.by[g]), index.br[g]);
    }
    field
}

/// `raft_field_indexed`, and each raft's own field into `per_raft` (written
/// whole). A finite point only.
pub fn raft_fields_indexed(x: f64, y: f64, index: &BlobIndex, per_raft: &mut [f64]) -> f64 {
    per_raft.fill(0.0);
    let range = index.bucket(x, y);
    let d = index.domain;
    let q = if index.bp.is_some() {
        Some(index.query_point(x, y))
    } else {
        None
    };
    let mut field = 0.0;
    for k in range {
        let g = index.items[k] as usize;
        if let Some(q) = q
            && index.chord_sq(q, g) >= index.br[g] * index.br[g] * CHORD_MARGIN
        {
            continue;
        }
        let kernel = blob_kernel(d.distance_sq(x, y, index.bx[g], index.by[g]), index.br[g]);
        field += kernel;
        per_raft[index.braft[g] as usize] += kernel;
    }
    field
}

/// The raft whose blob is nearest in radii, within `reach` radii, or None.
pub fn nearest_raft_indexed(x: f64, y: f64, index: &BlobIndex, reach: f64) -> Option<usize> {
    let d = index.domain;
    let mut on_raft = None;
    let mut nearest = reach;
    if !finite(x, y) {
        for g in 0..index.bx.len() {
            let dist = d.distance_sq(x, y, index.bx[g], index.by[g]).sqrt() / index.br[g];
            if dist < nearest {
                nearest = dist;
                on_raft = Some(index.braft[g] as usize);
            }
        }
        return on_raft;
    }
    let range = index.bucket(x, y);
    if index.bp.is_some() {
        let q = index.query_point(x, y);
        for k in range {
            let g = index.items[k] as usize;
            let reach_g = nearest * index.br[g];
            if index.chord_sq(q, g) >= reach_g * reach_g * CHORD_MARGIN {
                continue;
            }
            let dist = d.distance_sq(x, y, index.bx[g], index.by[g]).sqrt() / index.br[g];
            if dist < nearest {
                nearest = dist;
                on_raft = Some(index.braft[g] as usize);
            }
        }
        return on_raft;
    }
    for k in range {
        let g = index.items[k] as usize;
        let dist = d.distance_sq(x, y, index.bx[g], index.by[g]).sqrt() / index.br[g];
        if dist < nearest {
            nearest = dist;
            on_raft = Some(index.braft[g] as usize);
        }
    }
    on_raft
}

/// Continental membership 0..1 at a world point.
pub fn raft_membership(x: f64, y: f64, rafts: &[Raft], domain: &Domain) -> f64 {
    smoothstep_between(FIELD_LO, FIELD_HI, raft_field(x, y, rafts, domain))
}

/// Continental membership at a list of points, through one blob index.
pub fn compute_membership_at(rafts: &[Raft], xs: &[f64], ys: &[f64], domain: &Domain) -> Vec<f64> {
    let blobs = build_blob_index(rafts, domain, 1.0);
    (0..xs.len())
        .map(|i| smoothstep_between(FIELD_LO, FIELD_HI, raft_field_indexed(xs[i], ys[i], &blobs)))
        .collect()
}

/// A coarse field of continental crust oldness 0..1 (−1 off the crust):
/// 1 where the crust formed at epoch 0 (the old cratonic cores), lower
/// toward margins accreted later. The metaball-weighted mean birth AGE per
/// cell, normalised against the world's age, both in Ma (`world_epoch_ma`):
/// the stamps lie on the continuous epoch axis, on which an Archean epoch
/// is five tectonic ones (DEC-0036 phase 8b-2). `archean_epochs` is the
/// Archean's length; in the Archean itself, its current epoch. The
/// ecology's iron reads it, and the craton-age overlay.
///
/// Each blob is scattered over the cells it can reach, not each cell asked
/// about each blob. The kernel is exactly 0 at and past the radius, so the
/// field is the same to the last bit; the work goes with the crust that
/// exists, not with cells × blobs (about 40 000 kernel evaluations in
/// place of 5 million at 256 × 128 with 156 blobs). The accumulators are
/// f64: f32 partial sums moved ~10 % of the cells by up to 9e-8.
pub fn compute_craton_oldness_field(
    rafts: &[Raft],
    current_epoch: f64,
    archean_epochs: f64,
    res_x: usize,
    res_y: usize,
    domain: &Domain,
) -> Vec<f32> {
    let mut weight = vec![0.0; res_x * res_y];
    let mut age_weighted = vec![0.0; res_x * res_y];
    let cell_w = domain.width / res_x as f64;
    let cell_h = domain.height / res_y as f64;
    let grid = domain.grid(res_x, res_y);
    for raft in rafts {
        for blob in &raft.blobs {
            let birth = world_epoch_ma(blob.birth_epoch.unwrap_or(0.0), archean_epochs);
            let b = grid.disc_box(blob.x, blob.y, blob.radius);
            for gy in b.y0..=b.y1 {
                let wy = (gy as f64 + 0.5) * cell_h;
                for gx in b.x0..=b.x1 {
                    let wx = (gx as f64 + 0.5) * cell_w;
                    let w = blob_kernel(domain.distance_sq(wx, wy, blob.x, blob.y), blob.radius);
                    if w <= 0.0 {
                        continue;
                    }
                    let i = grid.index(gx, gy);
                    weight[i] += w;
                    age_weighted[i] += w * birth;
                }
            }
        }
    }
    let now_ma = world_epoch_ma(current_epoch, archean_epochs);
    (0..res_x * res_y)
        .map(|i| {
            if weight[i] == 0.0 {
                -1.0
            } else if now_ma <= 0.0 {
                1.0
            } else {
                js::max(
                    0.0,
                    js::min(1.0, 1.0 - age_weighted[i] / weight[i] / now_ma),
                ) as f32
            }
        })
        .collect()
}

/// Which raft owns each cell: the one whose blob contributes the most
/// there, −1 where none reaches.
pub fn compute_owner_field(
    rafts: &[Raft],
    res_x: usize,
    res_y: usize,
    domain: &Domain,
) -> Vec<i32> {
    let mut best = vec![0f32; res_x * res_y];
    let mut owner = vec![-1i32; res_x * res_y];
    let cell_w = domain.width / res_x as f64;
    let cell_h = domain.height / res_y as f64;
    let grid = domain.grid(res_x, res_y);
    for (raft_index, raft) in rafts.iter().enumerate() {
        for blob in &raft.blobs {
            let b = grid.disc_box(blob.x, blob.y, blob.radius);
            for gy in b.y0..=b.y1 {
                let wy = (gy as f64 + 0.5) * cell_h;
                for gx in b.x0..=b.x1 {
                    let wx = (gx as f64 + 0.5) * cell_w;
                    let v = blob_kernel(domain.distance_sq(wx, wy, blob.x, blob.y), blob.radius);
                    let i = grid.index(gx, gy);
                    if v <= best[i] as f64 {
                        continue;
                    }
                    best[i] = v as f32;
                    owner[i] = raft_index as i32;
                }
            }
        }
    }
    owner
}

pub fn sample_owner_field(owner: &[i32], grid: &DomainGrid, x: f64, y: f64) -> i32 {
    owner[grid.cell_at(x, y)]
}

const SEED_CONTINENTAL_THRESHOLD: f64 = 0.5;

/// A plate is continental when a raft covers its seed.
pub fn derive_plate_types(seeds: &[PlateSeed], rafts: &[Raft], domain: &Domain) -> Vec<PlateType> {
    seeds
        .iter()
        .map(|s| {
            if raft_membership(s.x, s.y, rafts, domain) >= SEED_CONTINENTAL_THRESHOLD {
                PlateType::Continental
            } else {
                PlateType::Oceanic
            }
        })
        .collect()
}

/// The area-weighted fraction of crust blobs past the stabilisation age:
/// the Archean's progress gauge. Over 600 epochs it was the one quantity
/// that reads the phase cleanly — 6 % at epoch 50, 54 % at 200, 58 % at
/// 300, 91 % at 600, monotone. Several separate cratons hold until about
/// 60 %; past about 85 % the world only accumulates land.
///
/// By area (Σ radius²), not by count (2026-08-06): `consolidate_raft_blobs`
/// merges stabilised blobs into fewer, larger ones, so a count deflates as
/// the phase matures (61–63 % at epoch 300 against 81–88 % without the
/// merge, for the same stable crust).
pub fn stabilised_fraction(rafts: &[Raft], epoch: f64, stabilisation_epochs: f64) -> f64 {
    let (mut total, mut stable) = (0.0, 0.0);
    for raft in rafts {
        for blob in &raft.blobs {
            let area = blob.radius * blob.radius;
            total += area;
            if epoch - blob.birth_epoch.unwrap_or(0.0) >= stabilisation_epochs {
                stable += area;
            }
        }
    }
    if total == 0.0 { 0.0 } else { stable / total }
}

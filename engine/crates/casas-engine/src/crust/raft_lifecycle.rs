//! `crust/raftLifecycle.ts`: how rafts move and change over an epoch:
//! drifting with their host plate (or, in the Archean, on the mantle flow),
//! compacting, consolidating, recycling, growing by accretion, suturing,
//! tearing at a rift, and coming apart into separate continents. Blob-set
//! operations, all of them. The reasoning and the measurements are in the
//! TypeScript port (`client/src/generator/crust/raftLifecycle.ts`, git
//! history).

use crate::core::det_math::det_hypot;
use crate::core::domain::Domain;
use crate::core::js;
use crate::tectonics::plate_motion::{EulerMotion, PlateMotion, advance_point_by_motion};
use crate::tectonics::plate_seeds::PlateSeed;

use super::raft_field::{BlobIndex, nearest_raft_indexed};
use super::raft_names::{deserves_continent_name, pick_unused_raft_name};
use super::raft_types::{Raft, RaftBlob, RaftMergeEvent, RaftSplitEvent};

pub fn nearest_plate_index(x: f64, y: f64, seeds: &[PlateSeed], domain: &Domain) -> usize {
    let mut best = 0;
    let mut best_sq = f64::INFINITY;
    for (i, s) in seeds.iter().enumerate() {
        let d = domain.distance_sq(x, y, s.x, s.y);
        if d < best_sq {
            best_sq = d;
            best = i;
        }
    }
    best
}

/// How far from a raft blob's centre a point still rides the raft, radii.
pub const RAFT_CARRY_REACH: f64 = 1.5;

/// The host plate of each raft (nearest its first blob); None for a raft
/// with no blobs.
pub fn raft_host_plates(
    rafts: &[Raft],
    seeds: &[PlateSeed],
    domain: &Domain,
) -> Vec<Option<usize>> {
    rafts
        .iter()
        .map(|r| {
            r.blobs
                .first()
                .map(|b| nearest_plate_index(b.x, b.y, seeds, domain))
        })
        .collect()
}

/// The plate that carries the crust at a point: a raft's host on a raft,
/// else the nearest seed's.
pub fn carrier_plate_at(
    x: f64,
    y: f64,
    blobs: &BlobIndex,
    hosts: &[Option<usize>],
    seeds: &[PlateSeed],
    domain: &Domain,
) -> usize {
    match nearest_raft_indexed(x, y, blobs, RAFT_CARRY_REACH).and_then(|r| hosts[r]) {
        Some(h) => h,
        None => nearest_plate_index(x, y, seeds, domain),
    }
}

/// Every raft moved rigidly with the plate nearest its first blob.
pub fn advance_rafts(
    rafts: &mut [Raft],
    seeds: &[PlateSeed],
    motions: &[PlateMotion],
    step_ma: f64,
    domain: &Domain,
) {
    for raft in rafts.iter_mut() {
        let Some(first) = raft.blobs.first() else {
            continue;
        };
        let host = nearest_plate_index(first.x, first.y, seeds, domain);
        let motion = &motions[host];
        for blob in raft.blobs.iter_mut() {
            let p = advance_point_by_motion(blob.x, blob.y, motion, step_ma, domain);
            blob.x = p.x;
            blob.y = p.y;
        }
    }
}

/// The Archean's drift on the mantle flow: the mean flow across a raft's
/// blobs plus `1 − rigidity` of each blob's own departure from it.
/// `flow_at` gives the flow at a point in its own frame.
pub fn advance_rafts_on_flow(
    rafts: &mut [Raft],
    flow_at: &mut dyn FnMut(f64, f64) -> (f64, f64),
    domain: &Domain,
    rigidity: f64,
) {
    for raft in rafts.iter_mut() {
        if raft.blobs.is_empty() {
            continue;
        }
        let n = raft.blobs.len();
        let mut vx = vec![0.0; n];
        let mut vy = vec![0.0; n];
        let (mut mean_x, mut mean_y) = (0.0, 0.0);
        for b in 0..n {
            let (lx, ly) = flow_at(raft.blobs[b].x, raft.blobs[b].y);
            vx[b] = lx;
            vy[b] = ly;
            mean_x += lx;
            mean_y += ly;
        }
        mean_x /= n as f64;
        mean_y /= n as f64;
        let differential = 1.0 - rigidity;
        if domain.is_sphere() {
            advance_raft_on_globe(raft, &vx, &vy, differential, domain);
            continue;
        }
        for b in 0..n {
            let blob = &mut raft.blobs[b];
            let m = domain.displace(blob.x, blob.y, mean_x, mean_y);
            let p = domain.advance(
                m.x,
                m.y,
                differential * (vx[b] - mean_x),
                differential * (vy[b] - mean_y),
            );
            blob.x = p.x;
            blob.y = p.y;
        }
    }
}

/// The sphere's rigid raft move: the raft turned as one body about the axis
/// perpendicular to its mean velocity, each blob's own share carried to its
/// turned point.
fn advance_raft_on_globe(
    raft: &mut Raft,
    vx: &[f64],
    vy: &[f64],
    differential: f64,
    domain: &Domain,
) {
    let n = raft.blobs.len();
    let r = domain.radius();
    let (mut cx, mut cy, mut cz, mut ux, mut uy, mut uz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for b in 0..n {
        let f = domain.globe_frame(raft.blobs[b].x, raft.blobs[b].y);
        cx += f.px;
        cy += f.py;
        cz += f.pz;
        ux += vx[b] * f.ex + vy[b] * f.sx;
        uy += vx[b] * f.ey + vy[b] * f.sy;
        uz += vx[b] * f.ez + vy[b] * f.sz;
    }
    let cl = (cx * cx + cy * cy + cz * cz).sqrt();
    let nf = n as f64;
    ux /= nf;
    uy /= nf;
    uz /= nf;
    let (mut kx, mut ky, mut kz, mut rate) = (0.0, 0.0, 1.0, 0.0);
    if cl > 0.0 {
        cx /= cl;
        cy /= cl;
        cz /= cl;
        let along = ux * cx + uy * cy + uz * cz;
        ux -= along * cx;
        uy -= along * cy;
        uz -= along * cz;
        let speed = (ux * ux + uy * uy + uz * uz).sqrt();
        if speed > 0.0 {
            kx = (cy * uz - cz * uy) / speed;
            ky = (cz * ux - cx * uz) / speed;
            kz = (cx * uy - cy * ux) / speed;
            rate = speed / r;
        }
    }
    let turn = PlateMotion::Euler(EulerMotion {
        pole_x: kx,
        pole_y: ky,
        pole_z: kz,
        rate,
    });
    for b in 0..n {
        let blob = &mut raft.blobs[b];
        let (mut dx, mut dy) = (0.0, 0.0);
        if differential != 0.0 {
            let f = domain.globe_frame(blob.x, blob.y);
            let wx = rate * (ky * f.pz - kz * f.py);
            let wy = rate * (kz * f.px - kx * f.pz);
            let wz = rate * (kx * f.py - ky * f.px);
            dx = differential * (vx[b] - (wx * f.ex + wy * f.ey + wz * f.ez));
            dy = differential * (vy[b] - (wx * f.sx + wy * f.sy + wz * f.sz));
        }
        let to = advance_point_by_motion(blob.x, blob.y, &turn, 1.0, domain);
        if differential != 0.0 {
            let o = domain.transport(dx, dy, blob.x, blob.y, to.x, to.y);
            let p = domain.advance(to.x, to.y, o.x, o.y);
            blob.x = p.x;
            blob.y = p.y;
        } else {
            blob.x = to.x;
            blob.y = to.y;
        }
    }
}

/// The Archean's compaction: the blobs outside a raft's compact disc pulled
/// toward its centroid by `rate` of their excess.
pub fn compact_rafts(rafts: &mut [Raft], rate: f64, domain: &Domain) {
    if rate <= 0.0 {
        return;
    }
    for raft in rafts.iter_mut() {
        let n = raft.blobs.len();
        if n < 3 {
            continue;
        }
        let (rx, ry) = (raft.blobs[0].x, raft.blobs[0].y);
        let (mut sum_x, mut sum_y, mut radius_sum) = (0.0, 0.0, 0.0);
        for blob in &raft.blobs {
            let o = domain.delta(blob.x, blob.y, rx, ry);
            sum_x += o.x;
            sum_y += o.y;
            radius_sum += blob.radius;
        }
        let m = domain.displace(rx, ry, sum_x / n as f64, sum_y / n as f64);
        let (cx, cy) = (m.x, m.y);
        let mean_radius = radius_sum / n as f64;
        let mut nearest = vec![0.0; n];
        for i in 0..n {
            let mut best = f64::INFINITY;
            let bi = &raft.blobs[i];
            for j in 0..n {
                if j == i {
                    continue;
                }
                let bj = &raft.blobs[j];
                let d = domain.distance_sq(bi.x, bi.y, bj.x, bj.y);
                if d < best {
                    best = d;
                }
            }
            nearest[i] = best.sqrt();
        }
        // Float64Array.sort: numeric, ascending.
        nearest.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let spacing = js::min(
            1.2 * mean_radius,
            js::max(0.5 * mean_radius, nearest[n >> 1]),
        );
        let compact_radius = (n as f64 / std::f64::consts::PI).sqrt() * spacing;
        if domain.is_sphere() {
            compact_raft_on_globe(raft, compact_radius, rate, domain);
            continue;
        }
        for blob in raft.blobs.iter_mut() {
            let o = domain.delta(blob.x, blob.y, cx, cy);
            let dist = det_hypot(o.x, o.y);
            let excess = dist - compact_radius;
            if excess <= 0.0 {
                continue;
            }
            let pull = (excess * rate) / dist;
            let p = domain.advance(blob.x, blob.y, -o.x * pull, -o.y * pull);
            blob.x = p.x;
            blob.y = p.y;
        }
    }
}

fn compact_raft_on_globe(raft: &mut Raft, compact_radius: f64, rate: f64, domain: &Domain) {
    let (mut cx, mut cy, mut cz) = (0.0, 0.0, 0.0);
    for blob in &raft.blobs {
        let f = domain.globe_frame(blob.x, blob.y);
        cx += f.px;
        cy += f.py;
        cz += f.pz;
    }
    if cx * cx + cy * cy + cz * cz == 0.0 {
        return;
    }
    let centre = domain.globe_locate(cx, cy, cz);
    for blob in raft.blobs.iter_mut() {
        let o = domain.delta(centre.x, centre.y, blob.x, blob.y);
        let dist = det_hypot(o.x, o.y);
        let excess = dist - compact_radius;
        if excess <= 0.0 {
            continue;
        }
        let pull = (excess * rate) / dist;
        let p = domain.advance(blob.x, blob.y, o.x * pull, o.y * pull);
        blob.x = p.x;
        blob.y = p.y;
    }
}

/// Merges near-concentric pairs of stabilised blobs into one, each blob at
/// most once per epoch, up to `max_radius`; returns how many merged.
pub fn consolidate_raft_blobs(
    rafts: &mut [Raft],
    epoch: f64,
    stabilisation_epochs: f64,
    proximity_factor: f64,
    max_radius: f64,
    domain: &Domain,
) -> usize {
    let mut merged = 0;
    for raft in rafts.iter_mut() {
        let blobs = &mut raft.blobs;
        let n = blobs.len();
        let mut dead = vec![false; n];
        let mut used = vec![false; n];
        for i in 0..n {
            if dead[i] || used[i] {
                continue;
            }
            if epoch - blobs[i].birth_epoch.unwrap_or(0.0) < stabilisation_epochs {
                continue;
            }
            for j in i + 1..n {
                if dead[j] || used[j] {
                    continue;
                }
                let (a, b) = (&blobs[i], &blobs[j]);
                if epoch - b.birth_epoch.unwrap_or(0.0) < stabilisation_epochs {
                    continue;
                }
                let new_radius = (a.radius * a.radius + b.radius * b.radius).sqrt();
                if new_radius > max_radius {
                    continue;
                }
                let reach = proximity_factor * js::min(a.radius, b.radius);
                if domain.distance_sq(a.x, a.y, b.x, b.y) >= reach * reach {
                    continue;
                }
                let wa = a.radius * a.radius;
                let wb = b.radius * b.radius;
                let t = wb / (wa + wb);
                let o = domain.delta(b.x, b.y, a.x, a.y);
                let p = domain.advance(a.x, a.y, o.x * t, o.y * t);
                let birth = js::round(
                    a.birth_epoch.unwrap_or(0.0) * (1.0 - t) + b.birth_epoch.unwrap_or(0.0) * t,
                );
                let a = &mut blobs[i];
                a.x = p.x;
                a.y = p.y;
                a.radius = new_radius;
                a.birth_epoch = Some(birth);
                dead[j] = true;
                used[i] = true;
                merged += 1;
                break;
            }
        }
        // As the TypeScript code: filtered once anything merged in this
        // call, in this raft or a raft before it.
        if merged > 0 {
            let mut k = 0;
            blobs.retain(|_| {
                k += 1;
                !dead[k - 1]
            });
        }
    }
    merged
}

/// Destroys crust not yet stabilised that sits over a downwelling; drops
/// the rafts left without blobs. Returns how many blobs went.
pub fn recycle_unstabilised_crust(
    rafts: &mut Vec<Raft>,
    mantle_at: &mut dyn FnMut(f64, f64) -> f64,
    age_of: &dyn Fn(f64) -> f64,
    stabilisation_epochs: f64,
    downwelling_threshold: f64,
) -> usize {
    let mut recycled = 0;
    for raft in rafts.iter_mut() {
        let mut kept = Vec::with_capacity(raft.blobs.len());
        for blob in raft.blobs.drain(..) {
            let age = age_of(blob.birth_epoch.unwrap_or(0.0));
            let over_downwelling = mantle_at(blob.x, blob.y) < downwelling_threshold;
            if age < stabilisation_epochs && over_downwelling {
                recycled += 1;
                continue;
            }
            kept.push(blob);
        }
        raft.blobs = kept;
    }
    for i in (0..rafts.len()).rev() {
        if rafts[i].blobs.is_empty() {
            rafts.remove(i);
        }
    }
    recycled
}

/// Accretion: a margin blob welded onto the raft nearest (x, y), unless one
/// already covers the spot or the raft is too far. Returns whether crust
/// was added.
#[allow(clippy::too_many_arguments)]
pub fn accrete_to_nearest_raft(
    rafts: &mut [Raft],
    x: f64,
    y: f64,
    blob_radius: f64,
    epoch: f64,
    min_gap_sq: f64,
    max_attach_sq: f64,
    domain: &Domain,
) -> bool {
    let mut nearest = None;
    let mut nearest_sq = f64::INFINITY;
    for (i, raft) in rafts.iter().enumerate() {
        for blob in &raft.blobs {
            let d = domain.distance_sq(x, y, blob.x, blob.y);
            if d < nearest_sq {
                nearest_sq = d;
                nearest = Some(i);
            }
        }
    }
    let Some(i) = nearest else {
        return false;
    };
    if nearest_sq < min_gap_sq || nearest_sq > max_attach_sq {
        return false;
    }
    rafts[i].blobs.push(RaftBlob {
        x,
        y,
        radius: blob_radius,
        birth_epoch: Some(epoch),
    });
    true
}

/// The closest overlapping blob pair between two rafts, by index.
fn closest_overlapping_blobs(
    a: &Raft,
    b: &Raft,
    overlap_factor: f64,
    domain: &Domain,
) -> Option<(usize, usize)> {
    let mut best = None;
    let mut best_sq = f64::INFINITY;
    for (ia, ba) in a.blobs.iter().enumerate() {
        for (ib, bb) in b.blobs.iter().enumerate() {
            let threshold = (ba.radius + bb.radius) * overlap_factor;
            let d = domain.distance_sq(ba.x, ba.y, bb.x, bb.y);
            if d < threshold * threshold && d < best_sq {
                best_sq = d;
                best = Some((ia, ib));
            }
        }
    }
    best
}

/// Sutures every pair of rafts whose coastlines touch, repeatedly; one
/// event per collision with its seam.
pub fn merge_overlapping_rafts(
    rafts: &mut Vec<Raft>,
    overlap_factor: f64,
    epoch: f64,
    domain: &Domain,
) -> Vec<RaftMergeEvent> {
    let mut merges = Vec::new();
    let mut merged_any = true;
    while merged_any {
        merged_any = false;
        'outer: for i in 0..rafts.len() {
            for j in i + 1..rafts.len() {
                if rafts[i].no_merge_until_epoch.unwrap_or(0.0) > epoch
                    || rafts[j].no_merge_until_epoch.unwrap_or(0.0) > epoch
                {
                    continue;
                }
                let Some((ia, ib)) =
                    closest_overlapping_blobs(&rafts[i], &rafts[j], overlap_factor, domain)
                else {
                    continue;
                };
                let name_a = rafts[i].name.clone();
                let name_b = rafts[j].name.clone();
                let (ax, ay) = (rafts[i].blobs[ia].x, rafts[i].blobs[ia].y);
                let (bx, by) = (rafts[j].blobs[ib].x, rafts[j].blobs[ib].y);
                let o = domain.delta(bx, by, ax, ay);
                let (dx, dy) = (o.x, o.y);
                let seam = domain.advance(ax, ay, dx / 2.0, dy / 2.0);
                let len = det_hypot(dx, dy);
                let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
                let t = domain.transport(-dy / len, dx / len, ax, ay, seam.x, seam.y);
                merges.push(RaftMergeEvent {
                    name_a,
                    name_b,
                    x: seam.x,
                    y: seam.y,
                    tangent_x: t.x,
                    tangent_y: t.y,
                });
                if rafts[i].name.is_none() && rafts[j].name.is_some() {
                    rafts[i].name = rafts[j].name.clone();
                }
                let absorbed = rafts.remove(j);
                rafts[i].blobs.extend(absorbed.blobs);
                merged_any = true;
                break 'outer;
            }
        }
    }
    merges
}

/// A rift tearing through a continent: the raft it runs through split
/// along the rift line into two halves pushed `gap` apart, the far half a
/// new raft `new_id`.
#[allow(clippy::too_many_arguments)]
pub fn split_raft_at_rift(
    rafts: &mut Vec<Raft>,
    rift_x: f64,
    rift_y: f64,
    normal_x: f64,
    normal_y: f64,
    new_id: u32,
    max_dist_sq: f64,
    gap: f64,
    current_epoch: f64,
    merge_immunity: f64,
    domain: &Domain,
) -> Option<RaftSplitEvent> {
    let mut target = None;
    let mut best_sq = f64::INFINITY;
    for (i, raft) in rafts.iter().enumerate() {
        for blob in &raft.blobs {
            let d = domain.distance_sq(rift_x, rift_y, blob.x, blob.y);
            if d < best_sq {
                best_sq = d;
                target = Some(i);
            }
        }
    }
    let target = target?;
    if best_sq > max_dist_sq {
        return None;
    }
    let (mut near, mut far) = (Vec::new(), Vec::new());
    for blob in &rafts[target].blobs {
        let o = domain.delta(blob.x, blob.y, rift_x, rift_y);
        if o.x * normal_x + o.y * normal_y >= 0.0 {
            near.push(blob.clone());
        } else {
            far.push(blob.clone());
        }
    }
    if near.is_empty() || far.is_empty() {
        return None;
    }
    for blob in near.iter_mut() {
        let o = domain.transport(normal_x, normal_y, rift_x, rift_y, blob.x, blob.y);
        let p = domain.advance(blob.x, blob.y, o.x * gap, o.y * gap);
        blob.x = p.x;
        blob.y = p.y;
    }
    for blob in far.iter_mut() {
        let o = domain.transport(normal_x, normal_y, rift_x, rift_y, blob.x, blob.y);
        let p = domain.advance(blob.x, blob.y, -o.x * gap, -o.y * gap);
        blob.x = p.x;
        blob.y = p.y;
    }
    let raft = &mut rafts[target];
    let parent_name = raft.name.clone();
    raft.blobs = near;
    raft.no_merge_until_epoch = Some(current_epoch + merge_immunity);
    rafts.push(Raft {
        id: new_id,
        name: None,
        blobs: far,
        no_merge_until_epoch: Some(current_epoch + merge_immunity),
    });
    Some(RaftSplitEvent {
        parent_name,
        x: rift_x,
        y: rift_y,
        axis_x: -normal_y,
        axis_y: normal_x,
    })
}

/// Connected components of a raft's blobs, in the order their roots are
/// first met.
fn connected_blob_components(
    blobs: &[RaftBlob],
    connect_factor: f64,
    domain: &Domain,
) -> Vec<Vec<RaftBlob>> {
    let n = blobs.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    for i in 0..n {
        for j in i + 1..n {
            let threshold = (blobs[i].radius + blobs[j].radius) * connect_factor;
            if domain.distance_sq(blobs[i].x, blobs[i].y, blobs[j].x, blobs[j].y)
                <= threshold * threshold
            {
                let ri = find(&mut parent, i);
                let rj = find(&mut parent, j);
                parent[ri] = rj;
            }
        }
    }
    let mut roots: Vec<usize> = Vec::new();
    let mut groups: Vec<Vec<RaftBlob>> = Vec::new();
    for i in 0..n {
        let root = find(&mut parent, i);
        match roots.iter().position(|&r| r == root) {
            Some(g) => groups[g].push(blobs[i].clone()),
            None => {
                roots.push(root);
                groups.push(vec![blobs[i].clone()]);
            }
        }
    }
    groups
}

/// Each raft whose blobs drifted into separate clusters decomposed into one
/// raft per cluster, the largest keeping the raft's id and name; returns how
/// many new rafts came out. `name_new_fragments` names the new ones big
/// enough to be continents.
pub fn split_disconnected_rafts(
    rafts: &mut Vec<Raft>,
    connect_factor: f64,
    random: &mut dyn FnMut() -> f64,
    domain: &Domain,
    name_new_fragments: bool,
) -> usize {
    let mut max_id = rafts.iter().fold(-1i64, |m, r| m.max(r.id as i64));
    let before = rafts.len();
    let mut result: Vec<Raft> = Vec::new();
    for raft in rafts.drain(..) {
        let mut components = connected_blob_components(&raft.blobs, connect_factor, domain);
        if components.len() <= 1 {
            result.push(raft);
            continue;
        }
        let area = |blobs: &[RaftBlob]| blobs.iter().fold(0.0, |s, b| s + b.radius * b.radius);
        // Stable, the largest first, as the comparator area(b) − area(a).
        components.sort_by(|a, b| {
            area(b)
                .partial_cmp(&area(a))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut iter = components.into_iter();
        let first = iter.next().unwrap();
        let no_merge = raft.no_merge_until_epoch;
        result.push(Raft {
            blobs: first,
            ..raft
        });
        for blobs in iter {
            max_id += 1;
            result.push(Raft {
                id: max_id as u32,
                name: None,
                blobs,
                no_merge_until_epoch: no_merge,
            });
        }
    }
    if name_new_fragments {
        let areas: Vec<f64> = result
            .iter()
            .map(|r| r.blobs.iter().fold(0.0, |s, b| s + b.radius * b.radius))
            .collect();
        let total = areas.iter().fold(0.0, |a, &b| a + b);
        for i in 0..result.len() {
            if result[i].name.is_none() && deserves_continent_name(areas[i], total) {
                result[i].name = pick_unused_raft_name(&result, random);
            }
        }
    }
    let created = result.len() - before;
    *rafts = result;
    created
}

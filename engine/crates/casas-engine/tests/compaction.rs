//! The Archean's compaction on the sphere near a pole (TEG-32, DEC-0035):
//! every blob outside a raft's compact disc moves TOWARD the raft's centre
//! along the great circle, by `rate` of its excess. The offset to the
//! centre is taken in the blob's own frame. Taken in the centre's frame and
//! applied in the blob's (the bug fixed 2026-10-12), a blob across the pole
//! from the centre is pushed away.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::crust::raft_lifecycle::compact_rafts;
use casas_engine::crust::raft_types::{Raft, RaftBlob};

/// A raft of `n` blobs on a ring about the north pole, its ring centre
/// moved off the pole by `off` units, so the raft's centre is not the pole.
fn polar_raft(domain: &Domain, n: usize, ring: f64, off: f64) -> Raft {
    let blobs = (0..n)
        .map(|i| {
            let a = (i as f64) * std::f64::consts::TAU / n as f64;
            // A point `ring` units from a centre `off` units down the
            // meridian x = 0, by the exp map at that centre.
            let c = domain.advance(0.0, 0.0, 0.0, off);
            let p = domain.advance(c.x, c.y, ring * det_cos(a), ring * det_sin(a));
            RaftBlob {
                x: p.x,
                y: p.y,
                radius: 4.0,
                birth_epoch: None,
            }
        })
        .collect();
    Raft {
        id: 1,
        name: None,
        blobs,
        no_merge_until_epoch: None,
    }
}

fn centre(domain: &Domain, raft: &Raft) -> (f64, f64) {
    let (mut cx, mut cy, mut cz) = (0.0, 0.0, 0.0);
    for b in &raft.blobs {
        let f = domain.globe_frame(b.x, b.y);
        cx += f.px;
        cy += f.py;
        cz += f.pz;
    }
    let c = domain.globe_locate(cx, cy, cz);
    (c.x, c.y)
}

#[test]
fn compaction_near_a_pole_pulls_every_blob_toward_the_centre() {
    let domain = Domain::sphere(2048.0, 1024.0);
    for &(ring, off) in &[(30.0, 0.0), (30.0, 10.0), (60.0, 20.0), (25.0, 24.0)] {
        let mut raft = polar_raft(&domain, 12, ring, off);
        let (cx, cy) = centre(&domain, &raft);
        let before: Vec<f64> = raft
            .blobs
            .iter()
            .map(|b| domain.distance_sq(b.x, b.y, cx, cy).sqrt())
            .collect();
        let mut rafts = vec![raft.clone()];
        compact_rafts(&mut rafts, 0.5, &domain);
        raft = rafts.pop().unwrap();
        let mut moved = 0;
        for (b, d0) in raft.blobs.iter().zip(&before) {
            let d1 = domain.distance_sq(b.x, b.y, cx, cy).sqrt();
            assert!(
                d1 <= d0 + 1e-9,
                "ring {ring} off {off}: a blob moved away from the centre, {d0} -> {d1}"
            );
            if d1 < d0 - 1e-9 {
                moved += 1;
            }
        }
        assert!(moved > 0, "ring {ring} off {off}: no blob moved");
    }
}

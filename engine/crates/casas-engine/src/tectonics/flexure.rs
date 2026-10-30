//! `tectonics/flexure.ts`: FLEXURAL ISOSTASY on the shared field mesh
//! (ADAPTIVE_MESH_PLAN.md phase 5.3, DEC-0036 phase 6): the plate equation
//! ∇²(D ∇²w) + ρm g w = −ρc g h, discretised as K diag(R / A) K w + A w =
//! −(ρc / ρm) A h and solved by conjugate gradients, matrix-free. The
//! reasoning and the measurements are in the TypeScript port
//! (`client/src/generator/tectonics/flexure.ts`, git history).

use crate::core::det_math::det_pow;
use crate::core::domain::Domain;
use crate::core::js;
use crate::fields::field_mesh::{FieldMesh, SharedFieldMesh};
use crate::fields::field_operators::{SolveOptions, SolveReport, conjugate_gradient};

use super::tectonics_tune_params::TECTONICS_TUNING as T;

const FLEXURE_RES_X: f64 = 256.0;

/// The flexure's spacing on a domain, metres: the shared mesh's.
pub fn flexure_spacing_m(domain: &Domain) -> f64 {
    (domain.width / FLEXURE_RES_X) * domain.metres_per_unit
}

/// A node's load onto the flexure's mesh, its volume kept whole: onto the
/// triangle's corners for a node no larger than the cell under it, else onto
/// as many cells as its area covers, outward in the mesh's neighbour order.
pub struct NodeLoadSpreader {
    stamp: Vec<u32>,
    queue: Vec<usize>,
    smallest: f64,
    pass: u32,
}

pub fn node_load_spreader(sm: &SharedFieldMesh) -> NodeLoadSpreader {
    let fm = &sm.mesh;
    let mut smallest = f64::INFINITY;
    for c in 0..fm.count {
        if fm.area[c] < smallest {
            smallest = fm.area[c];
        }
    }
    NodeLoadSpreader {
        stamp: vec![0; fm.count],
        queue: vec![0; fm.count],
        smallest,
        pass: 0,
    }
}

impl NodeLoadSpreader {
    /// Adds the node's `volume_m3` at (x, y), of area `area_m2`, to
    /// `load_m3` per cell.
    pub fn spread(
        &mut self,
        sm: &mut SharedFieldMesh,
        x: f64,
        y: f64,
        area_m2: f64,
        volume_m3: f64,
        load_m3: &mut [f64],
    ) {
        let start = if area_m2 <= self.smallest {
            None
        } else {
            Some(sm.sampler.nearest_cell(&mut sm.mesh, x, y))
        };
        let start = match start {
            Some(s) if area_m2 > sm.mesh.area[s] => s,
            _ => {
                let t = sm.sampler.taps(&mut sm.mesh, x, y);
                for k in 0..3 {
                    load_m3[t.corners[k]] += t.weights[k] * volume_m3;
                }
                return;
            }
        };
        let fm = &sm.mesh;
        self.pass += 1;
        let (mut head, mut tail) = (0, 0);
        let mut covered = 0.0;
        self.queue[tail] = start;
        tail += 1;
        self.stamp[start] = self.pass;
        while head < tail && covered < area_m2 {
            let c = self.queue[head];
            head += 1;
            covered += fm.area[c];
            for e in fm.edges(c) {
                let n = fm.nbr[e] as usize;
                if self.stamp[n] != self.pass {
                    self.stamp[n] = self.pass;
                    self.queue[tail] = n;
                    tail += 1;
                }
            }
        }
        for i in 0..head {
            let c = self.queue[i];
            load_m3[c] += volume_m3 * (fm.area[c] / covered);
        }
    }
}

/// The elastic thickness, km: a raft between the young and the craton value
/// by oldness, the ocean by its lithosphere age.
pub fn elastic_thickness_km(continental: bool, oldness: f64, ocean_age_ma: f64) -> f64 {
    if continental {
        return T.flexure_te_young_km
            + (T.flexure_te_craton_km - T.flexure_te_young_km)
                * js::min(1.0, js::max(0.0, oldness));
    }
    js::min(
        T.flexure_te_ocean_max_km,
        T.flexure_te_ocean_floor_km + T.flexure_te_ocean_age_km * js::max(0.0, ocean_age_ma).sqrt(),
    )
}

/// R = D / (ρm g), m⁴, with D = E Te³ / (12 (1 − ν²)).
pub fn flexural_rigidity_m4(te_km: f64) -> f64 {
    let e = T.flexure_youngs_modulus_gpa * 1e9;
    let te = te_km * 1000.0;
    let d = (e * te * te * te) / (12.0 * (1.0 - T.flexure_poisson * T.flexure_poisson));
    d / (T.flexure_mantle_density * 9.81)
}

/// The flexural parameter α = (4D / (ρm g))^(1/4), km.
pub fn flexural_alpha_km(te_km: f64) -> f64 {
    det_pow(4.0 * flexural_rigidity_m4(te_km), 0.25) / 1000.0
}

/// The plate's deflection w per cell, metres (+ up), for a load change
/// `load_m` per cell and the rigidity R per cell, into `w` (its content the
/// first guess).
pub fn flexural_response(
    fm: &FieldMesh,
    load_m: &[f64],
    rigidity_m4: &[f64],
    w: &mut [f64],
    options: SolveOptions,
) -> SolveReport {
    let n = fm.count;
    let compensation =
        (T.flexure_crust_density / T.flexure_mantle_density) * T.flexure_deflection_scale;
    let b: Vec<f64> = (0..n)
        .map(|i| -compensation * fm.area[i] * load_m[i])
        .collect();
    let mut scaled = vec![0.0; n];
    let mut k_diag = vec![0.0; n];
    for i in 0..n {
        let mut s = 0.0;
        for e in fm.edges(i) {
            s += fm.coupling[e];
        }
        k_diag[i] = s;
        scaled[i] = rigidity_m4[i] / fm.area[i];
    }
    let mut diag = vec![0.0; n];
    for i in 0..n {
        let mut s = k_diag[i] * k_diag[i] * scaled[i];
        for e in fm.edges(i) {
            s += fm.coupling[e] * fm.coupling[e] * scaled[fm.nbr[e] as usize];
        }
        diag[i] = fm.area[i] + s;
    }
    let mut moment = vec![0.0; n];
    let mut apply = |x: &[f64], out: &mut [f64]| {
        for i in 0..n {
            let xi = x[i];
            let mut s = 0.0;
            for e in fm.edges(i) {
                s += fm.coupling[e] * (x[fm.nbr[e] as usize] - xi);
            }
            moment[i] = scaled[i] * s;
        }
        for i in 0..n {
            let mi = moment[i];
            let mut s = 0.0;
            for e in fm.edges(i) {
                s += fm.coupling[e] * (moment[fm.nbr[e] as usize] - mi);
            }
            out[i] = s + fm.area[i] * x[i];
        }
    };
    conjugate_gradient(n, &mut apply, &diag, &b, w, options)
}

//! The chart of level 1 (client/src/screens/incubator/historyInput.ts):
//! the level's mesh decoded once, and one walk over the chart for the
//! heights, the biomes and the nodes. The incubator's chart worker paints
//! with it, the history's job takes its node map: both from this walk, so
//! the two give the same bits.

use casas_engine::core::det_math::{det_cos, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::mesh::mesh_raster::rasterise_node_field;
use casas_engine::mesh::mesh_serial::{SerializedMesh, decode_mesh};
pub use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;

/// The heights, the biomes and, at half the chart's resolution, the nodes
/// of one walk.
pub struct ChartPass {
    pub elevation: Vec<f32>,
    pub biome: Vec<u8>,
    pub nodes: Vec<i32>,
}

/// Level 1's mesh over the domain of the world raster's size.
pub fn level_mesh(
    sphere: bool,
    width: f64,
    height: f64,
    count: usize,
    nodes: &[f32],
    connectivity: &[u8],
) -> Result<PeriodicTriangulation, String> {
    let domain = if sphere {
        Domain::sphere(width, height)
    } else {
        Domain::torus(width, height)
    };
    let serial = SerializedMesh {
        count,
        nodes: nodes.to_vec(),
        connectivity: connectivity.to_vec(),
    };
    decode_mesh(&domain, &serial)
}

/// A node field on a `w` × `h` raster over the domain (the heights of a
/// level without its land fields, the world raster's for the waters).
pub fn raster(mesh: &mut PeriodicTriangulation, z: &[f32], w: usize, h: usize) -> Vec<f32> {
    rasterise_node_field(mesh, z, w, h)
}

/// One walk over the chart. The heights as `rasterise_node_field` gives
/// them (the same walk, the same sum in the same order, so the same bits);
/// the biome of the triangle's nearest corner, of its nearest land corner
/// where the texel is land; the nearest corner on every second row and
/// column for `nodes`.
pub fn chart_pass(
    mesh: &mut PeriodicTriangulation,
    z: &[f32],
    land: &[u8],
    biome: &[u8],
    w: usize,
    h: usize,
) -> ChartPass {
    let mut elevation = vec![0f32; w * h];
    let mut biomes = vec![0u8; w * h];
    let half = w >> 1;
    let mut nodes = vec![0i32; half * (h >> 1)];
    let sx = mesh.domain.width / w as f64;
    let sy = mesh.domain.height / h as f64;
    // On the globe a texel's unit vector from a row's and a column's
    // angles, made once each: the values `locate` and `barycentric` make
    // per call (globe_scale), without four sines and cosines a texel.
    let globe = mesh.globe;
    let (to_lon, to_colat) = mesh.globe_scale();
    let (cos_lon, sin_lon): (Vec<f64>, Vec<f64>) = if globe {
        (0..w)
            .map(|px| {
                let l = px as f64 * sx * to_lon;
                (det_cos(l), det_sin(l))
            })
            .unzip()
    } else {
        (Vec::new(), Vec::new())
    };
    let mut hint = mesh.last_tri as usize;
    let mut row_start = hint;
    for py in 0..h {
        let y = py as f64 * sy;
        let colat = y * to_colat;
        let (sin_colat, cos_colat) = if globe {
            (det_sin(colat), det_cos(colat))
        } else {
            (0.0, 0.0)
        };
        hint = row_start;
        for px in 0..w {
            let x = px as f64 * sx;
            let (t, bary) = if globe {
                let q = [sin_colat * cos_lon[px], sin_colat * sin_lon[px], cos_colat];
                let t = mesh.locate_unit(q, Some(hint));
                (t, mesh.barycentric_unit(t, q))
            } else {
                let t = mesh.locate(x, y, Some(hint));
                (t, mesh.barycentric(t, x, y))
            };
            hint = t;
            if px == 0 {
                row_start = t;
            }
            let corner =
                [mesh.tris[3 * t], mesh.tris[3 * t + 1], mesh.tris[3 * t + 2]].map(|v| v as usize);
            let i = py * w + px;
            let e = bary[0] * z[corner[0]] as f64
                + bary[1] * z[corner[1]] as f64
                + bary[2] * z[corner[2]] as f64;
            elevation[i] = e as f32;
            let mut near = 0;
            for k in 1..3 {
                if bary[k] > bary[near] {
                    near = k;
                }
            }
            let mut near_land: Option<usize> = None;
            if e > 0.0 {
                for k in 0..3 {
                    if land[corner[k]] != 0 && near_land.is_none_or(|n| bary[k] > bary[n]) {
                        near_land = Some(k);
                    }
                }
            }
            biomes[i] = biome[corner[near_land.unwrap_or(near)]];
            if (px | py) & 1 == 0 {
                nodes[(py >> 1) * half + (px >> 1)] = corner[near] as i32;
            }
        }
    }
    ChartPass {
        elevation,
        biome: biomes,
        nodes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use casas_engine::mesh::lattice::bootstrap_lattice;

    /// The walk as written first, with `locate` and `barycentric` on each
    /// texel's chart point.
    fn plain_pass(
        mesh: &mut PeriodicTriangulation,
        z: &[f32],
        land: &[u8],
        biome: &[u8],
        w: usize,
        h: usize,
    ) -> ChartPass {
        let mut elevation = vec![0f32; w * h];
        let mut biomes = vec![0u8; w * h];
        let mut nodes = vec![0i32; (w >> 1) * (h >> 1)];
        let sx = mesh.domain.width / w as f64;
        let sy = mesh.domain.height / h as f64;
        let mut hint = mesh.last_tri as usize;
        let mut row_start = hint;
        for py in 0..h {
            hint = row_start;
            for px in 0..w {
                let (x, y) = (px as f64 * sx, py as f64 * sy);
                let t = mesh.locate(x, y, Some(hint));
                hint = t;
                if px == 0 {
                    row_start = t;
                }
                let b = mesh.barycentric(t, x, y);
                let c = [0, 1, 2].map(|k| mesh.tris[3 * t + k] as usize);
                let e = b[0] * z[c[0]] as f64 + b[1] * z[c[1]] as f64 + b[2] * z[c[2]] as f64;
                elevation[py * w + px] = e as f32;
                let near = (0..3).fold(0, |n, k| if b[k] > b[n] { k } else { n });
                let mut near_land: Option<usize> = None;
                if e > 0.0 {
                    for k in 0..3 {
                        if land[c[k]] != 0 && near_land.is_none_or(|n| b[k] > b[n]) {
                            near_land = Some(k);
                        }
                    }
                }
                biomes[py * w + px] = biome[c[near_land.unwrap_or(near)]];
                if (px | py) & 1 == 0 {
                    nodes[(py >> 1) * (w >> 1) + (px >> 1)] = c[near] as i32;
                }
            }
        }
        ChartPass {
            elevation,
            biome: biomes,
            nodes,
        }
    }

    // The walk with the globe's tables gives the plain walk's bits, and
    // its heights are rasterise_node_field's.
    #[test]
    fn the_walk_is_the_plain_one() {
        for domain in [Domain::sphere(64.0, 32.0), Domain::torus(64.0, 32.0)] {
            let mut mesh = bootstrap_lattice(&domain, 1.7);
            let n = mesh.vertex_slots();
            let z: Vec<f32> = (0..n)
                .map(|v| ((v * 37 % 101) as f32 - 50.0) / 25.0)
                .collect();
            let land: Vec<u8> = (0..n).map(|v| (v % 3 != 0) as u8).collect();
            let biome: Vec<u8> = (0..n).map(|v| (v % 7) as u8).collect();
            let (w, h) = (256, 128);
            let got = chart_pass(&mut mesh, &z, &land, &biome, w, h);
            let want = plain_pass(&mut mesh, &z, &land, &biome, w, h);
            let bits = |e: &[f32]| e.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
            assert_eq!(
                bits(&got.elevation),
                bits(&want.elevation),
                "sphere: {}",
                domain.is_sphere()
            );
            assert_eq!(got.biome, want.biome);
            assert_eq!(got.nodes, want.nodes);
            assert_eq!(bits(&got.elevation), bits(&raster(&mut mesh, &z, w, h)));
        }
    }
}

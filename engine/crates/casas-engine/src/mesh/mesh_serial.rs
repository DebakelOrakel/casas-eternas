//! `mesh/meshSerial.ts`: the mesh as bytes — f32 node positions and, per
//! node, its neighbours counter-clockwise as zigzag varint deltas, in
//! Hilbert numbering — and the canonical form (`compact_mesh`) a session's
//! mesh takes after every epoch. The TypeScript file explains why the
//! connectivity is stored.

use crate::core::domain::Domain;
use crate::core::js;

use super::hilbert::hilbert_order;
use super::periodic_delaunay::PeriodicTriangulation;

/// The codec's bytes: the node count, x/y interleaved (domain units), the
/// connectivity.
#[derive(Clone, Debug, PartialEq)]
pub struct SerializedMesh {
    pub count: usize,
    pub nodes: Vec<f32>,
    pub connectivity: Vec<u8>,
}

/// Vertex ids of the mesh in Hilbert order (alive vertices only).
pub fn hilbert_vertex_order(mesh: &PeriodicTriangulation) -> Vec<i32> {
    let alive: Vec<usize> = (0..mesh.vertex_slots())
        .filter(|&v| mesh.v_alive[v] != 0)
        .collect();
    let xs: Vec<f64> = alive.iter().map(|&v| mesh.vx[v]).collect();
    let ys: Vec<f64> = alive.iter().map(|&v| mesh.vy[v]).collect();
    let order = hilbert_order(&xs, &ys, alive.len(), mesh.domain.width, mesh.domain.height);
    order.iter().map(|&i| alive[i as usize] as i32).collect()
}

/// Vertex `v`'s neighbours counter-clockwise as new ids into `out`,
/// starting at the smallest.
fn canonical_star(
    mesh: &PeriodicTriangulation,
    v: usize,
    new_id: &[i32],
    star: &mut Vec<u32>,
    out: &mut Vec<i32>,
) {
    mesh.neighbours(v, star);
    let n = star.len();
    let mut first = 0;
    for s in 1..n {
        if new_id[star[s] as usize] < new_id[star[first] as usize] {
            first = s;
        }
    }
    out.clear();
    for s in 0..n {
        out.push(new_id[star[(first + s) % n] as usize]);
    }
}

fn new_ids(mesh: &PeriodicTriangulation, order: &[i32]) -> Vec<i32> {
    let mut new_id = vec![-1i32; mesh.vertex_slots()];
    for (i, &v) in order.iter().enumerate() {
        new_id[v as usize] = i as i32;
    }
    new_id
}

/// The mesh with vertex i of the output being `order[i]` of the input.
pub fn encode_mesh(mesh: &PeriodicTriangulation, order: &[i32]) -> SerializedMesh {
    let count = order.len();
    let new_id = new_ids(mesh, order);
    let mut nodes = vec![0f32; count * 2];
    let mut bytes = Vec::new();
    let mut star = Vec::new();
    let mut ring = Vec::new();
    for (i, &v) in order.iter().enumerate() {
        let v = v as usize;
        nodes[2 * i] = mesh.vx[v] as f32;
        nodes[2 * i + 1] = mesh.vy[v] as f32;
        canonical_star(mesh, v, &new_id, &mut star, &mut ring);
        write_varint(&mut bytes, ring.len() as u64);
        for &r in &ring {
            write_varint(&mut bytes, zigzag(r as i64 - i as i64));
        }
    }
    SerializedMesh {
        count,
        nodes,
        connectivity: bytes,
    }
}

/// The triangulation from the bytes; vertex i is node i of the encoding.
pub fn decode_mesh(
    domain: &Domain,
    serial: &SerializedMesh,
) -> Result<PeriodicTriangulation, String> {
    let count = serial.count;
    let xs: Vec<f64> = (0..count).map(|i| serial.nodes[2 * i] as f64).collect();
    let ys: Vec<f64> = (0..count).map(|i| serial.nodes[2 * i + 1] as f64).collect();
    let mut at = 0usize;
    let mut tris: Vec<u32> = Vec::new();
    let mut star: Vec<i64> = Vec::new();
    for v in 0..count {
        let n = read_varint(&serial.connectivity, &mut at) as usize;
        star.clear();
        for _ in 0..n {
            star.push(v as i64 + unzigzag(read_varint(&serial.connectivity, &mut at)));
        }
        for s in 0..n {
            let a = star[s];
            let b = star[(s + 1) % n];
            if (v as i64) < a && (v as i64) < b {
                tris.extend_from_slice(&[v as u32, a as u32, b as u32]);
            }
        }
    }
    PeriodicTriangulation::from_triangles(domain.clone(), &xs, &ys, &tris)
}

/// The mesh in canonical form: Hilbert-numbered, rebuilt as the codec
/// rebuilds it; and per new vertex, the old vertex id.
pub fn compact_mesh(mesh: &PeriodicTriangulation) -> (PeriodicTriangulation, Vec<i32>) {
    let order = hilbert_vertex_order(mesh);
    let count = order.len();
    let new_id = new_ids(mesh, &order);
    let mut xs = vec![0.0; count];
    let mut ys = vec![0.0; count];
    let mut star = Vec::new();
    let mut ring = Vec::new();
    let mut tris: Vec<u32> = Vec::with_capacity(count * 6 + 3);
    for (i, &v) in order.iter().enumerate() {
        let v = v as usize;
        xs[i] = js::fround(mesh.vx[v]);
        ys[i] = js::fround(mesh.vy[v]);
        canonical_star(mesh, v, &new_id, &mut star, &mut ring);
        let n = ring.len();
        for s in 0..n {
            let a = ring[s];
            let b = ring[(s + 1) % n];
            if !((i as i32) < a && (i as i32) < b) {
                continue;
            }
            tris.extend_from_slice(&[i as u32, a as u32, b as u32]);
        }
    }
    let compact = PeriodicTriangulation::from_triangles(mesh.domain.clone(), &xs, &ys, &tris)
        .expect("compactMesh: the canonical stars do not form a triangulation");
    (compact, order)
}

/// A per-node field reordered: out[i] = field[order[i]].
pub fn permute<T: Copy>(field: &[T], order: &[i32]) -> Vec<T> {
    order.iter().map(|&o| field[o as usize]).collect()
}

fn zigzag(n: i64) -> u64 {
    if n >= 0 {
        (n * 2) as u64
    } else {
        (-n * 2 - 1) as u64
    }
}

fn unzigzag(u: u64) -> i64 {
    if u.is_multiple_of(2) {
        (u / 2) as i64
    } else {
        -(u.div_ceil(2) as i64)
    }
}

fn write_varint(out: &mut Vec<u8>, value: u64) {
    let mut v = value;
    while v >= 128 {
        out.push((v % 128 + 128) as u8);
        v /= 128;
    }
    out.push(v as u8);
}

fn read_varint(bytes: &[u8], at: &mut usize) -> u64 {
    let mut value = 0u64;
    let mut scale = 1u64;
    loop {
        let b = bytes[*at];
        *at += 1;
        value += (b as u64 % 128) * scale;
        if b < 128 {
            return value;
        }
        scale *= 128;
    }
}

//! The module test of `periodic_delaunay` against the TypeScript engine's
//! `mesh/periodicDelaunay.ts`: the same scenario gives the same state, bit
//! for bit, after every step (docs/decisions/rust-engine.md, fork 5). The
//! fixture is written by `engine/scripts/delaunayFixture.mjs`; the scenario
//! below is that script's, step for step.

use casas_engine::core::domain::Domain;
use casas_engine::mesh::periodic_delaunay::PeriodicTriangulation;

mod fixture;

const FILE: &str = "periodic_delaunay.txt";
const FIXTURE: &str = include_str!("fixtures/periodic_delaunay.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
    fn index(&mut self, n: usize) -> usize {
        self.uniform(0.0, n as f64).floor() as usize
    }
}

struct Hash(u32);

impl Hash {
    fn new() -> Self {
        Hash(0x811c_9dc5)
    }
    fn add(&mut self, v: f64) {
        let b = if v.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            v.to_bits()
        };
        self.0 = (self.0 ^ b as u32).wrapping_mul(0x0100_0193);
        self.0 = (self.0 ^ (b >> 32) as u32).wrapping_mul(0x0100_0193);
    }
    fn add_all<T: Copy + Into<f64>>(&mut self, a: &[T]) {
        for &v in a {
            self.add(v.into());
        }
    }
    fn hex(&self) -> String {
        format!("{:08x}", self.0)
    }
}

fn state_hash(m: &PeriodicTriangulation) -> String {
    let mut h = Hash::new();
    h.add(m.vertex_slots() as f64);
    h.add(m.alive_vertices as f64);
    h.add(m.tri_slots() as f64);
    h.add(m.alive_triangles as f64);
    h.add_all(&m.vx);
    h.add_all(&m.vy);
    h.add_all(&m.v_edge);
    h.add_all(&m.v_alive);
    if m.globe {
        h.add_all(&m.vu);
    }
    h.add_all(&m.tris);
    h.add_all(&m.twin);
    h.add_all(&m.t_alive);
    h.add(m.last_tri as f64);
    h.add(m.walk_steps as f64);
    h.add(m.flips as f64);
    h.add(m.walk_fallbacks as f64);
    h.hex()
}

fn bootstrap(domain: Domain, g: &mut Gen) -> PeriodicTriangulation {
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    let mut tris: Vec<u32> = Vec::new();
    if domain.is_sphere() {
        let (w, h) = (domain.width, domain.height);
        xs.extend_from_slice(&[0.0, 0.0, 0.0, w / 4.0, w / 2.0, (3.0 * w) / 4.0]);
        ys.extend_from_slice(&[0.0, h, h / 2.0, h / 2.0, h / 2.0, h / 2.0]);
        for k in 0..4 {
            let a = 2 + k;
            let b = 2 + (k + 1) % 4;
            tris.extend_from_slice(&[0, a, b, 1, b, a]);
        }
        return PeriodicTriangulation::from_triangles(domain, &xs, &ys, &tris).unwrap();
    }
    let (nx, ny) = (16i64, 8i64);
    let cw = domain.width / nx as f64;
    let ch = domain.height / ny as f64;
    for j in 0..ny {
        for i in 0..nx {
            xs.push((i as f64 + 0.5 * (j % 2) as f64 + g.uniform(-0.2, 0.2)) * cw);
            ys.push((j as f64 + g.uniform(-0.2, 0.2)) * ch);
        }
    }
    let id = |i: i64, j: i64| (j.rem_euclid(ny) * nx + i.rem_euclid(nx)) as u32;
    for j in 0..ny {
        for i in 0..nx {
            tris.extend_from_slice(&[
                id(i, j),
                id(i + 1, j),
                id(i + 1, j + 1),
                id(i, j),
                id(i + 1, j + 1),
                id(i, j + 1),
            ]);
        }
    }
    let mut m = PeriodicTriangulation::from_triangles(domain, &xs, &ys, &tris).unwrap();
    m.legalise_all();
    m
}

fn scenario(name: &str, domain: Domain, seed: u32) -> Vec<String> {
    let mut g = Gen(seed);
    let mut lines = Vec::new();
    let (w, h) = (domain.width, domain.height);
    let mut m = bootstrap(domain, &mut g);
    lines.push(format!("{name} bootstrap {}", state_hash(&m)));
    for _ in 0..20000 {
        let x = g.uniform(0.0, w);
        m.insert(x, g.uniform(0.0, h), None);
    }
    for _ in 0..1000 {
        let x = g.uniform(0.0, w);
        m.insert(x, g.uniform(0.0, h / 200.0), None);
    }
    lines.push(format!("{name} insert {}", state_hash(&m)));
    let mut removed = 0;
    for _ in 0..6000 {
        let v = g.index(m.vertex_slots());
        if m.remove(v) {
            removed += 1;
        }
    }
    lines.push(format!("{name} remove {} {removed}", state_hash(&m)));
    for _ in 0..500 {
        let v = g.index(m.vertex_slots());
        if m.v_alive[v] != 0 {
            m.insert(m.vx[v], m.vy[v], None);
        }
    }
    for _ in 0..500 {
        let t = g.index(m.tri_slots());
        if m.t_alive[t] == 0 {
            continue;
        }
        let f = m.frame(t);
        m.insert((f[0] + f[2]) / 2.0, (f[1] + f[3]) / 2.0, None);
    }
    lines.push(format!("{name} special {}", state_hash(&m)));
    for _ in 0..6000 {
        let x = g.uniform(-w / 2.0, 1.5 * w);
        m.insert(x, g.uniform(-h / 2.0, 1.5 * h), None);
    }
    lines.push(format!("{name} reinsert {}", state_hash(&m)));
    let mut copy = m.clone();
    for _ in 0..2000 {
        let x = g.uniform(0.0, w);
        copy.insert(x, g.uniform(0.0, h), None);
    }
    for _ in 0..500 {
        let v = g.index(copy.vertex_slots());
        copy.remove(v);
    }
    lines.push(format!("{name} clone {}", state_hash(&copy)));
    let mut qh = Hash::new();
    for _ in 0..5000 {
        let x = g.uniform(0.0, w);
        let y = g.uniform(0.0, h);
        let hint = g.index(m.tri_slots());
        let t = m.locate(x, y, Some(hint));
        let bw = m.barycentric(t, x, y);
        qh.add(t as f64);
        qh.add(m.on_edge as f64);
        qh.add(m.at_vertex as f64);
        qh.add_all(&bw);
    }
    lines.push(format!("{name} query {}", qh.hex()));
    let mut ah = Hash::new();
    for v in 0..m.vertex_slots() {
        if m.v_alive[v] != 0 {
            let a = m.voronoi_area(v);
            ah.add(a);
        }
    }
    lines.push(format!("{name} area {}", ah.hex()));
    let errors = m.validate(true);
    assert!(
        errors.is_empty(),
        "{name}: invalid: {:?}",
        &errors[..errors.len().min(3)]
    );
    lines
}

fn expected(name: &str) -> Vec<String> {
    FIXTURE
        .lines()
        .filter(|l| l.starts_with(&format!("{name} ")))
        .map(str::to_string)
        .collect()
}

/// Checks each line of the scenario against the fixture's line, in order.
fn check(name: &str, got: Vec<String>) {
    let want = expected(name);
    assert_eq!(got.len(), want.len(), "{name}: the number of lines");
    for (g, w) in got.iter().zip(&want) {
        fixture::check(FILE, g, w, name);
    }
}

#[test]
fn the_torus_scenario_gives_the_typescript_state() {
    check("torus", scenario("torus", Domain::torus(2048.0, 1024.0), 1));
}

#[test]
fn the_sphere_scenario_gives_the_typescript_state() {
    check(
        "sphere",
        scenario("sphere", Domain::sphere(2048.0, 1024.0), 2),
    );
}

fn read<T: Copy + Default>(dir: &str, name: &str) -> Vec<T> {
    let bytes = std::fs::read(format!("{dir}/{name}")).unwrap();
    let size = std::mem::size_of::<T>();
    bytes
        .chunks_exact(size)
        .map(|c| {
            let mut v = T::default();
            // SAFETY: T is a plain number type and the chunk is its size.
            unsafe { std::ptr::copy_nonoverlapping(c.as_ptr(), &mut v as *mut T as *mut u8, size) };
            v
        })
        .collect()
}

/// A real epoch's rebuild: the globe triangulation of a level-1 history at
/// epoch 12 (3.8 M inserts), dumped from the TypeScript engine. The dump is
/// hundreds of MB and not in the repository:
/// `CASAS_ENGINE_DUMP=<dir> cargo test --release -- --ignored`.
#[test]
#[ignore]
fn a_dumped_rebuild_gives_the_typescript_mesh() {
    let dir =
        std::env::var("CASAS_ENGINE_DUMP").expect("CASAS_ENGINE_DUMP names the dump directory");
    let mut m = PeriodicTriangulation::new(Domain::sphere(2048.0, 1024.0));
    m.vx = read(&dir, "vx.f64");
    m.vy = read(&dir, "vy.f64");
    m.vu = read(&dir, "vu.f64");
    m.v_edge = read(&dir, "vEdge.i32");
    m.v_alive = read(&dir, "vAlive.u8");
    m.tris = read(&dir, "tris.i32");
    m.twin = read(&dir, "twin.i32");
    m.t_alive = read(&dir, "tAlive.u8");
    m.alive_vertices = m.v_alive.iter().filter(|&&a| a != 0).count() as u32;
    m.alive_triangles = m.t_alive.iter().filter(|&&a| a != 0).count() as u32;
    let points: Vec<f64> = read(&dir, "points.f64");
    let start = std::time::Instant::now();
    for p in points.as_chunks::<2>().0 {
        m.insert(p[0], p[1], None);
    }
    eprintln!(
        "{} inserts in {:.0} ms, walk {} flips {}",
        points.len() / 2,
        start.elapsed().as_secs_f64() * 1e3,
        m.walk_steps,
        m.flips
    );
    assert!(
        m.tris == read::<i32>(&dir, "out_tris.i32"),
        "the triangles differ"
    );
    assert!(
        m.twin == read::<i32>(&dir, "out_twin.i32"),
        "the twins differ"
    );
    let vu: Vec<f64> = read(&dir, "out_vu.f64");
    assert!(
        m.vu.iter()
            .zip(&vu)
            .all(|(a, b)| a.to_bits() == b.to_bits())
            && m.vu.len() == vu.len(),
        "the unit vectors differ"
    );
}

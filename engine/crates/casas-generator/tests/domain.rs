//! The module test of the domain (the domain, its grids, `field`, and the
//! field mesh's raster readers) against the TypeScript engine's
//! `core/domain.ts`, `core/field.ts` and `fields/fieldMesh.ts`: the same
//! calls give the same bits (docs/decisions/rust-engine.md, fork 5). The
//! fixture is written by `engine/scripts/domainFixture.mjs`; the calls below
//! are that script's, one for one.

#![allow(clippy::needless_range_loop)]

use casas_generator::core::domain::{Domain, Vec2, bilinear_taps, domain_area, sample_taps};
use casas_generator::core::field::{downsample_box, downsample_max};
use casas_generator::fields::field_mesh::{
    create_field_mesh, create_field_sampler, field_from_raster_area_weighted,
    field_from_raster_at_centres, field_max_from_raster, raster_owners,
};

const FIXTURE: &str = include_str!("fixtures/domain.txt");

struct Gen(u32);

impl Gen {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * (self.next() as f64 / 4294967296.0)
    }
    fn int(&mut self, lo: f64, hi: f64) -> i64 {
        self.uniform(lo, hi).floor() as i64
    }
    fn field(&mut self, n: usize) -> Vec<f32> {
        (0..n).map(|_| self.uniform(-1.0, 1.0) as f32).collect()
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
    fn p(&mut self, p: Vec2) {
        self.add(p.x);
        self.add(p.y);
    }
    fn line(&self, name: &str) -> String {
        format!("{name} {:08x}", self.0)
    }
}

fn expected(name: &str) -> String {
    FIXTURE
        .lines()
        .find(|l| l.split_whitespace().next() == Some(name))
        .unwrap_or_else(|| panic!("no {name} in the fixture"))
        .to_string()
}

fn domain_scenario(name: &str, d: Domain, grids: &[(usize, usize)], seed: u32) {
    let mut g = Gen(seed);
    let mut h = Hash::new();
    h.add(d.width);
    h.add(d.height);
    h.add(d.metres_per_unit);
    h.add(d.metres_around);
    h.add(domain_area(&d));
    let sd = d.scaled_to(1024.0, 512.0);
    h.add(sd.metres_per_unit);
    h.add(sd.latitude(0.3));
    for _ in 0..20000 {
        let ax = g.uniform(-0.5 * d.width, 1.5 * d.width);
        let ay = g.uniform(-0.2 * d.height, 1.2 * d.height);
        let bx = g.uniform(0.0, d.width);
        let by = g.uniform(0.0, d.height);
        let yn = g.uniform(-0.5, 1.5);
        h.add(d.latitude(yn));
        h.add(if d.north(yn) { 1.0 } else { 0.0 });
        h.p(d.delta(ax, ay, bx, by));
        let dx = g.uniform(-40.0, 40.0);
        let dy = g.uniform(-40.0, 40.0);
        h.p(d.advance(bx, by, dx, dy));
        h.p(d.displace(bx, by, dx, dy));
        h.p(d.from_plane(bx + dx, by + dy, bx, by));
        h.add(d.wrap_x(ax));
        h.add(d.wrap_y(ay));
        h.p(d.wrap_point(ax, ay));
        h.add(d.distance_sq(ax, ay, bx, by));
        let angle = g.uniform(-0.3, 0.3);
        h.p(d.rotate_around(ax, ay, bx, by, angle));
        h.p(d.transport(dx, dy, ax, ay, bx, by));
        if d.is_sphere() {
            let f = d.globe_frame(ax, ay);
            for v in [f.px, f.py, f.pz, f.ex, f.ey, f.ez, f.sx, f.sy, f.sz] {
                h.add(v);
            }
            let (px, py, pz) = (
                g.uniform(-1.0, 1.0),
                g.uniform(-1.0, 1.0),
                g.uniform(-1.0, 1.0),
            );
            h.p(d.globe_locate(px, py, pz));
        }
    }
    assert_eq!(
        h.line(&format!("{name}_domain")),
        expected(&format!("{name}_domain"))
    );

    for &(rx, ry) in grids {
        let grid = d.grid(rx, ry);
        let field = g.field(rx * ry);
        let (fx, fy) = (rx as f64, ry as f64);
        let mut h = Hash::new();
        for _ in 0..2000 {
            h.add(grid.wrap_col(g.uniform(-3.0 * fx, 3.0 * fx)));
            h.add(grid.wrap_row(g.uniform(-3.0 * fy, 3.0 * fy)));
            h.add(grid.wrap_col(g.int(-3.0 * fx, 3.0 * fx) as f64));
            h.add(grid.wrap_row(g.int(-3.0 * fy, 3.0 * fy) as f64));
            let (x, y) = (g.int(-2.0 * fx, 2.0 * fx), g.int(-2.0 * fy, 2.0 * fy));
            h.add(grid.index(x, y) as f64);
            let (x, y, dx, dy) = (
                g.int(0.0, fx),
                g.int(0.0, fy),
                g.int(-3.0, 4.0),
                g.int(-3.0, 4.0),
            );
            h.add(grid.neighbour(x, y, dx, dy) as f64);
        }
        h.add_all(&grid.col_table(3));
        h.add_all(&grid.row_table(if d.is_sphere() { 0 } else { 3 }));
        for y in -2..ry as i64 + 2 {
            h.add(grid.row_scale(y as f64 + 0.25));
            h.add(grid.cell_area(y as f64));
            h.add(grid.edge_scale(y as f64 + 0.4));
        }
        for k in 0..2000 {
            let radius = if k % 50 == 0 {
                g.uniform(0.0, 2.0 * d.width)
            } else {
                g.uniform(0.0, 0.2 * d.height)
            };
            let x = g.uniform(-0.2 * d.width, 1.2 * d.width);
            let y = g.uniform(-0.1 * d.height, 1.1 * d.height);
            let b = grid.disc_box(x, y, radius);
            for v in [b.x0, b.x1, b.y0, b.y1] {
                h.add(v as f64);
            }
        }
        let mut a = field.clone();
        grid.average_pole_rows(&mut a, None);
        h.add_all(&a);
        let mut b = field.clone();
        let mask: Vec<u8> = (0..rx * ry).map(|_| (g.next() & 1) as u8).collect();
        grid.average_pole_rows(&mut b, Some(&mask));
        h.add_all(&b);
        let mut taps = bilinear_taps(1);
        for _ in 0..5000 {
            let gx = g.uniform(-fx, 2.0 * fx);
            let gy = g.uniform(-1.0, fy);
            h.add(grid.sample_bilinear(&field, gx, gy));
            let (ix, iy) = (g.uniform(-0.5, fx), g.uniform(-0.5, fy - 0.5));
            h.add(grid.interpolate(&field, ix, iy));
            let (cx, cy) = (g.int(0.0, fx) as f64, g.int(0.0, fy) as f64);
            let (dx, dy) = (g.uniform(-3.0, 3.0), g.uniform(-3.0, 3.0));
            grid.taps_at(cx, cy, dx, dy, &mut taps, 0);
            h.add_all(&taps.cells);
            h.add_all(&taps.weights);
            h.add(sample_taps(&field, &taps, 0));
            h.add(grid.cell_displaced(cx, cy, dx, dy) as f64);
            h.p(grid.displaced(cx, cy, dx, dy));
            let x = g.uniform(-0.2 * d.width, 1.2 * d.width);
            let y = g.uniform(0.0, d.height);
            h.add(grid.sample_bilinear_at(&field, x, y));
            h.add(grid.cell_at(x, y) as f64);
            h.add(grid.sample_nearest_at(&field, x, y));
        }
        h.add_all(&grid.upscale(&field, 2 * rx, 2 * ry));
        let key = format!("{name}_grid_{rx}x{ry}");
        assert_eq!(h.line(&key), expected(&key));
    }
}

#[test]
fn the_domains_and_grids_give_the_typescript_values() {
    let domains = [
        (
            "torus",
            Domain::torus(2048.0, 1024.0),
            vec![(256, 128), (63, 31)],
        ),
        (
            "torus_small",
            Domain::torus_with(512.0, 256.0, 0.1, 31200.0),
            vec![(64, 32)],
        ),
        (
            "sphere",
            Domain::sphere(2048.0, 1024.0),
            vec![(256, 128), (64, 32)],
        ),
        (
            "sphere_scaled",
            Domain::sphere(2048.0, 1024.0).scaled_to(256.0, 128.0),
            vec![(32, 16)],
        ),
    ];
    for (seed, (name, d, grids)) in domains.into_iter().enumerate() {
        domain_scenario(name, d, &grids, seed as u32 + 1);
    }
}

#[test]
fn the_field_reductions_give_the_typescript_values() {
    let mut g = Gen(9);
    let full = g.field(256 * 128);
    let mut h = Hash::new();
    h.add_all(&downsample_box(&full, 256, 128, 64, 32));
    h.add_all(&downsample_box(&full, 256, 128, 100, 50));
    h.add_all(&downsample_max(&full, 256, 128, 64, 32));
    h.add_all(&downsample_max(&full, 256, 128, 100, 50));
    assert_eq!(h.line("field_reductions"), expected("field_reductions"));
}

#[test]
fn the_raster_readers_give_the_typescript_values() {
    for (name, d) in [
        ("torus", Domain::torus(2048.0, 1024.0)),
        ("sphere", Domain::sphere(2048.0, 1024.0)),
    ] {
        let mut g = Gen(10);
        let mut fm = create_field_mesh(&d, 300000.0);
        let sampler = create_field_sampler(&mut fm);
        let mut h = Hash::new();
        for (rx, ry) in [(128, 64), (32, 16)] {
            let raster = g.field(rx * ry);
            h.add_all(&field_from_raster_at_centres(&fm, &raster, rx, ry));
            h.add_all(&field_from_raster_area_weighted(
                &mut fm, &sampler, &raster, rx, ry, None,
            ));
            let owners = raster_owners(&sampler, &mut fm, rx, ry);
            h.add_all(&field_from_raster_area_weighted(
                &mut fm,
                &sampler,
                &raster,
                rx,
                ry,
                Some(&owners),
            ));
            h.add_all(&field_max_from_raster(&fm, &raster, rx, ry, &owners));
        }
        h.add(fm.tri.last_tri as f64);
        h.add(fm.tri.walk_steps as f64);
        let key = format!("{name}_raster_readers");
        assert_eq!(h.line(&key), expected(&key));
    }
}

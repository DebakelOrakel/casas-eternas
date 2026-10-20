//! `climate/climateMesh.ts`: the static climate's field mesh — the domain's
//! width / 256, the ocean age's mesh, which the two share — with its
//! zonal bands, the distance to the sea, the graph's connected parts, the
//! seas along the parallels, and the terrain the climate reads. The
//! TypeScript file explains each.
//!
//! The mesh itself is the caller's `SharedFieldMesh` (the world's, as for
//! the ocean age); a `ClimateMesh` holds what the climate adds to it.
//! Not ported, because it changes the time and nothing else: the cache of
//! the raster's owners across terrains (a terrain keeps its own).

use std::borrow::Cow;
use std::cell::OnceCell;

use crate::core::domain::Domain;
use crate::core::js;
use crate::core::min_heap::MinHeap;
use crate::elevation::elevation_scale::is_land_at;
use crate::fields::field_mesh::{
    FieldMesh, SharedFieldMesh, field_from_raster_area_weighted, field_max_from_raster,
    raster_owners,
};

pub const CLIMATE_MESH_RES_X: f64 = 256.0;

/// The climate's spacing on a domain, metres.
pub fn climate_cell_m(domain: &Domain) -> f64 {
    (domain.width / CLIMATE_MESH_RES_X) * domain.metres_per_unit
}

/// What the climate adds to its field mesh: per cell the row position
/// y / height, and the zonal bands.
#[derive(Clone, Debug)]
pub struct ClimateMesh {
    pub cell_m: f64,
    pub y_norm: Vec<f64>,
    pub bands: usize,
    pub band: Vec<i32>,
}

impl ClimateMesh {
    /// Over `fm`, the world's mesh at `climate_cell_m(domain)`.
    pub fn new(fm: &FieldMesh) -> Self {
        let domain = &fm.domain;
        let cell_units = domain.width / CLIMATE_MESH_RES_X;
        let cell_m = cell_units * domain.metres_per_unit;
        assert!(
            fm.spacing_m == cell_m,
            "the climate's mesh is the world's at width / 256"
        );
        let y_norm: Vec<f64> = (0..fm.count).map(|i| fm.y[i] / domain.height).collect();
        let mut bands = js::max(
            8.0,
            js::round(domain.height / (cell_units * 3f64.sqrt() / 2.0)),
        ) as usize;
        if bands % 2 == 1 {
            bands += 1;
        }
        let band = y_norm
            .iter()
            .map(|&y| js::min((bands - 1) as f64, js::max(0.0, (y * bands as f64).floor())) as i32)
            .collect();
        ClimateMesh {
            cell_m,
            y_norm,
            bands,
            band,
        }
    }
}

/// A field's area-weighted mean along each zonal band over the cells `use_`
/// admits, read back per cell, linear between the bands' centres.
pub fn zonal_mean<T: Copy + Into<f64>>(
    cm: &ClimateMesh,
    fm: &FieldMesh,
    field: &[T],
    use_: Option<&dyn Fn(usize) -> bool>,
) -> Vec<f64> {
    let bands = cm.bands;
    let mut sum = vec![0.0; bands];
    let mut area = vec![0.0; bands];
    for i in 0..fm.count {
        if let Some(u) = use_
            && !u(i)
        {
            continue;
        }
        let b = cm.band[i] as usize;
        sum[b] += fm.area[i] * Into::<f64>::into(field[i]);
        area[b] += fm.area[i];
    }
    let mut mean = vec![0.0; bands];
    let mut any = false;
    for b in 0..bands {
        if area[b] > 0.0 {
            mean[b] = sum[b] / area[b];
            any = true;
        }
    }
    if !any {
        return vec![0.0; fm.count];
    }
    let half = bands as f64 / 2.0;
    for b in 0..bands {
        if area[b] > 0.0 {
            continue;
        }
        for d in 1..bands as i64 {
            let bi = b as i64;
            let toward = if (b as f64) < half { bi + d } else { bi - d };
            let away = if (b as f64) < half { bi - d } else { bi + d };
            if toward >= 0 && toward < bands as i64 && area[toward as usize] > 0.0 {
                mean[b] = mean[toward as usize];
                break;
            }
            if away >= 0 && away < bands as i64 && area[away as usize] > 0.0 {
                mean[b] = mean[away as usize];
                break;
            }
        }
    }
    (0..fm.count)
        .map(|i| {
            let f = cm.y_norm[i] * bands as f64 - 0.5;
            let b0 = f.floor();
            let t = f - b0;
            let lo = js::max(0.0, b0) as usize;
            let hi = js::min((bands - 1) as f64, b0 + 1.0) as usize;
            mean[lo] * (1.0 - t) + mean[hi] * t
        })
        .collect()
}

/// The distance from each cell to the nearest sea cell (land 0), metres
/// along the mesh's links, and that sea cell (−1 where none is reached).
pub fn distance_to_sea(fm: &FieldMesh, land: &[u8]) -> (Vec<f64>, Vec<i32>) {
    let n = fm.count;
    let mut dist = vec![f64::INFINITY; n];
    let mut nearest = vec![-1i32; n];
    let mut heap = MinHeap::new(n);
    for i in 0..n {
        if land[i] != 0 {
            continue;
        }
        dist[i] = 0.0;
        nearest[i] = i as i32;
        heap.push(0.0, i as i32);
    }
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let d = heap.popped_key;
        if d > dist[i] {
            continue;
        }
        for e in fm.edges(i) {
            let j = fm.nbr[e] as usize;
            let next = d + fm.dist[e];
            if next < dist[j] {
                dist[j] = next;
                nearest[j] = nearest[i];
                heap.push(next, j as i32);
            }
        }
    }
    (dist, nearest)
}

/// The connected parts of the cells `mask` admits: per cell its part's id
/// (−1 outside), per part its area (m²) and its cells, ascending. Ids in
/// the order of each part's lowest cell.
pub struct MeshComponents {
    pub label: Vec<i32>,
    pub area: Vec<f64>,
    pub cells: Vec<Vec<u32>>,
}

pub fn mesh_components(fm: &FieldMesh, mask: &[u8]) -> MeshComponents {
    let mut label = vec![-1i32; fm.count];
    let mut areas = Vec::new();
    let mut parts: Vec<Vec<u32>> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for seed in 0..fm.count {
        if mask[seed] == 0 || label[seed] >= 0 {
            continue;
        }
        let id = parts.len() as i32;
        let mut cells = Vec::new();
        let mut area = 0.0;
        label[seed] = id;
        stack.push(seed);
        while let Some(i) = stack.pop() {
            cells.push(i as u32);
            area += fm.area[i];
            for e in fm.edges(i) {
                let j = fm.nbr[e] as usize;
                if mask[j] != 0 && label[j] < 0 {
                    label[j] = id;
                    stack.push(j);
                }
            }
        }
        cells.sort_unstable();
        parts.push(cells);
        areas.push(area);
    }
    MeshComponents {
        label,
        area: areas,
        cells: parts,
    }
}

/// A zonal band's ring of points along its centre parallel (`BasinRing` in
/// TypeScript, which explains each field).
pub struct BasinRing {
    pub y: f64,
    pub count: usize,
    pub point_m: f64,
    pub scale: f64,
    pub cell: Vec<u32>,
    pub land: Vec<u8>,
    pub run_start: Vec<i32>,
    pub run_length: Vec<i32>,
}

/// The seas along the parallels: the rings, and per cell how far east it
/// lies in its basin and the run's length in points and in metres.
pub struct BasinRows {
    pub rings: Vec<BasinRing>,
    pub eastward: Vec<f64>,
    pub run_points: Vec<i32>,
    pub run_m: Vec<f64>,
}

pub fn basin_rows(sh: &mut SharedFieldMesh, terrain: &ClimateTerrain) -> BasinRows {
    let cm = &terrain.cm;
    let domain = &terrain.domain;
    let land = &terrain.land;
    let bands = cm.bands;
    let row_scale = domain.grid(2, bands);
    let around = domain.width * sh.mesh.unit_m;
    let mut rings = Vec::with_capacity(bands);
    for b in 0..bands {
        let y = ((b as f64 + 0.5) / bands as f64) * domain.height;
        let scale = row_scale.row_scale(b as f64);
        let count = js::max(8.0, js::round((around * scale) / cm.cell_m)) as usize;
        let mut cell = vec![0u32; count];
        let mut ring_land = vec![0u8; count];
        for k in 0..count {
            cell[k] = sh.sampler.nearest_cell(
                &mut sh.mesh,
                ((k as f64 + 0.5) / count as f64) * domain.width,
                y,
            ) as u32;
            ring_land[k] = land[cell[k] as usize];
        }
        let mut run_start = vec![-1i32; count];
        let mut run_length = vec![0i32; count];
        for k0 in 0..count {
            if ring_land[k0] == 0 || ring_land[(k0 + 1) % count] != 0 {
                continue;
            }
            let mut len = 0;
            while len < count && ring_land[(k0 + 1 + len) % count] == 0 {
                len += 1;
            }
            for k in 0..len {
                let at = (k0 + 1 + k) % count;
                run_start[at] = ((k0 + 1) % count) as i32;
                run_length[at] = len as i32;
            }
        }
        rings.push(BasinRing {
            y,
            count,
            point_m: (around * scale) / count as f64,
            scale,
            cell,
            land: ring_land,
            run_start,
            run_length,
        });
    }
    let fm = &sh.mesh;
    let mut eastward = vec![0.5; fm.count];
    let mut run_points = vec![0i32; fm.count];
    let mut run_m = vec![0.0; fm.count];
    for i in 0..fm.count {
        let ring = &rings[cm.band[i] as usize];
        let k = js::min(
            (ring.count - 1) as f64,
            js::max(0.0, ((fm.x[i] / domain.width) * ring.count as f64).floor()),
        ) as usize;
        let len = ring.run_length[k];
        if len == 0 {
            continue;
        }
        let along = (k as i64 - ring.run_start[k] as i64 + ring.count as i64) % ring.count as i64;
        eastward[i] = if len > 1 {
            along as f64 / (len - 1) as f64
        } else {
            0.5
        };
        run_points[i] = len;
        run_m[i] = len as f64 * ring.point_m;
    }
    BasinRows {
        rings,
        eastward,
        run_points,
        run_m,
    }
}

/// The terrain the climate reads (`ClimateTerrain` in TypeScript, which
/// explains each field): an elevation raster over the domain, its
/// dry-floor mask, and per cell the point value at the centre.
pub struct ClimateTerrain<'a> {
    pub cm: ClimateMesh,
    pub domain: Domain,
    pub elevation: Cow<'a, [f32]>,
    pub res_x: usize,
    pub res_y: usize,
    pub dry_land: Option<&'a [u8]>,
    pub raster_domain: Domain,
    pub z: Vec<f64>,
    pub land: Vec<u8>,
    pub dry: Vec<u8>,
    kx: f64,
    ky: f64,
    owners: OnceCell<Vec<u32>>,
    mean: OnceCell<Vec<f64>>,
    peak: OnceCell<Vec<f64>>,
}

impl<'a> ClimateTerrain<'a> {
    pub fn new(
        sh: &SharedFieldMesh,
        elevation: &'a [f32],
        res_x: usize,
        res_y: usize,
        dry_land: Option<&'a [u8]>,
    ) -> Self {
        Self::from_cow(sh, Cow::Borrowed(elevation), res_x, res_y, dry_land)
    }

    /// The terrain over a raster it keeps.
    pub fn owned(
        sh: &SharedFieldMesh,
        elevation: Vec<f32>,
        res_x: usize,
        res_y: usize,
    ) -> ClimateTerrain<'static> {
        ClimateTerrain::from_cow(sh, Cow::Owned(elevation), res_x, res_y, None)
    }

    fn from_cow(
        sh: &SharedFieldMesh,
        elevation: Cow<'a, [f32]>,
        res_x: usize,
        res_y: usize,
        dry_land: Option<&'a [u8]>,
    ) -> Self {
        let fm = &sh.mesh;
        let domain = fm.domain.clone();
        let cm = ClimateMesh::new(fm);
        let kx = res_x as f64 / domain.width;
        let ky = res_y as f64 / domain.height;
        let mut z = vec![0.0; fm.count];
        let mut land = vec![0u8; fm.count];
        let mut dry = vec![0u8; fm.count];
        let mut terrain = ClimateTerrain {
            cm,
            raster_domain: if res_x as f64 == domain.width && res_y as f64 == domain.height {
                domain.clone()
            } else {
                domain.scaled_to(res_x as f64, res_y as f64)
            },
            domain,
            elevation,
            res_x,
            res_y,
            dry_land,
            z: Vec::new(),
            land: Vec::new(),
            dry: Vec::new(),
            kx,
            ky,
            owners: OnceCell::new(),
            mean: OnceCell::new(),
            peak: OnceCell::new(),
        };
        for i in 0..fm.count {
            let t = terrain.texel(fm.x[i], fm.y[i]);
            z[i] = terrain.elevation[t] as f64;
            dry[i] = u8::from(dry_land.is_some_and(|d| d[t] == 1));
            land[i] = u8::from(is_land_at(z[i], dry[i] == 1));
        }
        terrain.z = z;
        terrain.land = land;
        terrain.dry = dry;
        terrain
    }

    fn texel(&self, x: f64, y: f64) -> usize {
        let tx = js::min((self.res_x - 1) as f64, js::max(0.0, (x * self.kx).floor())) as usize;
        let ty = js::min((self.res_y - 1) as f64, js::max(0.0, (y * self.ky).floor())) as usize;
        ty * self.res_x + tx
    }

    /// The texel under a point of the domain.
    pub fn elevation_at(&self, x: f64, y: f64) -> f64 {
        self.elevation[self.texel(x, y)] as f64
    }

    fn owners(&self, sh: &mut SharedFieldMesh) -> &[u32] {
        self.owners
            .get_or_init(|| raster_owners(&sh.sampler, &mut sh.mesh, self.res_x, self.res_y))
    }

    /// The mean elevation over each cell, model units.
    pub fn mean_elevation(&self, sh: &mut SharedFieldMesh) -> &[f64] {
        if self.mean.get().is_none() {
            let owners = self.owners(sh).to_vec();
            let mean = field_from_raster_area_weighted(
                &mut sh.mesh,
                &sh.sampler,
                &self.elevation,
                self.res_x,
                self.res_y,
                Some(&owners),
            );
            let _ = self.mean.set(mean);
        }
        self.mean.get().unwrap()
    }

    /// The highest texel in each cell, model units.
    pub fn peak_elevation(&self, sh: &mut SharedFieldMesh) -> &[f64] {
        if self.peak.get().is_none() {
            let owners = self.owners(sh).to_vec();
            let peak =
                field_max_from_raster(&sh.mesh, &self.elevation, self.res_x, self.res_y, &owners);
            let _ = self.peak.set(peak);
        }
        self.peak.get().unwrap()
    }
}

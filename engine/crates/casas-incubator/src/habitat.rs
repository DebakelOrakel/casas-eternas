//! THE INCUBATOR'S HABITAT (2026-10-25, a trial): the world as a living
//! thing sees it, for the plants, the animals (flora.rs) and the people
//! (simulation.rs, settle.rs) alike; and the steps they all take on it — a
//! niche's response (a trapezoid), the origins by landmass, the spread of a
//! range from its origins.
//!
//! THE CELLS (2026-10-26): the generator's field mesh at CELL_SPACING_KM,
//! unrelaxed — an icosahedron's lattice on the sphere, the hexagons on the
//! torus: cells of near one size everywhere, six neighbours each (the
//! sphere's twelve, five) at their true distances, no pole. The world
//! raster this stood on before (2048 × 1024) had cells half as wide at 60°
//! as at the equator, none at the poles, and fronts that ran octagons along
//! its eight neighbours.
//!
//! A cell is made from level 1: it takes the level's nodes under it through
//! the chart's node map (chartWorker.ts, a node per texel at half the
//! chart's size). It is land where most of its texels are; its biome and
//! Köppen class are its centre's (or one of its land's); its height and
//! ecology are the mean over its land; its sea's depth is its shallowest
//! sea texel's — the mean over a cell of 10 km left 1.5 % of Morvane's sea
//! on the shelf and no land bridge (2026-10-26). It holds its rivers too
//! (the ones the chart draws), its lakes and its coast. Its texels are
//! found once (`owners`), and serve the drawing too: a texel shows the cell
//! that owns it.
//!
//! The TypeScript it was ported from computed in doubles and kept what a
//! Float32Array holds as a float: every `as f32` here is such a store,
//! every read of one `as f64` (docs/decisions/incubator-history-engine.md, the way there 2).

use casas_engine::climate::biomes::biome;
use casas_engine::climate::climate_field::{latitude_of_norm, shifted_norm};
use casas_engine::core::det_math::{det_acos, det_cos, det_hypot, det_sin};
use casas_engine::core::domain::Domain;
use casas_engine::core::js;
use casas_engine::core::min_heap::MinHeap;
use casas_engine::core::rng::Mulberry32;
use casas_engine::ecology::ecology_field::{ECOLOGY_FINE_OCEAN, decode_fine_value};
use casas_engine::elevation::elevation_scale::ELEVATION_METERS;
use casas_engine::fields::field_mesh::{create_field_mesh_as, create_field_sampler, raster_owners};
use casas_engine::surface::hydrology::{RIVER_MAX_WIDTH, RIVER_MIN_WIDTH};

pub const CELL_SPACING_KM: f64 = 10.0;
/// `RiverRegime::Ephemeral.code()` (casas-engine surface/river_graph.rs).
pub(crate) const RIVER_EPHEMERAL: u8 = 2;

/// The ecology's fields a cell takes, in this order (the client's
/// historyInput.ts gives them so): the game, the carrying capacity and
/// LEVEL_ECOLOGY (cellsShared.ts).
pub const CELL_ECOLOGY: [&str; 8] = [
    "game",
    "carryingCapacity",
    "arable",
    "pasture",
    "fish",
    "toolStone",
    "salt",
    "copper",
];
pub const GAME: usize = 0;
pub const CARRYING: usize = 1;
pub const ARABLE: usize = 2;
pub const PASTURE: usize = 3;
pub const FISH: usize = 4;
pub const COPPER: usize = 7;

/// What the cells are made from.
pub struct CellInput<'a> {
    pub sphere: bool,
    /// The cells' spacing, km: CELL_SPACING_KM; coarser for a test world.
    pub spacing_km: f64,
    pub width: f64,
    pub height: f64,
    /// The level's node under each texel, `node_w` × `node_h`.
    pub nodes: &'a [i32],
    pub node_w: usize,
    pub node_h: usize,
    pub land: &'a [u8],
    pub biome: &'a [u8],
    pub koppen: &'a [u8],
    pub z: &'a [f32],
    pub lake_depth: &'a [f32],
    /// CELL_ECOLOGY's fields as their fine codes; None for one the level
    /// does not hold.
    pub ecology: [Option<&'a [u8]>; 8],
    /// The rivers in the world raster's texels: [x, y, width] a point, the
    /// points a river, each river's regime.
    pub rivers: Option<(&'a [f32], &'a [u32], &'a [u8])>,
}

pub struct Habitat {
    pub count: usize,
    pub torus: bool,
    // Per cell: on the land (most of it under level 1's land), its area.
    pub land: Vec<u8>,
    pub land_count: usize,
    pub area_km2: Vec<f32>,
    // The land's height and slope (m a m, the mean over its neighbours); the
    // sea's depth, m.
    pub height_m: Vec<f32>,
    pub slope: Vec<f32>,
    pub sea_depth_m: Vec<f32>,
    pub biome: Vec<u8>,
    // The Köppen–Geiger class ids.
    pub koppen: Vec<u8>,
    // A river through the cell (level 1's that hold water some of the year
    // at least), and the size of its biggest: the square root of its
    // discharge over the world's largest, as the ribbon's width is, 0 … 1.
    pub near_river: Vec<u8>,
    pub river_size: Vec<f32>,
    // A lake in the cell or a neighbour; the sea within two rings.
    pub near_lake: Vec<u8>,
    pub near_sea: Vec<u8>,
    // The land's connected pieces: an id a land cell, -1 at sea; their
    // number and areas, km².
    pub landmass: Vec<i32>,
    pub landmasses: usize,
    pub landmass_km2: Vec<f64>,
    /// CELL_ECOLOGY's fields, each the mean over the cell's land.
    pub ecology: [Option<Vec<f32>>; 8],
    // The neighbours, CSR: cell i's are nbr[nbr_start[i] .. nbr_start[i +
    // 1]), dist_km[e] the way to each.
    pub nbr_start: Vec<u32>,
    pub nbr: Vec<u32>,
    pub dist_km: Vec<f32>,
    // Where the cell's centre lies on the chart, as fractions (u across, v
    // down), for the marks and the arrows.
    pub u: Vec<f32>,
    pub v: Vec<f32>,
    // The world's size: the globe's radius, km (0 on the torus), or the
    // torus's width and height, km.
    pub radius_km: f64,
    pub width_km: f64,
    pub height_km: f64,
}

impl Habitat {
    #[inline]
    pub fn edges(&self, i: usize) -> std::ops::Range<usize> {
        self.nbr_start[i] as usize..self.nbr_start[i + 1] as usize
    }

    /// A field's value at a cell; 0 where the level holds no such field
    /// (the TypeScript's `field?.[i] ?? 0`).
    #[inline]
    pub fn eco(&self, field: usize, i: usize) -> f64 {
        self.ecology[field].as_ref().map_or(0.0, |f| f[i] as f64)
    }

    pub fn has(&self, field: usize) -> bool {
        self.ecology[field].is_some()
    }
}

/// The habitat and the texels each cell owns (`owners`, node_w × node_h).
pub fn build_cells(input: &CellInput) -> (Habitat, Vec<i32>) {
    let domain = if input.sphere {
        Domain::sphere(input.width, input.height)
    } else {
        Domain::torus(input.width, input.height)
    };
    let mut fm = create_field_mesh_as(&domain, input.spacing_km * 1000.0, false);
    let sampler = create_field_sampler(&mut fm);
    let n = fm.count;
    let owners: Vec<i32> = raster_owners(&sampler, &mut fm, input.node_w, input.node_h)
        .into_iter()
        .map(|c| c as i32)
        .collect();

    let mut texels = vec![0i32; n];
    let mut land_texels = vec![0i32; n];
    let mut z_land = vec![0f64; n];
    let mut z_sea = vec![f64::NEG_INFINITY; n];
    let mut lake = vec![0u8; n];
    let mut any_land_node = vec![-1i32; n];
    let mut sums: Vec<Vec<f64>> = (0..CELL_ECOLOGY.len()).map(|_| vec![0.0; n]).collect();
    // The texels of each cell, their land and their sums.
    for t in 0..owners.len() {
        let c = owners[t] as usize;
        let v = input.nodes[t] as usize;
        texels[c] += 1;
        if input.land[v] != 0 {
            land_texels[c] += 1;
            z_land[c] += input.z[v] as f64;
            any_land_node[c] = v as i32;
            for (k, codes) in input.ecology.iter().enumerate() {
                if let Some(codes) = codes {
                    let code = codes[v];
                    if code != ECOLOGY_FINE_OCEAN {
                        sums[k][c] += decode_fine_value(code);
                    }
                }
            }
        } else {
            z_sea[c] = js::max(z_sea[c], input.z[v] as f64);
        }
        if input.lake_depth[v] > 0.0 {
            lake[c] = 1;
        }
    }

    // The node at a cell's centre, through the node map.
    let centre_node = |c: usize, fm_x: f64, fm_y: f64| -> usize {
        let px = js::min(
            (input.node_w - 1) as f64,
            (fm_x / domain.width * input.node_w as f64).floor(),
        );
        let py = js::min(
            (input.node_h - 1) as f64,
            js::max(0.0, (fm_y / domain.height * input.node_h as f64).floor()),
        );
        let _ = c;
        let px = ((px as i64 + input.node_w as i64) % input.node_w as i64) as usize;
        input.nodes[py as usize * input.node_w + px] as usize
    };

    let mut land = vec![0u8; n];
    let mut height_m = vec![0f32; n];
    let mut sea_depth_m = vec![0f32; n];
    let mut biome_of = vec![0u8; n];
    let mut koppen = vec![0u8; n];
    let mut area_km2 = vec![0f32; n];
    let mut ecology: [Option<Vec<f32>>; 8] = Default::default();
    for (k, codes) in input.ecology.iter().enumerate() {
        if codes.is_some() {
            ecology[k] = Some(vec![0f32; n]);
        }
    }
    let mut land_count = 0;
    for c in 0..n {
        area_km2[c] = (fm.area[c] / 1e6) as f32;
        let centre = centre_node(c, fm.x[c], fm.y[c]);
        let seen = texels[c] > 0;
        let is_land = if seen {
            2 * land_texels[c] >= texels[c]
        } else {
            input.land[centre] == 1
        };
        if is_land {
            land[c] = 1;
            land_count += 1;
            let node = if input.land[centre] != 0 {
                centre
            } else if any_land_node[c] >= 0 {
                any_land_node[c] as usize
            } else {
                centre
            };
            biome_of[c] = input.biome[node];
            koppen[c] = input.koppen[node];
            let z = if land_texels[c] > 0 {
                z_land[c] / land_texels[c] as f64
            } else {
                input.z[centre] as f64
            };
            height_m[c] = (z * ELEVATION_METERS) as f32;
            for k in 0..CELL_ECOLOGY.len() {
                if let Some(m) = ecology[k].as_mut() {
                    m[c] = if land_texels[c] > 0 {
                        (sums[k][c] / land_texels[c] as f64) as f32
                    } else {
                        0.0
                    };
                }
            }
        } else {
            biome_of[c] = biome::OCEAN;
            let z = if texels[c] > land_texels[c] {
                z_sea[c]
            } else {
                input.z[centre] as f64
            };
            sea_depth_m[c] = (-z * ELEVATION_METERS) as f32;
        }
    }

    let nbr_start = fm.nbr_start.clone();
    let nbr = fm.nbr.clone();
    let dist_km: Vec<f32> = fm.dist.iter().map(|d| (d / 1000.0) as f32).collect();
    let edges = |c: usize| nbr_start[c] as usize..nbr_start[c + 1] as usize;

    // The slope: the mean over the neighbours of the height's fall a metre.
    let mut slope = vec![0f32; n];
    for c in 0..n {
        if land[c] == 0 {
            continue;
        }
        let mut sum = 0.0;
        let mut count = 0;
        for e in edges(c) {
            let u = nbr[e] as usize;
            if land[u] == 0 {
                continue;
            }
            let d = if fm.dist[e] != 0.0 { fm.dist[e] } else { 1.0 };
            sum += (height_m[u] as f64 - height_m[c] as f64).abs() / d;
            count += 1;
        }
        slope[c] = if count > 0 {
            (sum / count as f64) as f32
        } else {
            0.0
        };
    }

    // The rivers: the cells their segments cross, walked a quarter of a
    // world texel at a time; the ephemeral ones left out.
    let mut near_river = vec![0u8; n];
    let mut river_size = vec![0f32; n];
    if let Some((points, lengths, regimes)) = input.rivers {
        let mut start = 0usize;
        for r in 0..lengths.len() {
            let count = lengths[r] as usize;
            if regimes[r] != RIVER_EPHEMERAL {
                for k in start..(start + count).saturating_sub(1) {
                    let ax = points[3 * k] as f64;
                    let ay = points[3 * k + 1] as f64;
                    let bx = points[3 * k + 3] as f64;
                    let by = points[3 * k + 4] as f64;
                    let size = (points[3 * k + 2] as f64 - RIVER_MIN_WIDTH)
                        / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH);
                    let steps = js::max(1.0, (det_hypot(bx - ax, by - ay) / 0.25).ceil()) as usize;
                    for s in 0..=steps {
                        let x = domain.wrap_x(ax + ((bx - ax) * s as f64) / steps as f64);
                        let y = js::min(
                            domain.height - 1e-6,
                            js::max(0.0, ay + ((by - ay) * s as f64) / steps as f64),
                        );
                        let c = sampler.nearest_cell(&mut fm, x, y);
                        if land[c] == 0 {
                            continue;
                        }
                        near_river[c] = 1;
                        river_size[c] = js::max(river_size[c] as f64, size) as f32;
                    }
                }
            }
            start += count;
        }
    }

    // The lakes near, the sea within two rings.
    let mut near_lake = vec![0u8; n];
    let mut near_sea = vec![0u8; n];
    let mut sea_ring = vec![0u8; n];
    for c in 0..n {
        if land[c] == 0 {
            continue;
        }
        let mut lake_near = lake[c];
        for e in edges(c) {
            if lake[nbr[e] as usize] != 0 {
                lake_near = 1;
            }
            if land[nbr[e] as usize] == 0 {
                sea_ring[c] = 1;
            }
        }
        near_lake[c] = lake_near;
    }
    for c in 0..n {
        if land[c] == 0 {
            continue;
        }
        let mut near = sea_ring[c];
        for e in edges(c) {
            if near != 0 {
                break;
            }
            near = sea_ring[nbr[e] as usize];
        }
        near_sea[c] = near;
    }

    let mut landmass = vec![-1i32; n];
    let mut landmasses = 0usize;
    let mut areas: Vec<f64> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for s in 0..n {
        if land[s] == 0 || landmass[s] >= 0 {
            continue;
        }
        landmass[s] = landmasses as i32;
        let mut area = 0.0;
        stack.push(s);
        while let Some(c) = stack.pop() {
            area += area_km2[c] as f64;
            for e in edges(c) {
                let u = nbr[e] as usize;
                if land[u] == 0 || landmass[u] >= 0 {
                    continue;
                }
                landmass[u] = landmasses as i32;
                stack.push(u);
            }
        }
        areas.push(area);
        landmasses += 1;
    }

    let u: Vec<f32> = fm.x.iter().map(|x| (x / domain.width) as f32).collect();
    let v: Vec<f32> = fm.y.iter().map(|y| (y / domain.height) as f32).collect();
    let habitat = Habitat {
        count: n,
        torus: !input.sphere,
        land,
        land_count,
        area_km2,
        height_m,
        slope,
        sea_depth_m,
        biome: biome_of,
        koppen,
        near_river,
        river_size,
        near_lake,
        near_sea,
        landmass,
        landmasses,
        landmass_km2: areas,
        ecology,
        nbr_start,
        nbr,
        dist_km,
        u,
        v,
        radius_km: fm.radius_m / 1000.0,
        width_km: domain.width * fm.unit_m / 1000.0,
        height_km: domain.height * fm.unit_m / 1000.0,
    };
    (habitat, owners)
}

/// The distance between two cells' centres, km: the
/// great circle on the globe, the shorter way round on the torus.
pub fn km_between(h: &Habitat, a: usize, b: usize) -> f64 {
    use std::f64::consts::PI;
    if h.radius_km > 0.0 {
        let lon_a = h.u[a] as f64 * 2.0 * PI;
        let lon_b = h.u[b] as f64 * 2.0 * PI;
        let lat_a = (0.5 - h.v[a] as f64) * PI;
        let lat_b = (0.5 - h.v[b] as f64) * PI;
        let c = det_sin(lat_a) * det_sin(lat_b)
            + det_cos(lat_a) * det_cos(lat_b) * det_cos(lon_a - lon_b);
        return h.radius_km * det_acos(js::min(1.0, js::max(-1.0, c)));
    }
    let mut du = (h.u[a] as f64 - h.u[b] as f64).abs();
    let mut dv = (h.v[a] as f64 - h.v[b] as f64).abs();
    du = js::min(du, 1.0 - du);
    dv = js::min(dv, 1.0 - dv);
    det_hypot(du * h.width_km, dv * h.height_km)
}

/// A cell's latitude, degrees from the equator (0 … 90), as the climate
/// has it (climate_field.rs `latitude_of_norm`): on the globe from its
/// row; on the torus from its row about the thermal equator, which sits
/// at the map's middle since 2026-09-26 (world/runParams.ts
/// equatorOffset 0), so in the same way.
pub fn latitude_deg(h: &Habitat, i: usize) -> f64 {
    latitude_of_norm(shifted_norm(h.v[i] as f64, 0.0)) * 90.0
}

/// A trapezoid [a, b, c, d]: 0 below a, up to 1 at b, 1 to c, down to 0 at
/// d.
pub type Trapezoid = [f64; 4];

pub fn trapezoid(v: f64, t: &Trapezoid) -> f64 {
    if v <= t[0] || v >= t[3] {
        return 0.0;
    }
    if v < t[1] {
        return (v - t[0]) / (t[1] - t[0]);
    }
    if v > t[2] {
        return (t[3] - v) / (t[3] - t[2]);
    }
    1.0
}

/// FNV-1a over a text's UTF-16 units.
pub use casas_engine::core::rng::hash_seed_string as hash_text;

/// One origin on each landmass the niche suits somewhere, with its
/// `chance`: drawn there by the niche to
/// the fourth.
pub fn draw_origins_by_landmass(
    h: &Habitat,
    best: &[f32],
    chance: impl Fn(usize) -> f64,
    suitable: f64,
    random: &mut Mulberry32,
) -> Vec<usize> {
    let sq2 = |x: f64| x * x;
    let mut total = vec![0f64; h.landmasses];
    for i in 0..best.len() {
        if best[i] as f64 >= suitable && h.landmass[i] >= 0 {
            total[h.landmass[i] as usize] += sq2(sq2(best[i] as f64));
        }
    }
    let mut pick = vec![-1f64; h.landmasses];
    for m in 0..h.landmasses {
        // Both draws for every landmass, so one landmass's draw does not
        // depend on which others the niche suits.
        let take = random.next() < chance(m);
        let at = random.next();
        if take && total[m] > 0.0 {
            pick[m] = at * total[m];
        }
    }
    let mut origins = Vec::new();
    for i in 0..best.len() {
        if (best[i] as f64) < suitable || h.landmass[i] < 0 {
            continue;
        }
        let m = h.landmass[i] as usize;
        if pick[m] < 0.0 {
            continue;
        }
        pick[m] -= sq2(sq2(best[i] as f64));
        if pick[m] > 0.0 {
            continue;
        }
        origins.push(i);
        pick[m] = -1.0;
    }
    origins
}

pub struct SpreadOptions {
    // A cell is suitable from this niche on.
    pub suitable: f64,
    // The cost of a kilometre through land the niche does not suit, over one
    // through it.
    pub barrier: f64,
    // How far a range spreads, kilometres through the niche.
    pub max_km: f64,
    // Only through suitable cells (the salmon up its rivers).
    pub only_suitable: bool,
}

/// A range: what the cheapest ways from the starts reach within the budget,
/// over land only — the sea is not crossed.
pub fn spread_range(h: &Habitat, best: &[f32], starts: &[usize], o: &SpreadOptions) -> Vec<u8> {
    let mut range = vec![0u8; h.count];
    let mut cost = vec![f64::INFINITY; h.count];
    let mut heap = MinHeap::new(1 << 16);
    for &i in starts {
        cost[i] = 0.0;
        heap.push(0.0, i as i32);
    }
    while !heap.is_empty() {
        heap.pop();
        let i = heap.popped_index as usize;
        let c = heap.popped_key;
        if c > cost[i] {
            continue;
        }
        range[i] = 1;
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            if h.land[u] == 0 {
                continue;
            }
            if o.only_suitable && (best[u] as f64) < o.suitable {
                continue;
            }
            let fit = js::min(1.0, best[u] as f64 / o.suitable);
            let next = c + h.dist_km[e] as f64 * (1.0 + (o.barrier - 1.0) * (1.0 - fit));
            if next >= cost[u] || next > o.max_km {
                continue;
            }
            cost[u] = next;
            heap.push(next, u as i32);
        }
    }
    range
}

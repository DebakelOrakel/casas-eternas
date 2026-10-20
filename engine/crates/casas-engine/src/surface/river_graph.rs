//! `surface/riverGraph.ts`: the feature graph — rivers as reaches between
//! nodes over the flow substrate, their Strahler order and regime, the
//! ribbons the map draws from them, and the graph's invariants. The
//! TypeScript file explains each rule. Not ported: the graph's serialised
//! form, which is the world layer's.

use crate::core::det_math::det_hypot;
use crate::core::domain::Domain;
use crate::core::js;
use crate::elevation::elevation_scale::{SEA_LEVEL, elevation_to_meters};

use super::flow_substrate::FlowSubstrate;
use super::hydrogeology::SpringFeature;
use super::hydrology::{
    RIVER_MAX_WIDTH, RIVER_MIN_WIDTH, RIVER_REGIME_EPHEMERAL, RIVER_REGIME_INTERMITTENT,
    RIVER_REGIME_PERENNIAL, RegimeInputs, WaterBody, WaterKind, build_channel_mask_on,
};
use super::river_course::RiverCourse;
use super::surface_tune_params::SURFACE_TUNING;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiverNodeKind {
    Source,
    Junction,
    Mouth,
    Inlet,
    Outlet,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RiverNode {
    pub id: usize,
    pub kind: RiverNodeKind,
    pub cell: usize,
    pub x: f64,
    pub y: f64,
    /// The water body a mouth (-1: the sea), inlet or outlet belongs to.
    pub body: i32,
    pub catchment_cells: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiverReachKind {
    River,
    Lake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiverRegime {
    Perennial,
    Intermittent,
    Ephemeral,
}

impl RiverRegime {
    /// The code the ribbons carry (`RIVER_REGIME_CODE`).
    pub fn code(self) -> u8 {
        match self {
            RiverRegime::Perennial => RIVER_REGIME_PERENNIAL,
            RiverRegime::Intermittent => RIVER_REGIME_INTERMITTENT,
            RiverRegime::Ephemeral => RIVER_REGIME_EPHEMERAL,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RiverReach {
    pub id: usize,
    pub kind: RiverReachKind,
    pub from: usize,
    pub to: usize,
    pub cell_start: usize,
    pub cell_count: usize,
    pub discharge_in: f64,
    pub discharge_out: f64,
    pub width_px: f64,
    pub length_km: f64,
    pub drop_m: f64,
    pub slope: f64,
    pub sediment_m3: f64,
    /// The most common biome id along the reach's own cells, -1 for none.
    pub bank: i32,
    pub order: i32,
    pub regime: RiverRegime,
    pub runoff_out: f64,
    pub spring_fed: bool,
}

/// The feature graph. Its substrate is always the mesh's.
#[derive(Clone, Debug)]
pub struct RiverGraph {
    pub width: f64,
    pub height: f64,
    pub nodes: Vec<RiverNode>,
    pub reaches: Vec<RiverReach>,
    pub cells: Vec<i32>,
    pub cell_x: Vec<f32>,
    pub cell_y: Vec<f32>,
    pub bodies: Vec<WaterBody>,
    pub courses: Option<Vec<RiverCourse>>,
    pub springs: Option<Vec<SpringFeature>>,
}

pub struct RiverGraphInputs<'a, S: FlowSubstrate> {
    pub substrate: &'a S,
    pub discharge: &'a [f32],
    pub elevation: &'a [f32],
    pub threshold: f64,
    pub max_discharge: f64,
    pub bodies: &'a [WaterBody],
    pub body: &'a [i32],
    pub lake_depth: &'a [f32],
    pub sediment_flux: Option<&'a [f32]>,
    pub biomes: Option<&'a [u8]>,
    pub regime: Option<&'a RegimeInputs>,
    pub critical_area: Option<f64>,
}

/// The ribbons the map draws: points [x, y, width] per point, the points
/// per line, a regime code per line.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RiverPolylines {
    pub points: Vec<f32>,
    pub lengths: Vec<u32>,
    pub regimes: Vec<u8>,
}

/// The regime rule: the whole catchment arid → ephemeral, the dry season
/// alone too dry → intermittent.
pub fn classify_regime(discharge: f64, loss: f64, dry: f64) -> RiverRegime {
    if loss <= 0.0 {
        return RiverRegime::Perennial;
    }
    if discharge / loss < SURFACE_TUNING.regime_arid_below {
        return RiverRegime::Ephemeral;
    }
    if dry / loss < SURFACE_TUNING.regime_dry_season_below {
        return RiverRegime::Intermittent;
    }
    RiverRegime::Perennial
}

fn river_width(discharge: f64, max_discharge: f64) -> f64 {
    let scale = if max_discharge > 0.0 {
        max_discharge
    } else {
        1.0
    };
    js::min(
        RIVER_MAX_WIDTH,
        RIVER_MIN_WIDTH + (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH) * (discharge / scale).sqrt(),
    )
}

pub fn build_river_graph<S: FlowSubstrate>(input: &RiverGraphInputs<'_, S>) -> RiverGraph {
    let discharge = input.discharge;
    let elevation = input.elevation;
    let bodies = input.bodies;
    let body = input.body;
    let lake_depth = input.lake_depth;
    let sub = input.substrate;
    let domain = sub.domain();
    let (width, height) = (domain.width, domain.height);
    let flow_target = sub.flow_target();
    let pop_order = sub.pop_order();
    let popped = sub.popped_count();
    let n = sub.count();
    let cell_km = domain.metres_around / width / 1000.0;
    let land = |c: usize| elevation[c] as f64 > SEA_LEVEL;
    let mut channel = build_channel_mask_on(sub, elevation, discharge, input.threshold);
    // Catchment sizes in cells, every land element's.
    let mut area = vec![0f32; n];
    for (c, a) in area.iter_mut().enumerate() {
        if land(c) {
            *a = sub.area(c) as f32;
        }
    }
    for i in (0..popped).rev() {
        let c = pop_order[i] as usize;
        let t = flow_target[c];
        if t >= 0 && land(c) {
            area[t as usize] = (area[t as usize] as f64 + area[c] as f64) as f32;
        }
    }
    // Wadis.
    if let (Some(regime), Some(critical)) = (input.regime, input.critical_area) {
        let loss = &regime.loss;
        for c in 0..n {
            if channel[c] != 0 || !land(c) || (area[c] as f64) < critical {
                continue;
            }
            if loss[c] > 0.0
                && (discharge[c] as f64 / loss[c] as f64) < SURFACE_TUNING.regime_arid_below
            {
                channel[c] = 1;
            }
        }
        for i in (0..popped).rev() {
            let c = pop_order[i] as usize;
            if channel[c] == 0 {
                continue;
            }
            let t = flow_target[c];
            if t >= 0 && land(t as usize) {
                channel[t as usize] = 1;
            }
        }
    }
    // No channel inside a terminal basin.
    for c in 0..n {
        if channel[c] != 0
            && body[c] >= 0
            && let Some(b) = bodies.get(body[c] as usize)
            && b.kind != WaterKind::Lake
        {
            channel[c] = 0;
        }
    }
    let is_lake = |c: usize| lake_depth[c] > 0.0 && body[c] >= 0;

    // In-degree among channel cells.
    let mut in_deg = vec![0u8; n];
    for c in 0..n {
        if channel[c] == 0 {
            continue;
        }
        let t = flow_target[c];
        if t >= 0 && channel[t as usize] != 0 && in_deg[t as usize] < 255 {
            in_deg[t as usize] += 1;
        }
    }

    // Node cells.
    let mut node_at = vec![-1i32; n];
    let mut nodes: Vec<RiverNode> = Vec::new();
    let add_node = |nodes: &mut Vec<RiverNode>,
                    node_at: &mut [i32],
                    cell: usize,
                    kind: RiverNodeKind,
                    body_id: i32|
     -> usize {
        if node_at[cell] >= 0 {
            return node_at[cell] as usize;
        }
        let id = nodes.len();
        let catchment = if matches!(kind, RiverNodeKind::Mouth | RiverNodeKind::Inlet) {
            area[cell] as f64
        } else {
            0.0
        };
        nodes.push(RiverNode {
            id,
            kind,
            cell,
            x: sub.x(cell),
            y: sub.y(cell),
            body: body_id,
            catchment_cells: catchment,
        });
        node_at[cell] = id as i32;
        id
    };
    for c in 0..n {
        if channel[c] == 0 {
            continue;
        }
        let t = flow_target[c];
        let lake_here = is_lake(c);
        if in_deg[c] == 0 && !lake_here {
            add_node(&mut nodes, &mut node_at, c, RiverNodeKind::Source, -1);
        } else if in_deg[c] >= 2 {
            add_node(
                &mut nodes,
                &mut node_at,
                c,
                RiverNodeKind::Junction,
                if lake_here { body[c] } else { -1 },
            );
        }
        if t < 0 {
            add_node(&mut nodes, &mut node_at, c, RiverNodeKind::Mouth, -1);
            continue;
        }
        let t = t as usize;
        let lake_next = is_lake(t);
        if !lake_here && lake_next {
            add_node(&mut nodes, &mut node_at, t, RiverNodeKind::Inlet, body[t]);
        } else if lake_here && !lake_next && channel[t] != 0 {
            add_node(&mut nodes, &mut node_at, c, RiverNodeKind::Outlet, body[c]);
        } else if channel[t] == 0 || !land(t) {
            add_node(&mut nodes, &mut node_at, t, RiverNodeKind::Mouth, body[t]);
        }
    }
    for c in 0..n {
        if channel[c] != 0 && in_deg[c] == 0 {
            add_node(&mut nodes, &mut node_at, c, RiverNodeKind::Source, body[c]);
        }
    }

    // Reaches. The nodes a walk adds are walked too, as `for … of` visits
    // what is pushed during the loop.
    let mut reaches: Vec<RiverReach> = Vec::new();
    let mut cells_out: Vec<i32> = Vec::new();
    let mut ni = 0;
    while ni < nodes.len() {
        let node_id = nodes[ni].id;
        let start = nodes[ni].cell;
        ni += 1;
        if channel[start] == 0 {
            continue;
        }
        let t0 = flow_target[start];
        if (t0 < 0 || channel[t0 as usize] == 0) && (t0 < 0 || node_at[t0 as usize] < 0) {
            continue;
        }
        let cell_start = cells_out.len();
        cells_out.push(start as i32);
        let mut cur = start;
        let mut length_km = 0.0;
        let mut guard = 0;
        loop {
            let t = flow_target[cur];
            if t < 0 {
                break;
            }
            let t = t as usize;
            length_km += sub.step(cur, t) * cell_km;
            cells_out.push(t as i32);
            cur = t;
            if node_at[t] >= 0 {
                break;
            }
            guard += 1;
            if guard > n {
                panic!("river graph: a reach does not terminate");
            }
        }
        let cell_count = cells_out.len() - cell_start;
        if cell_count < 2 {
            cells_out.truncate(cell_start);
            continue;
        }
        let to = if node_at[cur] >= 0 {
            node_at[cur] as usize
        } else {
            add_node(&mut nodes, &mut node_at, cur, RiverNodeKind::Mouth, -1)
        };
        let last_own = cells_out[cells_out.len() - 2] as usize;
        let discharge_out = discharge[last_own] as f64;
        let drop_m = elevation_to_meters(elevation[start] as f64)
            - elevation_to_meters(elevation[last_own] as f64);
        let mut bank = -1;
        if let Some(biomes) = input.biomes {
            let mut counts = [0u32; 256];
            let mut best = -1i32;
            let mut best_count = 0;
            for &cell in &cells_out[cell_start..cells_out.len() - 1] {
                let b = biomes[cell as usize];
                counts[b as usize] += 1;
                let count = counts[b as usize];
                if count > best_count || (count == best_count && (b as i32) < best) {
                    best_count = count;
                    best = b as i32;
                }
            }
            bank = best;
        }
        reaches.push(RiverReach {
            id: reaches.len(),
            kind: if is_lake(start) {
                RiverReachKind::Lake
            } else {
                RiverReachKind::River
            },
            from: node_id,
            to,
            cell_start,
            cell_count,
            discharge_in: discharge[start] as f64,
            discharge_out,
            width_px: river_width(discharge_out, input.max_discharge),
            length_km,
            drop_m,
            slope: if length_km > 0.0 {
                drop_m / (length_km * 1000.0)
            } else {
                0.0
            },
            sediment_m3: input.sediment_flux.map_or(0.0, |s| s[last_own] as f64),
            bank,
            order: 0,
            regime: input.regime.map_or(RiverRegime::Perennial, |r| {
                classify_regime(
                    discharge_out,
                    r.loss[last_own] as f64,
                    r.dry[last_own] as f64,
                )
            }),
            runoff_out: 0.0,
            spring_fed: false,
        });
    }

    // Strahler order over the reach DAG, tributaries first.
    let mut starting_at = vec![-1i32; nodes.len()];
    let mut pending = vec![0i32; reaches.len()];
    let mut best = vec![0i32; reaches.len()];
    let mut best_count = vec![0i32; reaches.len()];
    for r in &reaches {
        starting_at[r.from] = r.id as i32;
    }
    for r in &reaches {
        let next = starting_at[r.to];
        if next >= 0 {
            pending[next as usize] += 1;
        }
    }
    let mut queue: Vec<usize> = reaches
        .iter()
        .filter(|r| pending[r.id] == 0)
        .map(|r| r.id)
        .collect();
    let mut head = 0;
    while head < queue.len() {
        let id = queue[head];
        head += 1;
        let order = if best[id] == 0 {
            1
        } else if best_count[id] >= 2 {
            best[id] + 1
        } else {
            best[id]
        };
        reaches[id].order = order;
        let next = starting_at[reaches[id].to];
        if next < 0 {
            continue;
        }
        let next = next as usize;
        if order > best[next] {
            best[next] = order;
            best_count[next] = 1;
        } else if order == best[next] {
            best_count[next] += 1;
        }
        pending[next] -= 1;
        if pending[next] == 0 {
            queue.push(next);
        }
    }

    let cells = cells_out;
    let mut cell_x: Vec<f32> = cells.iter().map(|&c| sub.x(c as usize) as f32).collect();
    let mut cell_y: Vec<f32> = cells.iter().map(|&c| sub.y(c as usize) as f32).collect();
    // A reach into the sea ends where its last step crosses sea level.
    for r in &reaches {
        if r.cell_count < 2 {
            continue;
        }
        let last = r.cell_start + r.cell_count - 1;
        let z_land = elevation[cells[last - 1] as usize] as f64;
        let z_sea = elevation[cells[last] as usize] as f64;
        if !(z_land > SEA_LEVEL && z_sea <= SEA_LEVEL) {
            continue;
        }
        let f = (z_land - SEA_LEVEL) / (z_land - z_sea);
        let step = domain.delta(
            cell_x[last] as f64,
            cell_y[last] as f64,
            cell_x[last - 1] as f64,
            cell_y[last - 1] as f64,
        );
        let at = domain.advance(
            cell_x[last - 1] as f64,
            cell_y[last - 1] as f64,
            f * step.x,
            f * step.y,
        );
        cell_x[last] = at.x as f32;
        cell_y[last] = at.y as f32;
    }
    RiverGraph {
        width,
        height,
        nodes,
        reaches,
        cells,
        cell_x,
        cell_y,
        bodies: bodies.to_vec(),
        courses: None,
        springs: None,
    }
}

/// A jump across the torus seam, or a turn over a pole, between two
/// consecutive line points.
fn seam_step(ax: f64, ay: f64, bx: f64, by: f64, width: f64, height: f64) -> bool {
    (bx - ax).abs() > width / 2.0 || (by - ay).abs() > height / 2.0 || (bx - ax).abs() > width / 4.0
}

/// The longest piece of a river step in the chart where the chart
/// stretches it, texels.
const RIVER_CHART_STEP: f64 = 2.0;

struct Ribbons<'a> {
    width: f64,
    height: f64,
    domain: Option<&'a Domain>,
    points: Vec<f64>,
    lengths: Vec<u32>,
    regimes: Vec<u8>,
    regime: u8,
    len: usize,
    prev_x: f64,
    prev_y: f64,
    prev_w: f64,
}

impl Ribbons<'_> {
    fn flush(&mut self) {
        if self.len >= 2 {
            self.lengths.push(self.len as u32);
            self.regimes.push(self.regime);
        } else {
            self.points.truncate(self.points.len() - self.len * 3);
        }
        self.len = 0;
    }

    fn emit_point(&mut self, x: f64, y: f64, w: f64) {
        if self.prev_x >= 0.0 && seam_step(self.prev_x, self.prev_y, x, y, self.width, self.height)
        {
            self.flush();
        }
        self.points.extend_from_slice(&[x, y, w]);
        self.prev_x = x;
        self.prev_y = y;
        self.prev_w = w;
        self.len += 1;
    }

    fn stretched(&self, ax: f64, ay: f64, bx: f64, by: f64) -> bool {
        let mut cx = (bx - ax).abs();
        if cx > self.width / 2.0 {
            cx = self.width - cx;
        }
        let mut cy = (by - ay).abs();
        if cy > self.height / 2.0 {
            cy = self.height - cy;
        }
        let chart = det_hypot(cx, cy);
        match self.domain {
            Some(d) => {
                chart > RIVER_CHART_STEP && chart > 1.01 * d.distance_sq(ax, ay, bx, by).sqrt()
            }
            None => false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_piece(&mut self, ax: f64, ay: f64, aw: f64, bx: f64, by: f64, bw: f64, depth: u32) {
        if let Some(domain) = self.domain
            && depth < 12
            && self.stretched(ax, ay, bx, by)
        {
            let offset = domain.delta(bx, by, ax, ay);
            let piece = domain.advance(ax, ay, offset.x / 2.0, offset.y / 2.0);
            let my = piece.y;
            let mx = if my < 1e-6 || my > self.height - 1e-6 {
                ax
            } else {
                piece.x
            };
            let mw = (aw + bw) / 2.0;
            self.emit_piece(ax, ay, aw, mx, my, mw, depth + 1);
            self.emit_piece(mx, my, mw, bx, by, bw, depth + 1);
            return;
        }
        self.emit_point(bx, by, bw);
    }

    fn emit_xy(&mut self, x: f64, y: f64, w: f64) {
        if self.domain.is_some() && self.prev_x >= 0.0 {
            self.emit_piece(self.prev_x, self.prev_y, self.prev_w, x, y, w, 0);
        } else {
            self.emit_point(x, y, w);
        }
    }

    fn emit_line(&mut self, line: &[f32], w_in: f64, w_out: f64) {
        let count = line.len() / 2;
        for k in 0..count {
            let t = if count > 1 {
                k as f64 / (count - 1) as f64
            } else {
                1.0
            };
            self.emit_xy(
                line[k * 2] as f64,
                line[k * 2 + 1] as f64,
                w_in + (w_out - w_in) * t,
            );
        }
    }
}

/// The ribbons the map draws, from the graph: chains of reaches along the
/// main stem, cut at the seam and where the regime changes; `domain` cuts
/// a step the chart stretches along the great circle.
pub fn river_polylines_from_graph(
    graph: &RiverGraph,
    max_discharge: f64,
    domain: Option<&Domain>,
) -> RiverPolylines {
    let nodes = &graph.nodes;
    let reaches = &graph.reaches;
    let cells = &graph.cells;
    let mut rb = Ribbons {
        width: graph.width,
        height: graph.height,
        domain,
        points: Vec::new(),
        lengths: Vec::new(),
        regimes: Vec::new(),
        regime: RIVER_REGIME_PERENNIAL,
        len: 0,
        prev_x: -1.0,
        prev_y: -1.0,
        prev_w: 0.0,
    };
    // The course of a reach; a later course of the same reach wins, as
    // in a Map.
    let mut course_of: Vec<Option<&RiverCourse>> = vec![None; reaches.len()];
    for c in graph.courses.iter().flatten() {
        if c.reach < course_of.len() {
            course_of[c.reach] = Some(c);
        }
    }
    let mut continues = vec![-1i32; nodes.len()];
    let mut largest_in = vec![-1.0f64; nodes.len()];
    let mut out_of = vec![-1i32; nodes.len()];
    for r in reaches {
        if out_of[r.from] < 0 {
            out_of[r.from] = r.id as i32;
        }
        if r.discharge_out > largest_in[r.to] {
            largest_in[r.to] = r.discharge_out;
            continues[r.to] = r.id as i32;
        }
    }
    let mut drawn = vec![false; reaches.len()];
    struct Extra<'a> {
        line: &'a [f32],
        w: f64,
        regime: u8,
    }
    let mut extras: Vec<Extra<'_>> = Vec::new();
    for head in reaches {
        if drawn[head.id] {
            continue;
        }
        let c = continues[head.from];
        if c >= 0 && !drawn[c as usize] {
            continue;
        }
        let mut r = Some(head);
        let mut prev_cell = -1i32;
        rb.prev_x = -1.0;
        rb.prev_y = -1.0;
        while let Some(reach) = r {
            if drawn[reach.id] {
                break;
            }
            drawn[reach.id] = true;
            let code = reach.regime.code();
            if code != rb.regime {
                rb.flush();
                prev_cell = -1;
                rb.regime = code;
            }
            let w_in = river_width(reach.discharge_in, max_discharge);
            let w_out = river_width(reach.discharge_out, max_discharge);
            match course_of[reach.id] {
                Some(course) if !course.lines.is_empty() => {
                    let lw = course.line_width[0];
                    rb.emit_line(&course.lines[0], w_in * lw, w_out * lw);
                    for i in 1..course.lines.len() {
                        extras.push(Extra {
                            line: &course.lines[i],
                            w: river_width(
                                reach.discharge_out * course.line_width[i] * course.line_width[i],
                                max_discharge,
                            ),
                            regime: code,
                        });
                    }
                    for o in &course.oxbows {
                        extras.push(Extra {
                            line: o,
                            w: RIVER_MIN_WIDTH,
                            regime: code,
                        });
                    }
                    prev_cell = cells[reach.cell_start + reach.cell_count - 1];
                }
                _ => {
                    for k in 0..reach.cell_count {
                        let cell = cells[reach.cell_start + k];
                        if prev_cell == cell {
                            continue;
                        }
                        let cx = graph.cell_x[reach.cell_start + k] as f64;
                        let cy = graph.cell_y[reach.cell_start + k] as f64;
                        let t = if reach.cell_count > 1 {
                            k as f64 / (reach.cell_count - 1) as f64
                        } else {
                            1.0
                        };
                        rb.emit_xy(cx, cy, w_in + (w_out - w_in) * t);
                        prev_cell = cell;
                    }
                }
            }
            let next = if continues[reach.to] == reach.id as i32 {
                out_of[reach.to]
            } else {
                -1
            };
            r = (next >= 0).then(|| &reaches[next as usize]);
        }
        rb.flush();
    }
    for extra in extras {
        rb.prev_x = -1.0;
        rb.prev_y = -1.0;
        rb.regime = extra.regime;
        rb.emit_line(extra.line, extra.w, extra.w);
        rb.flush();
    }
    RiverPolylines {
        points: rb.points.iter().map(|&v| v as f32).collect(),
        lengths: rb.lengths,
        regimes: rb.regimes,
    }
}

/// The invariants every graph holds: check name and violations, in the
/// TypeScript order.
pub fn river_graph_invariants(graph: &RiverGraph, elevation: &[f32]) -> Vec<(&'static str, usize)> {
    let (nodes, reaches) = (&graph.nodes, &graph.reaches);
    let (mut acyclic, mut monotone, mut mouths, mut terminate, mut known, mut contiguous) =
        (0, 0, 0, 0, 0, 0);
    let mut out_of: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for r in reaches {
        out_of[r.from].push(r.id);
    }
    for r in reaches {
        let mut seen = std::collections::HashSet::from([r.id]);
        let mut cur = r;
        let mut steps = 0;
        while let Some(&next) = out_of[cur.to].first() {
            let n2 = &reaches[next];
            if !seen.insert(n2.id) {
                acyclic += 1;
                break;
            }
            cur = n2;
            steps += 1;
            if steps > reaches.len() {
                terminate += 1;
                break;
            }
        }
    }
    for r in reaches {
        if r.discharge_out + 1e-6 < r.discharge_in {
            monotone += 1;
        }
        if let Some(&next) = out_of[r.to].first()
            && reaches[next].discharge_in + 1e-6 < r.discharge_out
        {
            monotone += 1;
        }
    }
    for node in nodes {
        if node.kind == RiverNodeKind::Mouth
            && node.body == -1
            && elevation[node.cell] as f64 > SEA_LEVEL
            && !out_of[node.id].is_empty()
        {
            mouths += 1;
        }
        if matches!(node.kind, RiverNodeKind::Inlet | RiverNodeKind::Outlet)
            && (node.body < 0 || node.body as usize >= graph.bodies.len())
        {
            known += 1;
        }
    }
    let mut expected = 0;
    for r in reaches {
        if r.cell_start != expected || r.cell_count < 2 {
            contiguous += 1;
        }
        expected = r.cell_start + r.cell_count;
    }
    if expected != graph.cells.len() {
        contiguous += 1;
    }
    vec![
        ("acyclic", acyclic),
        ("dischargeMonotone", monotone),
        ("mouthsInWater", mouths),
        ("reachesTerminate", terminate),
        ("bodiesKnown", known),
        ("cellsContiguous", contiguous),
        ("regimeKnown", 0),
    ]
}

//! The tile levels' graph — which tiles a refine plan computes below level
//! 1, and what each waits for: its parents and the tiles of its own level
//! whose water enters it, the flow edges cut acyclic from level 1's
//! drainage. The TypeScript port
//! (`client/src/generator/pipeline/tilePlan.ts`, git history) explains the
//! rules. The keys are TypeScript's strings, so every tie and every sort
//! falls as there.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::core::domain::Domain;
use crate::elevation::elevation_scale::SEA_LEVEL;
use crate::mesh::mesh_erosion::MeshRouting;
use crate::mesh::mesh_tile::{TileId, tile_spec};
use crate::mesh::periodic_delaunay::PeriodicTriangulation;
use crate::mesh::tile_layout::{parent_tiles_on, tile_at_on};

#[derive(Clone, Debug, PartialEq)]
pub struct PlannedTile {
    pub tile: TileId,
    pub parents: Vec<TileId>,
    pub upstream: Vec<TileId>,
}

pub struct TilePlanInput<'a> {
    pub mesh: &'a PeriodicTriangulation,
    pub z: &'a [f32],
    pub routing: &'a MeshRouting,
    pub width: usize,
    pub height: usize,
    /// The tile levels, coarse to fine.
    pub levels: &'a [u32],
    /// A level's tiles with land or shelf.
    pub land_tiles: &'a dyn Fn(u32) -> Vec<TileId>,
}

fn key_of(t: &TileId) -> String {
    format!("{}:{},{}", t.level, t.x, t.y)
}

/// The tile of `level` that holds a world point.
pub fn tile_at(level: u32, x: f64, y: f64, world: &Domain) -> TileId {
    tile_at_on(level, x, y, world)
}

pub fn plan_tiles(input: &TilePlanInput<'_>) -> Vec<PlannedTile> {
    let world = &input.mesh.domain;
    let levels = input.levels;
    let mut sets: HashMap<u32, BTreeMap<String, TileId>> = HashMap::new();
    for i in (0..levels.len()).rev() {
        let level = levels[i];
        let mut set: BTreeMap<String, TileId> = BTreeMap::new();
        for t in (input.land_tiles)(level) {
            set.insert(key_of(&t), t);
        }
        if let Some(finer) = levels.get(i + 1).and_then(|l| sets.get(l)) {
            for t in finer.values() {
                for p in parent_tiles_on(t, tile_spec(level), world) {
                    set.insert(key_of(&p), p);
                }
            }
        }
        sets.insert(level, set);
    }
    let mut out = Vec::new();
    for (i, &level) in levels.iter().enumerate() {
        let set = &sets[&level];
        let upstream = flow_edges(input.mesh, input.z, input.routing, world, level, set);
        let above = (i > 0).then(|| tile_spec(levels[i - 1]));
        let mut tiles: Vec<TileId> = set.values().copied().collect();
        tiles.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)));
        for tile in tiles {
            out.push(PlannedTile {
                tile,
                parents: above.map_or_else(Vec::new, |a| parent_tiles_on(&tile, a, world)),
                upstream: upstream
                    .get(&key_of(&tile))
                    .map_or_else(Vec::new, |list| list.iter().map(|k| set[k]).collect()),
            });
        }
    }
    out
}

struct Edge {
    from: String,
    to: String,
    water: f64,
}

/// A level's flow edges, acyclic: for each tile the tiles whose water
/// enters it, sorted.
fn flow_edges(
    mesh: &PeriodicTriangulation,
    z: &[f32],
    routing: &MeshRouting,
    world: &Domain,
    level: u32,
    set: &BTreeMap<String, TileId>,
) -> HashMap<String, Vec<String>> {
    let mut crossing: BTreeMap<(String, String), f64> = BTreeMap::new();
    let mut tile_key: HashMap<usize, String> = HashMap::new();
    let mut key_at = |v: usize| -> String {
        tile_key
            .entry(v)
            .or_insert_with(|| key_of(&tile_at(level, mesh.vx[v], mesh.vy[v], world)))
            .clone()
    };
    for v in 0..mesh.vertex_slots() {
        if mesh.v_alive[v] == 0 || z[v] as f64 <= SEA_LEVEL {
            continue;
        }
        let t = routing.flow_target[v];
        if t < 0 {
            continue;
        }
        let a = key_at(v);
        let b = key_at(t as usize);
        if a == b || !set.contains_key(&a) || !set.contains_key(&b) {
            continue;
        }
        *crossing.entry((a, b)).or_insert(0.0) += routing.accumulation[v] as f64;
    }
    // Of a pair, the direction with more water (ties: the smaller key).
    let mut edges: BTreeMap<String, Edge> = BTreeMap::new();
    for ((from, to), &water) in &crossing {
        let back = crossing
            .get(&(to.clone(), from.clone()))
            .copied()
            .unwrap_or(0.0);
        if water > back || (water == back && from < to) {
            edges.insert(
                format!("{from}>{to}"),
                Edge {
                    from: from.clone(),
                    to: to.clone(),
                    water,
                },
            );
        }
    }
    // Longer cycles: cut at the weakest edge of each strongly connected
    // component, until none is left.
    loop {
        let cycles = strongly_connected(&edges);
        if cycles.is_empty() {
            break;
        }
        for members in &cycles {
            let mut weakest: Option<(&String, f64)> = None;
            for (key, e) in &edges {
                if !members.contains(&e.from) || !members.contains(&e.to) {
                    continue;
                }
                let weaker = match weakest {
                    None => true,
                    Some((k, w)) => e.water < w || (e.water == w && key < k),
                };
                if weaker {
                    weakest = Some((key, e.water));
                }
            }
            if let Some((key, _)) = weakest {
                let key = key.clone();
                edges.remove(&key);
            }
        }
    }
    let mut upstream: HashMap<String, Vec<String>> = HashMap::new();
    for e in edges.values() {
        upstream
            .entry(e.to.clone())
            .or_default()
            .push(e.from.clone());
    }
    for list in upstream.values_mut() {
        list.sort();
    }
    upstream
}

/// Tarjan's strongly connected components with more than one member,
/// iterative.
fn strongly_connected(edges: &BTreeMap<String, Edge>) -> Vec<BTreeSet<String>> {
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in edges.values() {
        next.entry(&e.from).or_default().push(&e.to);
    }
    for list in next.values_mut() {
        list.sort();
    }
    let nodes: BTreeSet<&str> = edges
        .values()
        .flat_map(|e| [e.from.as_str(), e.to.as_str()])
        .collect();
    let mut index: HashMap<&str, usize> = HashMap::new();
    let mut low: HashMap<&str, usize> = HashMap::new();
    let mut on_stack: BTreeSet<&str> = BTreeSet::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    let mut counter = 0;
    let empty: Vec<&str> = Vec::new();
    for &root in &nodes {
        if index.contains_key(root) {
            continue;
        }
        let mut work: Vec<(&str, usize)> = vec![(root, 0)];
        index.insert(root, counter);
        low.insert(root, counter);
        counter += 1;
        stack.push(root);
        on_stack.insert(root);
        while let Some(&(node, child)) = work.last() {
            let children = next.get(node).unwrap_or(&empty);
            if child < children.len() {
                work.last_mut().unwrap().1 += 1;
                let w = children[child];
                if !index.contains_key(w) {
                    index.insert(w, counter);
                    low.insert(w, counter);
                    counter += 1;
                    stack.push(w);
                    on_stack.insert(w);
                    work.push((w, 0));
                } else if on_stack.contains(w) {
                    let l = low[node].min(index[w]);
                    low.insert(node, l);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                let l = low[parent].min(low[node]);
                low.insert(parent, l);
            }
            if low[node] == index[node] {
                let mut members = BTreeSet::new();
                loop {
                    let w = stack.pop().unwrap();
                    on_stack.remove(w);
                    members.insert(w.to_string());
                    if w == node {
                        break;
                    }
                }
                if members.len() > 1 {
                    out.push(members);
                }
            }
        }
    }
    out
}

//! PER-NODE STATE that survives remeshing (decision 8 of
//! docs/decisions/adaptive-mesh.md). Named Float32 fields by vertex id; an
//! intensive field interpolates on insertion and is gone on removal, an
//! extensive one (an amount per area) is merged into the neighbours on
//! removal. A stacked field holds `depth` values per node, node-major.
//!
//! The arithmetic is the TypeScript engine's: the values are read as
//! doubles, combined in doubles and stored rounded to float32.

use super::periodic_delaunay::PeriodicTriangulation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    Intensive,
    Extensive,
}

pub struct MeshField {
    pub name: String,
    pub kind: FieldKind,
    pub depth: usize,
    pub data: Vec<f32>,
}

pub struct MeshState {
    pub fields: Vec<MeshField>,
    capacity: usize,
}

impl MeshState {
    pub fn new(capacity: usize) -> Self {
        MeshState {
            fields: Vec::new(),
            capacity: capacity.max(16),
        }
    }

    /// Adds a field; panics when the name exists.
    pub fn add(&mut self, name: &str, kind: FieldKind, depth: usize) -> &mut Vec<f32> {
        assert!(!self.has(name), "MeshState: field {name} exists");
        assert!(depth >= 1, "MeshState: depth {depth}");
        self.fields.push(MeshField {
            name: name.to_string(),
            kind,
            depth,
            data: vec![0.0; self.capacity * depth],
        });
        &mut self.fields.last_mut().unwrap().data
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|f| f.name == name)
    }

    pub fn has(&self, name: &str) -> bool {
        self.index(name).is_some()
    }

    pub fn get(&self, name: &str) -> &[f32] {
        let i = self
            .index(name)
            .unwrap_or_else(|| panic!("MeshState: no field {name}"));
        &self.fields[i].data
    }

    pub fn get_mut(&mut self, name: &str) -> &mut [f32] {
        let i = self
            .index(name)
            .unwrap_or_else(|| panic!("MeshState: no field {name}"));
        &mut self.fields[i].data
    }

    /// Grows every field to cover the triangulation's vertex slots.
    pub fn ensure(&mut self, mesh: &PeriodicTriangulation) {
        let slots = mesh.vertex_slots();
        if slots <= self.capacity {
            return;
        }
        let mut cap = self.capacity;
        while cap < slots {
            cap *= 2;
        }
        for f in &mut self.fields {
            f.data.resize(cap * f.depth, 0.0);
        }
        self.capacity = cap;
    }

    /// A new vertex v inside triangle (a, b, c) with barycentric weights.
    #[allow(clippy::too_many_arguments)]
    pub fn inherit_insert(
        &mut self,
        v: usize,
        a: usize,
        b: usize,
        c: usize,
        wa: f64,
        wb: f64,
        wc: f64,
    ) {
        for f in &mut self.fields {
            let d = &mut f.data;
            let depth = f.depth;
            for k in 0..depth {
                d[v * depth + k] = (wa * d[a * depth + k] as f64
                    + wb * d[b * depth + k] as f64
                    + wc * d[c * depth + k] as f64) as f32;
            }
        }
    }

    /// Vertex v is about to go: its neighbours had Voronoi areas `before`
    /// and will have `after`; v's own cell had `area_v`. Extensive fields are
    /// redistributed in proportion to the area each neighbour gains.
    pub fn inherit_remove(
        &mut self,
        v: usize,
        neighbours: &[u32],
        before: &[f64],
        after: &[f64],
        area_v: f64,
    ) {
        if area_v <= 0.0 {
            return;
        }
        for f in &mut self.fields {
            if f.kind != FieldKind::Extensive {
                continue;
            }
            let d = &mut f.data;
            let depth = f.depth;
            for k in 0..depth {
                let amount = d[v * depth + k] as f64 * area_v;
                if amount == 0.0 {
                    continue;
                }
                for (i, &n) in neighbours.iter().enumerate() {
                    let gained = after[i] - before[i];
                    if gained <= 0.0 || after[i] <= 0.0 {
                        continue;
                    }
                    let u = n as usize * depth + k;
                    d[u] =
                        ((d[u] as f64 * before[i] + amount * (gained / area_v)) / after[i]) as f32;
                }
            }
        }
    }
}

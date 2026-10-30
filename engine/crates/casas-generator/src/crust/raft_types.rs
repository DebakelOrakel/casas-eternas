//! What a raft is, and what its lifecycle reports.

#[derive(Clone, Debug, PartialEq)]
pub struct RaftBlob {
    pub x: f64,
    pub y: f64,
    pub radius: f64,
    /// The world epoch this crust formed, on the continuous axis; None reads
    /// as 0 (the oldest).
    pub birth_epoch: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Raft {
    pub id: u32,
    pub name: Option<String>,
    pub blobs: Vec<RaftBlob>,
    /// A freshly split half does not merge back before this epoch; None or
    /// 0: mergeable now.
    pub no_merge_until_epoch: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RaftMergeEvent {
    pub name_a: Option<String>,
    pub name_b: Option<String>,
    pub x: f64,
    pub y: f64,
    pub tangent_x: f64,
    pub tangent_y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Suture {
    pub x: f64,
    pub y: f64,
    pub tangent_x: f64,
    pub tangent_y: f64,
    pub epoch: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RaftSplitEvent {
    pub parent_name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub axis_x: f64,
    pub axis_y: f64,
}

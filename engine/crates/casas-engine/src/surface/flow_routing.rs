//! `surface/flowRouting.ts`: the raster engine's routing vocabulary — the
//! D8 slot order and the world ocean as the largest water component.

use crate::core::domain::DomainGrid;

/// The eight D8 steps in slot order: N, NE, E, SE, S, SW, W, NW. A diagonal
/// slot is odd.
pub const D8_OFFSETS: [(i64, i64); 8] = [
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];

/// The largest 4-connected component of cells at or under `sea_level`, as a
/// mask; `None` when there is no such cell.
pub fn largest_water_component(raw: &[f32], grid: &DomainGrid, sea_level: f64) -> Option<Vec<u8>> {
    let width = grid.res_x;
    let n = width * grid.res_y;
    let mut label = vec![-1i32; n];
    let mut sizes: Vec<u32> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for s in 0..n {
        if raw[s] as f64 > sea_level || label[s] != -1 {
            continue;
        }
        let id = sizes.len() as i32;
        let mut size = 0u32;
        stack.push(s);
        label[s] = id;
        while let Some(i) = stack.pop() {
            size += 1;
            let y = (i / width) as i64;
            let x = i as i64 - y * width as i64;
            // The order of the four does not change the mask, only the walk.
            for nb in [
                grid.neighbour(x, y, 1, 0),
                grid.neighbour(x, y, -1, 0),
                grid.neighbour(x, y, 0, 1),
                grid.neighbour(x, y, 0, -1),
            ] {
                if raw[nb] as f64 <= sea_level && label[nb] == -1 {
                    label[nb] = id;
                    stack.push(nb);
                }
            }
        }
        sizes.push(size);
    }
    if sizes.is_empty() {
        return None;
    }
    let mut best = 0;
    for i in 1..sizes.len() {
        if sizes[i] > sizes[best] {
            best = i;
        }
    }
    Some(label.iter().map(|&l| u8::from(l == best as i32)).collect())
}

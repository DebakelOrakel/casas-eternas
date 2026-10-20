//! `tectonics/plateTypes.ts`: a plate's crust type, derived from the rafts.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlateType {
    Oceanic,
    Continental,
}

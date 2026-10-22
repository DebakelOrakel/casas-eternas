// Crust type is no longer an independent plate property — it's derived from
// raft coverage each epoch (see the engine's `derive_plate_types` and the raft
// decision doc). This union survives as the shared vocabulary the
// classification/feature code still speaks; the old random per-plate
// assignment (assignPlateTypes) is gone with the pre-raft model.
export type PlateType = 'oceanic' | 'continental'

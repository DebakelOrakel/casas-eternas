// The volcanoes a world currently shows, distilled from its terrain features
// by the engine (tectonics/volcanoes.rs collect_volcanoes): its render gives
// them of a live world, `Engine.volcanoesOfSnapshot` of a save's snapshot.
//
// The map's markers (the volcano overlay), not the ecology's: the ecology reads
// its own list in the engine (tectonics/volcanoes.rs ecology_volcanoes, DEC-0053,
// 2026-10-29) — every active arc, not one per ARC_MARKER_CELL, and the extinct arcs
// for the copper. Until then it read this one, and the marker grid, a display rule,
// thinned the copper's arcs.
export interface Volcano {
  x: number
  y: number
  thickness: number
  kind: 'hotspot' | 'flood' | 'arc'
}

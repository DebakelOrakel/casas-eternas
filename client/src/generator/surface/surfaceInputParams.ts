import type { InputParam } from '../core/inputParams'

// The erosion and hydrology panels' controls. They live together because both
// panels drive this module — erosionPassV2.ts and hydrology.ts — even though the UI
// shows them as two panels.
//
// All three reach the save, and the erosion pair reaches further than that: a
// world's `spec.erosion.*` is read back by the amplification bake so a world
// tuned for gentle incision does not come back carved like an aggressive one
// (see docs/decisions/worldmap-amplification.md, rule 3).
// The erosion pass's sliders went with the pass (phase 5.1, decision 6):
// `alluvium` and `rockContrast` are the tectonics' now
// (tectonics/tectonicsInputParams.ts), `landscapeAge` has no successor.
// The declaration stays for the surface's input namespace; it is empty.
export const SURFACE_INPUTS = {} satisfies Record<string, InputParam>

import type { InputParam } from '../core/inputParams'

// The erosion and hydrology panels' controls. They live together because both
// panels drive this module — erosion.ts and hydrology.ts — even though the UI
// shows them as two panels.
//
// All three reach the save, and the erosion pair reaches further than that: a
// world's `spec.erosion.*` is read back by the amplification bake so a world
// tuned for gentle incision does not come back carved like an aggressive one
// (see docs/decisions/worldmap-amplification.md, rule 3).
export const SURFACE_INPUTS = {
  // Erosion strength as a multiplier on the pass's incision.
  erosionStrength: {
    min: 1, max: 5, step: 1, default: 2,
    i18n: 'worldgen.panel.erosion.strength',
    unit: 'common.unit.times',
    inSpec: true,
  },
  // How often the flow network is refreshed during a pass.
  drainageRefresh: {
    min: 1, max: 5, step: 1, default: 3,
    i18n: 'worldgen.panel.erosion.drainage',
    unit: 'common.unit.times',
    inSpec: true,
  },
  // River density 0..100. NOT converted here: the worker takes the raw slider
  // value and `densityToCriticalArea` maps it to a critical drainage area, a
  // curve rather than a scale factor. Deliberately absent from the artifact
  // cache key even though the bake reads it — see storage/artifactKey.ts.
  riverDensity: {
    min: 0, max: 100, step: 1, default: 55,
    i18n: 'worldgen.panel.hydrology.riverDensity',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

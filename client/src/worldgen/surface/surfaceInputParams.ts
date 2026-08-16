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
  // The v2 engine's central axis: how long the transient runs, in engine
  // iterations. Young keeps the inherited tectonic relief and cuts sharp
  // dendritic valleys; old approaches the smooth denuded equilibrium
  // (measured: 25 crisp / 100 softened / 400 blob — erosion-v2.md).
  landscapeAge: {
    min: 10, max: 400, step: 5, default: 40,
    i18n: 'worldgen.panel.erosion.age',
    inSpec: true,
  },
  // Settling-length scale: more alluvium settles sediment sooner — broader
  // valley floors, bigger deltas. 50 is the engine's calibrated neutral.
  alluvium: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'worldgen.panel.erosion.alluvium',
    inSpec: true,
  },
  // Lithology contrast σ: how differently hard and soft rock erode. 50 is
  // the calibrated neutral (σ 1.4); 0 is uniform rock.
  rockContrast: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'worldgen.panel.erosion.rockContrast',
    inSpec: true,
  },
  // River density 0..100. NOT converted here: the worker takes the raw slider
  // value and `densityToCriticalArea` maps it to a critical drainage area, a
  // curve rather than a scale factor. Deliberately absent from the artifact
  // cache key even though the bake reads it — see world/identity.ts.
  riverDensity: {
    min: 0, max: 100, step: 1, default: 55,
    i18n: 'worldgen.panel.hydrology.riverDensity',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

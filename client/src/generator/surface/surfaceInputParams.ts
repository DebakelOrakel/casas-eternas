import type { InputParam } from '../core/inputParams'

// The erosion and hydrology panels' controls. They live together because both
// panels drive this module — erosionPassV2.ts and hydrology.ts — even though the UI
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
    i18n: 'generator.panel.erosion.age',
    inSpec: true,
  },
  // Settling-length scale: more alluvium settles sediment sooner — broader
  // valley floors, bigger deltas. 50 is the engine's calibrated neutral.
  alluvium: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'generator.panel.erosion.alluvium',
    inSpec: true,
  },
  // Lithology contrast σ: how differently hard and soft rock erode. 50 is
  // the calibrated neutral (σ 1.4); 0 is uniform rock.
  rockContrast: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'generator.panel.erosion.rockContrast',
    inSpec: true,
  },
  // riverDensity is GONE (erosion-v2 P4 + teardown): drainage density is
  // climate-driven, everything draws the one canonical channel set
  // (hydrology.ts' CANONICAL_RIVER_DENSITY), and the hydrology panel that
  // hosted the slider folded into the erosion panel.
} satisfies Record<string, InputParam>

import type { InputParam } from '../core/inputParams'

// The genesis panel's two controls — the only inputs to the Archean run.
//
// Neither is used raw. `mantleVigour` becomes the per-epoch mantle diffusion
// (WorldGenScreen's vigourToDiffusion), and `water` becomes BOTH a sea-level
// offset in metres and a land-fraction target (elevationScale.waterSliderToOffsetM,
// landTarget.waterSliderToLandTarget). Those mappings are curves, not scales, so
// they stay functions rather than a `toModel` here — but the RANGE is a property
// of the control and belongs in this file.
//
// The water knob offsets the anchors and never SEA_LEVEL itself; that invariant
// is documented in docs/decisions/archean-genesis.md and is easy to break by
// reading this slider as "sea level".
export const ARCHEAN_INPUTS = {
  mantleVigour: {
    min: 1, max: 10, step: 1, default: 4,
    i18n: 'worldgen.panel.genesis.mantleVigour',
    inSpec: true,
  },
  water: {
    min: 0, max: 100, step: 1, default: 50,
    i18n: 'worldgen.panel.genesis.water',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

import type { InputParam } from '../core/inputParams'

// The genesis panel's two controls — the only inputs to the Archean run.
//
// Neither is used raw. `mantleVigour` becomes the per-epoch mantle diffusion
// (world/runParams.mantleDiffusionFromVigour) and `water` a sea-level offset in
// metres (elevationScale.waterSliderToOffsetM). Those mappings are curves,
// not scales, so they stay functions rather than a `toModel` here — but the
// RANGE is a property of the control and belongs in this file.
//
// The water knob offsets the anchors and never SEA_LEVEL itself; that invariant
// is documented in docs/decisions/archean-genesis.md and is easy to break by
// reading this slider as "sea level". It was documented as also being a
// land-fraction target; that solver was never wired and was removed
// 2026-09-22 (BUG_BOUNTY 12) — wiring one is a decision of its own, since it
// would change every world's land share at the hand-over.
export const ARCHEAN_INPUTS = {
  mantleVigour: {
    min: 1, max: 10, step: 1, default: 4,
    i18n: 'generator.panel.genesis.mantleVigour',
    inSpec: true,
  },
  water: {
    min: 0, max: 100, step: 1, default: 50,
    i18n: 'generator.panel.genesis.water',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

import type { InputParam } from '../core/inputParams'

// The genesis panel's two controls — the only inputs to the Archean run.
//
// Neither is used raw. `mantleVigour` becomes the per-epoch mantle diffusion
// (world/runParams.mantleDiffusionFromVigour) and `landShare` the Archean's
// land target, a fraction (world/runParams.landShareFromControl; the
// controller is archean/archeanLand.ts). The mappings stay functions there
// rather than a `toModel` here — but the RANGE is a property of the control
// and belongs in this file.
//
// `landShare` replaced the water control (a sea-level offset of ±600 m) in
// DEC-0036 phase 8b-1: the water moved the land by ±1.5 points, while the
// land was set by how much crust the Archean had made by the hand-over. The
// Archean climbs to it by 800 Ma and holds it however long it runs, aiming
// above it by what the history's first epochs take back
// (archean/archeanLand.archeanLandAim), so the target is the land a world
// has a little into the history.
export const ARCHEAN_INPUTS = {
  mantleVigour: {
    min: 1, max: 10, step: 1, default: 4,
    i18n: 'generator.panel.genesis.mantleVigour',
    inSpec: true,
  },
  landShare: {
    min: 15, max: 40, step: 1, default: 30,
    i18n: 'generator.panel.genesis.landShare',
    unit: 'common.unit.percent',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

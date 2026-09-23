import type { InputParam } from '../core/inputParams'

// The tectonics' controls since the coupled history (ADAPTIVE_MESH_PLAN.md
// phase 5.1; decision 6 of docs/decisions/adaptive-mesh.md: "no erosion
// sliders"). Erosion runs inside every epoch, so what shaped a final
// erosion pass shapes the history now and sits with the stage that runs
// it: the epoch's length (how much time each plate step spans — the
// erosion per unit of drift), and the two material properties.
//
// `landscapeAge` went with the pass: a range worn down is one that had
// quiet epochs after its orogeny, and running more epochs is how a world
// gets older.
export const TECTONICS_INPUTS = {
  // Million years per tectonic epoch. The plates' step per epoch is the
  // tectonics' own constant (TECTONICS_TUNING.epochAngleStep); the epoch
  // length scales the erosion's time against it, and the ocean floor's
  // age — read in Ma by GDH1 (elevationField.oceanFloorAtAge).
  epochLength: {
    min: 0.5, max: 4, step: 0.5, default: 1,
    i18n: 'generator.panel.tectonics.epochLength',
    unit: 'common.unit.millionYears',
    inSpec: true,
  },
  // Settling-length scale: more alluvium settles sediment sooner — broader
  // valley floors, bigger deltas. 50 = the engine's calibrated neutral.
  alluvium: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'generator.panel.tectonics.alluvium',
    inSpec: true,
  },
  // Lithology contrast 0..100 (50 neutral = σ 1.4).
  rockContrast: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'generator.panel.tectonics.rockContrast',
    inSpec: true,
  },
} satisfies Record<string, InputParam>

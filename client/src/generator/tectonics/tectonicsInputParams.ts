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
  // The epoch's length (million years per tectonic epoch) was a slider
  // here from phase 5.1 until 2026-09-27. It scaled the erosion, the
  // coast's retreat, the ice's cut and the lakes' ages against one plate
  // step at once, and the explicit engine grew restless at 4 Ma; it is
  // the world clock's constant now (core/worldTime.TECTONIC_MA_PER_EPOCH),
  // the same one the age readout always used.
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

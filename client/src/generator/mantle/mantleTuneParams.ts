// Algorithm tuning grouped into one object so it can be hashed — see the module
// contract in client/src/generator/CLAUDE.md. These were module-level constants
// in mantleField.ts until 2026-09-22 (BUG_BOUNTY 13).
//
// Out, as exports (contracts): MANTLE_RES_X/Y (a grid size, structural) and
// DEFAULT_INITIAL_SMOOTHING (the Archean reads it).

export const MANTLE_TUNING = {
  // Continents add heat under themselves each epoch; ocean removes it. The
  // asymmetry (insulation vs. cooling) is what drives the cycle.
  insulationRate: 0.05,
  oceanCoolRate: 0.025,
  // One gentle pass — enough to make broad cells, few enough that an upwelling
  // building under a continent stays peaked (over-diffusing flattened it and
  // starved the doming/breakup). That warning still holds for the TECTONIC phase,
  // which is why this stays the default; the Archean passes its own value (see
  // ArcheanParams.diffusion), where it is the mantle-mixing knob.
  diffusionPasses: 1,
  // How much of a cell's value each pass replaces with its neighbours' mean.
  diffusionWeight: 0.5,
  // Decay relaxes toward a zero mean so heat never accumulates unbounded (and
  // the periodic Poisson source stays solvable).
  decayKeep: 0.955,
  clamp: 2.5,
  // Gauss-Seidel iterations for the Poisson flow solve.
  solveIters: 260,
  // Scales the raw ∇φ flow to world pixels/epoch — tuned so plate speeds land in a
  // reasonable range (see plateMotion's LINEAR_SPEED_*). Calibrated by harness.
  flowSpeedScale: 110,
} as const

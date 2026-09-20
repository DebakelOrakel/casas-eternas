import type { InputParam } from '../core/inputParams'

// The migration panel's controls, declared once.
//
// The InputParam type moved to core/inputParams.ts once a second module needed
// it. This file stays as the worked example for the pattern described in
// docs/design/architecture-unification.md, part B. Before this, every slider's
// range lived in an HTML template string and its default lived there AND in the
// label AND in the reset handler — the three migration sliders carried four
// copies of each default between them, with nothing linking them. A range is a
// property of the parameter, not of the markup that happens to render it.

export const MIGRATION_INPUTS = {
  // NONE of the three is `inSpec` yet, and for two of them that is provisional
  // rather than a property of the control (2026-08-09). The migration layer may
  // leave the generator for a screen of its own, so its values are deliberately
  // kept out of `world.yaml` and out of any params hash until that is settled —
  // writing them into the save format now would mean a format to migrate later
  // for a layer that might not live here. `arrowThreshold` is the one that is
  // permanently out: it only changes what is drawn.
  //
  // They are still declared, so the panel renders from this file like every
  // other and the ranges stop living in HTML. The flag is the whole difference
  // between "the UI knows about it" and "the world is defined by it".

  // Cost budget: cells beyond this cost-distance from any origin stay unsettled.
  spreadBudget: {
    min: 20, max: 400, step: 10, default: 120,
    i18n: 'generator.panel.migration.spread',
    inSpec: false,
  },
  // Minimum flow, as a percentage of the largest, for a migration arrow to be
  // drawn. Display only — see `inSpec` above.
  arrowThreshold: {
    min: 0, max: 100, step: 5, default: 50,
    i18n: 'generator.panel.migration.arrows',
    inSpec: false,
    toModel: (v: number) => v / 100,
  },
  // How far shallow seas are crossable. 0 = only land bridges, 1 = broad
  // shallow shelves.
  seaCrossing: {
    min: 0, max: 100, step: 5, default: 30,
    i18n: 'generator.panel.migration.seaCrossing',
    unit: 'common.unit.percent',
    inSpec: false,
    toModel: (v: number) => v / 100,
  },
} satisfies Record<string, InputParam>

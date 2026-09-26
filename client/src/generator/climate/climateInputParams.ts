import type { InputParam } from '../core/inputParams'

// The climate panel's four controls. Ranges and defaults were retyped in the
// HTML template, in the label beside it and again as a string fallback in the
// load path; this is the one place now.
//
// Three of the four carry a `toModel`: the slider speaks percent because that is
// what a person reads, the model wants a factor. That conversion used to sit at
// the postToWorker call, i.e. in a different file from the range it belongs to.
export const CLIMATE_INPUTS = {
  // Global temperature offset in °C, added to the latitudinal band.
  tempOffset: {
    min: -20, max: 20, step: 1, default: 0,
    i18n: 'generator.panel.climate.temperature',
    unit: 'common.unit.celsius',
    inSpec: true,
  },
  // The thermal-equator shift (equatorOffset, ±50 % of the half-height) was
  // a slider here until 2026-09-26. Since the climate runs inside the
  // history (ADAPTIVE_MESH_PLAN.md phase 5.4) a shift set afterwards left
  // the terrain eroded under one climate and coloured by another; the
  // model keeps the parameter at 0 and the map draws the equator instead.
  // Global moisture supply, 100 % = neutral.
  humidity: {
    min: 40, max: 200, step: 5, default: 100,
    i18n: 'generator.panel.climate.humidity',
    unit: 'common.unit.percent',
    inSpec: true,
    toModel: (v: number) => v / 100,
  },
  // Equator-to-pole temperature contrast, 100 % = neutral.
  contrast: {
    min: 30, max: 170, step: 5, default: 100,
    i18n: 'generator.panel.climate.contrast',
    unit: 'common.unit.percent',
    inSpec: true,
    toModel: (v: number) => v / 100,
  },
} satisfies Record<string, InputParam>

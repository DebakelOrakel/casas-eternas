// What a user-facing generator control IS, declared once so the range, the
// default and the label key stop being retyped into HTML.
//
// Lives in core/ because every module with a panel needs it and none of them
// owns it. It started in migration/migrationInputParams.ts, where the pattern
// was first proved, and moved here the moment a second module needed it — a
// shared vocabulary type has no business living inside one of its users,
// especially one that may leave the generator.

export interface InputParam {
  min: number
  max: number
  step: number
  default: number
  // i18n key BASE. `${i18n}.label` names the control; the same base is its
  // `data-help` key, so the tooltip and the label cannot drift apart.
  i18n: string
  // Optional suffix after the value, itself an i18n key (e.g. common.unit.percent).
  unit?: string
  // Whether the value reaches the GENERATOR, and therefore the save.
  //
  // Not every control does, and conflating the two is how a display knob ends
  // up in a world's identity. A control that only changes what is DRAWN must
  // stay out: in the spec it would make two identical worlds differ by a
  // rendering preference, and (once inputs feed a cache key) orphan every
  // artifact each time someone nudged it. That is the mistake
  // world/identity.ts records for riverDensity — which has since left the
  // spec entirely and is the standing example of a draw-only control.
  //
  // It also carries a second, softer meaning: a control whose home is not yet
  // settled stays out until it is, because a save format written today is a
  // format to migrate tomorrow. Migration's sliders are the current case.
  inSpec: boolean
  // Slider units → model units, when they differ. Absent means identity.
  // Declared here rather than at the call site so the UI and the save agree on
  // one conversion instead of two.
  toModel?: (sliderValue: number) => number
  // Slider units → the number SHOWN beside the control, when the model's
  // unit is not the reader's: `shown = value × scale`, rounded to `digits`.
  // The slider, the spec and the save keep the model's unit (the landscape
  // age stays iterations in every recipe ever written); only the label
  // reads in years. Absent means the value is shown as it is.
  display?: { scale: number; digits: number }
}

// The number a control shows for a slider value (InputParam.display).
export function displayValue(p: InputParam, value: number): string {
  if (!p.display) return String(value)
  return (value * p.display.scale).toFixed(p.display.digits)
}

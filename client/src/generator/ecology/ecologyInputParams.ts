import type { InputParam } from '../core/inputParams'
import type { EcologyFieldId } from './ecologyField'

// The ecology panel's three top-level controls, plus the shape shared by the
// thirteen per-resource abundance sliders in the fold-out.
export const ECOLOGY_INPUTS = {
  // Global carrying-capacity gain, 100 % = neutral. Scales the level only.
  carryingCapacity: {
    min: 50, max: 200, step: 5, default: 100,
    i18n: 'generator.panel.ecology.carryingCapacity',
    unit: 'common.unit.percent',
    inSpec: true,
  },
  // Spatial structure, -100..100. 0 = physics as-is; positive clumps, negative
  // evens out. Mean-preserving, so it changes shape and not level.
  concentration: {
    min: -100, max: 100, step: 5, default: 0,
    i18n: 'generator.panel.ecology.concentration',
    inSpec: true,
  },
  // Volcanic-province fertility strength. The model wants 0..1; the default
  // matches ecologyField's DEFAULT_PROVINCE_STRENGTH, which is where it has to
  // stay until this declaration is the one the module reads.
  provinceStrength: {
    min: 0, max: 100, step: 5, default: 45,
    i18n: 'generator.panel.ecology.provinces',
    inSpec: true,
    toModel: (v: number) => v / 100,
  },
} satisfies Record<string, InputParam>

// The fold-out abundance sliders share one range and one default across all
// thirteen resources, but NOT one label: each is `generator.ecology.fieldAbundance`
// interpolated with the resource's name, and each carries its own
// `resource.<id>` help key. So this declares the numbers only — the
// generic renderer cannot serve them until it can take a per-instance label.
export const ECOLOGY_ABUNDANCE = { min: 50, max: 200, step: 5, default: 100 }

// How the abundance fields are GROUPED — both in the fold-out UI and, more
// importantly, in the save: a field's group name is part of its yaml path
// (`spec.ecology.<group>.<field>`), so this ordering is a format contract, not a
// layout preference. It lived in WorldGenScreen next to the panel icons, which
// put a save-format decision inside a screen; the icons stay there and join on
// `id`.
//
// Order matters twice over: it is the order the fold-out renders and the order
// the yaml is written in.
export const ECOLOGY_ABUNDANCE_GROUPS: readonly { readonly id: string; readonly fields: readonly EcologyFieldId[] }[] = [
  { id: 'subsistence', fields: ['arable', 'fish', 'game', 'pasture'] },
  { id: 'material', fields: ['timber', 'salt', 'toolStone'] },
  { id: 'metal', fields: ['copper', 'tin', 'iron'] },
  { id: 'prestige', fields: ['gold', 'silver', 'gems'] },
]

import type { TKey } from '../../i18n/i18n'

// The layer panel's data (LayerPanel.ts), apart from the panel and its
// styles, so that a module without a DOM (map/overlayGroups.ts) can name it.

// One row: a layer, or a pick of one.
export interface LayerRow {
  id: string
  // The catalog base: `.label` names the row, `.help` fills the hover card the
  // delegated `data-help` listener shows. `overlay.none` marks a group's way
  // out, which counts as no layer.
  helpBase: string
  icon: string
}

// A row's state, read from the same state the map is drawn from rather than
// kept a second time here.
export interface LayerState {
  on: boolean
  available: boolean
}

export interface LayerGroup {
  // Its name's catalog key.
  title: TKey
  kind: 'one' | 'any'
  // Whether it starts open; a group starts folded otherwise.
  open?: boolean
  // The catalog base of its heading's hover card (`.label`, `.help`).
  helpBase?: string
  rows: readonly LayerRow[]
}

// The panel's own strings, by the screen: its title, the count of what is
// on (`{count}`), the two actions, and a pick group's "of how many"
// (`{count}`).
export interface LayerPanelTexts {
  title: TKey
  active: TKey
  allOff: TKey
  defaults: TKey
  oneOf: TKey
  // The favourites' name, for assistive technology only: they show no
  // heading.
  favourites: TKey
}

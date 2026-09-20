// THE OVERLAY VOCABULARY: which map layers exist, what each one is called and
// which icon stands for it.
//
// Only the facts that need no live state. Whether a layer can be shown right
// now (`available`) and what its legend says belong to the screen, which is
// what holds the data — see WorldGenScreen's overlayAvailable/overlayLegend,
// both keyed by this type, so a layer added here is a compile error until it
// answers both.
//
// Split out for the step table (see steps.ts), which must be able to name a
// layer without pulling the whole screen in.

export type OverlayId =
  | 'terrain'
  | 'boundaries'
  | 'names'
  | 'mantle'
  | 'volcanoes'
  | 'hotspots'
  | 'cratonAge'
  | 'temperature'
  | 'seasonality'
  | 'wind'
  | 'currents'
  | 'precipitation'
  | 'monsoon'
  | 'biomes'
  | 'rivers'
  | 'waterBalance'
  | 'watersheds'
  | 'ecology'
  | 'migration'

export interface OverlayMeta {
  icon: string
}

// The layer's catalog base: `.label` names it, `.help` fills the hover card, and
// `.legend.*` names the legend it may carry. Derived from the id rather than
// stored, because locales/*/overlay.json holds exactly one branch per OverlayId
// — a table of key names could disagree with the ids, and once did: the ecology
// layer's strings were filed under "resources".
export const overlayKey = (id: OverlayId): string => `overlay.${id}`

export const OVERLAY_META: Record<OverlayId, OverlayMeta> = {
  terrain: { icon: '/icons/colours.png' },
  boundaries: { icon: '/icons/voronoi.png' },
  names: { icon: '/icons/continent_name.png' },
  mantle: { icon: '/icons/mantle.png' },
  volcanoes: { icon: '/icons/volcano.png' },
  hotspots: { icon: '/icons/hotspot.png' },
  cratonAge: { icon: '/icons/craton.png' },
  temperature: { icon: '/icons/temperature.png' },
  seasonality: { icon: '/icons/seasonality.png' },
  wind: { icon: '/icons/wind.png' },
  currents: { icon: '/icons/gyres.png' },
  precipitation: { icon: '/icons/rain.png' },
  monsoon: { icon: '/icons/weather.png' },
  biomes: { icon: '/icons/biomes.png' },
  rivers: { icon: '/icons/river.png' },
  waterBalance: { icon: '/icons/waterbilance.png' },
  watersheds: { icon: '/icons/watersheds.png' },
  ecology: { icon: '/icons/ecology.png' },
  migration: { icon: '/icons/human.png' },
}

export const OVERLAY_IDS = Object.keys(OVERLAY_META) as OverlayId[]

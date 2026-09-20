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
  // The `world.overlay.*` catalog base: `.label` names the layer, `.help` fills
  // the hover card. The id and the key slug match except for 'ecology', which
  // the catalog calls "resources" — the layer paints a resource field.
  labelKey: string
}

export const OVERLAY_META: Record<OverlayId, OverlayMeta> = {
  terrain: { icon: '/icons/colours.png', labelKey: 'world.overlay.terrain' },
  boundaries: { icon: '/icons/voronoi.png', labelKey: 'world.overlay.boundaries' },
  names: { icon: '/icons/continent_name.png', labelKey: 'world.overlay.names' },
  mantle: { icon: '/icons/mantle.png', labelKey: 'world.overlay.mantle' },
  volcanoes: { icon: '/icons/volcano.png', labelKey: 'world.overlay.volcanoes' },
  hotspots: { icon: '/icons/hotspot.png', labelKey: 'world.overlay.hotspots' },
  cratonAge: { icon: '/icons/craton.png', labelKey: 'world.overlay.cratonAge' },
  temperature: { icon: '/icons/temperature.png', labelKey: 'world.overlay.temperature' },
  seasonality: { icon: '/icons/seasonality.png', labelKey: 'world.overlay.seasonality' },
  wind: { icon: '/icons/wind.png', labelKey: 'world.overlay.wind' },
  currents: { icon: '/icons/gyres.png', labelKey: 'world.overlay.currents' },
  precipitation: { icon: '/icons/rain.png', labelKey: 'world.overlay.precipitation' },
  monsoon: { icon: '/icons/weather.png', labelKey: 'world.overlay.monsoon' },
  biomes: { icon: '/icons/biomes.png', labelKey: 'world.overlay.biomes' },
  rivers: { icon: '/icons/river.png', labelKey: 'world.overlay.rivers' },
  waterBalance: { icon: '/icons/waterbilance.png', labelKey: 'world.overlay.waterBalance' },
  watersheds: { icon: '/icons/watersheds.png', labelKey: 'world.overlay.watersheds' },
  ecology: { icon: '/icons/ecology.png', labelKey: 'world.overlay.resources' },
  migration: { icon: '/icons/human.png', labelKey: 'world.overlay.migration' },
}

export const OVERLAY_IDS = Object.keys(OVERLAY_META) as OverlayId[]

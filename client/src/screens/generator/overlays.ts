// THE OVERLAY VOCABULARY: which map layers exist, what each one is called and
// which icon stands for it.
//
// Only the facts that need no live state. Whether a layer can be shown right
// now (`available`) and what its legend says belong to the screen, which is
// what holds the data — see GeneratorScreen's overlayAvailable/overlayLegend,
// both keyed by this type, so a layer added here is a compile error until it
// answers both.
//
// Split out for the step table (see steps.ts), which must be able to name a
// layer without pulling the whole screen in.
import type { TKey } from '../../i18n/i18n'
import { ECOLOGY_ABUNDANCE_GROUPS } from '../../generator/ecology/ecologyInputParams'
import type { EcologyFieldId } from '../../generator/ecology/ecologyField'

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
  | 'pressure'
  | 'wind'
  | 'currents'
  | 'upwelling'
  | 'salinity'
  | 'fog'
  | 'foehn'
  | 'rainVariability'
  | 'enso'
  | 'cyclone'
  | 'tornado'
  | 'blizzard'
  | 'dust'
  | 'thunder'
  | 'precipitation'
  | 'monsoon'
  | 'koppen'
  | 'biomes'
  | 'rivers'
  | 'waterBalance'
  | 'watersheds'
  | 'ecology'

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
  pressure: { icon: '/icons/pressure.png' },
  wind: { icon: '/icons/wind.png' },
  currents: { icon: '/icons/gyres.png' },
  upwelling: { icon: '/icons/upwelling.png' },
  salinity: { icon: '/icons/salt.png' },
  // The weather phenomena (2026-09-29), each its own layer in the climate
  // step's weather group.
  fog: { icon: '/icons/fog.png' },
  foehn: { icon: '/icons/foehn.png' },
  rainVariability: { icon: '/icons/rainvar.png' },
  enso: { icon: '/icons/enso.png' },
  cyclone: { icon: '/icons/hurricane.png' },
  tornado: { icon: '/icons/tornado.png' },
  blizzard: { icon: '/icons/blizzard.png' },
  dust: { icon: '/icons/dust.png' },
  thunder: { icon: '/icons/thunder.png' },
  precipitation: { icon: '/icons/rain.png' },
  monsoon: { icon: '/icons/weather.png' },
  koppen: { icon: '/icons/climate.png' },
  biomes: { icon: '/icons/biomes.png' },
  rivers: { icon: '/icons/river.png' },
  waterBalance: { icon: '/icons/waterbilance.png' },
  watersheds: { icon: '/icons/watersheds.png' },
  ecology: { icon: '/icons/ecology.png' },
}

export const OVERLAY_IDS = Object.keys(OVERLAY_META) as OverlayId[]

// THE LAYER PANEL'S GROUPS (ui/layerPanel), WORLD-WIDE (2026-10-28). The
// panel holds every layer of the world in every step; a layer is greyed out
// only while its data is not there (GeneratorScreen's overlayAvailable),
// never because of the step. A step decides its controls and which layers
// are on as you enter it (steps.ts `defaults`), not what the map can show.
//
// Each layer is in exactly ONE group, so it is the same kind of control in
// every step. The biomes were a land pick in the climate step and a switch
// in the ecology and the finishing; they are a land pick everywhere now,
// since they are a wash over the land as the climate classes are.
export interface OverlayGroup {
  // Its name's catalog key.
  title: TKey
  members: readonly OverlayId[]
}

// The switches: layers that combine, each on or off by itself. Shapes and
// lines over the map, and the washes that read under them (the terrain's
// colour, the temperature, the mantle, the cratons).
export const SWITCH_GROUPS: readonly OverlayGroup[] = [
  { title: 'incubator.layers.global', members: ['terrain', 'names'] },
  { title: 'incubator.layers.geology', members: ['boundaries', 'mantle', 'hotspots', 'volcanoes', 'cratonAge'] },
  // The lines — wind, currents, rivers — read over each other and over any
  // wash, so they are switches; the temperature is the climate's ground.
  { title: 'incubator.layers.climate', members: ['temperature', 'wind', 'currents', 'rivers'] },
]

// The picks: ONE AT A TIME within a group, the groups combine (2026-09-29:
// by what the layers draw, one on the land, one on the sea, one of weather).
// Full-map washes physically cannot share the map: the later one covers the
// earlier. The panel opens each group with its "none".
// The pressure is a wash over land and sea with its isobars; it sits with
// the land's washes, and may still read over a sea wash. The water balance
// and the watersheds are land washes.
export const PICK_GROUPS: readonly OverlayGroup[] = [
  { title: 'generator.section.land.label', members: ['precipitation', 'seasonality', 'monsoon', 'koppen', 'biomes', 'pressure', 'waterBalance', 'watersheds'] },
  { title: 'generator.section.sea.label', members: ['upwelling', 'salinity'] },
  { title: 'generator.section.weather.label', members: ['fog', 'foehn', 'rainVariability', 'enso', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder'] },
]

// The resource fields, a pick of their own: the 'ecology' layer paints ONE
// field over the whole land, so a second could only overwrite the first.
// The carrying capacity first, then the per-field abundance controls,
// derived from the grouping the save uses, so the picker and the save can
// never disagree about which fields exist.
export const RESOURCES_TITLE: TKey = 'generator.section.resources.label'
export const RESOURCE_FIELDS: readonly EcologyFieldId[] = ['carryingCapacity', ...ECOLOGY_ABUNDANCE_GROUPS.flatMap((g) => [...g.fields])]

// Every layer in exactly one group, the 'ecology' layer being the resource
// picks'. Checked at startup: a layer in no group has no control, a layer in
// two is two answers to one question.
{
  const grouped = [...SWITCH_GROUPS, ...PICK_GROUPS].flatMap((g) => g.members)
  if (new Set(grouped).size !== grouped.length) throw new Error('generator overlays: a layer is in two panel groups')
  const missing = OVERLAY_IDS.filter((id) => id !== 'ecology' && !grouped.includes(id))
  if (missing.length > 0 || grouped.includes('ecology')) throw new Error(`generator overlays: not in exactly one panel group: ${missing.length > 0 ? missing : 'ecology'}`)
}

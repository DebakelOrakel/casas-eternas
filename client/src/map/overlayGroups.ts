// THE OVERLAY LIST (2026-10-28): every overlay of the world, in its groups,
// the same in the generator and in the incubator. Both screens fill their
// layer panel (ui/layerPanel) from it, so every overlay is listed in both;
// each screen maps an id to its own state, and a row whose data the screen
// does not have is greyed out. An id the screen does not know is never on
// and never available: the generator has no people, the incubator no plate
// boundaries.
//
// One id per overlay, the same string in both screens: a generator layer
// is its OverlayId (overlays.ts), the ice its own word, the rest
// carry a prefix by what they are ('resource:', 'people:', 'settle:',
// 'plant:', 'animal:', 'wood:'). A group of one choice opens with its
// "none", `none:<group>`.
//
// A group of one choice ('one') is exclusive within itself, and only
// there: the groups combine. Which screen may add a rule across groups is
// its own business (the incubator's plants, animals and trees paint one
// overlay, so one of them at a time).
//
// In map/, with the layers' vocabulary (overlays.ts) and their painting
// (climateLayers.ts, refinedLayers.ts, geologyLayers.ts): no screen's
// state, so both screens read it.
import type { TKey } from '../i18n/i18n'
import type { LayerGroup, LayerPanelTexts, LayerRow } from '../ui/layerPanel/layerTypes'
import { ECOLOGY_FIELD_IDS, type EcologyFieldId } from '../generator/ecology/ecologyField'
import { OVERLAY_IDS, OVERLAY_META, overlayKey, type OverlayId } from './overlays'

// What people get of a plant, of a tree's wood, of an animal: the uses the
// incubator's plants, trees and animals carry (screens/incubator plants.ts,
// trees.ts, animals.ts), here because the overlays pick by them.
export type PlantUse = 'starch' | 'fat' | 'fruit' | 'fibre'
export type WoodUse = 'build' | 'fuel' | 'tool' | 'boat' | 'resin'
export type AnimalUse = 'hunt' | 'tame' | 'water' | 'fur' | 'danger'

export type OverlayGroupId =
  | 'global' | 'geology' | 'climate' | 'land' | 'sea' | 'weather'
  | 'resources' | 'people' | 'settlement' | 'plants' | 'animals' | 'trees'

export interface OverlayGroup extends LayerGroup {
  id: OverlayGroupId
}

// Per ecology field its icon; every field has its own.
export const FIELD_ICON: Record<EcologyFieldId, string> = {
  carryingCapacity: 'ecology',
  arable: 'wheat', fish: 'fish', game: 'deer', pasture: 'pastures',
  timber: 'timber', salt: 'salt', toolStone: 'stone_axe',
  copper: 'copper_ore', tin: 'tin_ore', iron: 'iron_ore',
  silver: 'silver', gold: 'gold', gems: 'gems',
}

// The uses of the plants, in the order of their rows, with their icons;
// their names are `plant.use.<use>`.
export const PLANT_USES: readonly { use: PlantUse; icon: string }[] = [
  { use: 'starch', icon: '/icons/wheat.png' },
  { use: 'fat', icon: '/icons/nuts.png' },
  { use: 'fruit', icon: '/icons/fruits.png' },
  { use: 'fibre', icon: '/icons/rope.png' },
]
// The uses of the wood (the trees' group), as the plants'; their names are
// `wood.use.<use>`.
export const WOOD_USES: readonly { use: WoodUse; icon: string }[] = [
  { use: 'build', icon: '/icons/timber.png' },
  { use: 'fuel', icon: '/icons/bonfire.png' },
  { use: 'tool', icon: '/icons/stone_axe.png' },
  { use: 'boat', icon: '/icons/boat.png' },
  { use: 'resin', icon: '/icons/resin.png' },
]
// What the animals are to people, as the plants' uses; their names are
// `animal.use.<use>`.
export const ANIMAL_USES: readonly { use: AnimalUse; icon: string }[] = [
  { use: 'hunt', icon: '/icons/deer.png' },
  { use: 'tame', icon: '/icons/pastures.png' },
  { use: 'water', icon: '/icons/fish.png' },
  { use: 'fur', icon: '/icons/beaver.png' },
  { use: 'danger', icon: '/icons/tiger.png' },
]

export const resourceLayerId = (field: EcologyFieldId): string => `resource:${field}`
export const plantLayerId = (use: PlantUse): string => `plant:${use}`
export const woodLayerId = (use: WoodUse): string => `wood:${use}`
export const animalLayerId = (use: AnimalUse): string => `animal:${use}`
export const noneLayerId = (group: OverlayGroupId): string => `none:${group}`

const overlayRow = (id: OverlayId): LayerRow => ({ id, helpBase: overlayKey(id), icon: OVERLAY_META[id].icon })
const none = (group: OverlayGroupId): LayerRow => ({ id: noneLayerId(group), helpBase: 'overlay.none', icon: '/icons/clear.png' })
// A group's name and its heading's hover card: `common.layers.<group>`,
// whose `.label` is the name and `.help` the card's text.
const heading = (group: OverlayGroupId): { title: TKey; helpBase: string } => ({ title: `common.layers.${group}.label`, helpBase: `common.layers.${group}` })

// The groups, in their order. Only the first starts open; the rest start
// folded until the viewer opens them.
export const OVERLAY_GROUPS: readonly OverlayGroup[] = [
  { id: 'global', ...heading('global'), kind: 'any', open: true, rows: (['terrain', 'names', 'boundaries', 'temperature'] as const).map(overlayRow) },
  { id: 'geology', ...heading('geology'), kind: 'any', rows: (['volcanoes', 'hotspots', 'cratonAge', 'mantle'] as const).map(overlayRow) },
  {
    id: 'climate',
    ...heading('climate'),
    kind: 'any',
    rows: [
      { id: 'iceAge', helpBase: 'incubator.layers.iceAge', icon: '/icons/blizzard.png' },
      ...(['rivers', 'pressure', 'wind', 'currents'] as const).map(overlayRow),
    ],
  },
  // The land's washes: one at a time, since a later wash covers an earlier.
  { id: 'land', ...heading('land'), kind: 'one', rows: [none('land'), ...(['seasonality', 'koppen', 'biomes', 'precipitation', 'monsoon', 'waterBalance', 'watersheds'] as const).map(overlayRow)] },
  { id: 'sea', ...heading('sea'), kind: 'one', rows: [none('sea'), ...(['upwelling', 'salinity'] as const).map(overlayRow)] },
  { id: 'weather', ...heading('weather'), kind: 'one', rows: [none('weather'), ...(['fog', 'foehn', 'rainVariability', 'enso', 'cyclone', 'tornado', 'blizzard', 'dust', 'thunder'] as const).map(overlayRow)] },
  // The ecology's fields: the generator's 'ecology' layer paints ONE of
  // them over the whole land.
  {
    id: 'resources',
    ...heading('resources'),
    kind: 'one',
    rows: [none('resources'), ...ECOLOGY_FIELD_IDS.map((field) => ({ id: resourceLayerId(field), helpBase: `resource.${field}`, icon: `/icons/${FIELD_ICON[field]}.png` }))],
  },
  {
    id: 'people',
    ...heading('people'),
    kind: 'any',
    rows: [
      { id: 'people:routes', helpBase: 'incubator.people.routes', icon: '/icons/river.png' },
      { id: 'people:trade', helpBase: 'incubator.people.trade', icon: '/icons/trade.png' },
      { id: 'people:hamlets', helpBase: 'incubator.people.hamlets', icon: '/icons/hamlet.png' },
      { id: 'people:camps', helpBase: 'incubator.people.camps', icon: '/icons/yurt.png' },
      { id: 'people:villages', helpBase: 'incubator.people.villages', icon: '/icons/village.png' },
      { id: 'people:centres', helpBase: 'incubator.people.centres', icon: '/icons/origin.png' },
      { id: 'people:sources', helpBase: 'incubator.people.sources', icon: '/icons/stone_axe.png' },
    ],
  },
  {
    id: 'settlement',
    ...heading('settlement'),
    kind: 'one',
    rows: [
      none('settlement'),
      { id: 'settle:spread', helpBase: 'incubator.people.spread', icon: '/icons/human.png' },
      { id: 'settle:groups', helpBase: 'incubator.peopling.groups', icon: '/icons/lineage.png' },
      { id: 'settle:peoples', helpBase: 'incubator.people.peoples', icon: '/icons/group.png' },
      // No icon of its own yet: the names' (TEG-148).
      { id: 'settle:languages', helpBase: 'incubator.peopling.languages', icon: '/icons/language.png' },
      { id: 'settle:lifeway', helpBase: 'incubator.people.lifeway', icon: '/icons/pastures.png' },
      { id: 'settle:density', helpBase: 'incubator.people.density', icon: '/icons/population.png' },
    ],
  },
  { id: 'plants', ...heading('plants'), kind: 'one', rows: [none('plants'), ...PLANT_USES.map((p) => ({ id: plantLayerId(p.use), helpBase: `plant.use.${p.use}`, icon: p.icon }))] },
  { id: 'animals', ...heading('animals'), kind: 'one', rows: [none('animals'), ...ANIMAL_USES.map((p) => ({ id: animalLayerId(p.use), helpBase: `animal.use.${p.use}`, icon: p.icon }))] },
  { id: 'trees', ...heading('trees'), kind: 'one', rows: [none('trees'), ...WOOD_USES.map((p) => ({ id: woodLayerId(p.use), helpBase: `wood.use.${p.use}`, icon: p.icon }))] },
]

const GROUP_OF = new Map<string, OverlayGroup>(OVERLAY_GROUPS.flatMap((g) => g.rows.map((r) => [r.id, g] as const)))

// The group a row is in; undefined for an id that is no row.
export const overlayGroupOf = (id: string): OverlayGroup | undefined => GROUP_OF.get(id)
export const overlayGroup = (id: OverlayGroupId): OverlayGroup => OVERLAY_GROUPS.find((g) => g.id === id)!
// A group's layers, its "none" not one of them.
export const groupLayers = (group: OverlayGroup): string[] => group.rows.filter((r) => !isNoneLayer(r.id)).map((r) => r.id)
export const isNoneLayer = (id: string): boolean => id.startsWith('none:')

// A screen's FAVOURITES (2026-10-28): the rows of the panel's first group,
// links to rows of the groups, set per step. They are the only thing a
// step says about the layers; it turns none on. What comes on as a world
// opens, and on the panel's "Defaults", is these: the rows to turn on,
// everything else off. A group of one choice may list several of its
// members among the favourites, but one of them can be on: the first
// listed. An id that is no row is left out.
export function favouritesToTurnOn(favourites: readonly string[]): string[] {
  const chosen = new Set<OverlayGroupId>()
  return favourites.filter((id) => {
    const group = GROUP_OF.get(id)
    if (!group) return false
    if (group.kind !== 'one') return true
    if (chosen.has(group.id)) return false
    chosen.add(group.id)
    return true
  })
}

// Every row once, and every generator layer a row but 'ecology', whose rows
// are the resource fields. Checked at startup: a layer in no group has no
// control, a row in two groups is two answers to one question.
{
  const ids = OVERLAY_GROUPS.flatMap((g) => g.rows.map((r) => r.id))
  if (new Set(ids).size !== ids.length) throw new Error('overlay list: a row is listed twice')
  const missing = OVERLAY_IDS.filter((id) => id !== 'ecology' && !GROUP_OF.has(id))
  if (missing.length > 0 || GROUP_OF.has('ecology')) throw new Error(`overlay list: not in exactly one group: ${missing.length > 0 ? missing : 'ecology'}`)
}

// The panel's own strings, the same in both screens.
export const OVERLAY_PANEL_TEXTS: LayerPanelTexts = {
  title: 'common.layers.title.label',
  active: 'common.layers.active.label',
  allOff: 'common.layers.allOff.label',
  defaults: 'common.layers.defaults.label',
  favourites: 'common.layers.favourites.label',
}

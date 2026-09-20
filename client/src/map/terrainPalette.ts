import { Biome } from '../generator/climate/biomes'

// The map's own TERRAIN palette, and how it is laid onto the paper.
//
// Deliberately not the generator's `biomeColor`, though it is keyed on the same
// classification. The two answer different questions and are free to diverge:
// the generator's palette is a DATA VIEW, tuned so a reader can tell twelve
// classes apart while tuning a simulation — the same register its overlays are
// in. This one is the world as it LOOKS, so it may collapse distinctions the
// data view needs (a boreal forest and a temperate one are both dark conifer
// green from above) and separate ones the data view does not care about.
// Sharing one palette between them would mean neither could be tuned without
// damaging the other.
//
// Colours are chosen as PIGMENTS rather than as labels — sap green, olive,
// raw sienna, yellow ochre, payne's grey — because that is what the medium
// around them is imitating.

const TERRAIN_COLORS: Record<number, [number, number, number]> = {
  // Ocean never reaches the wash (the paper keeps its own bathymetric blue),
  // but the entry exists so a lookup can never fall through to grey.
  [Biome.Ocean]: [40, 90, 140],
  [Biome.Ice]: [232, 240, 248], // cool near-white
  [Biome.Tundra]: [166, 158, 128], // warm grey-olive, thin soil
  [Biome.Boreal]: [46, 92, 70], // deep conifer
  [Biome.Grassland]: [216, 190, 96], // straw
  [Biome.Woodland]: [138, 156, 68], // olive
  [Biome.TemperateForest]: [88, 152, 62], // sap green
  [Biome.TemperateRainforest]: [34, 122, 92], // deep teal-green
  [Biome.Desert]: [228, 194, 128], // raw sienna, warm sand
  [Biome.Savanna]: [206, 156, 62], // yellow ochre
  [Biome.TropicalRainforest]: [26, 108, 46], // viridian
  [Biome.Alpine]: [140, 140, 156], // payne's grey, bare rock
  [Biome.SaltFlat]: [238, 232, 216], // warm salt crust
  [Biome.Glacier]: [212, 226, 242], // pale glacier blue, frozen water
}

export function terrainColor(id: number): [number, number, number] {
  return TERRAIN_COLORS[id] ?? [128, 128, 128]
}

export interface TerrainWash {
  // How far each pigment is pulled toward its own luminance. Runs NEGATIVE on
  // purpose: below zero it pushes away instead, which is the "make it pop"
  // knob — one slider that raises chroma without touching thirteen colours.
  desaturate: number
  // How far the multiplier travels from white to the full pigment. 0 leaves
  // bare paper, 1 is the pigment at full strength.
  strength: number
}

export const DEFAULT_TERRAIN_WASH: TerrainWash = {
  desaturate: 0.05,
  strength: 0.82,
}

// The one pen for all water LINES on the map: the worldmap's river ribbons
// read it as their far-zoom ink, and the lake shorelines (traced as vector
// loops by mapPresentation, drawn by the same ribbon overlay) are stroked
// with it — river → shore ring → outflow reads as a single pen stroke, which
// is what lets the ribbons END at a lake instead of being drawn across its
// surface. Water SURFACES stay in the wash register; this ink is never a
// fill. (A first cut painted the shoreline into the paper here — one texel of
// texture blurs at zoom while the river ribbons stay crisp beside it, so the
// line moved to vector.)
export const WATER_LINE_INK: [number, number, number] = [43, 64, 102]

// Lake water, in the paper's own register: anchored on the paper base's light
// ocean blue rather than the generator's data-view lake blue, so a lake reads
// as the same water the ocean is, one tone deeper. The ramp saturates where
// the generator's does — its 900 m sits just above the measured 99th-percentile
// lake depth (859 m; see GeneratorScreen's LAKE_SHADE_SATURATION_M), so the ramp
// spends its range on depths lakes actually have.
const LAKE_SHALLOW: [number, number, number] = [160, 196, 226]
const LAKE_DEEP: [number, number, number] = [95, 140, 188]
const LAKE_DEPTH_SATURATION_M = 900
// Blended, not multiplied: water is not a glaze over the land pigment, it
// replaces it. Slightly under 1 so a whisper of the hillshade survives at the
// shore, the way the worldgen screen's 0.75 does.
const LAKE_ALPHA = 0.85

// Lay the lakes over the washed paper, IN PLACE. `lakeDepthMeters` is one
// depth per texel (0 = no lake), already in metres.
// A wet cell whose biome says Glacier is a FROZEN basin (the riparian
// override, see hydrology's LakeFields.frozen) — painted as ice, not open
// water: pale blue-white, barely darkening with depth.
const LAKE_ICE_SHALLOW: [number, number, number] = [222, 233, 243]
const LAKE_ICE_DEEP: [number, number, number] = [204, 220, 236]

export function applyLakeWash(paper: Uint8ClampedArray, lakeDepthMeters: Float32Array, biomeIds: Uint8Array | null = null): void {
  for (let i = 0; i < lakeDepthMeters.length; i++) {
    const d = lakeDepthMeters[i]
    if (d <= 0) continue
    const t = Math.min(1, d / LAKE_DEPTH_SATURATION_M)
    const ice = biomeIds !== null && biomeIds[i] === Biome.Glacier
    const shallow = ice ? LAKE_ICE_SHALLOW : LAKE_SHALLOW
    const deep = ice ? LAKE_ICE_DEEP : LAKE_DEEP
    const p = i * 4
    for (let c = 0; c < 3; c++) {
      const water = shallow[c] + (deep[c] - shallow[c]) * t
      paper[p + c] = paper[p + c] * (1 - LAKE_ALPHA) + water * LAKE_ALPHA
    }
  }
}

// Lay the palette over a paper base, IN PLACE. Land only: the ocean keeps the
// paper's own blue, which already carries bathymetric shading and reads as
// water without competing with the terrain hues.
//
// MULTIPLICATIVE, not a blend toward the colour — this is the first ingredient
// in docs/design/watercolor-map.md and it was the thing actually making the map
// look washed out. Watercolour is subtractive: pigment filters the light coming
// back off the paper, so a lit sheet stays lit and a shaded one stays shaded.
// Lerping toward the colour instead REPLACES the paper by however much it is
// applied, which means every step toward stronger colour is a step away from
// visible relief, and the only way out is to keep the colour weak — i.e.
// washed out. Multiplying has no such trade: the hillshade survives at full
// strength because it is a factor on both sides.
export function applyTerrainWash(paper: Uint8ClampedArray, relief: Uint8Array, ids: Uint8Array, wash: TerrainWash): void {
  const { desaturate, strength } = wash
  // One multiplier per biome id rather than per texel: there are at most a
  // dozen, and the alternative is recomputing the same luminance mix eight
  // million times.
  const factors = new Float32Array(256 * 3).fill(1)
  const seen = new Uint8Array(256)
  for (let i = 0; i < relief.length; i++) {
    if (!(relief[i] & 128)) continue // ocean: paper blue stays
    const id = ids[i]
    if (id === Biome.Ocean) continue // dilation missed it; leave the paper alone
    if (!seen[id]) {
      seen[id] = 1
      const [cr, cg, cb] = terrainColor(id)
      const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb
      for (let c = 0; c < 3; c++) {
        const channel = c === 0 ? cr : c === 1 ? cg : cb
        // Negative desaturate pushes away from luminance; clamp so a strong
        // boost cannot wrap a channel around.
        const tinted = Math.min(255, Math.max(0, channel + (lum - channel) * desaturate))
        factors[id * 3 + c] = 1 + (tinted / 255 - 1) * strength
      }
    }
    const p = i * 4
    paper[p] *= factors[id * 3]
    paper[p + 1] *= factors[id * 3 + 1]
    paper[p + 2] *= factors[id * 3 + 2]
  }
}

import { computeReliefBytes } from '../worldgen/render/reliefShade'
import { upscaleBilinearToroidal } from '../worldgen/core/field'
import { buildPaperBase, buildUnshadedPaperBase } from '../ui/mapOverlay/paperBase'
import { applyBiomeWash, dilateLandBiomes, expandBiomeIds } from '../ui/mapOverlay/biomePaper'
import { createElevationSurface, downsampleElevation } from './elevationSurface'
import { createFineElevationSurface } from './fineElevationSurface'
import { RELIEF_DECIMATION, RELIEF_HEIGHT_SCALE } from './mapSceneSettings'
import { SEA_LEVEL } from '../worldgen/elevation/elevationScale'
import { Biome, computeBiomesFine, reduceTemperatureToSeaLevel } from '../worldgen/climate/biomes'
import { CLIMATE_RES_X, CLIMATE_RES_Y } from '../worldgen/climate/climateField'
import type { ElevationSurface } from './elevationSurface'

// How a world's FIELDS become what a map view eats: the paper texture bytes and
// the elevation surfaces. Everything here is "what does this world look like",
// nothing is "which world is it" — the caller owns identity, loading and the
// scene.
//
// Extracted from WorldMapScreen (2026-08-11), which held it as four functions
// over eight mutable locals. The trigger was the watercolour work
// (docs/design/watercolor-map.md): a knowledge field `k` modulating pigment,
// hillshade and relief height would otherwise have become a ninth local
// threaded through all four. One input, one place.
//
// Two inputs, because they change for different reasons and at different rates:
// `setWorld` is the save's own fields, which arrive once; `setElevation` is
// whichever height raster is CURRENT, which is replaced every time an amplified
// tier lands. The expensive per-tier work — hillshade, classification, the
// three surfaces — hangs off the second.

export interface MapPresentationOptions {
  // The paper texture's resolution. Fixed for a session by the caller, so a
  // tier landing never rebuilds the map view.
  textureWidth: number
  textureHeight: number
  // The composited paper: `shaded` carries the baked hillshade for the flat
  // map plane, `unshaded` is for the LIT relief meshes, which carry real
  // normals and would otherwise be shaded twice.
  onPaper: (shaded: Uint8ClampedArray, unshaded: Uint8ClampedArray) => void
  // The three surfaces derived from the current height raster: the decimated
  // one the coarse relief mesh uses, the full-resolution one, and the
  // synthetic fine cascade for the near-field patch.
  onSurfaces: (coarse: ElevationSurface, fine: ElevationSurface, detail: ElevationSurface) => void
}

// The save's own fields. `biomeInputs` is null for a save written before the
// classification's inputs were stored; the legacy upsample path then stands.
export interface MapWorldFields {
  elevations: Float32Array
  width: number
  height: number
  biome: { data: Float32Array; resX: number; resY: number } | null
  detailSeed: number
  biomeInputs: {
    temperature: { data: Float32Array; resX: number; resY: number }
    precipitationEffective: { data: Float32Array; resX: number; resY: number }
    seasonalAmplitude: { data: Float32Array; resX: number; resY: number }
    monsoonIndex: { data: Float32Array; resX: number; resY: number }
  } | null
}

export interface MapPresentation {
  setWorld(fields: MapWorldFields): void
  // The height raster now in force — the save's macro field at load, then each
  // amplified tier as it arrives. Emits paper AND surfaces.
  setElevation(field: Float32Array, fieldWidth: number, fieldHeight: number, detailSeed: number): void
  // The biome actually PAINTED at this point, or null where no wash was built.
  // UV rather than texel coords, matching ElevationSurface and MapHoverTooltip
  // — the texture's resolution stays in here.
  biomeIdAtUV(u: number, v: number): number | null
}

// How much of the biome palette reaches the paper. Same two knobs, and the
// same reasoning, as the generator's terrain wash: pull the colours toward
// their own luminance and let them through only partly, so the paper's white
// and its hillshade keep showing. Full-strength palette would turn the map
// into a flat colour chart.
const BIOME_DESATURATE = 0.45
const BIOME_ALPHA = 0.55

export function createMapPresentation(options: MapPresentationOptions): MapPresentation {
  const { textureWidth, textureHeight, onPaper, onSurfaces } = options

  // The paper's hillshade bytes and the per-texel biome ids, retained so a
  // repaint costs neither again.
  let lastRelief: Uint8Array | null = null
  let biomeIds: Uint8Array | null = null
  // The save's climate inputs, kept so the biome wash can be RECLASSIFIED
  // against whatever terrain is current instead of upsampled from the saved
  // ids — that is what makes an amplified tier's ridges carry a treeline.
  let biomeInputs: MapWorldFields['biomeInputs'] = null
  // The MACRO biome ids, nearest-sampled to texture resolution. Two things the
  // classification cannot re-derive on its own live in here, and the macro
  // raster is their authority: salt flats (a hydrology state, not a climate)
  // and dry basin floors (below sea level yet land).
  let macroBiomeAtTexel: Uint8Array | null = null
  // The saved temperature with its lapse term removed, computed ONCE against
  // the macro raster the generator's climate actually ran on. It has to be
  // built here rather than inside the classification, because the terrain
  // being classified is no longer that raster once a tier lands.
  let seaLevelTemperature: Float32Array | null = null

  // Biomes re-derived from THIS raster, at texture resolution.
  //
  // The wash used to be the saved 2048 ids upsampled through a domain-warped
  // coordinate — a guess at what lies between two macro cells. Here the
  // elevation at every texel is already known (it is the field the hillshade
  // was just built from), and the Whittaker classification is pointwise, so the
  // answer can simply be computed instead. It re-runs as each amplified tier
  // lands: the biome boundaries sharpen in step with the terrain, and a
  // treeline follows the ridges the bake actually carved rather than the 62 km
  // cell they sit in.
  //
  // What does NOT get finer: precipitation, seasonality and monsoon stay
  // regional (the classification interpolates them, but interpolation is not
  // information). So this sharpens the elevation-driven boundaries — treeline,
  // alpine, valley warmth — and leaves rain-driven ones where they were. In
  // mountains that is the visible half; on a plain nothing changes.
  function reclassifyBiomes(paperField: Float32Array): void {
    // Legacy save, or a climate grid this build does not index the same way:
    // keep whatever setWorld built. computeBiomesFine reads the grid through
    // the shared constants, so a mismatch would be misindexed rather than
    // rejected, and the upsample path is a working fallback.
    if (!biomeInputs || !seaLevelTemperature) return
    const { temperature, precipitationEffective, seasonalAmplitude, monsoonIndex } = biomeInputs

    // Dry basin floors: below sea level in THIS raster, yet land according to
    // the macro authority. Rebuilt per call because it depends on the field.
    let dryLand: Uint8Array | undefined
    if (macroBiomeAtTexel) {
      dryLand = new Uint8Array(paperField.length)
      for (let i = 0; i < paperField.length; i++) {
        if (paperField[i] <= SEA_LEVEL && macroBiomeAtTexel[i] !== Biome.Ocean) dryLand[i] = 1
      }
    }
    const ids = computeBiomesFine(
      temperature.data, precipitationEffective.data, seasonalAmplitude.data, monsoonIndex.data,
      paperField, textureWidth, textureHeight, dryLand, seaLevelTemperature,
    )
    // Salt flats are a hydrology state and the classification has no way to
    // reach them — they come from the terminal-basin pass that ran on the macro
    // world. Carried over rather than re-derived, per the authority rule.
    if (macroBiomeAtTexel) {
      for (let i = 0; i < ids.length; i++) if (macroBiomeAtTexel[i] === Biome.SaltFlat) ids[i] = Biome.SaltFlat
    }
    biomeIds = ids
  }

  // Paint the retained relief bytes into both papers, with the biome wash on
  // top wherever there are ids for it. Split from setElevation so a repaint
  // costs neither the hillshade nor the classification again.
  function repaintPaper(): void {
    if (!lastRelief) return
    const shaded = buildPaperBase(lastRelief)
    const unshaded = buildUnshadedPaperBase(lastRelief)
    if (biomeIds) {
      applyBiomeWash(shaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
      applyBiomeWash(unshaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
    }
    onPaper(shaded, unshaded)
  }

  return {
    setWorld(fields: MapWorldFields): void {
      const { elevations, width, height, biome, detailSeed, biomeInputs: savedBiomeInputs } = fields
      biomeInputs = savedBiomeInputs
      // The macro ids at texture resolution, nearest — this is a lookup table
      // for two facts the classification cannot reach (salt flats, dry basin
      // floors), so nearest is right: they are categorical and the macro raster
      // is their authority. Blending them would invent states that exist
      // nowhere.
      macroBiomeAtTexel = null
      if (biome) {
        const table = new Uint8Array(textureWidth * textureHeight)
        for (let y = 0; y < textureHeight; y++) {
          const sy = Math.min(biome.resY - 1, Math.floor((y / textureHeight) * biome.resY))
          for (let x = 0; x < textureWidth; x++) {
            const sx = Math.min(biome.resX - 1, Math.floor((x / textureWidth) * biome.resX))
            table[y * textureWidth + x] = Math.round(biome.data[sy * biome.resX + sx])
          }
        }
        macroBiomeAtTexel = table
      }
      // Sea-level temperature, against the MACRO raster and its own dry-basin
      // floors (below sea level yet land) — the same pair computeTemperature saw.
      seaLevelTemperature = null
      if (savedBiomeInputs && savedBiomeInputs.temperature.resX === CLIMATE_RES_X && savedBiomeInputs.temperature.resY === CLIMATE_RES_Y) {
        let macroDry: Uint8Array | undefined
        if (biome) {
          macroDry = new Uint8Array(elevations.length)
          for (let i = 0; i < elevations.length; i++) {
            const by = Math.min(biome.resY - 1, Math.floor((Math.floor(i / width) / height) * biome.resY))
            const bx = Math.min(biome.resX - 1, Math.floor(((i % width) / width) * biome.resX))
            if (elevations[i] <= SEA_LEVEL && Math.round(biome.data[by * biome.resX + bx]) !== Biome.Ocean) macroDry[i] = 1
          }
        }
        seaLevelTemperature = reduceTemperatureToSeaLevel(savedBiomeInputs.temperature.data, elevations, width, height, macroDry)
      }
      // Fallback ids for a save too old to carry the classification's inputs:
      // dilate the land biomes over the ocean first (so coastal land can't
      // sample "Ocean" across the grid mismatch), then expand through a warped
      // coordinate so boundaries are organic rather than blocks. When the
      // inputs ARE present, the next setElevation replaces this with a real
      // classification.
      biomeIds = biome
        ? expandBiomeIds(dilateLandBiomes(biome.data, biome.resX, biome.resY), biome.resX, biome.resY, textureWidth, textureHeight, detailSeed)
        : null
    },

    // Re-derive the paper from whatever height raster is current, at the
    // session's fixed texture resolution: a coarser field is upscaled, a finer
    // one BOX-DOWNSAMPLED (averaging heights, so the hillshade doesn't sparkle
    // the way point-sampling would).
    setElevation(field: Float32Array, fieldWidth: number, fieldHeight: number, detailSeed: number): void {
      let paperField = field
      if (fieldWidth > textureWidth && fieldWidth % textureWidth === 0) {
        const reduced = downsampleElevation(field, fieldWidth, fieldHeight, fieldWidth / textureWidth)
        paperField = reduced.data
      } else if (fieldWidth !== textureWidth) {
        paperField = upscaleBilinearToroidal(field, fieldWidth, fieldHeight, textureWidth, textureHeight)
      }
      lastRelief = computeReliefBytes(paperField, textureWidth, textureHeight)
      reclassifyBiomes(paperField)
      repaintPaper()

      const decimated = downsampleElevation(field, fieldWidth, fieldHeight, RELIEF_DECIMATION)
      const coarse = createElevationSurface(decimated.data, decimated.resX, decimated.resY, RELIEF_HEIGHT_SCALE)
      const fine = createElevationSurface(field, fieldWidth, fieldHeight, RELIEF_HEIGHT_SCALE)
      // The synthetic cascade rides ON TOP of whatever raster is current: its
      // scales are relative to the raster's resolution, so once a tier lands it
      // automatically retreats to the band below the amplified cells instead of
      // competing with them. (What survives of it once erosion lands is a later
      // question — see the decision doc's ladder.)
      const detail = createFineElevationSurface(field, fieldWidth, fieldHeight, RELIEF_HEIGHT_SCALE, detailSeed, 0.6)
      onSurfaces(coarse, fine, detail)
    },

    biomeIdAtUV(u: number, v: number): number | null {
      if (!biomeIds) return null
      const px = Math.min(textureWidth - 1, Math.max(0, Math.floor(u * textureWidth)))
      const py = Math.min(textureHeight - 1, Math.max(0, Math.floor(v * textureHeight)))
      return biomeIds[py * textureWidth + px]
    },
  }
}

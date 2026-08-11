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

// How much of the world is known, one value per paper texel (0..1). See
// docs/design/watercolor-map.md: the three registers are BANDS of this, not
// classes, so the transitions are washes rather than borders.
export interface KnowledgeSource {
  // k per texel, at exactly the paper's resolution.
  readonly texels: Float32Array
  // Changes when the field does — the presentation repaints on a new value.
  readonly revision: number
}

export interface MapPresentation {
  setWorld(fields: MapWorldFields): void
  // The knowledge field, or null for "everything known", which reproduces the
  // pre-knowledge map byte for byte (see the identity note on PAPER_TONE).
  setKnowledge(source: KnowledgeSource | null): void
  // Retune where the three registers sit. Debug-facing: stage A exists to
  // decide these numbers.
  setKnowledgeRamp(ramp: KnowledgeRamp): void
  // The knowledge field changed in place — repaint against it.
  refreshKnowledge(): void
  // How much is known at a UV, 0..1 (1 with no field). Callers that draw their
  // OWN geometry over the map need it: a river through unexplored land must not
  // be drawn either.
  knowledgeAtUV(u: number, v: number): number
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

// The sheet itself: a warm off-white, not #fff. Pure white reads as ABSENCE —
// as though the render failed — while a paper tone reads as an unpainted sheet,
// which is the whole point of the unexplored register.
const PAPER_TONE = [250, 247, 240] as const

// k below which nothing has been painted at all, and the k at which the flat
// first wash sits. Between them the pigment ramps up; above the second, the map
// works itself out toward the full-strength picture.
//
// These are the three registers as NUMBERS, and they are the thing stage A
// exists to judge (docs/design/watercolor-map.md). Debug-tunable from the
// screen for exactly that reason.
export interface KnowledgeRamp {
  // Pigment reaching the paper at the "explored" plateau — a pale flat wash.
  exploredPigment: number
  // k at which that plateau sits.
  exploredAt: number
  // k above which relief (and the last of the pigment) fades in.
  activeFrom: number
}

export const DEFAULT_KNOWLEDGE_RAMP: KnowledgeRamp = {
  exploredPigment: 0.35,
  exploredAt: 0.5,
  activeFrom: 0.6,
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

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
  let knowledge: KnowledgeSource | null = null
  let ramp: KnowledgeRamp = { ...DEFAULT_KNOWLEDGE_RAMP }
  // The raster now in force, kept so a knowledge change can re-derive without
  // the caller handing the field in again.
  let currentField: { data: Float32Array; width: number; height: number; detailSeed: number } | null = null

  // k at an arbitrary UV, read off the same per-texel array the paper uses —
  // one source, so the geometry can never disagree with the picture.
  function knowledgeAtUV(u: number, v: number): number {
    const k = knowledge?.texels
    if (!k) return 1
    const uw = u - Math.floor(u)
    const vw = v - Math.floor(v)
    const x = Math.min(textureWidth - 1, Math.floor(uw * textureWidth))
    const y = Math.min(textureHeight - 1, Math.floor(vw * textureHeight))
    return k[y * textureWidth + x]
  }

  // Land RISES as it becomes known. Without this an unexplored mountain range
  // still betrays itself: the paper above it may be blank, but the mesh is real
  // geometry, lit for real, and its silhouette and shading give the shape away
  // the moment the camera tilts.
  //
  // A wrapper rather than a change to ToroidalMapView, because
  // `setReliefSurfaces` already takes an ElevationSurface — the seam was
  // already there. Keyed off the SAME ramp the pigment uses, so terrain and
  // colour arrive together.
  function sinkWithKnowledge(surface: ElevationSurface): ElevationSurface {
    if (!knowledge) return surface
    return {
      heightAtUV(u: number, v: number): number {
        return surface.heightAtUV(u, v) * smoothstep(ramp.activeFrom, 1, knowledgeAtUV(u, v))
      },
    }
  }

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
  //
  // Knowledge enters LAST, as two lerps per texel over the finished picture,
  // and that ordering is what makes it cheap AND exact: the wash and the
  // hillshade are computed once at full strength, and k only decides how much
  // of them survives. At k = 1 everywhere both lerps are the identity, so the
  // output is byte-for-byte the map that existed before any of this — which is
  // the property the extraction's spec check pins down.
  //
  //   flat map   = lerp(PAPER, lerp(unshaded, shaded, relief(k)), pigment(k))
  //   relief map = lerp(PAPER, unshaded, pigment(k))
  //
  // The relief meshes get no baked hillshade in either case — they are lit for
  // real, and their GEOMETRY carries how much is known (see the k-sunk surfaces
  // below). Blending toward the paper tone rather than scaling the wash's alpha
  // is deliberate: a pixel a third of the way from paper to its full colour IS
  // a pale wash, and it lightens as it desaturates, which is what thin
  // watercolour does.
  function repaintPaper(): void {
    if (!lastRelief) return
    const shaded = buildPaperBase(lastRelief)
    const unshaded = buildUnshadedPaperBase(lastRelief)
    if (biomeIds) {
      applyBiomeWash(shaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
      applyBiomeWash(unshaded, lastRelief, biomeIds, BIOME_DESATURATE, BIOME_ALPHA)
    }
    const k = knowledge?.texels
    if (k) {
      for (let i = 0; i < k.length; i++) {
        const kv = k[i]
        const relief = smoothstep(ramp.activeFrom, 1, kv)
        const pigment = kv <= ramp.exploredAt
          ? smoothstep(0, ramp.exploredAt, kv) * ramp.exploredPigment
          : ramp.exploredPigment + (1 - ramp.exploredPigment) * smoothstep(ramp.exploredAt, 1, kv)
        const p = i * 4
        for (let c = 0; c < 3; c++) {
          const flat = unshaded[p + c]
          const lit = flat + (shaded[p + c] - flat) * relief
          const tone = PAPER_TONE[c]
          shaded[p + c] = tone + (lit - tone) * pigment
          unshaded[p + c] = tone + (flat - tone) * pigment
        }
      }
    }
    onPaper(shaded, unshaded)
  }

  // The three surfaces derived from the current raster, each sunk by what is
  // known of the ground it describes.
  function emitSurfaces(): void {
    if (!currentField) return
    const { data: field, width, height, detailSeed } = currentField
    const decimated = downsampleElevation(field, width, height, RELIEF_DECIMATION)
    const coarse = createElevationSurface(decimated.data, decimated.resX, decimated.resY, RELIEF_HEIGHT_SCALE)
    const fine = createElevationSurface(field, width, height, RELIEF_HEIGHT_SCALE)
    // The synthetic cascade rides ON TOP of whatever raster is current: its
    // scales are relative to the raster's resolution, so once a tier lands it
    // automatically retreats to the band below the amplified cells instead of
    // competing with them. (What survives of it once erosion lands is a later
    // question — see the decision doc's ladder.)
    const detail = createFineElevationSurface(field, width, height, RELIEF_HEIGHT_SCALE, detailSeed, 0.6)
    onSurfaces(sinkWithKnowledge(coarse), sinkWithKnowledge(fine), sinkWithKnowledge(detail))
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
      currentField = { data: field, width: fieldWidth, height: fieldHeight, detailSeed }
      repaintPaper()
      emitSurfaces()
    },

    setKnowledge(source: KnowledgeSource | null): void {
      knowledge = source
      if (lastRelief) repaintPaper()
      emitSurfaces()
    },

    setKnowledgeRamp(next: KnowledgeRamp): void {
      ramp = { ...next }
      if (lastRelief) repaintPaper()
      emitSurfaces()
    },

    // The knowledge field mutated in place (a brush stroke, a scout arriving).
    // Separate from setKnowledge because the source object has not changed —
    // only its contents — and the caller is the one that knows a stroke ended.
    refreshKnowledge(): void {
      if (lastRelief) repaintPaper()
      emitSurfaces()
    },

    biomeIdAtUV(u: number, v: number): number | null {
      if (!biomeIds) return null
      const px = Math.min(textureWidth - 1, Math.max(0, Math.floor(u * textureWidth)))
      const py = Math.min(textureHeight - 1, Math.max(0, Math.floor(v * textureHeight)))
      return biomeIds[py * textureWidth + px]
    },

    knowledgeAtUV,
  }
}

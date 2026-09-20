import { elevationToColor } from '../elevation/elevationColor'
import { applyMountainRedistribution, computeRaftBaseline } from '../elevation/elevationField'
import type { PlateSimulation } from '../tectonics/plateSimulation'
import { rasterizeVoronoiPlates } from './voronoiRaster'
import type { ContinentLabelPlacement } from './continentLabelRenderer'
import { computeRaftLabelPlacements } from './raftLabelLayout'
import type { ElevationRenderer } from './elevationRenderPool'
import { upscaleBilinearToroidal } from '../core/field'
import { computeOwnerField } from '../crust/raftField'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { applyErosionDetailTexture } from './erosionDetailTexture'
import { reliefShadeAt } from './reliefShade'

// Whether to apply the mountain-accentuating gamma redistribution curve
// (applyMountainRedistribution) before coloring. Temporarily false
// (2026-07-23) to evaluate the raw new tectonic terrain — the redistribution
// reshapes elevations against the map's own peak and can mask what the
// ridge/trench/ridged-multifractal changes actually produce.
const ACCENTUATE_MOUNTAINS = false

// Whether to add erosionDetailTexture.ts's slope-conditioned fine noise
// (2026-08-06, new — not yet eye-verified against a running world). Default
// off for the same reason ACCENTUATE_MOUNTAINS is: flip on to evaluate, keep
// off while the constants above it are still starting values rather than
// tuned ones.
const APPLY_EROSION_DETAIL_TEXTURE = true

// Event highlights (merge/rift/subduction markers) used to be baked into
// the raster here as red plate-territory tints and distance-field halos.
// They now live as main-thread overlay markers with proper geologic-line
// geometry, driven by the sim's events (see GeneratorScreen's event overlay
// and the raft SimEvent types) — so all of that baking machinery is gone.

export interface SimulationRenderResult {
  // Base color raster ONLY — elevation shading, no boundaries/arrows/labels/
  // event markers baked in. Those are now separate, individually toggleable
  // main-thread overlay layers composited on top (see GeneratorScreen); the
  // three overlay-source fields below are the data they draw from.
  buffer: Uint8Array
  // Neutral relief base, one byte/pixel: top bit = land, low 7 bits = hillshade
  // (0..127), for BOTH land and ocean floor — see the render loop's comment.
  relief: Uint8Array
  // Full-resolution plate-boundary mask (1 where the pixel sits on a Voronoi
  // cell edge, else 0). Drawn as fine boundary lines by the compositor; kept
  // full-res regardless of the elevation preview scale so the lines stay
  // crisp. Uint8 rather than a bitset for a straightforward transfer + draw.
  boundaryMask: Uint8Array
  // Per-raft continent-name label geometry (position/angle/fit size) for the
  // names overlay — computed from raft blobs, no text drawn here.
  raftLabels: ContinentLabelPlacement[]
  // Fraction of the map (by pixel count, computed from this same pass —
  // not from plate type counts) whose elevation is above sea level.
  // Plate type alone is a poor proxy for this: a continental plate's own
  // baseline can dip below zero near its jittered low end or a nearby
  // rift, and an oceanic plate can push well above zero at an island
  // arc/hotspot — actual rendered elevation is what should count as land.
  landFraction: number
  // Elevation exactly as the field query (or precomputedElevations, if
  // that path was taken) produced it, *before* applyMountainRedistribution's
  // cosmetic reshaping — the physically meaningful values a later erosion
  // pass (erosion.ts) needs to act on, not the display-squashed ones.
  rawElevations: Float32Array
  // The redistributed values actually used for elevationToColor — what a
  // debug 3D heightmap preview (see GeneratorScreen.ts) should displace
  // by, so the relief it shows matches what the 2D color map is already
  // showing (a white "snow-capped" pixel should also be the tallest
  // point in 3D) rather than the pre-redistribution physical field.
  elevations: Float32Array
}

export interface RenderSimulationOptions {
  // Skip the elevation field query (baseline blend + pool.renderElevations
  // — together the ~88%+~15% of a normal render's cost) and use this
  // array instead, e.g. the output of an erosion pass (erosion.ts) run
  // against a previous render's own rawElevations. Everything downstream
  // — redistribution, coloring, and the overlay-source passes — runs
  // exactly as it would on a freshly-queried field, since none of it
  // knows or cares where the elevation values came from.
  precomputedElevations?: Float32Array
  // Downscale factor for the expensive elevation-field query only (baseline
  // blend + pool.renderElevations): the field is sampled on a grid of
  // width/scale x height/scale and bilinearly upscaled back to full
  // resolution before coloring, so a live preview can render several times
  // faster at a slightly softer elevation shading. Must divide the map
  // dimensions evenly. Defaults to 1 (full resolution — no downscale, no
  // upscale). The boundary mask and labels stay full resolution
  // regardless, so plate outlines and overlays remain crisp. Ignored when
  // precomputedElevations is supplied (that array is already the final
  // full-res field).
  elevationScale?: number
  // Terminal-basin truth from the hydrology (LakeFields.dryBasin/saltFlat):
  // dry sub-sea basin floor renders as LAND — salt-crust colour inside the
  // evaporite band, pale basin rock above it — shaded by the same hillshade
  // as everything else, so the exposed bathymetry keeps its real relief. Set
  // by the worker's post-hydrology re-render; cleared whenever topography
  // changes (the masks describe a hydrology that no longer exists then).
  dryBasin?: Uint8Array
  saltFlat?: Uint8Array
}

// Dry terminal-basin floor colours (see RenderSimulationOptions.dryBasin).
// Salt matches the SaltFlat biome swatch; the rock above the evaporite band
// is a darker desert tone so the band reads as a bright shoreline ring.
const SALT_CRUST_COLOR: [number, number, number] = [236, 230, 218]
const BASIN_ROCK_COLOR: [number, number, number] = [196, 178, 148]

// Renders the simulation's current state into an RGBA buffer: elevation
// (from the stateless distance-field query) determines every pixel's
// color, except pixels right on a plate boundary — those stay a dark
// outline on top (see showBoundaries).
//
// Bilinear upscale of a low-res elevation grid back to full resolution,
// wrapping toroidally at both seams (the map wraps in both axes, so the
// last row/column interpolate against the first, not a clamped edge). Used
// to expand a downscaled live-preview elevation field (see
// RenderSimulationOptions.elevationScale) to the full raster the coloring
// pass and everything downstream expect.
// Async, and takes a render pool, because the actual per-pixel elevation
// query — profiled at ~88% of total render time — is farmed out across
// a pool of nested workers (see elevationRenderPool.ts) rather than
// computed inline here. Everything else in this function (Voronoi
// rasterization, baseline blending, redistribution, coloring, boundary
// lines, labels) stays single-threaded — combined, profiling
// showed it's under 15% of total cost, not worth distributing too.
// What the renderer actually reads. Narrower than PlateSimulation on purpose: the
// Archean has no plates, no features and no ocean-age field, and should not have to
// fabricate a PlateSimulation just to be drawn. Empty arrays for the plate-shaped
// fields are a truthful description of that phase, not a placeholder.
export interface RenderableWorld {
  width: number
  height: number
  seeds: PlateSimulation['seeds']
  rafts: PlateSimulation['rafts']
  features: PlateSimulation['features']
  oceanAge: Float32Array
  warpSeed: number
  seaLevelOffset: number
}

export async function renderSimulationImage(sim: RenderableWorld, pool: ElevationRenderer, options: RenderSimulationOptions = {}): Promise<SimulationRenderResult> {
  const { precomputedElevations } = options
  const { width, height } = sim
  // The Archean phase runs with no plates at all — plate tectonics has not started
  // yet (see archean/). Everything plate-shaped below is therefore skipped rather
  // than given a second render function: the elevation raster, hillshade and colour
  // ramp are ~90% of this and need no plates, so a parallel renderer would be
  // almost entirely duplication. "No plates yet" is an honest special case.
  const hasPlates = sim.seeds.length > 0
  const cellIds = hasPlates ? rasterizeVoronoiPlates(sim.seeds, width, height) : new Uint16Array(width * height)
  const buffer = new Uint8Array(width * height * 4)

  let elevations: Float32Array
  if (precomputedElevations) {
    // Copied rather than used directly — applyMountainRedistribution
    // below mutates in place, and precomputedElevations may be a caller-
    // retained array (e.g. the worker's own cached "last raw elevations"
    // it plans to erode again from later) that shouldn't be silently
    // reshaped as a side effect of rendering it once.
    elevations = precomputedElevations.slice()
  } else {
    // The elevation field query runs on a (possibly coarser) render grid;
    // everything else stays at full world resolution. scale 1 == no
    // downscale/upscale, identical to before.
    const scale = Math.max(1, Math.floor(options.elevationScale ?? 1))
    const renderWidth = Math.floor(width / scale)
    const renderHeight = Math.floor(height / scale)
    const blendedBaselines = computeRaftBaseline(sim.rafts, sim.oceanAge, renderWidth, renderHeight, width, height, sim.warpSeed, sim.seaLevelOffset)
    const rendered = await pool.renderElevations(renderWidth, renderHeight, width, height, blendedBaselines, sim.features, sim.warpSeed)
    elevations = scale === 1 ? rendered : upscaleBilinearToroidal(rendered, renderWidth, renderHeight, width, height)
  }
  // Captured before redistribution reshapes elevations in place — see
  // SimulationRenderResult.rawElevations.
  const rawElevations = elevations.slice()
  // Normalizes against this map's own actual highest point — has to
  // happen after every pixel's raw elevation is known (i.e. after the
  // pool has finished, not per-pixel/per-slice as each one is computed)
  // — see applyMountainRedistribution's own comment for why.
  // Temporarily gated off (2026-07-23) while evaluating the new tectonic
  // ridge/trench/ridged-multifractal terrain by eye — flip back to true to
  // restore the mountain-accentuating gamma curve. Now normalizes PER
  // CONTINENT rather than against the whole world's max — see
  // applyMountainRedistribution's own comment (2026-08-06 mountain-realism
  // review) — via a coarse "which raft owns this point" field computed at
  // the same MANTLE_RES grid every other raft-derived field already uses.
  if (ACCENTUATE_MOUNTAINS) {
    const ownerField = computeOwnerField(sim.rafts, MANTLE_RES_X, MANTLE_RES_Y, width, height)
    applyMountainRedistribution(elevations, width, height, ownerField, MANTLE_RES_X, MANTLE_RES_Y)
  }

  // Slope-conditioned fine detail — see erosionDetailTexture.ts. Reads slope
  // from rawElevations (pre-redistribution, physically meaningful) but paints
  // onto `elevations` (the display copy), so the two effects stay
  // independent of each other's reshaping.
  if (APPLY_EROSION_DETAIL_TEXTURE) applyErosionDetailTexture(elevations, rawElevations, width, height, sim.warpSeed)

  // Base color raster + the boundary mask, in one pass. The mask marks a
  // pixel whose right or down neighbor belongs to a different plate — the
  // same edge test the baked boundary used, but recorded rather than
  // painted, so the compositor can draw (or hide) the lines on the main
  // thread without a re-render.
  const boundaryMask = new Uint8Array(width * height)
  // A neutral "relief" base (the "paper" the panels paint on): a subtle hillshade
  // over BOTH land and ocean floor, packed into one byte — top bit = land, low 7
  // bits = shade (0..127). The screen expands it to RGBA (land → near-white grey,
  // ocean → light blue, each modulated by the shade so relief reads on water too).
  // Forward-difference hillshade lit from the top-left; exaggerated since
  // normalized elevation deltas are tiny per pixel. See GeneratorScreen.
  const relief = new Uint8Array(width * height)
  let landPixelCount = 0
  for (let y = 0; y < height; y++) {
    const downRow = (y + 1) % height
    for (let x = 0; x < width; x++) {
      const rightCol = (x + 1) % width
      const idx = y * width + x
      const plateIndex = cellIds[idx]
      if (plateIndex !== cellIds[y * width + rightCol] || plateIndex !== cellIds[downRow * width + x]) boundaryMask[idx] = 1
      const elevation = elevations[idx]
      const dryFloor = options.dryBasin !== undefined && options.dryBasin[idx] === 1
      if (elevation > 0 || dryFloor) landPixelCount++
      const shade = reliefShadeAt(elevations, width, height, x, y)
      relief[idx] = (elevation > 0 || dryFloor ? 128 : 0) | Math.round(shade * 127)
      const color = dryFloor
        ? (options.saltFlat !== undefined && options.saltFlat[idx] === 1 ? SALT_CRUST_COLOR : BASIN_ROCK_COLOR)
        : elevationToColor(elevation)
      const pixelIndex = idx * 4
      buffer[pixelIndex] = color[0]
      buffer[pixelIndex + 1] = color[1]
      buffer[pixelIndex + 2] = color[2]
      buffer[pixelIndex + 3] = 255
    }
  }

  // Overlay source data — always produced (cheap), toggled on the main
  // thread. Labels come from raft blobs.
  const raftLabels = computeRaftLabelPlacements(sim.rafts, width, height)

  return { buffer, relief, boundaryMask, raftLabels, landFraction: landPixelCount / (width * height), rawElevations, elevations }
}

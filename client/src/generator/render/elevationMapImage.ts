import { elevationToColor } from '../elevation/elevationColor'
import type { PlateSimulation } from '../tectonics/plateSimulationTypes'
import type { Domain, DomainGrid } from '../core/domain'
import { rasterizeVoronoiPlates } from './voronoiRaster'
import type { ContinentLabelPlacement } from './continentLabelRenderer'
import { computeRaftLabelPlacements } from './raftLabelLayout'
import { applyErosionDetailTexture } from './erosionDetailTexture'
import { reliefShadeAt } from './reliefShade'

// Whether to add erosionDetailTexture.ts's slope-conditioned fine noise
// (2026-08-06, new — not yet eye-verified against a running world). Flip
// off to evaluate the terrain without it.
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
  // Fraction of the world (by area — the pixel count on the torus — from this same pass —
  // not from plate type counts) whose elevation is above sea level.
  // Plate type alone is a poor proxy for this: a continental plate's own
  // baseline can dip below zero near its jittered low end or a nearby
  // rift, and an oceanic plate can push well above zero at an island
  // arc/hotspot — actual rendered elevation is what should count as land.
  landFraction: number
  // The elevation exactly as the caller gave it (the engine's render),
  // *before* the display's fine detail texture — the physically meaningful
  // values, not the display ones.
  rawElevations: Float32Array
  // The values actually used for elevationToColor (with the fine detail
  // texture) — what a debug 3D heightmap preview (see GeneratorScreen.ts)
  // should displace by, so the relief it shows matches what the 2D color
  // map shows.
  elevations: Float32Array
}

export interface RenderSimulationOptions {
  // Terminal-basin truth from the hydrology (the engine's LakeFields, dry_basin/salt_flat):
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

// The colour ramp's own shoreline stop: what a coastal sea cell paints as
// (see the loop's comment).
const SHORE_COLOR = elevationToColor(0)

// Whether any of a cell's eight neighbours is land (above sea level, or a dry
// basin floor that renders as land). Inside the raster through the column
// table (`cols`: DomainGrid colTable(1)); in the first and the last row
// through the grid's own step, which on the sphere crosses the pole to the
// opposite meridian (on the torus it is the wrapped row, as a row table
// gave it).
function touchesLand(elevations: Float32Array, grid: DomainGrid, cols: Int32Array, x: number, y: number, dryBasin: Uint8Array | undefined): boolean {
  const { resX: width, resY: height } = grid
  const edge = y === 0 || y === height - 1
  for (let dy = -1; dy <= 1; dy++) {
    const ny = (y + dy) * width
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const n = edge && dy !== 0 ? grid.neighbour(x, y, dx, dy) : ny + cols[x + dx + 1]
      if (elevations[n] > 0 || (dryBasin !== undefined && dryBasin[n] === 1)) return true
    }
  }
  return false
}

// What the renderer actually reads. Narrower than PlateSimulation on purpose: the
// Archean has no plates, and should not have to fabricate a PlateSimulation just
// to be drawn. An empty `seeds` is a truthful description of that phase, not a
// placeholder.
export interface RenderableWorld {
  width: number
  height: number
  domain: Domain
  seeds: PlateSimulation['seeds']
  rafts: PlateSimulation['rafts']
  warpSeed: number
}

// Renders the simulation's current state into an RGBA buffer: `rendered`
// (the engine's render, width × height) determines every pixel's color; the
// plate boundaries, the relief and the labels come with it as separate
// layers. Async because the pipeline awaits it between a step and the next
// (pipeline/runtime.ts).
export async function renderSimulationImage(sim: RenderableWorld, rendered: Float32Array, options: RenderSimulationOptions = {}): Promise<SimulationRenderResult> {
  const { width, height } = sim
  const grid = sim.domain.grid(width, height)
  // The Archean phase runs with no plates at all — plate tectonics has not started
  // yet (see archean/). Everything plate-shaped below is therefore skipped rather
  // than given a second render function: the elevation raster, hillshade and colour
  // ramp are ~90% of this and need no plates, so a parallel renderer would be
  // almost entirely duplication. "No plates yet" is an honest special case.
  const hasPlates = sim.seeds.length > 0
  const cellIds = hasPlates ? rasterizeVoronoiPlates(sim.seeds, sim.domain) : new Uint16Array(width * height)
  const buffer = new Uint8Array(width * height * 4)

  // Copied rather than used directly — the fine detail texture below
  // mutates in place, and the caller may keep the array.
  const elevations = rendered.slice()
  const rawElevations = elevations.slice()

  // Slope-conditioned fine detail — see erosionDetailTexture.ts. Reads slope
  // from rawElevations (physically meaningful) but paints onto `elevations`.
  if (APPLY_EROSION_DETAIL_TEXTURE) applyErosionDetailTexture(elevations, rawElevations, grid, sim.warpSeed)

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
  // The land counted by AREA (cellArea: 1 a cell on the torus, so a plain
  // count there; on the sphere the polar rows' cells are small).
  let landArea = 0
  let totalArea = 0
  for (let y = 0; y < height; y++) totalArea += grid.cellArea(y) * width
  const cols = grid.colTable(1)
  for (let y = 0; y < height; y++) {
    // The row below; the last row's through the grid's step (across the
    // south pole on the sphere, the wrap on the torus).
    const lastRow = y === height - 1
    const downRow = (y + 1) * width
    const rowArea = grid.cellArea(y)
    for (let x = 0; x < width; x++) {
      const right = y * width + cols[x + 2]
      const down = lastRow ? grid.neighbour(x, y, 0, 1) : downRow + x
      const idx = y * width + x
      const plateIndex = cellIds[idx]
      if (plateIndex !== cellIds[right] || plateIndex !== cellIds[down]) boundaryMask[idx] = 1
      const elevation = elevations[idx]
      const dryFloor = options.dryBasin !== undefined && options.dryBasin[idx] === 1
      if (elevation > 0 || dryFloor) landArea += rowArea
      const shade = reliefShadeAt(elevations, idx, right, down)
      relief[idx] = (elevation > 0 || dryFloor ? 128 : 0) | Math.round(shade * 127)
      // A sea cell next to land paints as SHORE, not as water: the water
      // itself is drawn at draw time as the iso-line of its level on the
      // interpolated terrain (map/waterMaterialPlugin.ts), so what can show
      // of this cell's own colour is the sliver of it the interpolation puts
      // above the level — land, at the shoreline's height.
      const color = dryFloor
        ? (options.saltFlat !== undefined && options.saltFlat[idx] === 1 ? SALT_CRUST_COLOR : BASIN_ROCK_COLOR)
        : elevation <= 0 && touchesLand(elevations, grid, cols, x, y, options.dryBasin)
          ? SHORE_COLOR
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
  const raftLabels = computeRaftLabelPlacements(sim.rafts, sim.domain)

  return { buffer, relief, boundaryMask, raftLabels, landFraction: landArea / totalArea, rawElevations, elevations }
}

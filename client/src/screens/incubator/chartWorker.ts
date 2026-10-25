import { domainOfKind, type Domain } from '../../generator/core/domain'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { rasteriseNodeField } from '../../generator/mesh/meshRaster'
import { reliefShadeAt } from '../../generator/render/reliefShade'
import type { WaterBody } from '../../generator/surface/hydrology'
import { dilateLandBiomes, expandBiomeIds } from '../../map/biomeIds'
import { buildPaperBase, buildUnshadedPaperBase } from '../../map/paperBase'
import { applyLakeWash, applyTerrainWash, DEFAULT_TERRAIN_WASH } from '../../map/terrainPalette'
import { meshLevelMesh, type MeshLevelArtifact } from '../../world/meshArtifacts'
import { waterLevelsFromBodies } from './waterLevels'

// THE INCUBATOR'S CHART WORKER: level 1 painted onto the chart as the
// generator paints its world (2026-10-23): the paper with its hillshade
// (map/paperBase.ts), the terrain wash by biome and the lakes
// (map/terrainPalette.ts) — only at the level's resolution, not the
// world raster's. One paint per world; off the main thread, because the
// level's mesh and a chart of 8192 × 4096 are seconds and a gigabyte.
//
// The heights are level 1's. The biomes are the save's (level 0's
// nodes, on the world raster): the level has no classification of its
// own, so they are spread over the level's coast (dilateLandBiomes) and
// widened to the chart. The lakes stand at the levels the level's own
// water bodies give on the world raster (waterLevels.ts), and their
// shores are where the level's chart heights cross them.
//
// Two paints of each: with the terrain wash, and the bare paper (white
// land with its hillshade, as the generator's map with its terrain colour
// off). The screen switches between them; the lakes are on both.

export interface ChartWorkerInbound {
  kind: Domain['kind']
  // The world raster's size, cells (the save's), and the chart's, texels.
  width: number
  height: number
  chartWidth: number
  chartHeight: number
  level: Pick<MeshLevelArtifact, 'count' | 'nodes' | 'connectivity' | 'z'> & { waterBodies: WaterBody[] }
  // The save's biome ids on the world raster, or null.
  biome: Float32Array | null
  detailSeed: number
}

export type ChartWorkerOutbound =
  | {
    type: 'painted'
    // With the terrain wash.
    shaded: Uint8ClampedArray
    unshaded: Uint8ClampedArray
    // The bare paper.
    paperShaded: Uint8ClampedArray
    paperUnshaded: Uint8ClampedArray
    ms: Record<string, number>
  }
  | { type: 'failed'; message: string }

const worker = self as unknown as Worker

worker.onmessage = (event: MessageEvent<ChartWorkerInbound>): void => {
  try {
    paint(event.data)
  } catch (e) {
    worker.postMessage({ type: 'failed', message: String(e) } satisfies ChartWorkerOutbound)
  }
}

function paint(message: ChartWorkerInbound): void {
  const { kind, width, height, chartWidth: W, chartHeight: H, level } = message
  const ms: Record<string, number> = {}
  let started = performance.now()
  const step = (name: string): void => {
    const now = performance.now()
    ms[name] = Math.round(now - started)
    started = now
  }
  const mesh = meshLevelMesh({ ...level, level: 1, waterBodies: level.waterBodies, graph: null, rivers: null }, width, height, kind)
  step('mesh')
  // The water's levels on the world raster, from the level's terrain
  // there.
  const coarse = rasteriseNodeField(mesh, level.z, width, height)
  const water = waterLevelsFromBodies(level.waterBodies, coarse, width, height, kind === 'torus')
  step('water')
  const elevation = rasteriseNodeField(mesh, level.z, W, H)
  step('raster')
  // THE HILLSHADE as the generator's (reliefShade.ts), whose exaggeration
  // is set for a difference between neighbours on the world raster: on
  // the chart a texel is W / width times narrower, and its difference as
  // many times smaller on the same slope. So the heights it shades are
  // scaled by that, and a slope reads as it does in the generator. The
  // same buffer then holds the lakes' depths.
  const scaled = new Float32Array(W * H)
  const gain = W / width
  for (let i = 0; i < scaled.length; i++) scaled[i] = elevation[i] * gain
  // Packed as the generator's render packs it (elevationMapImage.ts): the
  // land bit and the shade, the last row's neighbour below through the
  // grid (across the pole on the sphere, where a row table cannot say it).
  const grid = domainOfKind(kind, width, height).grid(W, H)
  const cols = grid.colTable(1)
  const relief = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const down = y === H - 1 ? grid.neighbour(x, y, 0, 1) : i + W
      relief[i] = (elevation[i] > 0 ? 128 : 0) | Math.round(reliefShadeAt(scaled, i, y * W + cols[x + 2], down) * 127)
    }
  }
  const paperShaded = buildPaperBase(relief)
  const paperUnshaded = buildUnshadedPaperBase(relief)
  const shaded = paperShaded.slice()
  const unshaded = paperUnshaded.slice()
  step('paper')
  let ids: Uint8Array | null = null
  if (message.biome) {
    ids = expandBiomeIds(dilateLandBiomes(message.biome, width, height), width, height, W, H, message.detailSeed)
    applyTerrainWash(shaded, relief, ids, DEFAULT_TERRAIN_WASH)
    applyTerrainWash(unshaded, relief, ids, DEFAULT_TERRAIN_WASH)
  }
  step('wash')
  // A lake's depth at a texel, metres: its body's level (the world cell's,
  // nearest) over the texel's own height.
  const depth = scaled
  for (let y = 0; y < H; y++) {
    const row = Math.min(height - 1, Math.floor((y * height) / H)) * width
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const cell = row + Math.min(width - 1, Math.floor((x * width) / W))
      depth[i] = water.surface[cell] === 1 && water.body[cell] >= 0 ? Math.max(0, (water.level[cell] - elevation[i]) * ELEVATION_METERS) : 0
    }
  }
  for (const chart of [shaded, unshaded, paperShaded, paperUnshaded]) applyLakeWash(chart, depth, ids)
  step('lakes')
  worker.postMessage({ type: 'painted', shaded, unshaded, paperShaded, paperUnshaded, ms } satisfies ChartWorkerOutbound, [shaded.buffer, unshaded.buffer, paperShaded.buffer, paperUnshaded.buffer])
}

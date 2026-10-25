import { domainOfKind, type Domain } from '../../generator/core/domain'
import { ELEVATION_METERS } from '../../generator/elevation/elevationScale'
import { rasteriseNodeField } from '../../generator/mesh/meshRaster'
import type { PeriodicTriangulation } from '../../generator/mesh/periodicDelaunay'
import { barycentric } from '../../generator/mesh/remesh'
import { reliefShadeAt } from '../../generator/render/reliefShade'
import type { WaterBody } from '../../generator/surface/hydrology'
import { dilateLandBiomes, expandBiomeIds } from '../../map/biomeIds'
import { buildPaperBase, buildUnshadedPaperBase } from '../../map/paperBase'
import { applyLakeWash, applyTerrainWash, DEFAULT_TERRAIN_WASH } from '../../map/terrainPalette'
import { meshLevelMesh, type LevelLand, type MeshLevelArtifact } from '../../world/meshArtifacts'
import { waterLevelsFromBodies } from './waterLevels'

// THE INCUBATOR'S CHART WORKER: level 1 painted onto the chart as the
// generator paints its world (2026-10-23): the paper with its hillshade
// (map/paperBase.ts), the terrain wash by biome and the lakes
// (map/terrainPalette.ts) — only at the level's resolution, not the
// world raster's. One paint per world; off the main thread, because the
// level's mesh and a chart of 8192 × 4096 are seconds and a gigabyte.
//
// The heights are level 1's. The biomes are level 1's own, per node
// (its land fields, docs/decisions/level-waters.md): a texel takes its
// triangle's nearest corner, a land corner on land. A level made before
// them has none: then the save's (level 0's nodes, on the world raster),
// spread over the level's coast (dilateLandBiomes) and widened to the
// chart. The lakes stand at the levels the level's own water bodies give
// on the world raster (waterLevels.ts), and their shores are where the
// level's chart heights cross them.
//
// With the biomes it answers which node a texel shows, at half the
// chart's resolution (`nodes`, a texel of it for 2 × 2 of the chart): the
// screen draws a node field from it — the ecology's — without the mesh.
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
  // The level's land and biome per node, or null for a level without its
  // land fields.
  land: Pick<LevelLand, 'land' | 'biome'> | null
  // The save's biome ids on the world raster, or null: for a level
  // without its land fields.
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
    // The node each texel of the half-resolution chart shows, or null for
    // a level without its land fields.
    nodes: Int32Array | null
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
  const pass = message.land ? chartPass(mesh, level.z, message.land, W, H) : null
  const elevation = pass ? pass.elevation : rasteriseNodeField(mesh, level.z, W, H)
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
  let ids: Uint8Array | null = pass ? pass.biome : null
  if (!ids && message.biome) ids = expandBiomeIds(dilateLandBiomes(message.biome, width, height), width, height, W, H, message.detailSeed)
  if (ids) {
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
  const nodes = pass ? pass.nodes : null
  const transfer = [shaded.buffer, unshaded.buffer, paperShaded.buffer, paperUnshaded.buffer]
  if (nodes) transfer.push(nodes.buffer)
  worker.postMessage({ type: 'painted', shaded, unshaded, paperShaded, paperUnshaded, nodes, ms } satisfies ChartWorkerOutbound, transfer)
}

// One walk over the chart for the heights, the biomes and the nodes. The
// heights as rasteriseNodeField gives them (the same walk, the same sum in
// the same order, so the same bits); the biome of the triangle's nearest
// corner, of its nearest land corner where the texel is land; the nearest
// corner on every second row and column for `nodes`.
function chartPass(mesh: PeriodicTriangulation, z: Float32Array, land: Pick<LevelLand, 'land' | 'biome'>, W: number, H: number): { elevation: Float32Array; biome: Uint8Array; nodes: Int32Array } {
  const elevation = new Float32Array(W * H)
  const biome = new Uint8Array(W * H)
  const half = W >> 1
  const nodes = new Int32Array(half * (H >> 1))
  const sx = mesh.domain.width / W
  const sy = mesh.domain.height / H
  const bary = new Float64Array(3)
  const corner = new Int32Array(3)
  let hint = mesh.lastTri
  let rowStart = hint
  for (let py = 0; py < H; py++) {
    const y = py * sy
    hint = rowStart
    for (let px = 0; px < W; px++) {
      const x = px * sx
      const t = mesh.locate(x, y, hint)
      hint = t
      if (px === 0) rowStart = t
      barycentric(mesh, t, x, y, bary)
      corner[0] = mesh.tris[3 * t]
      corner[1] = mesh.tris[3 * t + 1]
      corner[2] = mesh.tris[3 * t + 2]
      const i = py * W + px
      const h = bary[0] * z[corner[0]] + bary[1] * z[corner[1]] + bary[2] * z[corner[2]]
      elevation[i] = h
      let near = 0
      for (let k = 1; k < 3; k++) if (bary[k] > bary[near]) near = k
      let nearLand = -1
      if (h > 0) for (let k = 0; k < 3; k++) if (land.land[corner[k]] && (nearLand < 0 || bary[k] > bary[nearLand])) nearLand = k
      biome[i] = land.biome[corner[nearLand >= 0 ? nearLand : near]]
      if (((px | py) & 1) === 0) nodes[(py >> 1) * half + (px >> 1)] = corner[near]
    }
  }
  return { elevation, biome, nodes }
}

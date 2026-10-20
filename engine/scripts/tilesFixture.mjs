// Writes the module test fixture for the engine's tiles: hashes of what
// the TypeScript engine's mesh/cubeAtlas.ts, mesh/meshTile.ts,
// mesh/meshTileCube.ts, mesh/tileLayout.ts, pipeline/tilePlan.ts and
// pipeline/meshTileBake.ts make of a stand-in level 1 on each shape — the
// plan, level-2 tiles (one with an upstream tile, on the pool), and a
// level-3 tile on its patchwork parent — which the Rust port must make
// bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/tilesFixture.mjs           write the fixture
//   node engine/scripts/tilesFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/tiles.rs runs the same scenarios: change one,
// change the other. The pool runs on real worker threads
// (client/scripts/engineWorkerHost.mjs).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/tiles.txt', import.meta.url)
const HOST = new URL('../../client/scripts/engineWorkerHost.mjs', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { compactMesh, permute } = await L('/src/generator/mesh/meshSerial.ts')
const { createMeshSampler } = await L('/src/generator/mesh/meshSampler.ts')
const { meshRouting, meshAreas } = await L('/src/generator/mesh/meshHydrology.ts')
const { climateMesh } = await L('/src/generator/climate/climateMesh.ts')
const { climateCellsFromSaved, climateAtPoints, meshPoints, meanLandRunoff } = await L('/src/generator/climate/climatePoints.ts')
const CA = await L('/src/generator/mesh/cubeAtlas.ts')
const MT = await L('/src/generator/mesh/meshTile.ts')
const MC = await L('/src/generator/mesh/meshTileCube.ts')
const TL = await L('/src/generator/mesh/tileLayout.ts')
const TP = await L('/src/generator/pipeline/tilePlan.ts')
const TB = await L('/src/generator/pipeline/meshTileBake.ts')
const B = await L('/src/generator/pipeline/meshBakeStage.ts')
const { bakedTileToArtifact } = await L('/src/world/meshTileArtifacts.ts')
await server.close()

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
  if (v === true) v = 1
  else if (v === false) v = 0
  if (v !== v) {
    w[1] = 0x7ff80000
    w[0] = 0
  } else f[0] = v
  h = Math.imul(h ^ w[0], 0x01000193) >>> 0
  h = Math.imul(h ^ w[1], 0x01000193) >>> 0
}
const addAll = (a) => {
  for (let i = 0; i < a.length; i++) add(a[i])
}
const hex = () => h.toString(16).padStart(8, '0')
const lines = [
  '# Hashes of client/src/generator/mesh/cubeAtlas.ts, meshTile.ts, meshTileCube.ts, tileLayout.ts and pipeline/tilePlan.ts, meshTileBake.ts, for crates/casas-engine/tests/tiles.rs.',
  '# Written by engine/scripts/tilesFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const named = (o) => { for (const [k, v] of Object.entries(o)) { for (let i = 0; i < k.length; i++) add(k.charCodeAt(i)); add(v) } }
const tileId = (t) => { add(t.level); add(t.x); add(t.y) }
const meshHash = (m) => { addAll(m.vx.subarray(0, m.vertexSlots)); addAll(m.vy.subarray(0, m.vertexSlots)); addAll(m.tris.subarray(0, 3 * m.triSlots)) }
const bakedHash = (b) => {
  const t = b.tile
  tileId(t.tile); add(t.originX); add(t.originY); add(t.halo)
  meshHash(t.mesh); addAll(t.z); addAll(t.role); addAll(t.worldX); addAll(t.worldY)
  addAll(b.z); addAll(b.routing.flowTarget); addAll(b.routing.accumulation); addAll(b.routing.popOrder); add(b.routing.poppedCount)
  add(b.inflows); add(b.inflowDischarge); add(b.upstreamInflow); add(b.upstreamNodes); addAll(b.outflow); add(b.erodedFluxM3)
}
const spawn = () => {
  const worker = new Worker(HOST)
  worker.on('error', (e) => {
    console.error(`worker error: ${e?.message ?? e}`)
    process.exit(1)
  })
  return worker
}

// The cube atlas alone.
h = 0x811c9dc5
for (const [n, r] of [[3, CA.IDENTITY], [5, CA.rotationAbout(0.48, 0.6, 0.64, 0.7)]]) {
  const atlas = new CA.CubeAtlas(n, r)
  for (let index = 0; index < atlas.tileCount; index += 7) {
    const t = atlas.tileOfIndex(index)
    for (const p of atlas.corners(t)) addAll(p)
    addAll(atlas.centre(t))
    for (let s = 0; s < 4; s++) {
      const nb = atlas.neighbour(t, s)
      add(atlas.indexOf(nb.tile)); add(nb.side)
      const e = CA.sideEnds(atlas, t, s)
      addAll(e.a); addAll(e.b); add(e.reversed)
      addAll(CA.sidePoint(atlas, e.a, e.b, 0.37))
    }
    for (const c of atlas.cornerNeighbours(t)) add(atlas.indexOf(c))
    const fr = atlas.frame(t, 160)
    addAll(fr.centre); addAll(fr.e1); addAll(fr.e2)
    const at = { x: 0, y: 0 }
    const q = CA.unproject(fr, 3.5, -2.25)
    addAll(q)
    add(CA.project(fr, q, at)); add(at.x); add(at.y)
    const tg = atlas.faceTangents(t.face, atlas.toCube(q))
    if (tg) addAll(tg)
    addAll(atlas.facePoint(t.face, 0.1, -0.3))
    add(atlas.indexOf(atlas.tileAt(q)))
  }
}
for (let k = 0; k < 50; k++) add(MT.hash01(k * 37 - 400, k * k, k % 7 + 64, (k * 2654435761) >>> 0))
for (const level of [2, 3]) { named(MT.tileConstants(MT.tileSpec(level))); named(MC.cubeConstants(level)) }
line('atlas')

const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.02 - 0.06 * Math.max(0, detSin(x * 0.011 + 2) * detCos(y * 0.013 + 1) - 0.6)
const W = 1024
const H = 512
for (const [name, world] of [['torus', torusDomain(W, H)], ['sphere', sphereDomain(W, H)]]) {
  // A stand-in level 1, canonical as its artifact is.
  const built = buildMesh(world, { heightAt }, { seed: 7, budget: 2 })
  const { mesh: level1, order } = compactMesh(built.mesh)
  const z1 = permute(built.state.get(MESH_Z), order)
  const routing = meshRouting(level1, z1)
  // The climate per cell, and level 1's waters from it.
  const cm = climateMesh(world)
  const nc = cm.mesh.count
  const climate = { cells: nc, spacingM: cm.cellM, seaLevelTemperature: new Float32Array(nc), precipitation: new Float32Array(nc), seasonalAmplitude: new Float32Array(nc), monsoonIndex: new Float32Array(nc) }
  for (let i = 0; i < nc; i++) {
    const x = cm.mesh.x[i]
    const y = cm.mesh.y[i]
    const lat = Math.abs(y / H - 0.5) * 2
    const land = heightAt(x, y) > 0
    climate.seaLevelTemperature[i] = 28 - 40 * lat + 3 * detSin(x * 0.02)
    climate.precipitation[i] = land ? 300 + 900 * (1 + detSin(x * 0.009 + y * 0.005)) : -1
    climate.seasonalAmplitude[i] = 4 + 14 * lat
    climate.monsoonIndex[i] = land ? 0.7 * detCos(x * 0.004) : -1
  }
  const cells = climateCellsFromSaved(world, climate)
  const at = climateAtPoints(cells, meshPoints(level1, z1))
  const meanLandWater = meanLandRunoff(cells)
  const water = B.levelHydrology(level1, z1, routing, meshAreas(level1), new Float32Array(level1.vertexSlots), { precipitation: at.precipitation, temperature: at.temperature, monsoonIndex: at.monsoonIndex, meanRunoff: meanLandWater }, { width: W, height: H, budget: 2, detailSeed: 4242 })

  // The layout and the plan.
  h = 0x811c9dc5
  for (const level of [2, 3]) {
    const { cols, rows } = TL.tileGridOn(world, level)
    add(cols); add(rows)
    for (let k = 0; k < 40; k++) {
      const t = TL.tileAtOn(level, (k * 97.31) % W, (k * 53.77) % H, world)
      tileId(t)
      if (level === 3) for (const p of TL.parentTilesOn(t, MT.tileSpec(2), world)) tileId(p)
    }
  }
  // A level's land tiles: in a window, where the tile's centre is land.
  const landTiles = (level) => {
    const spec = MT.tileSpec(level)
    const out = []
    if (world.kind === 'sphere') {
      MC.cubeTileSamples(world, level, 1, (t, xs, ys) => {
        if (t.x < MC.cubeAtlasOf(world, level).n && t.y >= 4 && heightAt(xs[0], ys[0]) > 0 && out.length < (level === 2 ? 14 : 6)) out.push(t)
      })
      return out
    }
    const [x0, x1, y0, y1] = level === 2 ? [18, 26, 8, 14] : [40, 46, 20, 24]
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const c = MT.tileCorner({ level, x, y }, spec)
      if (heightAt(c.x + spec.cells / 2, c.y + spec.cells / 2) > 0) out.push({ level, x, y })
    }
    return out
  }
  const plan = TP.planTiles({ mesh: level1, z: z1, routing, width: W, height: H, levels: [2, 3], landTiles })
  const planHash = (plan) => { for (const p of plan) { tileId(p.tile); add(p.parents.length); for (const t of p.parents) tileId(t); add(p.upstream.length); for (const t of p.upstream) tileId(t) } }
  planHash(plan)
  // A drainage that jumps between tiles at random, both ways along most
  // edges and round longer cycles, for the cuts.
  const n1 = level1.vertexSlots
  const jumps = { flowTarget: new Int32Array(n1), accumulation: new Float32Array(n1), filled: z1, popOrder: new Int32Array(0), poppedCount: 0 }
  for (let v = 0; v < n1; v++) {
    jumps.flowTarget[v] = v % 11 === 0 ? -1 : (v * 7919 + 13) % n1
    jumps.accumulation[v] = (v % 97) + 0.5
  }
  const cyclic = TP.planTiles({ mesh: level1, z: z1, routing: jumps, width: W, height: H, levels: [2, 3], landTiles })
  planHash(cyclic)
  console.log(name, 'upstream edges', plan.reduce((a, p) => a + p.upstream.length, 0), cyclic.reduce((a, p) => a + p.upstream.length, 0))
  line(`${name}_plan`)

  // Level 2: the tiles a level-3 tile needs, then one with upstream tiles.
  const macro = createMeshSampler(level1, z1)
  const parent2 = { mesh: level1, z: z1, discharge: null, sampler: macro, macro }
  const inputs = (parent, upstream) => ({ parent, parentGraph: water.graph, width: W, height: H, detailSeed: 4242, lithoSeed: 99, controls: { alluvium: 60, rockContrast: 35 }, uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0, climate, meanLandWater, upstream })
  // The level-3 tile with the most parents, the first of them.
  const l3 = plan.filter((p) => p.tile.level === 3).reduce((a, b) => (b.parents.length > a.parents.length ? b : a))
  // The level-2 tile the largest of level 1's rivers enters.
  let riverTile = null
  let riverQ = -1
  for (const r of water.graph.reaches) {
    if (r.kind !== 'river') continue
    for (let i = 1; i < r.cellCount; i++) {
      const a = TL.tileAtOn(2, water.graph.cellX[r.cellStart + i - 1], water.graph.cellY[r.cellStart + i - 1], world)
      const b = TL.tileAtOn(2, water.graph.cellX[r.cellStart + i], water.graph.cellY[r.cellStart + i], world)
      if ((a.x !== b.x || a.y !== b.y) && r.dischargeOut > riverQ) { riverQ = r.dischargeOut; riverTile = b }
    }
  }
  const withUpstream = plan.find((p) => p.tile.level === 2 && p.upstream.length > 0)
  console.log(name, 'tiles', plan.length, 'level 3', l3 && l3.parents.length, 'upstream', withUpstream && withUpstream.upstream.length)
  const artifacts = new Map()
  const key = (t) => `${t.x},${t.y}`
  h = 0x811c9dc5
  for (const t of [...l3.parents, ...withUpstream.upstream]) {
    if (artifacts.has(key(t))) continue
    const baked = await TB.bakeMeshTile(inputs(parent2, []), t, { rounds: 2 })
    bakedHash(baked)
    artifacts.set(key(t), bakedTileToArtifact(baked))
  }
  const river = await TB.bakeMeshTile(inputs(parent2, []), riverTile, { rounds: 2 })
  bakedHash(river)
  console.log(name, 'river tile inflows', river.inflows, river.inflowDischarge)
  const upstream = withUpstream.upstream.map((t) => { const a = artifacts.get(key(t)); return { tile: t, count: a.count, nodes: a.nodes, outflow: a.outflow } })
  const baked = await TB.bakeMeshTile(inputs(parent2, upstream), withUpstream.tile, { rounds: 6, pool: { createWorker: spawn, stencilWorkers: 2, refreshWorkers: 1 } })
  bakedHash(baked)
  console.log(name, 'level 2 nodes', baked.tile.mesh.vertexSlots, 'inflows', baked.inflows, 'upstream nodes', baked.upstreamNodes)
  line(`${name}_level2`)

  // Level 3 on its patchwork.
  h = 0x811c9dc5
  const pieces = l3.parents.map((t) => { const a = artifacts.get(key(t)); return { tile: t, count: a.count, nodes: a.nodes, z: a.z } })
  const patch = TL.tileParentOn(pieces, world)
  // The patchwork's heights and region, not its triangulation: removing a
  // lattice node of degree over 64 overruns PeriodicTriangulation.remove's
  // star of 64 (periodicDelaunay.ts) and picks its ears among the first 64
  // only, which the Rust triangulation does not copy. The triangles the
  // tile reads come out the same (the level-3 tile below is checked bit
  // for bit); the slots and the far lattice nodes do not.
  addAll(patch.z); add(patch.region.x); add(patch.region.y); add(patch.region.width); add(patch.region.height); add(patch.region.nodes)
  const parent3 = { mesh: patch.mesh, z: patch.z, discharge: null, sampler: createMeshSampler(patch.mesh, patch.z, patch.region), macro }
  const b3 = await TB.bakeMeshTile(inputs(parent3, []), l3.tile, { rounds: 2 })
  bakedHash(b3)
  console.log(name, 'level 3 nodes', b3.tile.mesh.vertexSlots, 'inflows', b3.inflows)
  line(`${name}_level3`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/tiles.txt is stale — run node engine/scripts/tilesFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`tiles fixture: ${lines.length - 2} lines`)
}
process.exit(0)

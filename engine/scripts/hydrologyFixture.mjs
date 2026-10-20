// Writes the module test fixture for the engine's hydrology: hashes of
// what the TypeScript engine's surface/hydrology.ts over the mesh's flow
// substrate (mesh/meshHydrology.ts), mesh/meshRaster.ts and
// mesh/meshSerial.ts make on a built mesh of each shape with a synthetic
// climate, which the Rust port must make bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/hydrologyFixture.mjs           write the fixture
//   node engine/scripts/hydrologyFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/hydrology.rs runs the same scenarios: change
// one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/hydrology.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { DEFAULT_ENGINE_PARAMS } = await L('/src/generator/surface/erosionEngine.ts')
const MH = await L('/src/generator/mesh/meshHydrology.ts')
const H = await L('/src/generator/surface/hydrology.ts')
const MR = await L('/src/generator/mesh/meshRaster.ts')
const MS = await L('/src/generator/mesh/meshSerial.ts')
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
  '# Hashes of client/src/generator/surface/hydrology.ts over mesh/meshHydrology.ts, and of mesh/meshRaster.ts and mesh/meshSerial.ts, for crates/casas-engine/tests/hydrology.rs.',
  '# Written by engine/scripts/hydrologyFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const KIND = { lake: 0, terminal: 1, dry: 2 }
const bodiesHash = (bodies) => {
  for (const b of bodies) {
    add(b.id); add(KIND[b.kind]); add(b.level); add(b.spill); add(b.floor)
    add(b.seedX); add(b.seedY); add(b.outletX); add(b.outletY); add(b.cells); add(b.frozen)
  }
}

const heightAt = (x, y) => 0.09 * detSin(x * 0.006) * detCos(y * 0.008) + 0.05 * detSin(x * 0.019 + y * 0.011) + 0.03 * detCos(x * 0.043 - y * 0.027) - 0.02 - 0.06 * Math.max(0, detSin(x * 0.011 + 2) * detCos(y * 0.013 + 1) - 0.6)
const sampler = { heightAt, dischargeAt: (x, y) => 2500 * (1 + detSin(x * 0.05 + y * 0.03)) }

for (const [name, domain] of [['torus', torusDomain(2048, 1024)], ['sphere', sphereDomain(2048, 1024)]]) {
  const { mesh, state: ms } = buildMesh(domain, sampler, { seed: 7, budget: 12 })
  const slots = mesh.vertexSlots
  const z = ms.get(MESH_Z).slice(0, slots)
  const routing = MH.meshRouting(mesh, z, DEFAULT_ENGINE_PARAMS)
  const areas = MH.meshAreas(mesh)
  const sub = MH.meshSubstrate(mesh, routing, areas)
  const temp = new Float32Array(slots)
  const precip = new Float32Array(slots)
  const monsoon = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    const lat = Math.abs(mesh.vy[v] / domain.height - 0.5) * 2
    temp[v] = 28 - 45 * lat + 4 * detSin(mesh.vx[v] * 0.01) - (z[v] > 0 ? z[v] * 58 : 0)
    precip[v] = z[v] > 0 ? 100 + 700 * (1 + detSin(mesh.vx[v] * 0.007 + mesh.vy[v] * 0.004)) : -1
    monsoon[v] = z[v] > 0 ? 0.8 * detCos(mesh.vx[v] * 0.003) : -1
  }
  h = 0x811c9dc5
  addAll(routing.flowTarget)
  addAll(routing.filled)
  addAll(routing.accumulation)
  addAll(routing.popOrder)
  add(routing.poppedCount)
  addAll(areas)
  const bare = H.accumulateDischargeOn(sub, z, precip)
  const discharge = H.accumulateDischargeOn(sub, z, precip, temp)
  addAll(bare)
  addAll(discharge)
  const lakes = H.computeLakesOn(sub, discharge, z, temp)
  for (const k of ['depth', 'saltFlat', 'dryBasin', 'frozen', 'level', 'body']) addAll(lakes[k])
  add(lakes.bodies.length)
  bodiesHash(lakes.bodies)
  const kinds = [0, 0, 0]
  for (const b of lakes.bodies) kinds[KIND[b.kind]]++
  // A hot world with a trickle of inflow: the terminal basins dry out.
  const hot = temp.map((t) => t + 25)
  const trickle = discharge.map((q) => q * 0.02)
  const dry = H.computeLakesOn(sub, trickle, z, hot, 2)
  for (const k of ['depth', 'saltFlat', 'dryBasin', 'frozen', 'level', 'body']) addAll(dry[k])
  bodiesHash(dry.bodies)
  for (const b of dry.bodies) kinds[KIND[b.kind]]++
  console.log(name, 'bodies', kinds)
  line(`${name}_lakes`)

  h = 0x811c9dc5
  const regime = H.accumulateRegimeInputsOn(sub, z, temp, precip, monsoon)
  addAll(regime.loss)
  addAll(regime.dry)
  const mt = new Float32Array(12 * slots)
  const mp = new Float32Array(12 * slots)
  for (let m = 0; m < 12; m++) {
    for (let v = 0; v < slots; v++) {
      mt[m * slots + v] = temp[v] + 12 * detCos(m * 0.523 + (mesh.vy[v] < domain.height / 2 ? 0 : 3.1))
      mp[m * slots + v] = precip[v] < 0 ? -1 : precip[v] * (1 + 0.9 * detSin(m * 0.523 + v * 0.001))
    }
  }
  const regime2 = H.accumulateRegimeInputsOn(sub, z, temp, precip, monsoon, { temperature: mt, precipitation: mp, count: 12 })
  addAll(regime2.loss)
  addAll(regime2.dry)
  const maxQ = H.maxDischargeOverLand(discharge, z)
  add(maxQ)
  let landSum = 0
  let landArea = 0
  for (let v = 0; v < slots; v++) if (z[v] > 0) { landSum += Math.max(0, precip[v]) * areas[v]; landArea += areas[v] }
  const threshold = H.channelThreshold(H.densityToCriticalArea(H.CANONICAL_RIVER_DENSITY, domain), landSum / landArea)
  add(threshold)
  add(H.channelReferenceSlopeOn(sub, z, discharge, threshold))
  addAll(H.buildChannelMaskOn(sub, z, discharge, threshold))
  addAll(H.watershedsOn(sub, z))
  addAll(H.watershedsOn(sub, z, 1000))
  addAll(H.riparianPrecipitationOn(sub, z, discharge, threshold, maxQ, lakes.depth, lakes.frozen, precip))
  addAll(H.riparianPrecipitationOn(sub, z, discharge, threshold * 0.3, maxQ, lakes.depth, null, precip))
  for (let k = 0; k <= 20; k++) { add(H.dischargeToM3s(k * 1e6, 7800)); add(H.evaporationPotential(-40 + k * 4)); add(H.densityToCriticalArea(k * 6 - 10, domain)) }
  line(`${name}_rivers`)

  // The raster readers: the elevation rasterised, the water on it, the
  // node parts, the coarse readers.
  h = 0x811c9dc5
  const RX = 512
  const RY = 256
  const el = MR.rasteriseNodeField(mesh, z, RX, RY)
  addAll(el)
  const water = MH.waterFieldsFromMesh(mesh, lakes.body, lakes.bodies, el, RX, RY)
  for (const k of ['depth', 'level', 'body', 'surface', 'saltFlat', 'dryBasin', 'frozen']) addAll(water[k])
  const elGrid = domain.scaledTo(RX, RY).grid(RX, RY)
  const scaled = lakes.bodies.map((b) => ({ ...b, seedX: b.seedX * RX / domain.width, seedY: b.seedY * RY / domain.height }))
  const levels = H.waterLevelField(scaled, el, elGrid)
  addAll(levels.level)
  addAll(levels.body)
  addAll(levels.surface)
  addAll(H.lakeDepthFromBodies(scaled, el, elGrid))
  const nodeLand = new Uint8Array(slots)
  for (let v = 0; v < slots; v++) nodeLand[v] = mesh.vAlive[v] && z[v] > 0 ? 1 : 0
  const pixelLand = new Uint8Array(RX * RY)
  for (let p = 0; p < pixelLand.length; p++) pixelLand[p] = el[p] > -0.005 ? 1 : 0
  const plan = MR.triangleRaster(mesh, RX, RY)
  addAll(plan.tri)
  addAll(plan.w0)
  addAll(plan.w1)
  addAll(MR.rasteriseNodePart(mesh, precip, nodeLand, pixelLand, -1, RX, RY, false, undefined, plan))
  addAll(MR.rasteriseNodePart(mesh, lakes.body, nodeLand, null, -7, RX, RY, true))
  const coarse = new Float32Array(64 * 32)
  for (let i = 0; i < coarse.length; i++) coarse[i] = i % 5 === 0 ? -1 : detSin(i * 0.37)
  addAll(MR.nearestCellAtNodes(coarse, 64, 32, mesh))
  addAll(MR.landBilinearAtNodes(coarse, domain.grid(64, 32), mesh))
  add(mesh.lastTri)
  line(`${name}_raster`)

  // The codec and the canonical form.
  h = 0x811c9dc5
  const order = MS.hilbertVertexOrder(mesh)
  addAll(order)
  const serial = MS.encodeMesh(mesh, order)
  add(serial.count)
  addAll(serial.nodes)
  addAll(serial.connectivity)
  const back = MS.decodeMesh(domain, serial)
  addAll(back.vx.subarray(0, back.vertexSlots))
  addAll(back.vy.subarray(0, back.vertexSlots))
  addAll(back.tris.subarray(0, 3 * back.triSlots))
  addAll(back.twin.subarray(0, 3 * back.triSlots))
  const { mesh: compact, order: corder } = MS.compactMesh(mesh)
  addAll(corder)
  addAll(compact.vx.subarray(0, compact.vertexSlots))
  addAll(compact.vy.subarray(0, compact.vertexSlots))
  addAll(compact.tris.subarray(0, 3 * compact.triSlots))
  addAll(compact.twin.subarray(0, 3 * compact.triSlots))
  addAll(compact.vEdge.subarray(0, compact.vertexSlots))
  addAll(MS.permute(z, corder))
  line(`${name}_serial`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/hydrology.txt is stale — run node engine/scripts/hydrologyFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`hydrology fixture: ${lines.length - 2} lines`)
}

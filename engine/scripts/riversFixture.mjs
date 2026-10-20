// Writes the module test fixture for the engine's rivers: hashes of what
// the TypeScript engine's surface/riverGraph.ts, surface/hydrogeology.ts
// and surface/riverCourse.ts make over the mesh's flow substrate on a
// built mesh of each shape with a synthetic climate, which the Rust port
// must make bit for bit (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/riversFixture.mjs           write the fixture
//   node engine/scripts/riversFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/rivers.rs runs the same scenarios: change one,
// change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/rivers.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const { torusDomain, sphereDomain } = await L('/src/generator/core/domain.ts')
const { detSin, detCos } = await L('/src/generator/core/detMath.ts')
const { buildMesh, MESH_Z } = await L('/src/generator/mesh/meshBuild.ts')
const { COLUMN_DEPTH, COLUMN_VALUES } = await L('/src/generator/mesh/meshColumn.ts')
const { DEFAULT_ENGINE_PARAMS } = await L('/src/generator/surface/erosionEngine.ts')
const MH = await L('/src/generator/mesh/meshHydrology.ts')
const H = await L('/src/generator/surface/hydrology.ts')
const RG = await L('/src/generator/surface/riverGraph.ts')
const GW = await L('/src/generator/surface/hydrogeology.ts')
const RC = await L('/src/generator/surface/riverCourse.ts')
const CG = await L('/src/generator/surface/coastGraph.ts')
const SB = await L('/src/generator/surface/sedimentBasins.ts')
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
  '# Hashes of client/src/generator/surface/riverGraph.ts, surface/hydrogeology.ts and surface/riverCourse.ts, for crates/casas-engine/tests/rivers.rs.',
  '# Written by engine/scripts/riversFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${hex()}`)
const NODE = { source: 0, junction: 1, mouth: 2, inlet: 3, outlet: 4 }
const PATTERN = { straight: 0, meandering: 1, braided: 2, anastomosing: 3 }
const graphHash = (g) => {
  add(g.width); add(g.height)
  for (const n of g.nodes) { add(n.id); add(NODE[n.kind]); add(n.cell); add(n.x); add(n.y); add(n.body); add(n.catchmentCells) }
  for (const r of g.reaches) {
    add(r.id); add(r.kind === 'lake'); add(r.from); add(r.to); add(r.cellStart); add(r.cellCount)
    add(r.dischargeIn); add(r.dischargeOut); add(r.widthPx); add(r.lengthKm); add(r.dropM); add(r.slope)
    add(r.sedimentM3); add(r.bank); add(r.order); add(H.RIVER_REGIME_CODE[r.regime]); add(r.runoffOut); add(r.springFed)
  }
  addAll(g.cells); addAll(g.cellX); addAll(g.cellY)
  add(g.bodies.length)
}
const invariantsHash = (o) => { for (const [k, v] of Object.entries(o)) { for (let i = 0; i < k.length; i++) add(k.charCodeAt(i)); add(v) } }
const polyHash = (p) => { addAll(p.points); addAll(p.lengths); addAll(p.regimes) }

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
  const biomes = new Uint8Array(slots)
  const flux = new Float32Array(slots)
  const hardness = new Float32Array(slots)
  const cover = new Float32Array(slots)
  const column = { data: new Float32Array(slots * COLUMN_DEPTH), epochs: [3, 5, 8] }
  for (let v = 0; v < slots; v++) {
    const x = mesh.vx[v]
    const y = mesh.vy[v]
    const lat = Math.abs(y / domain.height - 0.5) * 2
    temp[v] = 28 - 45 * lat + 4 * detSin(x * 0.01) - (z[v] > 0 ? z[v] * 58 : 0)
    precip[v] = z[v] > 0 ? 100 + 700 * (1 + detSin(x * 0.007 + y * 0.004)) : -1
    monsoon[v] = z[v] > 0 ? 0.8 * detCos(x * 0.003) : -1
    biomes[v] = (v * 7 + Math.floor(x / 97)) % 15
    flux[v] = Math.max(0, 1e6 * detSin(x * 0.002 + y * 0.003))
    hardness[v] = 0.2 + 1.5 * (0.5 + 0.5 * detCos(x * 0.004 - y * 0.006))
    cover[v] = 0.5 + 0.5 * detSin(y * 0.009)
    for (let layer = 0; layer < 3; layer++) {
      const at = v * COLUMN_DEPTH + layer * COLUMN_VALUES
      column.data[at] = Math.max(0, 6 * detSin(x * 0.013 + layer * 1.7 + y * 0.002))
      column.data[at + 1] = Math.max(0, 7 * detCos(y * 0.011 - layer * 2.3 + x * 0.003))
    }
  }
  const discharge = H.accumulateDischargeOn(sub, z, precip, temp)
  const lakes = H.computeLakesOn(sub, discharge, z, temp)
  const regime = H.accumulateRegimeInputsOn(sub, z, temp, precip, monsoon)
  const maxQ = H.maxDischargeOverLand(discharge, z)
  const critical = H.densityToCriticalArea(H.CANONICAL_RIVER_DENSITY, domain)
  let landSum = 0
  let landArea = 0
  for (let v = 0; v < slots; v++) if (z[v] > 0) { landSum += Math.max(0, precip[v]) * areas[v]; landArea += areas[v] }
  const threshold = H.channelThreshold(critical, landSum / landArea)
  const inputs = { substrate: sub, discharge, elevation: z, threshold, maxDischarge: maxQ, bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth }

  // The graph, bare and with every input.
  h = 0x811c9dc5
  const bare = RG.buildRiverGraph(inputs)
  graphHash(bare)
  invariantsHash(RG.riverGraphInvariants(bare, z))
  const graph = RG.buildRiverGraph({ ...inputs, sedimentFlux: flux, biomes, regime, criticalArea: critical })
  graphHash(graph)
  invariantsHash(RG.riverGraphInvariants(graph, z))
  const kinds = [0, 0, 0, 0, 0]
  for (const n of graph.nodes) kinds[NODE[n.kind]]++
  // A wet world without evaporation: the lakes spill, and rivers leave them.
  const wetQ = H.accumulateDischargeOn(sub, z, precip.map((p) => p * 4))
  const wetLakes = H.computeLakesOn(sub, wetQ, z, temp.map((t) => t - 30))
  const wet = RG.buildRiverGraph({ ...inputs, discharge: wetQ, maxDischarge: H.maxDischargeOverLand(wetQ, z), bodies: wetLakes.bodies, body: wetLakes.body, lakeDepth: wetLakes.depth })
  graphHash(wet)
  invariantsHash(RG.riverGraphInvariants(wet, z))
  for (const n of wet.nodes) kinds[NODE[n.kind]]++
  console.log(name, 'reaches', graph.reaches.length, wet.reaches.length, 'nodes', kinds, 'lake reaches', wet.reaches.filter((r) => r.kind === 'lake').length)
  line(`${name}_graph`)

  // The hydrogeology over both graphs: with the column and the hardness,
  // and on bare bedrock.
  h = 0x811c9dc5
  const cellM = domain.metresPerUnit
  for (const [g, col, hard] of [[graph, column, hardness], [bare, null, null]]) {
    const ground = GW.computeHydrogeology({ sub, elevation: z, graph: g, column: col, hardness: hard, precipitation: precip, temperature: temp, monsoonIndex: col ? monsoon : undefined, cover, regime, discharge, cellM })
    addAll(ground.permeability)
    addAll(ground.waterTableDepthM)
    for (const s of ground.springs) { add(s.id); add(s.cell); add(s.x); add(s.y); add(s.elevation); add(s.oasis) }
    graphHash(g)
    invariantsHash(GW.hydrogeologyInvariants(ground, g, z))
    console.log(name, 'springs', ground.springs.length, 'oases', ground.springs.filter((s) => s.oasis).length, 'spring-fed', g.reaches.filter((r) => r.springFed).length)
  }
  line(`${name}_ground`)

  // The courses: at the defaults, and down to narrow reaches in fewer steps.
  h = 0x811c9dc5
  const patterns = [0, 0, 0, 0]
  let deltas = 0
  let oxbows = 0
  // The terrain's reaches are all gentler than 0.005, under the straight
  // pattern; a copy thirty times as steep has some.
  const steep = { ...graph, reaches: graph.reaches.map((r) => ({ ...r, slope: r.slope * 30 })) }
  for (const [g, options] of [[steep, { cellM: cellM / 400, seed: 19, domain, minWidthM: 0.01, steps: 4, maxPointsPerReach: 200 }]]) {
    for (const c of RC.computeRiverCourses(g, options)) {
      add(c.reach); add(PATTERN[c.pattern]); add(c.slope)
      for (const l of c.lines) addAll(l)
      addAll(c.lineWidth); add(c.sinuosity)
      patterns[PATTERN[c.pattern]]++
    }
  }
  for (const options of [{ cellM, seed: 7, domain }, { cellM, seed: 11, domain, minWidthM: 5, steps: 30, maxPointsPerReach: 600 }, { cellM: cellM / 20, seed: 13, domain, minWidthM: 0.5, steps: 10, maxPointsPerReach: 300 }, { cellM: cellM / 400, seed: 17, domain, minWidthM: 0.01, steps: 4, maxPointsPerReach: 200 }]) {
    const courses = RC.computeRiverCourses(graph, options)
    for (const c of courses) {
      add(c.reach); add(PATTERN[c.pattern]); add(c.dischargeM3s); add(c.widthM); add(c.depthM); add(c.slope); add(c.bankStrength)
      add(c.lines.length)
      for (const l of c.lines) addAll(l)
      addAll(c.lineWidth); add(c.sinuosity); add(c.beltWidthM)
      add(c.oxbows.length)
      for (const o of c.oxbows) addAll(o)
      addAll(c.lobeAges)
      patterns[PATTERN[c.pattern]]++
      if (c.lobeAges.length > 0) deltas++
      oxbows += c.oxbows.length
    }
    graph.courses = courses
  }
  for (let k = 0; k <= 20; k++) { add(RC.channelWidthM(k * 400 - 100)); add(RC.classifyPattern(k * 300, k * 4e-4, 1e5, 300, k / 20, k % 2) === 'braided') }
  console.log(name, 'patterns', patterns, 'deltas', deltas, 'oxbows', oxbows)
  line(`${name}_courses`)

  // The ribbons: with the courses, with and without the domain; and the
  // bare graph's cell paths.
  h = 0x811c9dc5
  polyHash(RG.riverPolylinesFromGraph(graph, maxQ))
  polyHash(RG.riverPolylinesFromGraph(graph, maxQ, domain))
  polyHash(RG.riverPolylinesFromGraph(bare, maxQ, domain))
  polyHash(RG.riverPolylinesFromGraph(bare, 0))
  line(`${name}_ribbons`)

  // The sediment basins: a deposit over part of the world, with the
  // graph's catchments and on their own.
  h = 0x811c9dc5
  const after = new Float32Array(slots)
  for (let v = 0; v < slots; v++) after[v] = z[v] + 0.004 * (detSin(mesh.vx[v] * 0.01) * detCos(mesh.vy[v] * 0.013)) - 0.0005
  const craton = hardness.map((k) => k - 0.6)
  for (const [g, c, k] of [[graph, craton, hardness], [null, undefined, undefined]]) {
    const r = SB.findSedimentBasins({ mesh, before: z, after, substrate: sub, graph: g, cratonAge: c, hardness: k })
    addAll(r.label)
    for (const b of r.basins) {
      add(b.id); add(b.kind === 'marine'); add(b.nodes); add(b.areaKm2); add(b.volumeKm3); add(b.meanThicknessM); add(b.maxThicknessM)
      add(b.x); add(b.y); addAll(b.mouthReaches); add(b.catchmentKm2); add(b.cratonAge); add(b.hardness)
    }
    invariantsHash(SB.sedimentBasinInvariants(r, z, after))
    console.log(name, 'basins', r.basins.length, 'marine', r.basins.filter((b) => b.kind === 'marine').length, 'fed', r.basins.filter((b) => b.mouthReaches.length > 0).length)
  }
  line(`${name}_basins`)

  // The coast graph, with the rivers and the hardness and without.
  h = 0x811c9dc5
  const windE = new Float32Array(slots)
  const windS = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    windE[v] = 8 * detCos(mesh.vy[v] * 0.004) + 2 * detSin(mesh.vx[v] * 0.003)
    windS[v] = 3 * detSin(mesh.vx[v] * 0.005)
  }
  const TYPES = { rocky: 1, cliff: 2, beach: 3, marsh: 4, delta: 5 }
  for (const [g, k] of [[graph, hardness], [null, undefined]]) {
    const c = CG.buildCoastGraph({ mesh, z, windE, windS, hardness: k, graph: g })
    addAll(c.nodes)
    addAll(c.type)
    for (const r of c.reaches) {
      add(r.id); add(r.nodeStart); add(r.nodeCount); add(r.lengthKm); add(r.exposure); add(r.reliefM); add(r.hardness); add(r.supply); add(TYPES[r.type]); add(r.mouthReach)
    }
    invariantsHash(CG.coastGraphInvariants(c, mesh, z))
    const types = [0, 0, 0, 0, 0, 0]
    for (let v = 0; v < slots; v++) types[c.type[v]]++
    console.log(name, 'coast reaches', c.reaches.length, 'types', types.slice(1))
  }
  add(mesh.lastTri)
  line(`${name}_coast`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/rivers.txt is stale — run node engine/scripts/riversFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(`rivers fixture: ${lines.length - 2} lines`)
}

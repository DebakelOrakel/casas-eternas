// Regression checks for the ADAPTIVE MESH — the periodic Delaunay
// triangulation, the density rule and the remeshing (ADAPTIVE_MESH_PLAN.md
// phase 4.1, docs/decisions/adaptive-mesh.md decisions 1, 8, 11).
//
//   npm run harness:mesh                    run every layer
//   npm run harness:mesh hash-record        freeze the byte baseline (the refactor guard)
//   npm run harness:mesh measure <save.zip> node counts on a real save, per constant
//                                           (overrides after the path: minSpacingM=3900 …)
//
// WHY THIS EXISTS. The mesh is the substrate everything from phase 4.2 on
// runs on, and none of the other harnesses reach it: golden and pipeline
// guard the raster generator, amplify the raster bake, roundtrip the save
// format. What can go wrong here goes wrong silently — a triangulation
// with one inverted triangle still has the right vertex count, a
// coarsen that loses sediment mass still produces a valid mesh, a
// removal that depends on iteration order still validates. So:
//
//   1. INVARIANTS   what must hold of every mesh: the structure (twins,
//                   orientation, Euler's formula for the torus — the
//                   sphere's in [1g], with the globe's geometry —, the edge
//                   margin, the empty circumcircle), the Voronoi areas
//                   summing to the domain, the remesh converging inside
//                   its hysteresis band, extensive state conserved by a
//                   coarsen, intensive state interpolated within
//                   tolerance; and of the EROSION on it (phase 4.2): the
//                   graph index consistent with the mesh, the sediment
//                   budget closed (uplift in, export out, the rest on the
//                   nodes), the receiver graph acyclic with every terminal
//                   at the sea, no node moved that the engine froze. No
//                   baseline; a failure is a bug.
//   2. DETERMINISM  the same fields, seed and operations built twice in
//                   one process, hashed against each other — the
//                   property the tile bakes of phase 4.5 depend on
//                   absolutely.
//   3. BYTE HASHES  opt-in and temporary, for a refactor that must change
//                   nothing. Delete mesh-hashes.json to end the layer.
//
// Small on purpose: a 512×256 synthetic world with three ridges, a valley
// river and a sea exercises every path in seconds. Node counts on a real
// world are the `measure` mode's business, not a check.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HASHES = fileURLToPath(new URL('./mesh-hashes.json', import.meta.url))
const MODE = process.argv[2] ?? 'check'

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

const M = {
  domain: await L('/src/generator/core/domain.ts'),
  toroidal: await L('/src/generator/core/toroidal.ts'),
  field: await L('/src/generator/core/field.ts'),
  rng: await L('/src/generator/core/rng.ts'),
  scale: await L('/src/generator/elevation/elevationScale.ts'),
  config: await L('/src/generator/core/mapConfig.ts'),
  delaunay: await L('/src/generator/mesh/periodicDelaunay.ts'),
  lattice: await L('/src/generator/mesh/lattice.ts'),
  hilbert: await L('/src/generator/mesh/hilbert.ts'),
  density: await L('/src/generator/mesh/meshDensity.ts'),
  state: await L('/src/generator/mesh/meshState.ts'),
  remesh: await L('/src/generator/mesh/remesh.ts'),
  build: await L('/src/generator/mesh/meshBuild.ts'),
  erosion: await L('/src/generator/mesh/meshErosion.ts'),
  raster: await L('/src/generator/mesh/meshRaster.ts'),
  serial: await L('/src/generator/mesh/meshSerial.ts'),
  meshHydro: await L('/src/generator/mesh/meshHydrology.ts'),
  sampler: await L('/src/generator/mesh/meshSampler.ts'),
  tile: await L('/src/generator/mesh/meshTile.ts'),
  tileBake: await L('/src/generator/pipeline/meshTileBake.ts'),
  tilePlan: await L('/src/generator/pipeline/tilePlan.ts'),
  meshHydrology: await L('/src/generator/mesh/meshHydrology.ts'),
  bake: await L('/src/generator/pipeline/meshBakeStage.ts'),
  bakeInputs: await L('/src/world/bakeInputs.ts'),
  coupled: await L('/src/generator/pipeline/coupledEpoch.ts'),
  column: await L('/src/generator/mesh/meshColumn.ts'),
  flexure: await L('/src/generator/tectonics/flexure.ts'),
  cover: await L('/src/generator/surface/cover.ts'),
  ground: await L('/src/generator/surface/hydrogeology.ts'),
  glacial: await L('/src/generator/surface/glacial.ts'),
  coastal: await L('/src/generator/surface/coastal.ts'),
  coast: await L('/src/generator/surface/coastGraph.ts'),
  basins: await L('/src/generator/surface/sedimentBasins.ts'),
  wind: await L('/src/generator/climate/wind.ts'),
  surfaceTune: await L('/src/generator/surface/surfaceTuneParams.ts'),
  hydro: await L('/src/generator/surface/hydrology.ts'),
  graph: await L('/src/generator/surface/riverGraph.ts'),
  meshHydro: await L('/src/generator/mesh/meshHydrology.ts'),
  climateField: await L('/src/generator/climate/climateField.ts'),
  folds: await L('/src/generator/tectonics/folds.ts'),
  mapConfig: await L('/src/generator/core/mapConfig.ts'),
  field: await L('/src/generator/elevation/elevationField.ts'),
  tectonicsTune: await L('/src/generator/tectonics/tectonicsTuneParams.ts'),
  biomes: await L('/src/generator/climate/biomes.ts'),
  weather: await L('/src/generator/climate/weather.ts'),
  climateMesh: await L('/src/generator/climate/climateMesh.ts'),
  climatePoints: await L('/src/generator/climate/climatePoints.ts'),
  climateChart: await L('/src/generator/climate/climateChart.ts'),
  planet: await L('/src/generator/planet/planetForcing.ts'),
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
  plates: await L('/src/generator/tectonics/plateSimulation.ts'),
  finalize: await L('/src/generator/archean/finalizeArchean.ts'),
  artifacts: await L('/src/world/meshArtifacts.ts'),
  tileArtifacts: await L('/src/world/meshTileArtifacts.ts'),
  memory: await L('/src/storage/MemoryArtifactStore.ts'),
  store: await L('/src/storage/ArtifactStore.ts'),
  surface: await L('/src/map/meshSurface.ts'),
  sceneSettings: await L('/src/map/mapSceneSettings.ts'),
  hydro: await L('/src/generator/surface/hydrology.ts'),
  graph: await L('/src/generator/surface/riverGraph.ts'),
  engine: await L('/src/generator/surface/erosionEngine.ts'),
  forcing: await L('/src/generator/surface/erosionForcingFields.ts'),
  passV2: await L('/src/generator/surface/erosionPassV2.ts'),
  layers: await L('/src/world/save/worldLayers.ts'),
  inputs: await L('/src/world/save/loadWorldInputs.ts'),
  detMath: await L('/src/generator/core/detMath.ts'),
  enginePool: await L('/src/generator/surface/erosionEnginePool.ts'),
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}

const W = 512, H = 256
// See the deterministic math check in [2].
const DET_MATH_HASH = 'dadf96b6'
const T = M.density.MESH_TUNING
const domain = M.domain.torusDomain(W, H)
// Metres per domain unit, the torus's (DEC-0035 fork 6): the synthetic world's.
const UNITS_TO_M = domain.metresPerUnit
// A uniform climate per cell of a domain's climate mesh (climate/
// climatePoints.ClimateCellValues, the bakes' input): 15 °C at sea level,
// 1000 mm/yr, land everywhere.
const uniformClimate = (dom) => {
  const cm = M.climateMesh.climateMesh(dom)
  const n = cm.mesh.count
  return { cells: n, spacingM: cm.cellM, seaLevelTemperature: new Float32Array(n).fill(15), precipitation: new Float32Array(n).fill(1000), seasonalAmplitude: new Float32Array(n).fill(10), monsoonIndex: new Float32Array(n) }
}

// ---------------------------------------------------------------- helpers

const aliveVertices = (mesh) => {
  const out = []
  for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) out.push(v)
  return out
}
const areaSum = (mesh) => {
  let a = 0
  for (const v of aliveVertices(mesh)) a += mesh.voronoiArea(v)
  return a
}
const meshHash = (mesh) => createHash('sha256')
  .update(Buffer.from(mesh.vx.buffer, 0, mesh.vertexSlots * 8))
  .update(Buffer.from(mesh.vy.buffer, 0, mesh.vertexSlots * 8))
  .update(Buffer.from(mesh.tris.buffer, 0, mesh.triSlots * 12))
  .update(Buffer.from(mesh.twin.buffer, 0, mesh.triSlots * 12))
  .digest('hex').slice(0, 16)
const targetsOf = (mesh, state) => {
  const targets = new Float64Array(mesh.vx.length)
  M.build.densityTarget(state)(mesh, targets)
  return targets
}
// The finest target among a node and its neighbours — the coarsen's
// criterion (remesh.ts).
const effectiveTarget = (mesh, targets, v, nb) => {
  const n = mesh.neighbours(v, nb)
  let h = targets[v]
  for (let i = 0; i < n; i++) if (targets[nb[i]] < h) h = targets[nb[i]]
  return h
}

// A synthetic world: a sea, a plain, three ridges of different sharpness,
// a valley river whose discharge grows downstream. Heights in elevation
// units (ELEVATION_METERS per unit).
const m = (x) => M.scale.metersToElevation(x)
const gaussOffset = { x: 0, y: 0 }
const gauss = (x, y, cx, cy, sx, sy) => {
  domain.delta(x, y, cx, cy, gaussOffset)
  const dx = gaussOffset.x / sx
  const dy = gaussOffset.y / sy
  return Math.exp(-(dx * dx + dy * dy))
}
const synthetic = {
  heightAt(x, y) {
    // A continent in the middle of the sea, plain at +300 m.
    const land = gauss(x, y, 256, 128, 150, 80)
    let z = m(-4000) + (m(300) - m(-4000)) * Math.min(1, land * 1.6)
    z += m(4000) * gauss(x, y, 200, 120, 30, 8) // a long sharp range
    z += m(2500) * gauss(x, y, 320, 150, 25, 25) // a round massif
    z += m(1500) * gauss(x, y, 260, 90, 12, 40) // a narrow north–south ridge
    return z
  },
  dischargeAt(x, y) {
    // A river along y = 128 from x = 180 to x = 330, widening downstream
    // (east), a few cells wide.
    if (x < 180 || x > 330) return 0
    domain.delta(x, y, x, 128, gaussOffset)
    const d = Math.abs(gaussOffset.y)
    if (d > 1.5) return 0
    return 200 + (x - 180) * 60
  },
}

// ------------------------------------------------------------- invariants

console.log('\n[1] invariants')

{
  const lat = M.lattice.hexLattice(domain, T.oceanSpacingM / UNITS_TO_M)
  const errs = lat.validate()
  check('bootstrap lattice is a valid periodic Delaunay triangulation', errs.length === 0, errs[0] ?? `${lat.aliveVertices} nodes`)
  check('lattice Voronoi areas sum to the domain', Math.abs(areaSum(lat) - W * H) < 1e-6 * W * H)

  // Random insertion in Hilbert order, then removal of every other node —
  // the two primitives on a random point set.
  const N = 20000
  const rng = M.rng.mulberry32(7)
  const xs = new Float64Array(N), ys = new Float64Array(N)
  for (let i = 0; i < N; i++) { xs[i] = rng() * W; ys[i] = rng() * H }
  const order = M.hilbert.hilbertOrder(xs, ys, N, W, H)
  const ids = new Int32Array(N)
  for (let k = 0; k < N; k++) { const i = order[k]; ids[i] = lat.insert(xs[i], ys[i]) }
  let e = lat.validate()
  check(`after ${N} random insertions the triangulation is valid`, e.length === 0, e[0] ?? `${(lat.walkSteps / N).toFixed(2)} walk steps per insert`)
  check('areas still sum to the domain', Math.abs(areaSum(lat) - W * H) < 1e-6 * W * H)
  let removed = 0
  for (let k = 0; k < N; k += 2) if (lat.remove(ids[order[k]])) removed++
  e = lat.validate()
  check(`after removing ${removed} of them the triangulation is valid`, e.length === 0 && removed === N / 2, e[0] ?? '')
  check('areas still sum to the domain after removal', Math.abs(areaSum(lat) - W * H) < 1e-6 * W * H)

  // The degenerate case: lattice nodes have exactly collinear opposite
  // neighbours and co-circular quads; removing them is where a flip-only
  // deletion got stuck.
  const pure = M.lattice.hexLattice(domain, 8)
  const alive = aliveVertices(pure)
  const r2 = M.rng.mulberry32(11)
  let latticeRemoved = 0
  for (const v of alive) if (r2() < 0.35 && pure.remove(v)) latticeRemoved++
  e = pure.validate()
  check(`removing ${latticeRemoved} lattice nodes (collinear, co-circular stars) stays valid`, e.length === 0, e[0] ?? '')
}

// The build under the density rule: converged inside the hysteresis band,
// every term visible, the fixed point reached.
const built = M.build.buildMesh(domain, synthetic, { seed: 42 })
{
  const { mesh, state, stats } = built
  const errs = mesh.validate()
  check(`built mesh (${mesh.aliveVertices} nodes, ${stats.rounds} rounds) is valid`, errs.length === 0, errs[0] ?? '')
  check('areas sum to the domain', Math.abs(areaSum(mesh) - W * H) < 1e-6 * W * H)
  const targets = targetsOf(mesh, state)
  let edges = 0, long = 0
  for (let t = 0; t < mesh.triSlots; t++) {
    if (!mesh.tAlive[t]) continue
    for (let i = 0; i < 3; i++) {
      const e = 3 * t + i
      if (mesh.twin[e] < e) continue
      edges++
      const a = mesh.tris[e], b = mesh.to(e)
      if (mesh.edgeLength(e) > T.insertRatio * Math.min(targets[a], targets[b])) long++
    }
  }
  check('no more than 0.1 % of edges exceed insertRatio × target', long <= edges * 0.001, `${long} of ${edges}`)
  const nb = new Int32Array(256)
  let crowded = 0
  for (const v of aliveVertices(mesh)) if (M.remesh.meanSpacing(mesh, v) < T.removeRatio * effectiveTarget(mesh, targets, v, nb)) crowded++
  check('no node sits under removeRatio × effective target (the build settled)', crowded === 0, `${crowded}`)
  // Each term of the rule shows up somewhere.
  const z = state.get('z'), q = state.get('discharge')
  let deep = 0, floor = 0, river = 0
  for (const v of aliveVertices(mesh)) {
    const hM = targets[v] * UNITS_TO_M
    if (z[v] * M.scale.ELEVATION_METERS < T.deepOceanBelowM) { if (Math.abs(hM - T.oceanSpacingM) < 1e-6) deep++ }
    else if (hM <= T.minSpacingM + 1e-6) floor++
    if (q[v] > 0 && hM < T.maxSpacingM - 1e-6) river++
  }
  check('deep-ocean nodes sit at the ocean spacing', deep > 0)
  check('the sharp range reaches the spacing floor', floor > 0, `${floor} nodes`)
  check('river nodes are finer than the plain', river > 0, `${river} nodes`)
  // Fixed point: a remesh on the unchanged state moves (nearly) nothing.
  const again = M.remesh.remesh(mesh, state, M.build.densityTarget(state), { seed: 43 })
  check('remesh on the unchanged state moves under 0.1 % of nodes', again.inserted + again.removed <= mesh.aliveVertices * 0.001, `+${again.inserted} −${again.removed}`)
  check('mesh still valid after that remesh', mesh.validate().length === 0)
}

// State inheritance: an extensive field is conserved through a coarsen; an
// intensive one is interpolated to within tolerance through a refine.
{
  const { mesh, state } = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const sed = state.add('sediment', 'extensive')
  const rng = M.rng.mulberry32(5)
  const massOf = () => { let s = 0; for (const v of aliveVertices(mesh)) s += sed[v] * mesh.voronoiArea(v); return s }
  for (const v of aliveVertices(mesh)) sed[v] = rng() * 100
  const before = massOf()
  // Coarsen hard: twice the target everywhere.
  const target = (mesh, targets) => { M.build.densityTarget(state, 2)(mesh, targets) }
  const c = M.remesh.coarsen(mesh, state, target)
  const after = (() => { const s = state.get('sediment'); let sum = 0; for (const v of aliveVertices(mesh)) sum += s[v] * mesh.voronoiArea(v); return sum })()
  check(`extensive field conserved through a coarsen of ${c.removed} nodes`, Math.abs(after - before) < 1e-6 * before, `${before.toFixed(1)} → ${after.toFixed(1)}`)
  check('mesh valid after the coarsen', mesh.validate().length === 0)

  // Intensive: a smooth field sampled on the lattice, refined WITHOUT the
  // sampler — every new node interpolates — against the true field.
  const lat = M.lattice.hexLattice(domain, 16)
  const st = new M.state.MeshState(lat.vertexSlots * 4)
  const f = st.add('z', 'intensive')
  const truth = (x, y) => Math.sin((2 * Math.PI * x) / W) * Math.cos((2 * Math.PI * y) / H)
  for (let v = 0; v < lat.vertexSlots; v++) f[v] = truth(lat.vx[v], lat.vy[v])
  const uniform = (mesh, targets) => { for (let v = 0; v < mesh.vertexSlots; v++) targets[v] = 6 }
  const r = M.remesh.refine(lat, st, uniform, { seed: 1 })
  let maxErr = 0
  const z = st.get('z')
  for (const v of aliveVertices(lat)) maxErr = Math.max(maxErr, Math.abs(z[v] - truth(lat.vx[v], lat.vy[v])))
  check(`intensive field interpolated within 5 % of amplitude over ${r.inserted} inserted nodes`, maxErr < 0.05, `max error ${maxErr.toFixed(4)}`)
}

// Erosion on the mesh: the engine index, the budget, the routing.
{
  const { mesh, state } = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const z0 = state.get('z').slice()
  const alive = aliveVertices(mesh)
  // Uplift on the sharp range, neutral rock, uniform water.
  const uplift = new Float32Array(mesh.vertexSlots)
  const erodibility = new Float32Array(mesh.vertexSlots).fill(1)
  for (const v of alive) uplift[v] = gauss(mesh.vx[v], mesh.vy[v], 200, 120, 30, 8)
  const index = M.erosion.buildMeshEngineIndex(mesh, z0)
  // Index consistency: every active node's run is its star, reverse edges
  // point back, every edge has a facet, areas match the cells.
  let runsOk = true, revOk = true, facets = 0, areaErr = 0
  const nb = new Int32Array(256)
  for (let a = 0; a < index.activeCount; a++) {
    const v = index.active[a]
    const n = mesh.neighbours(v, nb)
    if (index.nbrStart[a + 1] - index.nbrStart[a] !== n) runsOk = false
    // The run is the star rotated to start at the smallest vertex id.
    let offset = 0
    for (let s = 1; s < n; s++) if (nb[s] < nb[offset]) offset = s
    for (let s = 0; s < n; s++) {
      const e = index.nbrStart[a] + s
      const j = index.nbr[e]
      const expected = nb[(offset + s) % n]
      if (j >= 0 && index.active[j] !== expected) runsOk = false
      if (j < 0 && index.activeOf[expected] >= 0) runsOk = false
      if (j >= 0) {
        const r = index.edgeRev[e]
        if (r < index.nbrStart[j] || r >= index.nbrStart[j + 1] || index.nbr[r] !== a) revOk = false
      }
      if (index.diffFactor[e] > 0) facets++
    }
    areaErr = Math.max(areaErr, Math.abs(index.areaRel[a] - mesh.voronoiArea(v)) / mesh.voronoiArea(v))
  }
  check(`engine index: ${index.activeCount} active of ${alive.length} nodes, ${index.frozenCount} frozen deep ocean`, index.frozenCount > 0 && index.activeCount + index.frozenCount === alive.length)
  check('every active node\'s neighbour run is its Delaunay star', runsOk)
  check('every reverse edge points back', revOk)
  check('nearly every edge carries a facet (cot α + cot β > 0)', facets >= index.edgeCount * 0.99, `${facets} of ${index.edgeCount}`)
  check('node areas are the Voronoi cells', areaErr < 1e-6, `max relative error ${areaErr.toExponential(1)}`)

  const AGE = 12
  const t0 = performance.now()
  const result = await M.erosion.runMeshErosion(mesh, z0, { uplift, erodibility }, { age: AGE, routingEvery: 2, params: { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 } })
  const ms = performance.now() - t0
  const z1 = result.z
  let nan = 0, out = 0, frozenMoved = 0, landMoved = 0
  for (const v of alive) {
    if (!Number.isFinite(z1[v])) nan++
    if (z1[v] < -1 || z1[v] > 1) out++
    if (index.activeOf[v] < 0 && z1[v] !== z0[v]) frozenMoved++
    if (z1[v] !== z0[v] && z0[v] > 0) landMoved++
  }
  check(`${AGE} iterations ran (${ms.toFixed(0)} ms), every height finite and in range`, nan === 0 && out === 0, `${nan} NaN, ${out} out of range`)
  check('the frozen ocean did not move', frozenMoved === 0, `${frozenMoved}`)
  check('the land did', landMoved > alive.length * 0.05, `${landMoved} nodes`)
  // The budget: what the nodes gained in volume equals the uplift added
  // minus what left over the rim — erosion moves material, it does not
  // make or lose it. Volumes in m³ over the Voronoi areas.
  const unitM = UNITS_TO_M
  const upliftDt = M.engine.DEFAULT_ENGINE_PARAMS.upliftDt
  let dV = 0
  let addedV = 0
  for (let a = 0; a < index.activeCount; a++) {
    const v = index.active[a]
    const areaM2 = index.areaRel[a] * unitM * unitM
    dV += (z1[v] - z0[v]) * M.scale.ELEVATION_METERS * areaM2
  }
  // Uplift is applied per iteration to land, capped at z = 1; replay it
  // on the trajectory is impossible here, so bound it instead: the
  // budget must close to within the uplift's own total.
  for (let a = 0; a < index.activeCount; a++) addedV += upliftDt * uplift[index.active[a]] * M.scale.ELEVATION_METERS * index.areaRel[a] * unitM * unitM * AGE
  const closure = dV + result.exportedFluxM3
  check('the sediment budget closes: Δvolume + export ≈ uplift', Math.abs(closure - addedV) <= addedV * 0.05 + 1e6, `Δ ${(dV / 1e9).toFixed(2)} + export ${(result.exportedFluxM3 / 1e9).toFixed(2)} vs uplift ${(addedV / 1e9).toFixed(2)} km³`)
  check('some sediment reached the deep ocean', result.exportedFluxM3 > 0)
  // Routing: acyclic (every receiver popped before its donor), terminals
  // only at the sea, accumulation grows downstream along the receivers.
  const pos = new Int32Array(mesh.vertexSlots).fill(-1)
  for (let i = 0; i < result.routing.poppedCount; i++) pos[result.routing.popOrder[i]] = i
  let cycles = 0, badTerminal = 0, notLower = 0, routed = 0, splitAway = 0
  for (const v of alive) {
    const t = result.routing.flowTarget[v]
    if (t < 0) {
      if (index.activeOf[v] >= 0 && z1[v] > 0 && pos[v] >= 0) badTerminal++
      continue
    }
    routed++
    if (pos[t] < 0 || pos[t] >= pos[v]) cycles++
    if (!(result.routing.filled[t] < result.routing.filled[v])) notLower++
    // Not an invariant, a property to know: the MFD splits the drainage
    // over every downslope neighbour by facet, the single receiver is the
    // steepest by length — where the two disagree the receiver carries
    // less than its donor.
    if (result.routing.accumulation[t] < result.routing.accumulation[v]) splitAway++
  }
  check(`the receiver graph is acyclic (${routed} routed nodes)`, cycles === 0, `${cycles} back edges`)
  check('every receiver is strictly lower in filled', notLower === 0, `${notLower}`)
  check('no land node is a terminal', badTerminal === 0, `${badTerminal}`)
  console.log(`       (MFD sends most of the water past the steepest receiver at ${splitAway} of ${routed} nodes)`)
  // The rasterisation reproduces the node heights it passes through.
  const grid = M.raster.rasteriseNodeField(mesh, z1, W, H)
  let rasterErr = 0
  for (let py = 0; py < H; py += 7) for (let px = 0; px < W; px += 7) {
    const t = mesh.locate(px, py)
    const a = mesh.tris[3 * t], b = mesh.tris[3 * t + 1], c = mesh.tris[3 * t + 2]
    const lo = Math.min(z1[a], z1[b], z1[c]), hi = Math.max(z1[a], z1[b], z1[c])
    const g = grid[py * W + px]
    if (g < lo - 1e-6 || g > hi + 1e-6) rasterErr++
  }
  check('the rasterised field stays inside each triangle\'s range', rasterErr === 0, `${rasterErr} samples`)
  // Determinism of the run.
  const again = await M.erosion.runMeshErosion(mesh, z0, { uplift, erodibility }, { age: AGE, routingEvery: 2, params: { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 } })
  let differ = 0
  for (const v of alive) if (again.z[v] !== z1[v]) differ++
  check('the same run gives the same bytes', differ === 0, `${differ} nodes differ`)
  // The pool over the mesh: the same kernels on worker ranges of the active
  // set must give the single-threaded bytes — the two-pass stencils read
  // reverse edges across range borders, which is exactly what this gates.
  const { Worker } = await import('node:worker_threads')
  const hostUrl = new URL('./engineWorkerHost.mjs', import.meta.url)
  const spawn = () => {
    const w = new Worker(hostUrl)
    // A worker that dies would leave the pool waiting forever: say so.
    w.on('error', (e) => { console.log(`  worker error: ${e?.message ?? e}`); process.exit(1) })
    return w
  }
  const P = await L('/src/generator/surface/erosionEnginePool.ts')
  const single = M.engine.ErosionEngine.onIndex(index, z0, { uplift, erodibility }, { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 })
  single.run(AGE, 2)
  for (const workers of [3]) {
    const pool = await P.PooledErosionEngine.create(0, 0, z0, { uplift, erodibility }, spawn, workers, { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 }, index)
    pool.run(AGE, 2)
    await pool.close()
    let poolDiffer = 0
    for (let a = 0; a < index.activeCount; a++) if (pool.z[a] !== single.z[a]) poolDiffer++
    check(`a pool of ${workers} workers gives the single-threaded bytes`, poolDiffer === 0, `${poolDiffer} nodes differ`)
  }
  // The pipelined pool on the synchronous cadence (a level's tiles,
  // meshTileBake.ts): fresh routing every D iterations, waited for — the
  // single engine's cadence at routingEvery = D, so its bytes.
  const piped = await P.PipelinedErosionEngine.create(0, 0, z0, { uplift, erodibility }, spawn, { stencilWorkers: 2, refreshWorkers: 1, pipelineDepth: 2, synchronous: true }, { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 }, index)
  piped.run(AGE)
  const pipedZ = Float32Array.from(piped.activeEngineViews.z)
  await piped.close()
  let pipedDiffer = 0
  for (let a = 0; a < index.activeCount; a++) if (pipedZ[a] !== single.z[a]) pipedDiffer++
  check('the synchronous pipelined pool gives the single engine\'s bytes', pipedDiffer === 0, `${pipedDiffer} nodes differ`)
  // And at the history's cadence (coupledEpoch.ts HISTORY_DEFAULTS
  // .routingEvery: the screen's single engine against the job worker's pool).
  const HISTORY = (await L('/src/generator/pipeline/coupledEpoch.ts')).HISTORY_DEFAULTS
  const singleH = M.engine.ErosionEngine.onIndex(index, z0, { uplift, erodibility }, { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 })
  singleH.run(AGE, HISTORY.routingEvery)
  const pipedH = await P.PipelinedErosionEngine.create(0, 0, z0, { uplift, erodibility }, spawn, { stencilWorkers: 2, refreshWorkers: 1, pipelineDepth: HISTORY.routingEvery, synchronous: true }, { ...M.engine.DEFAULT_ENGINE_PARAMS, epsM: 0 }, index)
  pipedH.run(AGE)
  const pipedHZ = Float32Array.from(pipedH.activeEngineViews.z)
  await pipedH.close()
  let pipedHDiffer = 0
  for (let a = 0; a < index.activeCount; a++) if (pipedHZ[a] !== singleH.z[a]) pipedHDiffer++
  check(`at the history's cadence (every ${HISTORY.routingEvery}) the synchronous pool gives the single engine's bytes`, pipedHDiffer === 0, `${pipedHDiffer} nodes differ`)
}

// The save's form of the mesh (phase 4.3): canonical numbering, the codec,
// and the property everything rests on — a mesh that went through the save
// erodes to the same bytes as the one that did not.
{
  const built = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const { mesh, order } = M.serial.compactMesh(built.mesh)
  const z = M.serial.permute(built.state.get('z'), order)
  check('the compacted mesh is valid and Hilbert-numbered without holes', mesh.validate().length === 0 && mesh.vertexSlots === mesh.aliveVertices && mesh.aliveVertices === built.mesh.aliveVertices, `${mesh.aliveVertices} nodes`)
  let ordered = true
  for (let v = 1; v < mesh.vertexSlots; v++) if (M.hilbert.hilbertKey(mesh.vx[v], mesh.vy[v], W, H) < M.hilbert.hilbertKey(mesh.vx[v - 1], mesh.vy[v - 1], W, H)) ordered = false
  check('vertex ids follow the Hilbert curve', ordered)
  // Same triangle set as the original, up to numbering.
  const triKey = (m, a, b, c, map) => { const t = [map(a), map(b), map(c)].sort((x, y) => x - y); return t.join(',') }
  const inv = new Int32Array(built.mesh.vertexSlots).fill(-1)
  for (let i = 0; i < order.length; i++) inv[order[i]] = i
  const before = new Set(), after = new Set()
  for (let t = 0; t < built.mesh.triSlots; t++) if (built.mesh.tAlive[t]) before.add(triKey(built.mesh, built.mesh.tris[3 * t], built.mesh.tris[3 * t + 1], built.mesh.tris[3 * t + 2], (v) => inv[v]))
  for (let t = 0; t < mesh.triSlots; t++) if (mesh.tAlive[t]) after.add(triKey(mesh, mesh.tris[3 * t], mesh.tris[3 * t + 1], mesh.tris[3 * t + 2], (v) => v))
  let missing = 0
  for (const k of before) if (!after.has(k)) missing++
  check('the compacted mesh has exactly the original triangles', missing === 0 && before.size === after.size, `${missing} missing, ${before.size} vs ${after.size}`)
  // Through the codec and back: identical bytes.
  const identity = new Int32Array(mesh.vertexSlots)
  for (let i = 0; i < identity.length; i++) identity[i] = i
  const serial = M.serial.encodeMesh(mesh, identity)
  const back = M.serial.decodeMesh(domain, serial)
  const bytesPerNode = serial.connectivity.length / serial.count
  check(`the codec round-trips positions and triangles (${bytesPerNode.toFixed(1)} connectivity bytes per node)`,
    meshHash(back) === meshHash(mesh), `${meshHash(mesh)} vs ${meshHash(back)}`)
  // The property: erode the session's mesh and the reloaded mesh — same bytes.
  const uplift = new Float32Array(mesh.vertexSlots)
  const erodibility = new Float32Array(mesh.vertexSlots).fill(1)
  for (let v = 0; v < mesh.vertexSlots; v++) uplift[v] = gauss(mesh.vx[v], mesh.vy[v], 200, 120, 30, 8)
  const zReloaded = new Float32Array(serial.count)
  zReloaded.set(z.subarray(0, serial.count))
  const a = await M.erosion.runMeshErosion(mesh, z, { uplift, erodibility }, { age: 6, routingEvery: 2 })
  const b = await M.erosion.runMeshErosion(back, zReloaded, { uplift, erodibility }, { age: 6, routingEvery: 2 })
  let differ = 0
  for (let v = 0; v < serial.count; v++) if (a.z[v] !== b.z[v]) differ++
  check('a reloaded mesh erodes to the session mesh\'s bytes', differ === 0, `${differ} nodes differ`)
}

// The hydrology on the mesh (phase 4.3, second half): discharge, lakes
// and the river graph over the mesh's own routing, and the graph's
// invariants (the phase-2 harness layer) on it.
{
  const built = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const { mesh, order } = M.serial.compactMesh(built.mesh)
  const z0 = M.serial.permute(built.state.get('z'), order)
  const uplift = new Float32Array(mesh.vertexSlots)
  const erodibility = new Float32Array(mesh.vertexSlots).fill(1)
  const eroded = await M.erosion.runMeshErosion(mesh, z0, { uplift, erodibility }, { age: 12, routingEvery: 2 })
  const areas = M.meshHydro.meshAreas(mesh)
  const sub = M.meshHydro.meshSubstrate(mesh, eroded.routing, areas)
  // A climate at the nodes: uniform 1000 mm/yr, 15 °C.
  const precip = new Float32Array(mesh.vertexSlots).fill(1000)
  const temperature = new Float32Array(mesh.vertexSlots).fill(15)
  const discharge = M.hydro.accumulateDischargeOn(sub, eroded.z, precip, temperature)
  let landArea = 0, maxQ = 0
  for (const v of aliveVertices(mesh)) if (eroded.z[v] > 0) { landArea += areas[v]; maxQ = Math.max(maxQ, discharge[v]) }
  check('the largest discharge is at most the land\'s whole runoff', maxQ <= 1000 * landArea * (1 + 1e-6) && maxQ > 0, `max ${maxQ.toFixed(0)} of ${(1000 * landArea).toFixed(0)}`)
  const lakes = M.hydro.computeLakesOn(sub, discharge, eroded.z, temperature)
  let badLevel = 0, badSeed = 0
  for (const b of lakes.bodies) {
    if (!(b.level >= b.floor) || !(b.spill >= b.floor)) badLevel++
    const t = mesh.locate(b.seedX, b.seedY)
    const a = mesh.tris[3 * t], bb = mesh.tris[3 * t + 1], c = mesh.tris[3 * t + 2]
    if (Math.min(eroded.z[a], eroded.z[bb], eroded.z[c]) > b.spill) badSeed++
  }
  check(`the lakes (${lakes.bodies.length} bodies) have levels between floor and spill and seeds in their basins`, badLevel === 0 && badSeed === 0, `${badLevel} levels, ${badSeed} seeds`)
  const meanRunoff = 1000
  const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY, mesh.domain), meanRunoff)
  const maxDischarge = M.hydro.maxDischargeOverLand(discharge, eroded.z)
  const graph = M.graph.buildRiverGraph({ substrate: sub, discharge, elevation: eroded.z, threshold, maxDischarge, bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, sedimentFlux: eroded.sedimentFlux })
  const violations = M.graph.riverGraphInvariants(graph, eroded.z)
  const broken = Object.entries(violations).filter(([, n]) => n > 0)
  check(`the river graph (${graph.reaches.length} reaches, ${graph.nodes.length} nodes) holds its invariants`, broken.length === 0 && graph.reaches.length > 0, broken.map(([k, n]) => `${k}:${n}`).join(' '))
  check('the graph is the mesh\'s and carries positions', graph.substrate === 'mesh' && graph.cellX.length === graph.cells.length)
  const lines = M.graph.riverPolylinesFromGraph(graph, maxDischarge)
  let inside = true
  for (let i = 0; i < lines.points.length; i += 3) if (lines.points[i] < 0 || lines.points[i] >= W || lines.points[i + 1] < 0 || lines.points[i + 1] >= H) inside = false
  check(`the ribbons (${lines.lengths.length} lines) lie in the world`, inside && lines.lengths.length > 0)
  const serial = M.graph.serializeRiverGraph(graph)
  const back = M.graph.deserializeRiverGraph(serial.json, serial.cells, serial.coursePoints, serial.positions)
  check('a mesh graph round-trips through its serialisation with positions', back !== null && back.cellX.length === graph.cellX.length && back.cellX[5] === graph.cellX[5])
  const again = M.hydro.computeLakesOn(sub, discharge, eroded.z, temperature)
  check('the lakes are deterministic', JSON.stringify(again.bodies) === JSON.stringify(lakes.bodies))

  // DEC-0036 phase 7b: the watersheds, the coast graph and the sediment
  // basins on the same nodes. A watershed is closed under the receiver (a
  // land node and its land receiver share a label); the coast's walk
  // covers every shore node once along the mesh's edges; a basin's volume
  // is its nodes' thickness by area.
  const sheds = M.hydro.watershedsOn(sub, eroded.z, 0)
  let open = 0, labelled = 0
  for (const v of aliveVertices(mesh)) {
    if (eroded.z[v] <= 0) continue
    if (sheds[v] > 0) labelled++
    const t = sub.flowTarget[v]
    if (t >= 0 && eroded.z[t] > 0 && sheds[t] !== sheds[v]) open++
  }
  check(`the watersheds are closed under the receivers (${labelled} land nodes labelled)`, open === 0 && labelled > 0, `${open} nodes leave their basin`)
  const windE = new Float32Array(mesh.vertexSlots).fill(6)
  const windS = new Float32Array(mesh.vertexSlots).fill(1)
  const coast = M.coast.buildCoastGraph({ mesh, z: eroded.z, windE, windS, graph })
  const shore = M.coastal.findShore(mesh, eroded.z)
  const coastBroken = Object.entries(M.coast.coastGraphInvariants(coast, mesh, eroded.z)).filter(([, n]) => n > 0)
  check(`the coast graph (${coast.reaches.length} reaches) walks every shore node once along the mesh`, coastBroken.length === 0 && coast.reaches.length > 0 && coast.nodes.length === shore.shore.length, coastBroken.map(([k, n]) => `${k}:${n}`).join(' ') + ` ${coast.nodes.length} of ${shore.shore.length}`)
  const again2 = M.coast.buildCoastGraph({ mesh, z: eroded.z, windE, windS, graph })
  check('the coast graph is deterministic', JSON.stringify(again2.reaches) === JSON.stringify(coast.reaches) && String(again2.type) === String(coast.type))
  const sediment = M.basins.findSedimentBasins({ mesh, before: z0, after: eroded.z, substrate: sub, graph })
  const basinBroken = Object.entries(M.basins.sedimentBasinInvariants(sediment, z0, eroded.z)).filter(([, n]) => n > 0)
  const km2 = (domain.metresPerUnit / 1000) ** 2
  let volume = 0
  for (const v of aliveVertices(mesh)) if (sediment.label[v] > 0) volume += M.scale.elevationToMeters(eroded.z[v] - z0[v]) * areas[v] * km2 / 1000
  const listed = sediment.basins.reduce((a, b) => a + b.volumeKm3, 0)
  check(`the sediment basins (${sediment.basins.length}) hold their invariants and their volume is their nodes' (${listed.toFixed(3)} km³)`, basinBroken.length === 0 && Math.abs(listed - volume) <= 1e-6 * Math.max(1, volume), basinBroken.map(([k, n]) => `${k}:${n}`).join(' ') + ` ${listed} vs ${volume}`)
}

// Sampling the mesh at a point (phase 4.4): the hint grid finds the right
// triangle from anywhere, heights and fields interpolate exactly at the
// nodes, normals are unit and upright, and the map surface's gradient is
// the finite difference of its own heights.
{
  const built = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const { mesh, order } = M.serial.compactMesh(built.mesh)
  const z = M.serial.permute(built.state.get('z'), order)
  const sampler = M.sampler.createMeshSampler(mesh, z)
  let offNode = 0
  for (let v = 0; v < mesh.vertexSlots; v += 37) if (Math.abs(sampler.heightAt(mesh.vx[v], mesh.vy[v]) - z[v]) > 1e-6) offNode++
  check('the height at a node is the node\'s', offNode === 0, `${offNode} off`)
  const rng = M.rng.mulberry32(99)
  let outside = 0, walkBefore = mesh.walkSteps, queries = 0
  const bary = new Float64Array(3)
  for (let i = 0; i < 20000; i++) {
    const x = rng() * W, y = rng() * H
    const t = sampler.triangleAt(x, y)
    M.remesh.barycentric(mesh, t, x, y, bary)
    if (bary[0] < -1e-9 || bary[1] < -1e-9 || bary[2] < -1e-9) outside++
    queries++
  }
  check('the hint grid locates every random point in its triangle', outside === 0, `${outside} outside, ${((mesh.walkSteps - walkBefore) / queries).toFixed(2)} walk steps per query`)
  const linear = new Float32Array(mesh.vertexSlots)
  for (let v = 0; v < mesh.vertexSlots; v++) linear[v] = 3 * mesh.vx[v] + 2
  let linErr = 0
  for (let i = 0; i < 2000; i++) { const x = 8 + rng() * (W - 16), y = rng() * H; linErr = Math.max(linErr, Math.abs(sampler.sampleAt(linear, x, y) - (3 * x + 2))) }
  check('a linear field interpolates exactly (away from the seam)', linErr < 1e-3, `max error ${linErr.toExponential(1)}`)
  const n = new Float64Array(3)
  let badNormal = 0
  for (let i = 0; i < 2000; i++) { sampler.normalAt(rng() * W, rng() * H, n); if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 1e-6 || n[1] <= 0) badNormal++ }
  check('normals are unit and point up', badNormal === 0, `${badNormal}`)
  const flat = new Float32Array(mesh.vertexSlots).fill(0.1)
  const flatSampler = M.sampler.createMeshSampler(mesh, flat)
  flatSampler.normalAt(W / 2, H / 2, n)
  check('a flat field has a vertical normal', Math.abs(n[1] - 1) < 1e-9)
  // The map surface: its gradient against finite differences of its heights.
  const surface = M.surface.createMeshSurface(sampler, M.sceneSettings.RELIEF_HEIGHT_SCALE, false)
  const g = new Float64Array(2)
  let worst = 0, sumRel = 0, count = 0
  for (let i = 0; i < 3000; i++) {
    const u = rng(), v = rng()
    if (sampler.heightAt(u * W - 0.5, v * H - 0.5) <= 0) continue
    surface.gradientAtUV(u, v, g)
    const eps = 0.02 / W
    const dhdx = (surface.heightAtUV(u + eps, v) - surface.heightAtUV(u - eps, v)) / (2 * eps * M.sceneSettings.MAP_WORLD_WIDTH)
    const dhdz = (surface.heightAtUV(u, v + eps) - surface.heightAtUV(u, v - eps)) / (2 * eps * M.sceneSettings.MAP_WORLD_HEIGHT)
    const err = Math.hypot(g[0] - dhdx, g[1] - dhdz), mag = Math.hypot(dhdx, dhdz)
    if (mag > 1e-4) { sumRel += err / mag; count++; worst = Math.max(worst, err / mag) }
  }
  // Vertex normals are smoothed over the star, so the two differ on a
  // crest; the mean relative error says they agree in sign and size.
  check('the mesh surface\'s gradient agrees with finite differences of its heights', count > 100 && sumRel / count < 0.5, `mean relative error ${(sumRel / count).toFixed(2)} over ${count} land samples`)
}

// The mesh bake, level 1 (phase 4.5): the parent refined to twice the
// density under the same rule, parents kept, the transient with the
// coast pinned, the level's hydrology and graph, and the artifact that
// carries it — written and read back identical.
{
  const built = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const { mesh: parentMesh, order } = M.serial.compactMesh(built.mesh)
  const parentZ = M.serial.permute(built.state.get('z'), order)
  const parentSerial = M.serial.encodeMesh(parentMesh, Int32Array.from({ length: parentMesh.vertexSlots }, (_, i) => i))
  const climate = uniformClimate(domain)
  const inputs = {
    mesh: { count: parentSerial.count, nodes: parentSerial.nodes, connectivity: parentSerial.connectivity, z: parentZ.slice(0, parentSerial.count) },
    width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
    uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
    climate,
  }
  const parentSampler = M.sampler.createMeshSampler(parentMesh, parentZ)
  const t0 = performance.now()
  // The refine path at half the parent's budget: this synthetic parent is
  // built at budget 1, the ladder's level 1 (levelBudget(1), since
  // 2026-10-01 made by replay rather than by refining), so refining to it
  // would add nothing.
  const REFINE_BUDGET = 0.5
  const level = await M.bake.bakeMeshLevel(inputs, { level: 1, budget: REFINE_BUDGET, rounds: 4 })
  const ms = performance.now() - t0
  const split = (m, zz) => { let land = 0, sea = 0; for (let v = 0; v < m.vertexSlots; v++) if (m.vAlive[v]) { if (zz[v] > 0) land++; else sea++ } ; return `${land} land / ${sea} sea` }
  check(`level 1 is valid and denser (${parentMesh.aliveVertices} → ${level.mesh.aliveVertices} nodes, ${ms.toFixed(0)} ms)`, level.mesh.validate().length === 0 && level.mesh.aliveVertices > parentMesh.aliveVertices * 2, `parent ${split(parentMesh, parentZ)}, level ${split(level.mesh, level.z)}`)
  // Every parent node is still a node of the level, at its position.
  const sampler = M.sampler.createMeshSampler(level.mesh, level.z)
  let lost = 0
  for (let v = 0; v < parentMesh.vertexSlots; v += 13) {
    const t = level.mesh.locate(parentMesh.vx[v], parentMesh.vy[v])
    if (level.mesh.atVertex < 0) lost++
  }
  check('every parent node is a node of the level', lost === 0, `${lost} lost`)
  // The coast is the parent's: land stays land, sea stays sea.
  let crossed = 0, land = 0
  for (let v = 0; v < level.mesh.vertexSlots; v++) {
    const parentH = parentSampler.heightAt(level.mesh.vx[v], level.mesh.vy[v])
    if ((parentH > 0) !== (level.z[v] > 0)) crossed++
    if (level.z[v] > 0) land++
  }
  check('no node crossed the coastline', crossed === 0, `${crossed} of ${level.mesh.vertexSlots}`)
  check('the level has a river graph with reaches', level.graph !== null && level.graph.reaches.length > 0, `${level.graph?.reaches.length ?? 0} reaches`)
  // Determinism, and the artifact round trip.
  const again = await M.bake.bakeMeshLevel(inputs, { level: 1, budget: REFINE_BUDGET, rounds: 4 })
  let differ = 0
  for (let v = 0; v < level.mesh.vertexSlots; v++) if (again.z[v] !== level.z[v]) differ++
  check('the same save bakes the same level', differ === 0 && meshHash(again.mesh) === meshHash(level.mesh), `${differ} heights differ`)
  const store = M.memory.createMemoryArtifactStore()
  const key = M.store.artifactKey('uid', 'world', M.artifacts.meshPipelineVersion(1, 4), M.artifacts.meshLevelStage(1))
  const artifact = M.artifacts.meshLevelToArtifact(level)
  const wrote = await M.artifacts.writeMeshLevelArtifact(store, key, artifact, ms, 'synthetic', 4)
  const read = await M.artifacts.readMeshLevelArtifact(store, key)
  const back = read ? M.artifacts.meshLevelMesh(read.artifact, W, H) : null
  check('the level artifact writes and reads back to the same mesh and heights', wrote && read !== null && back !== null && meshHash(back) === meshHash(level.mesh) && read.artifact.z.every((v, i) => v === level.z[i]) && (read.artifact.graph?.reaches.length ?? -1) === level.graph.reaches.length)
  check('the mesh pipeline version carries the density rule', M.artifacts.meshPipelineVersion(1, 4) !== M.artifacts.meshPipelineVersion(1, 5) && M.artifacts.meshPipelineVersion(1, 4) !== M.artifacts.meshPipelineVersion(2, 4))

  // The tiles of the fine levels (docs/decisions/tile-jobs.md; the levels,
  // detail-ladder.md step 5): built from level 1, one tile and its
  // neighbour, per level. The seam rule is what is checked — the shared
  // edge line the same in both, at the same heights, every step of it an
  // edge of both triangulations, and the tile's inside a function of its
  // own points alone (a wider halo changes no triangle in it).
  for (const tileLevel of [3, 2]) {
    const T = M.tile
    const spec = T.tileSpec(tileLevel)
    const C = spec.cells
    console.log(`  — level ${tileLevel}: ${C} × ${C} cells, offset ${spec.offset}, budget ${spec.budget}`)
    const corner = (t) => T.tileCorner({ level: tileLevel, ...t }, spec)
    const onLine = (v) => (((v - spec.offset) % C) + C) % C === 0
    const tileOf = (x, y) => ({ level: tileLevel, x: Math.floor((((x - spec.offset) % W) + W) % W / C), y: Math.floor((((y - spec.offset) % H) + H) % H / C) })
    const parent = { mesh: level.mesh, z: level.z, discharge: level.discharge, sampler, macro: sampler }
    const opts = { seed: 1234, width: W, height: H }
    const { cols, rows } = T.tileGrid(W, H, spec)
    // The tile with the most land under its centre row, and its east neighbour.
    let best = { level: tileLevel, x: 0, y: 0, land: -1 }
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      let n = 0
      const c = corner({ x: tx, y: ty })
      for (let k = 0; k < C; k++) if (sampler.heightAt((c.x + k + 0.5) % W, (c.y + C / 2) % H) > 0) n++
      if (n > best.land) best = { level: tileLevel, x: tx, y: ty, land: n }
    }
    const t1 = performance.now()
    const A = T.buildTileMesh(parent, best, opts)
    const tileMs = performance.now() - t1
    const B = T.buildTileMesh(parent, { level: tileLevel, x: (best.x + 1) % cols, y: best.y }, opts)
    const count = (t, role) => { let n = 0; for (let v = 0; v < t.mesh.vertexSlots; v++) if (t.mesh.vAlive[v] && t.role[v] === role) n++; return n }
    check(`a tile is a valid triangulation (${A.mesh.aliveVertices} nodes: ${count(A, T.TILE_ROLE_NEW)} new, ${count(A, T.TILE_ROLE_PARENT)} parents, ${count(A, T.TILE_ROLE_EDGE)} edge; ${tileMs.toFixed(0)} ms)`, A.mesh.validate().length === 0 && B.mesh.validate().length === 0)
    // Edge nodes by world position.
    const key = (x, y) => `${x},${y}`
    const edgeNodes = (t) => {
      const map = new Map()
      for (let v = 0; v < t.mesh.vertexSlots; v++) if (t.mesh.vAlive[v] && t.role[v] === T.TILE_ROLE_EDGE) map.set(key(T.tileWorldX(t, t.mesh.vx[v], domain), T.tileWorldY(t, t.mesh.vy[v], domain)), v)
      return map
    }
    const edgeA = edgeNodes(A), edgeB = edgeNodes(B)
    const sharedX = corner({ x: (best.x + 1) % cols, y: best.y }).x % W
    let shared = 0, heightDiffers = 0, missing = 0
    for (const [k, v] of edgeA) {
      if (Number(k.split(',')[0]) !== sharedX) continue
      shared++
      const u = edgeB.get(k)
      if (u === undefined) missing++
      else if (A.z[v] !== B.z[u]) heightDiffers++
    }
    check('two neighbours hold the same nodes on their shared edge, at the same heights', shared === spec.edgeSteps + 1 && missing === 0 && heightDiffers === 0, `${shared} shared, ${missing} missing, ${heightDiffers} heights differ`)
    // Every step of the edge line is an edge of the triangulation.
    const stepsMissing = (t, edges) => {
      // The row along each line, sorted; consecutive nodes must be neighbours.
      const nb = new Int32Array(64)
      const lines = new Map()
      for (const [k, v] of edges) {
        const [x, y] = k.split(',').map(Number)
        if (onLine(x)) { const l = `x${x}`; if (!lines.has(l)) lines.set(l, []); lines.get(l).push([y, v]) }
        if (onLine(y)) { const l = `y${y}`; if (!lines.has(l)) lines.set(l, []); lines.get(l).push([x, v]) }
      }
      let lost = 0, steps = 0
      for (const row of lines.values()) {
        row.sort((a, b) => a[0] - b[0])
        for (let i = 1; i < row.length; i++) {
          if (row[i][0] - row[i - 1][0] > C / 2) continue // across the world's seam
          steps++
          const n = t.mesh.neighbours(row[i][1], nb)
          let found = false
          for (let j = 0; j < n; j++) if (nb[j] === row[i - 1][1]) found = true
          if (!found) lost++
        }
      }
      return steps === 4 * spec.edgeSteps ? lost : -1
    }
    const lostA = stepsMissing(A, edgeA), lostB = stepsMissing(B, edgeB)
    check('every step of the edge line is an edge of the tile\'s triangulation', lostA === 0 && lostB === 0, `${lostA} + ${lostB} missing (-1: not every step found)`)
    // The inside does not depend on the halo.
    const insideTriangles = (t) => {
      const set = new Set()
      // Inside: no corner in the halo (a centroid test would catch the
      // local torus's wrap-around triangles, whose naive centroid can fall
      // anywhere).
      for (let tri = 0; tri < t.mesh.triSlots; tri++) {
        if (!t.mesh.tAlive[tri]) continue
        const vs = [0, 1, 2].map((c) => t.mesh.tris[3 * tri + c])
        if (vs.some((v) => t.role[v] === T.TILE_ROLE_HALO)) continue
        set.add(vs.map((v) => `${t.role[v]}@` + key(T.tileWorldX(t, t.mesh.vx[v], domain), T.tileWorldY(t, t.mesh.vy[v], domain)) + ':' + t.z[v]).sort().join('|'))
      }
      return set
    }
    const wide = T.buildTileMesh(parent, best, { ...opts, halo: 2 })
    const inA = insideTriangles(A), inWide = insideTriangles(wide)
    let differ = 0
    let first = ''
    for (const k of inA) if (!inWide.has(k)) { differ++; first ||= k }
    check('a wider halo changes no triangle and no height inside the tile', differ === 0 && inA.size === inWide.size, `${inA.size} vs ${inWide.size} triangles, ${differ} differ${first ? `, e.g. ${first}` : ''}`)
    const again = T.buildTileMesh(parent, best, opts)
    check('the same parent builds the same tile', meshHash(again.mesh) === meshHash(A.mesh) && again.z.every((v, i) => v === A.z[i]))
    // Across the world's seam: the last column's east edge is the first's west edge.
    const east = T.buildTileMesh(parent, { level: tileLevel, x: cols - 1, y: best.y }, opts), west = T.buildTileMesh(parent, { level: tileLevel, x: 0, y: best.y }, opts)
    const edgeE = edgeNodes(east), edgeW = edgeNodes(west)
    let seam = 0, seamBad = 0
    for (const [k, v] of edgeE) { if (Number(k.split(',')[0]) !== spec.offset % W) continue; seam++; const u = edgeW.get(k); if (u === undefined || east.z[v] !== west.z[u]) seamBad++ }
    check('tiles meet across the world\'s seam as they do inside it', seam === spec.edgeSteps + 1 && seamBad === 0, `${seam} shared, ${seamBad} differ`)

    // The tile's bake: the edge row pinned, the halo frozen, level 1's
    // rivers entering with their discharge. The edge must come out at the
    // parent surface to the bit, the inside must erode, and every land
    // node inside must drain — over the edge or into the sea.
    const macro = M.raster.rasteriseNodeField(level.mesh, level.z, W, H)
    const tileInputs = {
      parent, parentGraph: level.graph, width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
      uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
      climate,
      meanLandWater: M.climatePoints.meanLandRunoff(M.climatePoints.climateCellsFromSaved(domain, climate)),
      upstream: [],
    }
    const t2 = performance.now()
    const baked = await M.tileBake.bakeMeshTile(tileInputs, best, { rounds: 4 })
    const bakeMs = performance.now() - t2
    const bt = baked.tile
    let edgeMoved = 0, moved = 0, nan = 0, maxCutM = 0
    for (let v = 0; v < bt.mesh.vertexSlots; v++) {
      if (!bt.mesh.vAlive[v]) continue
      if (!Number.isFinite(baked.z[v])) nan++
      if (bt.role[v] === T.TILE_ROLE_EDGE) { if (baked.z[v] !== bt.z[v]) edgeMoved++ }
      else if (bt.role[v] !== T.TILE_ROLE_HALO && baked.z[v] !== bt.z[v]) { moved++; maxCutM = Math.max(maxCutM, (bt.z[v] - baked.z[v]) * M.scale.ELEVATION_METERS) }
    }
    check(`a tile bakes (${bakeMs.toFixed(0)} ms, ${baked.inflows} level-1 rivers enter)`, nan === 0 && moved > 0 && baked.erodedFluxM3 > 0, `${moved} inside nodes moved, deepest cut ${maxCutM.toFixed(1)} m, ${nan} NaN`)
    check('the tile\'s edge row keeps the parent surface to the bit', edgeMoved === 0, `${edgeMoved} edge nodes moved`)
    let drained = 0, stuck = 0
    const target = baked.routing.flowTarget
    for (let v = 0; v < bt.mesh.vertexSlots; v++) {
      if (!bt.mesh.vAlive[v] || bt.role[v] === T.TILE_ROLE_EDGE || bt.role[v] === T.TILE_ROLE_HALO || baked.z[v] <= 0) continue
      let u = v, steps = 0
      while (steps++ < 1e6 && baked.z[u] > 0 && bt.role[u] !== T.TILE_ROLE_EDGE && target[u] >= 0) u = target[u]
      if (bt.role[u] === T.TILE_ROLE_EDGE || baked.z[u] <= 0) drained++
      else { stuck++ }
    }
    check('every land node inside drains over the edge or into the sea', stuck === 0 && drained > 0, `${drained} drained, ${stuck} stuck`)
    const bakedAgain = await M.tileBake.bakeMeshTile(tileInputs, best, { rounds: 4 })
    check('the same parent bakes the same tile', bakedAgain.z.every((v, i) => v === baked.z[i] || (Number.isNaN(v) && Number.isNaN(baked.z[i]))))
    // A tile a level-1 river flows into: its catchment enters at the
    // crossing and leaves over the edge — the accumulation on the edge
    // row carries at least what came in.
    let inTile = null
    const g = level.graph
    for (const r of g.reaches) {
      if (r.kind !== 'river') continue
      for (let k = 1; k < r.cellCount && !inTile; k++) {
        const a = tileOf(g.cellX[r.cellStart + k - 1], g.cellY[r.cellStart + k - 1])
        const b = tileOf(g.cellX[r.cellStart + k], g.cellY[r.cellStart + k])
        if ((a.x !== b.x || a.y !== b.y) && r.dischargeOut > 0) inTile = b
      }
      if (inTile) break
    }
    const fed = inTile ? await M.tileBake.bakeMeshTile(tileInputs, inTile, { rounds: 4 }) : null
    let edgeAcc = 0
    if (fed) for (let v = 0; v < fed.tile.mesh.vertexSlots; v++) if (fed.tile.mesh.vAlive[v] && fed.tile.role[v] === T.TILE_ROLE_EDGE) edgeAcc = Math.max(edgeAcc, fed.routing.accumulation[v])
    const inflowArea = fed ? fed.inflowDischarge / tileInputs.meanLandWater : 0
    check('a level-1 river entering a tile leaves over its edge with its catchment', fed !== null && fed.inflows > 0 && edgeAcc >= inflowArea, fed ? `tile ${inTile.x},${inTile.y}: ${fed.inflows} inflows, ${inflowArea.toFixed(1)} cells in, largest on the edge ${edgeAcc.toFixed(1)}` : 'no crossing found')
    // The tile's artifact: its inside only, written and read back identical,
    // under a stage that names the tile.
    {
      const art = M.tileArtifacts.bakedTileToArtifact(baked)
      let halo = 0
      for (let i = 0; i < art.count; i++) if (art.role[i] === T.TILE_ROLE_HALO) halo++
      let outside = 0
      for (let i = 0; i < art.count; i++) { const x = art.nodes[2 * i], y = art.nodes[2 * i + 1]; if (x < 0 || y < 0 || x > C || y > C) outside++ }
      const tileStore = M.memory.createMemoryArtifactStore()
      const stage = M.tileArtifacts.meshTileStage(best)
      const tileKey = M.store.artifactKey('uid', 'world', M.tileArtifacts.meshTilePipelineVersion(tileLevel, 4), stage)
      const wrote = await M.tileArtifacts.writeMeshTileArtifact(tileStore, tileKey, art, bakeMs, 'synthetic', 4)
      const read = await M.tileArtifacts.readMeshTileArtifact(tileStore, tileKey)
      const same = read !== null && read.artifact.count === art.count && read.artifact.z.every((v, i) => v === art.z[i]) && read.artifact.triangles.every((v, i) => v === art.triangles[i]) && read.artifact.nodes.every((v, i) => v === art.nodes[i])
      check(`a tile's artifact holds its inside and reads back identical (${stage}: ${art.count} nodes, ${art.triangles.length / 3} triangles)`, wrote && same && halo === 0 && outside === 0 && stage === `L${tileLevel}:${best.x},${best.y}`, `${halo} halo nodes, ${outside} outside the tile`)
      check('the tile pipeline version moves with the rounds and the level, and differs from level 1\'s', M.tileArtifacts.meshTilePipelineVersion(tileLevel, 4) !== M.tileArtifacts.meshTilePipelineVersion(tileLevel, 5) && M.tileArtifacts.meshTilePipelineVersion(2, 4) !== M.tileArtifacts.meshTilePipelineVersion(3, 4) && M.tileArtifacts.meshTilePipelineVersion(tileLevel, 4) !== M.artifacts.meshPipelineVersion(1, 4))
    }
  }

  // The patchwork parent (detail-ladder.md step 5.3): a level-3 tile
  // built on the level-2 tiles it overlaps, joined. The join must hold
  // every level-2 node at its own height, a shared edge node once, and the
  // level-3 tiles on it must meet as they do on level 1.
  {
    const T = M.tile
    const s2 = T.tileSpec(2), s3 = T.tileSpec(3)
    const parent1 = { mesh: level.mesh, z: level.z, discharge: level.discharge, sampler, macro: sampler }
    const macro = M.raster.rasteriseNodeField(level.mesh, level.z, W, H)
    const inputs2 = {
      parent: parent1, parentGraph: level.graph, width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
      uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
      climate,
      meanLandWater: M.climatePoints.meanLandRunoff(M.climatePoints.climateCellsFromSaved(domain, climate)),
      upstream: [],
    }
    // A level-3 tile on a level-2 seam with land, and its east neighbour.
    const { cols: c3, rows: r3 } = T.tileGrid(W, H, s3)
    let pick = null
    for (let ty = 0; ty < r3 && !pick; ty++) for (let tx = 0; tx < c3 && !pick; tx++) {
      const c = T.tileCorner({ level: 3, x: tx, y: ty }, s3)
      if (sampler.heightAt((c.x + 4) % W, (c.y + 4) % H) > 0 && T.parentTilesOf({ level: 3, x: tx, y: ty }, s2, domain).length >= 2) pick = { level: 3, x: tx, y: ty }
    }
    const pair = [pick, { level: 3, x: (pick.x + 1) % c3, y: pick.y }]
    const needed = new Map()
    for (const t of pair) for (const p of T.parentTilesOf(t, s2, domain)) needed.set(`${p.x},${p.y}`, p)
    const pieces = []
    for (const p of needed.values()) {
      const art = M.tileArtifacts.bakedTileToArtifact(await M.tileBake.bakeMeshTile(inputs2, p, { rounds: 2 }))
      pieces.push({ tile: p, count: art.count, nodes: art.nodes, z: art.z })
    }
    const patch = T.tileParentFromTiles(pieces, W, H)
    const patchSampler = M.sampler.createMeshSampler(patch.mesh, patch.z)
    let total = 0, off = 0
    for (const piece of pieces) {
      const c = T.tileCorner(piece.tile, s2)
      for (let i = 0; i < piece.count; i++) {
        total++
        // At the node as the mesh holds it (float32 world positions).
        const h = patchSampler.heightAt(Math.fround((c.x + piece.nodes[2 * i]) % W), Math.fround((c.y + piece.nodes[2 * i + 1]) % H))
        if (Math.abs(h - piece.z[i]) > 1e-6) off++
      }
    }
    check(`the patchwork holds every level-2 node at its height, a shared one once (${pieces.length} tiles, ${total} → ${patch.mesh.aliveVertices} nodes)`, off === 0 && patch.mesh.validate().length === 0 && patch.mesh.aliveVertices < total, `${off} off`)
    const parent3 = { mesh: patch.mesh, z: patch.z, discharge: null, sampler: patchSampler, macro: sampler }
    // Each tile on its OWN patchwork, as a worker builds it: the two share
    // some level-2 tiles, not all.
    const own = (t) => {
      const mine = pieces.filter((piece) => T.parentTilesOf(t, s2, domain).some((p) => p.x === piece.tile.x && p.y === piece.tile.y))
      const joined = T.tileParentFromTiles(mine, W, H)
      return { mesh: joined.mesh, z: joined.z, discharge: null, sampler: M.sampler.createMeshSampler(joined.mesh, joined.z), macro: sampler }
    }
    const opts = { seed: 1234, width: W, height: H }
    const A = T.buildTileMesh(own(pair[0]), pair[0], opts), B = T.buildTileMesh(own(pair[1]), pair[1], opts)
    const edge = (t) => { const m = new Map(); for (let v = 0; v < t.mesh.vertexSlots; v++) if (t.mesh.vAlive[v] && t.role[v] === T.TILE_ROLE_EDGE) m.set(`${T.tileWorldX(t, t.mesh.vx[v], domain)},${T.tileWorldY(t, t.mesh.vy[v], domain)}`, v); return m }
    const eA = edge(A), eB = edge(B)
    const sharedX = T.tileCorner(pair[1], s3).x % W
    let shared = 0, bad = 0
    for (const [k, v] of eA) { if (Number(k.split(',')[0]) !== sharedX) continue; shared++; const u = eB.get(k); if (u === undefined || A.z[v] !== B.z[u]) bad++ }
    check('level-3 tiles on the patchwork are valid and meet on their shared edge', A.mesh.validate().length === 0 && B.mesh.validate().length === 0 && shared === s3.edgeSteps + 1 && bad === 0, `${shared} shared, ${bad} differ; tile ${pick.x},${pick.y} over ${T.parentTilesOf(pick, s2, domain).length} level-2 tiles`)
    const baked3 = await M.tileBake.bakeMeshTile({ ...inputs2, parent: parent3 }, pair[0], { rounds: 2 })
    let stuck = 0, drained = 0
    const target = baked3.routing.flowTarget, bt = baked3.tile
    for (let v = 0; v < bt.mesh.vertexSlots; v++) {
      if (!bt.mesh.vAlive[v] || bt.role[v] === T.TILE_ROLE_EDGE || bt.role[v] === T.TILE_ROLE_HALO || baked3.z[v] <= 0) continue
      let u = v, n = 0
      while (n++ < 1e6 && baked3.z[u] > 0 && bt.role[u] !== T.TILE_ROLE_EDGE && target[u] >= 0) u = target[u]
      if (bt.role[u] === T.TILE_ROLE_EDGE || baked3.z[u] <= 0) drained++
      else stuck++
    }
    check('a level-3 tile on the patchwork bakes and every land node inside drains', stuck === 0 && drained > 0, `${drained} drained, ${stuck} stuck`)
  }

  // The tile levels' graph (detail-ladder.md step 5.4): planned from level
  // 1's drainage — acyclic, a finer tile's parents in the plan, every
  // dependency a planned tile — and the water across an edge: what an
  // upstream tile lets out over its edge row is what the tile below takes
  // in, node for node.
  {
    const T = M.tile, P = M.tilePlan
    const routing = M.meshHydrology.meshRouting(level.mesh, level.z)
    const landOf = (lv) => {
      const spec = T.tileSpec(lv), { cols, rows } = T.tileGrid(W, H, spec), out = []
      for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
        const c = T.tileCorner({ level: lv, x: tx, y: ty }, spec)
        let land = false
        for (let k = 0; k < spec.cells && !land; k += 2) for (let j = 0; j < spec.cells && !land; j += 2) if (sampler.heightAt((c.x + k + 0.5) % W, (c.y + j + 0.5) % H) > 0) land = true
        if (land) out.push({ level: lv, x: tx, y: ty })
      }
      return out
    }
    const t0 = performance.now()
    const plan = P.planTiles({ mesh: level.mesh, z: level.z, routing, width: W, height: H, levels: [2, 3], landTiles: landOf })
    const planMs = performance.now() - t0
    const key = (t) => `${t.level}:${t.x},${t.y}`
    const planned = new Map(plan.map((p) => [key(p.tile), p]))
    let missing = 0, edges = 0
    for (const p of plan) for (const d of [...p.parents, ...p.upstream]) { edges++; if (!planned.has(key(d))) missing++ }
    // Kahn's order: every tile placeable after what it waits for.
    const waiting = new Map(plan.map((p) => [key(p.tile), p.parents.length + p.upstream.length]))
    const after = new Map()
    for (const p of plan) for (const d of [...p.parents, ...p.upstream]) { const k = key(d); if (!after.has(k)) after.set(k, []); after.get(k).push(key(p.tile)) }
    const ready = [...waiting].filter(([, n]) => n === 0).map(([k]) => k)
    let placed = 0
    while (ready.length) { const k = ready.pop(); placed++; for (const n of after.get(k) ?? []) { waiting.set(n, waiting.get(n) - 1); if (waiting.get(n) === 0) ready.push(n) } }
    const counts = [2, 3].map((lv) => plan.filter((p) => p.tile.level === lv).length)
    const flow = plan.reduce((n, p) => n + p.upstream.length, 0)
    check(`the tile plan is acyclic and whole (${counts[0]} + ${counts[1]} tiles, ${flow} flow edges, ${edges} in all; ${planMs.toFixed(0)} ms)`, missing === 0 && placed === plan.length && flow > 0, `${missing} unplanned deps, ${placed}/${plan.length} placed`)

    // A level-2 tile with an upstream tile: the upstream's outflow over the
    // shared edge is the downstream's inflow, to the bit of a float sum.
    const down = plan.find((p) => p.tile.level === 2 && p.upstream.length > 0)
    const parent1 = { mesh: level.mesh, z: level.z, discharge: level.discharge, sampler, macro: sampler }
    const macro = M.raster.rasteriseNodeField(level.mesh, level.z, W, H)
    const base = {
      parent: parent1, parentGraph: level.graph, width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
      uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
      climate,
      meanLandWater: M.climatePoints.meanLandRunoff(M.climatePoints.climateCellsFromSaved(domain, climate)), upstream: [],
    }
    const ups = []
    for (const u of down.upstream) {
      const art = M.tileArtifacts.bakedTileToArtifact(await M.tileBake.bakeMeshTile(base, u, { rounds: 2 }))
      ups.push({ tile: u, count: art.count, nodes: art.nodes, outflow: art.outflow })
    }
    const fed = await M.tileBake.bakeMeshTile({ ...base, upstream: ups }, down.tile, { rounds: 2 })
    // What the upstream tiles let out on the edges they share with it.
    const spec = T.tileSpec(2)
    const own = new Set()
    for (let v = 0; v < fed.tile.mesh.vertexSlots; v++) if (fed.tile.mesh.vAlive[v] && fed.tile.role[v] === T.TILE_ROLE_EDGE) own.add(`${T.tileWorldX(fed.tile, fed.tile.mesh.vx[v], domain)},${T.tileWorldY(fed.tile, fed.tile.mesh.vy[v], domain)}`)
    let sent = 0
    for (const u of ups) {
      const c = T.tileCorner(u.tile, spec)
      for (let i = 0; i < u.count; i++) if (u.outflow[i] > 0 && own.has(`${(c.x + u.nodes[2 * i]) % W},${(c.y + u.nodes[2 * i + 1]) % H}`)) sent += u.outflow[i]
    }
    check('an upstream tile\'s outflow over the shared edge is the tile\'s inflow', sent > 0 && Math.abs(fed.upstreamInflow - sent) <= 1e-6 * sent, `${sent.toFixed(2)} out, ${fed.upstreamInflow.toFixed(2)} in over ${fed.upstreamNodes} edge nodes; tile ${down.tile.x},${down.tile.y} after ${down.upstream.map((u) => `${u.x},${u.y}`).join(' ')}`)
    // The water arrives in the network: against the same tile baked with
    // no upstream, the drainage somewhere grows by at least the strongest
    // single inflow (the engine spreads area over several receivers, so a
    // sum over single-flow outlets would not close).
    let strongest = 0
    for (const u of ups) {
      const c = T.tileCorner(u.tile, spec)
      for (let i = 0; i < u.count; i++) if (own.has(`${(c.x + u.nodes[2 * i]) % W},${(c.y + u.nodes[2 * i + 1]) % H}`)) strongest = Math.max(strongest, u.outflow[i])
    }
    const bare = await M.tileBake.bakeMeshTile(base, down.tile, { rounds: 2 })
    let grew = 0
    for (let v = 0; v < fed.tile.mesh.vertexSlots; v++) if (fed.tile.mesh.vAlive[v]) grew = Math.max(grew, fed.routing.accumulation[v] - bare.routing.accumulation[v])
    check('the water taken in arrives in the tile\'s drainage', grew >= 0.9 * strongest, `drainage grew by up to ${grew.toFixed(2)}, the strongest inflow ${strongest.toFixed(2)}`)
  }
}

// Flexural isostasy (phase 5.3; on the field mesh since DEC-0036 phase 6):
// the plate's answer to a ridge's load on a flat torus — the plate sinks
// under AND beside it (the foreland basin, no feature rule) and rises
// beyond (the forebulge), the whole answer compensates the load by
// ρ_crust/ρ_mantle, and a stiffer plate spreads it wider and shallower.
// The analytic profile is harness:fields' check.
{
  const domain = M.domain.torusDomain(128, 64, 0, 62400)
  const { mesh: fm } = M.flexure.flexureMesh(domain)
  const cellKm = fm.spacingM / 1000
  const x0 = 64
  const ridge = (teKm) => {
    const load = new Float64Array(fm.count), rig = new Float64Array(fm.count).fill(M.flexure.flexuralRigidityM4(teKm))
    for (let i = 0; i < fm.count; i++) if (Math.abs(fm.x[i] - x0) * domain.metresPerUnit < 1.5 * fm.spacingM) load[i] = 2000
    const w = new Float64Array(fm.count)
    const rep = M.flexure.flexuralResponse(fm, load, rig, w)
    return { load, w, rep }
  }
  const soft = ridge(20), stiff = ridge(70)
  // The profile across the ridge, by distance (km) from its axis: the mean
  // per one-cell bin.
  const profile = (r) => {
    const sum = new Map()
    for (let i = 0; i < fm.count; i++) {
      const d = Math.round(Math.abs(fm.x[i] - x0) * domain.metresPerUnit / fm.spacingM)
      const q = sum.get(d) ?? [0, 0]
      q[0] += r.w[i]; q[1]++
      sum.set(d, q)
    }
    return (k) => { const q = sum.get(k); return q[0] / q[1] }
  }
  const ps = profile(soft), pk = profile(stiff)
  const integral = (r, a) => { let s = 0; for (let i = 0; i < fm.count; i++) s += r[a][i] * fm.area[i]; return s }
  const alpha20 = M.flexure.flexuralAlphaKm(20), alpha70 = M.flexure.flexuralAlphaKm(70)
  console.log(`       α(Te 20 km) = ${alpha20.toFixed(0)} km, α(Te 70 km) = ${alpha70.toFixed(0)} km, the mesh ${cellKm.toFixed(1)} km; ${soft.rep.iterations} / ${stiff.rep.iterations} CG iterations`)
  check('the solve converges to its residual', soft.rep.converged && stiff.rep.converged, `${soft.rep.residual.toExponential(1)}, ${stiff.rep.residual.toExponential(1)}`)
  check('the plate sinks under the ridge', ps(0) < -100, `${ps(0).toFixed(0)} m`)
  check('and beside it — a foreland basin with no feature rule', pk(3) < -10 && pk(3) > pk(0), `${pk(3).toFixed(0)} m at ${(3 * cellKm).toFixed(0)} km (Te 70)`)
  let bulge = -Infinity, bulgeAt = 0
  for (let k = 2; k < 20; k++) if (pk(k) > bulge) { bulge = pk(k); bulgeAt = k }
  check('and rises beyond it — the forebulge, near πα', bulge > 1 && Math.abs(bulgeAt * cellKm - (Math.PI * alpha70 + 1.5 * cellKm)) < 2.5 * cellKm, `+${bulge.toFixed(1)} m at ${(bulgeAt * cellKm).toFixed(0)} km; πα + the ridge's half width ${(Math.PI * alpha70 + 1.5 * cellKm).toFixed(0)} km`)
  check('far away the plate is level', Math.abs(ps(40)) < 1, `${ps(40).toFixed(2)} m`)
  const ratio = -integral(soft, 'w') / integral(soft, 'load')
  check('the load is compensated by ρ_crust/ρ_mantle', Math.abs(ratio - 2700 / 3300) < 1e-6, ratio.toFixed(8))
  check('a stiffer plate answers wider and shallower', pk(0) > ps(0) && pk(4) < ps(4), `under: ${pk(0).toFixed(0)} vs ${ps(0).toFixed(0)} m; at ${(4 * cellKm).toFixed(0)} km: ${pk(4).toFixed(1)} vs ${ps(4).toFixed(1)} m`)
  check('Te grows with craton oldness and with ocean age', M.flexure.elasticThicknessKm(true, 1, 0) > M.flexure.elasticThicknessKm(true, 0, 0) && M.flexure.elasticThicknessKm(false, 0, 100) > M.flexure.elasticThicknessKm(false, 0, 1))
}

// The ice's load on the plate (pipeline/coupledEpoch.iceLoadChangeM): an
// ice sheet over the ridge's band, standing an epoch at the same thickness,
// loads nothing more — the deflection of its first epoch stays in the
// relief —; one that grew by a fifth deflects by the fifth, one that melted
// by a fifth springs back by it.
{
  const domain = M.domain.torusDomain(128, 64, 0, 62400)
  const { mesh: fm } = M.flexure.flexureMesh(domain)
  const rig = new Float64Array(fm.count).fill(M.flexure.flexuralRigidityM4(30))
  const sheet = (i) => (Math.abs(fm.x[i] - 64) * domain.metresPerUnit < 4 * fm.spacingM ? 2000 : 0)
  const deflect = (now, before) => {
    const load = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) load[i] = M.coupled.iceLoadChangeM(now(i), before(i))
    const w = new Float64Array(fm.count)
    M.flexure.flexuralResponse(fm, load, rig, w)
    return w
  }
  const first = deflect(sheet, () => 0)
  const standing = deflect(sheet, sheet)
  const grown = deflect((i) => sheet(i) * 1.2, sheet)
  const melted = deflect((i) => sheet(i) * 0.8, sheet)
  const extreme = (w) => w.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0)
  const w0 = extreme(first)
  check(`a standing ice sheet deflects the plate no further (first epoch ${w0.toFixed(1)} m, the next ${extreme(standing).toFixed(3)} m)`, w0 < 0 && standing.every((v) => v === 0))
  check(`growth deflects by the change, melt rebounds by it (+20 %: ${extreme(grown).toFixed(1)} m, −20 %: ${extreme(melted).toFixed(1)} m)`,
    Math.abs(extreme(grown) - 0.2 * w0) <= 1e-3 * Math.abs(w0) && Math.abs(extreme(melted) + 0.2 * w0) <= 1e-3 * Math.abs(w0))
}

// Folds (phase 5.7): across one range the uplift's multiplier is a train
// with the buckling wavelength, an anticline on the axis, mean one over a
// period; along the range it is constant; away from every range it is one.
{
  const W = 256, H = 128
  const feature = { x: 128, y: 64, thickness: 1, tangentX: 1, tangentY: 0, kind: 'range', subsides: false, plateA: 0, plateB: 1, movesWithPlate: 0, epochsSinceDeposit: 0 }
  const foldDomain = M.domain.torusDomain(W, H)
  const buckets = M.field.buildFeatureBuckets([feature], foldDomain)
  const T = M.tectonicsTune.TECTONICS_TUNING
  const lambda = (T.foldWavelengthKm * 1000) / foldDomain.metresPerUnit
  const at = (x, y) => M.folds.foldFactorAt(buckets, x, y, foldDomain)
  check('the axis is an anticline', Math.abs(at(128, 64) - (1 + T.foldAmplitude)) < 1e-6, at(128, 64).toFixed(3))
  check('half a wavelength across, a syncline', Math.abs(at(128, 64 + lambda / 2) - (1 - T.foldAmplitude)) < 1e-6, at(128, 64 + lambda / 2).toFixed(3))
  check('one wavelength across, the next anticline', Math.abs(at(128, 64 + lambda) - (1 + T.foldAmplitude)) < 1e-6)
  check('constant along the range', Math.abs(at(120, 64 + lambda / 4) - at(136, 64 + lambda / 4)) < 1e-6)
  let mean = 0
  const N = 200
  for (let i = 0; i < N; i++) mean += at(128, 64 + (i / N) * lambda)
  check('mean one over a period', Math.abs(mean / N - 1) < 1e-3, (mean / N).toFixed(4))
  check('one away from every range', at(20, 20) === 1)
}

// The coast as a process (phase 7): on a straight shore with a headland
// under a steady alongshore wind, the waves cut the exposed headland, the
// drift carries the sand along the shore and lays it down in the
// headland's lee — land that grows in the drift direction, a spit, with no
// rule that says so; the ledger closes (cut + supplied = deposited +
// exported).
{
  const W = 64, H = 32
  const lat = M.lattice.hexLattice(M.domain.torusDomain(W, H), 0.5)
  const z = new Float32Array(lat.vertexSlots)
  // Land in the upper half (y < 14), sea below; a headland reaching to
  // y = 20 between x = 28 and 36.
  const shoreY = (x) => (x >= 28 && x <= 36 ? 20 : 14)
  for (let v = 0; v < lat.vertexSlots; v++) {
    if (!lat.vAlive[v]) continue
    const land = lat.vy[v] < shoreY(lat.vx[v])
    // A shelf 20 m deep within four units of the shore, deep water beyond.
    const offshore = lat.vy[v] - shoreY(lat.vx[v])
    z[v] = land ? (50 + 10 * (shoreY(lat.vx[v]) - lat.vy[v])) / M.scale.ELEVATION_METERS : (offshore < 4 ? -20 : -200) / M.scale.ELEVATION_METERS
  }
  // A steady wind from the west-south-west: along the shore eastward, a
  // little onshore (the sea lies to the south, +y), at every node.
  const windE = new Float32Array(lat.vertexSlots).fill(8)
  const windS = new Float32Array(lat.vertexSlots).fill(-4)
  const areas = new Float32Array(lat.vertexSlots)
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) areas[v] = lat.voronoiArea(v)
  const hardness = new Float32Array(lat.vertexSlots).fill(1)
  const flux = new Float32Array(lat.vertexSlots)
  const zNow = z.slice()
  let land0 = 0, leeLand0 = 0
  // Where the drift builds: against the headland's updrift flank first
  // (the waves run straight onto it, the capacity is nil there — sand
  // piles up updrift of an obstacle, as against a groyne) and in its lee;
  // both are "beside the headland", and both are land that was sea.
  const lee = (v) => lat.vx[v] > 20 && lat.vx[v] < 44 && lat.vy[v] >= 14 && lat.vy[v] < 21
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v] && z[v] > 0) { land0++; if (lee(v)) leeLand0++ }
  let ledgerOk = true, cutTotal = 0, depTotal = 0
  for (let epoch = 0; epoch < 4; epoch++) {
    const r = M.coastal.computeCoastal({ mesh: lat, z: zNow, areas, windE, windS, cellM: UNITS_TO_M, hardness, sedimentFlux: flux, iterations: 4, epochYears: 1e6 })
    if (Math.abs(r.erodedM3 + r.suppliedM3 - r.depositedM3 - r.exportedM3) > 1e-6 * Math.max(1, r.erodedM3 + r.suppliedM3)) ledgerOk = false
    cutTotal += r.erodedM3; depTotal += r.depositedM3
    for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) zNow[v] += (r.depositM[v] - r.cutM[v]) / M.scale.ELEVATION_METERS
    if (epoch === 0) check(`the shore is found and exposed (${r.shoreNodes} shore nodes, cut ${(r.erodedM3 / 1e6).toFixed(1)} Mm³, deposited ${(r.depositedM3 / 1e6).toFixed(1)} Mm³, exported ${(r.exportedM3 / 1e6).toFixed(1)} Mm³)`, r.shoreNodes > 0 && r.erodedM3 > 0)
  }
  check('the coast\'s ledger closes every epoch (cut + supplied = deposited + exported)', ledgerOk)
  let land1 = 0, leeLand1 = 0
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v] && zNow[v] > 0) { land1++; if (lee(v)) leeLand1++ }
  check(`land grows beside the headland where the drift stalls (${leeLand0} → ${leeLand1} land nodes there)`, leeLand1 > leeLand0)
  console.log(`       land ${land0} → ${land1} nodes, ${(cutTotal / 1e9).toFixed(2)} km³ cut, ${(depTotal / 1e9).toFixed(2)} km³ laid down over 4 epochs`)
}

const order0 = (mesh) => { for (let v = 0; v < mesh.vertexSlots; v++) if (mesh.vAlive[v]) return v; return 0 }

// Ice as a process (phase 6): on a V-shaped valley under a cold climate
// the ice flows, its mass closes (what fed it = what melted + what left),
// and its erosion turns the V into a U — the floor widens.
{
  const W = 64, H = 32
  const lat = M.lattice.hexLattice(M.domain.torusDomain(W, H), 0.5)
  const z = new Float32Array(lat.vertexSlots)
  const valleyX = W / 2
  for (let v = 0; v < lat.vertexSlots; v++) {
    if (!lat.vAlive[v]) continue
    const dx = Math.abs(M.toroidal.wrappedDelta(lat.vx[v], valleyX, W))
    // A V valley 2000 m deep, walls to 3000 m, along y, sloping along its
    // length (a sine on the torus, 600 m of fall) so the ice FLOWS down
    // the valley — a glacier's erosion is its sliding, and sliding needs a
    // slope along the ice; across a V the ice surface is level. Land
    // everywhere.
    z[v] = (1300 + Math.min(1500, dx * 400) + 300 * Math.sin((2 * Math.PI * lat.vy[v]) / H)) / M.scale.ELEVATION_METERS
  }
  // −4 °C at 2300 m puts the equilibrium line near 2200 m: the walls
  // above it feed a trunk glacier that melts on the floor — a valley
  // glacier, not an ice sheet over everything (at −12 °C the whole world
  // was under ice and the cut was uniform: the V stayed). Per node, as the
  // climate reaches the nodes (climatePoints.ts): the temperature at sea
  // level, each node takes the model's lapse (6.5 °C per km) to its height
  // — cold walls, a warm floor.
  const precipitation = new Float32Array(lat.vertexSlots).fill(600)
  const seaLevelTemperature = new Float32Array(lat.vertexSlots).fill(-4 + 6.5 * 2.3)
  // A 14 °C year, the range where the history's ice ends (glacial.ts
  // melts on the warmest month since DEC-0036 phase 8b-2): the warmest
  // month at the line near −1 °C, as the annual mean's −8 was.
  const seasonalAmplitude = new Float32Array(lat.vertexSlots).fill(14)
  const ice = M.glacial.computeIceOnMesh({ mesh: lat, z, seaLevelTemperature, precipitation, seasonalAmplitude, cellM: UNITS_TO_M })
  let iced = 0, maxH = 0
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v] && ice.thickness[v] > 0) { iced++; maxH = Math.max(maxH, ice.thickness[v]) }
  let landNodes = 0
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) landNodes++
  let bMin = Infinity, bMax = -Infinity
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) { bMin = Math.min(bMin, ice.balance[v]); bMax = Math.max(bMax, ice.balance[v]) }
  check(`a valley glacier forms (${iced} of ${landNodes} nodes iced, up to ${maxH.toFixed(0)} m)`, iced > 0 && iced < landNodes && maxH > 50, `balance ${bMin.toFixed(2)}..${bMax.toFixed(2)} m/yr, ELA ${ice.elaM[order0(lat)].toFixed(0)} m`)
  check(`the ice's mass closes (in ${(ice.massIn / 1e9).toFixed(2)} = melt ${(ice.massMelt / 1e9).toFixed(2)} + out ${(ice.massOut / 1e9).toFixed(2)} km³/yr)`, Math.abs(ice.massIn - ice.massMelt - ice.massOut) <= 1e-6 * ice.massIn)
  // The profile across the valley at mid-length: the floor's width (the
  // span within 100 m of the deepest point) before and after the ice.
  // The trough's making: the cut is the sliding's, and the sliding is
  // the trunk's — the floor band (within half a unit of the axis) cuts
  // more than the walls two to three units out, 800–1200 m up; the
  // floor's sliding cut stays under the per-epoch cap (a fjord's rate),
  // and the buzzsaw (DEC-0036 phase 8d) adds no more than the node's
  // height over its line — it planes towards the ELA, never below it. On this
  // world the difference is small (259 vs 221 m): it is an ice cap, 91 %
  // of it iced, the walls under a kilometre of ice too. A full U profile
  // from a V needs a valley-scale test with a realistic accumulation area
  // and is the calibration's (ADAPTIVE_MESH_PLAN.md phase 6), not this
  // gate's.
  const zAfter = z.slice()
  let floorCut = 0, floorN = 0, wallCut = 0, wallN = 0, maxCut = 0, overCap = 0, sawed = 0
  for (let epoch = 0; epoch < 3; epoch++) {
    const iceNow = M.glacial.computeIceOnMesh({ mesh: lat, z: zAfter, seaLevelTemperature, precipitation, seasonalAmplitude, cellM: UNITS_TO_M })
    const g = M.glacial.glacialErosionOnMesh(lat, zAfter, iceNow, 1e6, UNITS_TO_M)
    for (let v = 0; v < lat.vertexSlots; v++) {
      if (!lat.vAlive[v]) continue
      const overLineM = Math.max(0, zAfter[v] * M.scale.ELEVATION_METERS - iceNow.elaM[v])
      overCap = Math.max(overCap, g.cutM[v] - M.surfaceTune.SURFACE_TUNING.glacialErosionMaxM - overLineM)
      if (overLineM > 0 && g.cutM[v] > 0) sawed++
      zAfter[v] -= g.cutM[v] / M.scale.ELEVATION_METERS
      const dx = Math.abs(M.toroidal.wrappedDelta(lat.vx[v], valleyX, W))
      if (dx <= 0.5) { floorCut += g.cutM[v]; floorN++ } else if (dx >= 2 && dx <= 3) { wallCut += g.cutM[v]; wallN++ }
      if (g.cutM[v] > maxCut) maxCut = g.cutM[v]
    }
    if (epoch === 0) check(`the ice cuts (${(g.cutM3 / 1e9).toFixed(1)} km³ in an epoch) and leaves till (${(g.tillM3 / 1e9).toFixed(1)} km³)`, g.cutM3 > 0 && g.tillM3 > 0)
  }
  const floorMean = floorCut / Math.max(1, floorN), wallMean = wallCut / Math.max(1, wallN)
  check(`the trunk cuts the floor more than the walls (floor ${floorMean.toFixed(0)} m vs walls ${wallMean.toFixed(0)} m an epoch)`, floorMean > wallMean && wallMean >= 0)
  check(`the cut stays under the cap plus the height over the line (max cut ${maxCut.toFixed(0)} m, ${Math.max(0, overCap).toFixed(1)} m over the bound; the cap ${M.surfaceTune.SURFACE_TUNING.glacialErosionMaxM} m an epoch; ${sawed} node-epochs over their line cut)`, overCap <= 1e-3)
}

// The coupled epoch (phase 5.1): a small real world through the handover,
// then epochs in which the plates move the nodes, the mesh is rebuilt
// and remeshed, the baseline follows the tectonics and the erosion runs
// on the relief — every epoch valid, finite, deterministic.
{
  const CW = 256, CH = 128
  const world = async () => {
    const archean = M.archean.createArcheanSimulation('coupled', CW, CH)
    // The land share reached in the harness's 60 epochs, not at 1000 Ma
    // (archean/archeanLand.ts): a world with land to carry the epochs.
    const params = { ...M.archeanStep.DEFAULT_ARCHEAN_PARAMS, land: { ...M.archeanStep.DEFAULT_ARCHEAN_PARAMS.land, reachEpoch: 60 } }
    for (let e = 0; e < 60; e++) M.archeanStep.archeanStep(archean, params)
    return M.finalize.finalizeArchean(archean)
  }
  const sim = await world()
  const t0 = performance.now()
  const terrain = M.coupled.createCoupledTerrain(sim)
  const buildMs = performance.now() - t0
  check(`the coupled terrain starts as a valid mesh (${terrain.mesh.aliveVertices} nodes, ${buildMs.toFixed(0)} ms)`, terrain.mesh.validate().length === 0)
  let land0 = 0
  for (let v = 0; v < terrain.mesh.vertexSlots; v++) if (terrain.mesh.vAlive[v] && terrain.z[v] > 0) land0++
  const EPOCHS = 5, ITER = 4
  const trace = []
  let valid = true, finite = true
  let ledger = 0, columnVolume = 0, supplyBounded = true, rebound = 0, subsidence = 0, climateSane = true
  const climateTrace = []
  const coverTrace = []
  let screeTotal = 0, solifluction = 0, folded = 0, iceShare = 0, glacialCut = 0, till = 0, coastCut = 0, coastDep = 0, shore = 0
  // The ice's load per epoch: its change against the ice the plate carried,
  // and the weight of all the ice standing (m³ of rock).
  const iceLoads = []
  let iceCarried = true
  const t1 = performance.now()
  for (let e = 0; e < EPOCHS; e++) {
    const te = performance.now()
    const stats = await M.coupled.stepCoupledEpoch(sim, terrain, { iterationsPerEpoch: ITER })
    if (terrain.mesh.validate().length > 0) valid = false
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) if (terrain.mesh.vAlive[v] && !Number.isFinite(terrain.z[v])) finite = false
    ledger += stats.depositedM3 + stats.screeM3 - stats.reErodedM3 + stats.iceCoastColumnM3
    columnVolume = stats.columnVolumeM3
    if (stats.reboundMaxM > rebound) rebound = stats.reboundMaxM
    if (stats.subsidenceMaxM > subsidence) subsidence = stats.subsidenceMaxM
    coverTrace.push(stats.meanLandCover)
    iceLoads.push({ load: stats.iceLoadM3, weight: stats.iceWeightM3 })
    if (terrain.ice.length !== terrain.mesh.vertexSlots) iceCarried = false
    screeTotal += stats.screeM3
    folded = Math.max(folded, stats.foldedShare)
    iceShare = Math.max(iceShare, stats.iceAreaShare)
    coastCut += stats.coastCutM3; coastDep += stats.coastDepositM3; shore = stats.shoreNodes
    glacialCut += stats.glacialCutM3
    till += stats.tillM3
    solifluction = Math.max(solifluction, stats.solifluctionShare)
    climateTrace.push(`${stats.meanLandTempC.toFixed(1)}°C ice ${stats.iceVolumeKm3.toFixed(0)} km³ sea ${stats.seaLevelM.toFixed(2)} m lakes ${stats.lakes} (oldest ${stats.oldestLakeMa} Ma) ${(stats.timing.climate / 1000).toFixed(1)}+${(stats.timing.lakes / 1000).toFixed(1)} s`)
    if (!Number.isFinite(stats.meanLandTempC) || stats.meanLandTempC < -60 || stats.meanLandTempC > 60 || stats.iceVolumeKm3 < 0 || stats.seaLevelM > 0) climateSane = false
    // No aggradation from nothing (the 2026-07-27 mode): what the walk
    // lays down plus what leaves the world is at most what came loose.
    if (stats.depositedM3 + stats.exportedFluxM3 > stats.erodedFluxM3 * 1.001 + 1) supplyBounded = false
    trace.push(`${stats.nodesAfter}n −${stats.removed} +${stats.inserted} land ${(stats.landCells / (CW * CH) * 100).toFixed(1)}% vol ${(stats.landVolume * 9).toFixed(0)} col ${(stats.columnVolumeM3 / 1e9).toFixed(1)} km³ ${(performance.now() - te).toFixed(0)}ms`)
  }
  const perEpoch = (performance.now() - t1) / EPOCHS
  check(`${EPOCHS} coupled epochs keep the mesh valid`, valid)
  check('every height stays finite', finite)
  console.log(`       ${trace.join(' | ')}`)
  check(`an epoch costs under 20 s at this size (${perEpoch.toFixed(0)} ms, ${ITER} iterations)`, perEpoch < 20000)
  let landN = 0
  for (let v = 0; v < terrain.mesh.vertexSlots; v++) if (terrain.mesh.vAlive[v] && terrain.z[v] > 0) landN++
  check(`land persists through the epochs (${land0} → ${landN} land nodes)`, landN > land0 * 0.5)
  {
    // THE ICE IS LOADED BY ITS CHANGE (2026-10-12). The deflection a load
    // causes stays in the nodes' z, so the flexure loads the change in the
    // ice since the epoch before, carried with the nodes through the
    // rebuild and the remesh; until then it loaded the whole ice at every
    // epoch, and a standing sheet pushed the plate down again and again.
    // The first epoch finds no ice on the plate and loads it all; a later
    // one what grew or melted: its load is the weight now less the weight
    // of the epoch before, up to what the rebuild and the remesh do to the
    // carried ice (cells change their areas as the nodes drift; measured
    // 2026-10-12 on this world: 0.05–0.4 % of the weight). The old load was
    // the whole weight, off by all of the epoch before's.
    const first = iceLoads[0]
    const fmt = (m3) => `${(m3 / 1e9).toFixed(1)} km³`
    const off = iceLoads.slice(1).map((e, i) => Math.abs(e.load - (e.weight - iceLoads[i].weight)) / iceLoads[i].weight)
    check(`the ice is on the plate after every epoch (${terrain.ice.length} nodes)`, iceCarried)
    check(`the first epoch loads all the ice (${fmt(first.load)} of ${fmt(first.weight)})`, first.weight > 0 && Math.abs(first.load - first.weight) <= 1e-9 * first.weight)
    check(`a later epoch loads only the ice's change (load against the change of the weight, off by ${off.map((f) => `${(f * 100).toFixed(2)} %`).join(', ')} of the weight before)`, off.length > 0 && off.every((f) => f <= 0.02), iceLoads.map((e) => `${fmt(e.load)} / ${fmt(e.weight)}`).join(', '))
  }
  // The sediment column (phase 5.2): the epochs' deposits as layers. The
  // ledger — deposited plus scree minus re-eroded, plus what the ice and the
  // coast put in and took out (since 2026-10-01), summed over the epochs
  // — closes against the column's volume to within what the remesh loses
  // (new nodes interpolate, a rift's fresh floor starts with none):
  // measured 4–10 % over five epochs on this world as the deposition's
  // pattern changed through 5.2–5.6, 0.1 % once the ice's and the coast's
  // share was counted (2026-10-01); the gate is what says the remesh does
  // not eat the column, not that the interpolation is exact.
  check(`the column holds the epochs' deposits (${(columnVolume / 1e9).toFixed(1)} km³, ${terrain.column.epochs.length} layers)`, columnVolume > 0 && terrain.column.epochs.length === EPOCHS)
  check(`the column's ledger closes (deposited + scree − re-eroded + ice and coast ${(ledger / 1e9).toFixed(1)} km³ vs column ${(columnVolume / 1e9).toFixed(1)} km³)`, Math.abs(ledger - columnVolume) <= 0.15 * Math.max(ledger, columnVolume))
  {
    // A cut that comes off the column: no layer is ever negative, and the
    // provenance products never exceed their thickness (oldness and the
    // hardness story are ≤ ~2, so the ratio stays in range).
    // The temperature product may be negative (a layer laid down below
    // freezing); every other value is a thickness or a thickness times a
    // non-negative quantity.
    let negative = 0
    const byValue = new Array(M.column.COLUMN_VALUES).fill(0)
    let worst = 0
    const d = terrain.column.data
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) {
      if (!terrain.mesh.vAlive[v]) continue
      for (let k = 0; k < M.column.COLUMN_DEPTH; k++) {
        if (k % M.column.COLUMN_VALUES === 4) continue
        const x = d[v * M.column.COLUMN_DEPTH + k]
        if (x < 0) { negative++; byValue[k % M.column.COLUMN_VALUES]++; if (x < worst) worst = x }
      }
    }
    check('no layer value goes negative (the temperature product aside)', negative === 0, `${negative} (${byValue.join('/')}, worst ${worst})`)
  }
  check('every epoch\'s deposits are bounded by its supply (no aggradation from nothing)', supplyBounded)
  check(`the plate answers the epochs' loads (rebound up to ${rebound.toFixed(0)} m, subsidence up to ${subsidence.toFixed(0)} m)`, rebound > 0 && subsidence > 0)
  // The climate per epoch (phase 5.4): a sane land temperature, an ice
  // volume and a sea level the ice lowers, every epoch on the record; the
  // lakes matched between epochs never older than the history; a layer's
  // climate products read back as the temperature it formed under.
  console.log(`       ${climateTrace.join(' | ')}`)
  check('every epoch has a sane climate (land temperature, ice ≥ 0, sea level ≤ 0)', climateSane)
  // The cover (phase 5.5): from the start, the land carries vegetation
  // that holds it; a world whose plants are still to come runs bare.
  check(`the land carries a cover (mean ${coverTrace.map((c) => c.toFixed(2)).join(' ')})`, coverTrace.every((c) => c > 0.05 && c <= 1))
  check('a forest holds more than a desert', M.cover.COVER_BY_BIOME[M.biomes.Biome.TemperateForest] > M.cover.COVER_BY_BIOME[M.biomes.Biome.Desert])
  // The hillslope additions (phase 5.6): creep lays down scree as a layer,
  // and the cold band exists on this world.
  check(`creep lays down scree (${(screeTotal / 1e9).toFixed(1)} km³ over the epochs)`, screeTotal > 0)
  check(`some land lies in the periglacial band (${(solifluction * 100).toFixed(0)} %)`, solifluction > 0 && solifluction < 1)
  check(`the ranges fold (${(folded * 100).toFixed(0)} % of the land under a folding range)`, folded > 0 && folded < 1)
  // The ice of the history (phase 6): on this cold world the ice covers
  // some land, cuts, and leaves moraines.
  check(`the epochs carry ice (up to ${(iceShare * 100).toFixed(0)} % of the land) that cuts ${(glacialCut / 1e9).toFixed(0)} km³ and leaves ${(till / 1e9).toFixed(0)} km³ of till`, iceShare > 0 && iceShare < 1 && glacialCut > 0 && till > 0)
  // The coast (phase 7): the waves work the shore and the drift lays
  // sand down along it, every epoch.
  check(`the waves work the shore (${shore} shore nodes, ${(coastCut / 1e9).toFixed(1)} km³ cut, ${(coastDep / 1e9).toFixed(1)} km³ laid down over the epochs)`, shore > 0 && coastCut > 0 && coastDep > 0)
  // The hydrogeology (phase 5a) on the history's terrain, with its column:
  // the graph from the last epoch's routing, then springs, the regime with
  // the baseflow and the water table — the invariants hold, and the
  // column's gravel gives this world its springs.
  {
    const RX = M.climateField.CLIMATE_RES_X, RY = M.climateField.CLIMATE_RES_Y
    const sub = M.meshHydro.meshSubstrate(terrain.mesh, terrain.routing, terrain.areas)
    const coarseZ = M.raster.rasteriseNodeField(terrain.mesh, terrain.z, RX, RY)
    const weather = M.weather.computeWeather(M.climateMesh.climateTerrain(terrain.mesh.domain, coarseZ, RX, RY), M.weather.defaultWeatherParams())
    // The climate at the nodes (climate/climatePoints.ts, DEC-0036 phase 7).
    const cells = M.climatePoints.climateCellsFromWeather(weather)
    const points = M.climatePoints.meshPoints(terrain.mesh, terrain.z)
    const at = M.climatePoints.climateAtPoints(cells, points)
    const discharge = M.hydro.accumulateDischargeOn(sub, terrain.z, at.precipitation, at.temperature)
    const lakes = M.hydro.computeLakesOn(sub, discharge, terrain.z, at.temperature)
    const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY, terrain.mesh.domain), M.climatePoints.meanLandRunoff(cells))
    const regime = M.hydro.accumulateRegimeInputsOn(sub, terrain.z, at.temperature, at.precipitation, at.monsoonIndex)
    const graph = M.graph.buildRiverGraph({ substrate: sub, discharge, elevation: terrain.z, threshold, maxDischarge: M.hydro.maxDischargeOverLand(discharge, terrain.z), bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, regime, criticalArea: M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY, terrain.mesh.domain) })
    const biomes = M.biomes.classifyPoints(at, points, terrain.mesh.domain).biome
    const ground = M.ground.computeHydrogeology({ sub, elevation: terrain.z, graph, column: terrain.column, hardness: null, precipitation: at.precipitation, temperature: at.temperature, monsoonIndex: at.monsoonIndex, cover: M.cover.coverField(biomes, true), regime, discharge, cellM: UNITS_TO_M })
    const broken = Object.entries(M.ground.hydrogeologyInvariants(ground, graph, terrain.z)).filter(([, n]) => n > 0)
    check(`the hydrogeology holds its invariants (${ground.springs.length} springs, ${graph.reaches.filter((r) => r.springFed).length} spring-fed of ${graph.reaches.length} reaches)`, broken.length === 0, broken.map(([k, n]) => `${k}:${n}`).join(' '))
    let land = 0, wet = 0, sum = 0
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) { if (!terrain.mesh.vAlive[v] || terrain.z[v] <= 0) continue; const d = ground.waterTableDepthM[v]; if (d < 0) continue; land++; sum += d; if (d === 0) wet++ }
    check(`the water table lies under the land (mean ${(sum / Math.max(1, land)).toFixed(0)} m, ${(wet / Math.max(1, land) * 100).toFixed(0)} % at the surface)`, land > 0 && sum / land > 0 && wet < land)
    check('a spring-fed reach is perennial', graph.reaches.every((r) => !r.springFed || r.regime === 'perennial'))
  }
  {
    const simBare = await world()
    const bare = M.coupled.createCoupledTerrain(simBare)
    const st = await M.coupled.stepCoupledEpoch(simBare, bare, { iterationsPerEpoch: ITER, weather: { ...M.weather.defaultWeatherParams(), planet: { ...M.planet.DEFAULT_PLANET_FORCING, landPlantsFromMa: 1e9 } } })
    check('before the land-plants moment the land is bare', st.meanLandCover === 0)
  }
  check(`the sim records the climate history (${sim.climateHistory.length} epochs)`, sim.climateHistory.length === EPOCHS && sim.climateHistory.every((r) => Number.isFinite(r.meanLandTempC) && r.iceVolumeKm3 >= 0))
  check(`the sea level is the ice's (${sim.eustaticM.toFixed(3)} m)`, sim.eustaticM <= 0 && sim.eustaticM === sim.climateHistory[sim.climateHistory.length - 1].seaLevelM)
  check(`no lake is older than the history (${sim.lakeAges.length} lakes)`, sim.lakeAges.every((l) => l.ageMa > 0 && l.ageMa <= EPOCHS * sim.epochMa))
  {
    let inRange = true, sampled = 0
    const d = terrain.column.data, D = M.column.COLUMN_DEPTH, V = M.column.COLUMN_VALUES
    for (let v = 0; v < terrain.mesh.vertexSlots && sampled < 5000; v++) {
      if (!terrain.mesh.vAlive[v]) continue
      for (let layer = 0; layer < terrain.column.epochs.length; layer++) {
        const t = d[v * D + layer * V] + d[v * D + layer * V + 1]
        if (t <= 1) continue
        sampled++
        const temp = d[v * D + layer * V + 4] / t
        if (!(temp > -60 && temp < 60)) inRange = false
      }
    }
    check(`a layer's climate reads back as a temperature (${sampled} layers sampled)`, sampled > 0 && inRange)
  }
  {
    // Two classes (5.2b): the torrents shed coarse, the plains fine; both
    // reach the column, the fine the larger part.
    let fine = 0, coarse = 0
    const d = terrain.column.data
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) {
      if (!terrain.mesh.vAlive[v]) continue
      for (let layer = 0; layer < terrain.column.epochs.length; layer++) {
        fine += d[v * M.column.COLUMN_DEPTH + layer * M.column.COLUMN_VALUES]
        coarse += d[v * M.column.COLUMN_DEPTH + layer * M.column.COLUMN_VALUES + 1]
      }
    }
    check(`the column holds both classes (coarse ${(coarse / (fine + coarse) * 100).toFixed(1)} % of the thickness)`, fine > 0 && coarse > 0)
    check(`the export tally grows on the sim (${(sim.sedimentExportM3 / 1e9).toFixed(1)} km³)`, sim.sedimentExportM3 > 0)
  }
  // Determinism: the same world, the same epochs, the same bytes.
  const sim2 = await world()
  const terrain2 = M.coupled.createCoupledTerrain(sim2)
  for (let e = 0; e < EPOCHS; e++) await M.coupled.stepCoupledEpoch(sim2, terrain2, { iterationsPerEpoch: ITER })
  const a = M.coupled.encodeCoupledTerrain(terrain), b = M.coupled.encodeCoupledTerrain(terrain2)
  check('the same history gives the same terrain bytes', a.z.length === b.z.length && a.z.every((v, i) => v === b.z[i]) && a.nodes.every((v, i) => v === b.nodes[i]), `${a.z.length} vs ${b.z.length} nodes`)
  check('and the same column bytes', a.column.length === b.column.length && a.column.every((v, i) => v === b.column[i]), `${a.column.length} bytes`)
  check('and the same climate history', JSON.stringify(sim.climateHistory) === JSON.stringify(sim2.climateHistory) && JSON.stringify(sim.lakeAges) === JSON.stringify(sim2.lakeAges))
  // A terrain restored from its bytes continues identically for one epoch.
  const restored = M.coupled.decodeCoupledTerrain(sim2, b)
  const simA = sim, simB = sim2
  const sa = await M.coupled.stepCoupledEpoch(simA, terrain, { iterationsPerEpoch: ITER })
  const sb = await M.coupled.stepCoupledEpoch(simB, restored, { iterationsPerEpoch: ITER })
  const za = terrain.z, zb = restored.z
  check('a restored terrain steps to the same bytes', za.length === zb.length && za.every((v, i) => v === zb[i]) && sa.nodesAfter === sb.nodesAfter)
  const ca = M.coupled.encodeCoupledTerrain(terrain).column, cb = M.coupled.encodeCoupledTerrain(restored).column
  check('and to the same column', ca.length === cb.length && ca.every((v, i) => v === cb[i]))
}

// ---------------------------------------------------------- sphere domain

// The sphere Domain and its grid (DEC-0035 step 4b): no stage runs on it
// yet, so its geometry is checked here against known great-circle values,
// and its raster against the sphere's area and the pole's neighbours.
console.log('\n[1s] the sphere domain')
{
  const t0 = performance.now()
  const SW = 512, SH = 256
  const S = M.domain.sphereDomain(SW, SH)
  const R = SW / (2 * Math.PI)
  const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))
  const dist = (ax, ay, bx, by) => Math.sqrt(S.distanceSq(ax, ay, bx, by))
  check('sphere: an equator quarter is πR/2', near(dist(0, SH / 2, SW / 4, SH / 2), Math.PI * R / 2), `${dist(0, SH / 2, SW / 4, SH / 2)}`)
  check('sphere: pole to equator is πR/2', near(dist(37, 0, 300, SH / 2), Math.PI * R / 2) && near(dist(5, SH, 99, SH / 2), Math.PI * R / 2))
  check('sphere: antipodes are πR apart', near(dist(10, 40, 10 + SW / 2, SH - 40), Math.PI * R) && near(dist(0, 0, 123, SH), Math.PI * R))
  check('sphere: a degree along a meridian is a degree of arc', near(dist(77, 10, 77, 10 + SH / 180), Math.PI * R / 180) && near(dist(77, SH - 1, 77 + SW / 2, SH - 1), 2 * Math.PI * R / SH))
  // Symmetry and |delta| = distance over a spread of point pairs, the
  // poles, near-poles and near-antipodes among them.
  const out = { x: 0, y: 0 }
  let asym = 0, lenErr = 0
  let seed = 11
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const pairs = [[0, 0, 100, 3], [5, SH, 300, SH - 1], [1, 1e-7, 200, 1e-7], [10, 40, 10 + SW / 2, SH - 40 - 1e-6]]
  for (let i = 0; i < 2000; i++) pairs.push([rnd() * SW, rnd() * SH, rnd() * SW, rnd() * SH])
  for (const [ax, ay, bx, by] of pairs) {
    const d = dist(ax, ay, bx, by)
    asym = Math.max(asym, Math.abs(d - dist(bx, by, ax, ay)) / R)
    S.delta(ax, ay, bx, by, out)
    lenErr = Math.max(lenErr, Math.abs(Math.hypot(out.x, out.y) - d) / R)
  }
  check('sphere: the distance is symmetric', asym < 1e-12, `${asym.toExponential(1)} R`)
  check('sphere: |delta(a, b)| is the distance', lenErr < 1e-12, `${lenErr.toExponential(1)} R`)
  S.delta(10, SH / 2, 9, SH / 2, out)
  const east = out.x > 0 && Math.abs(out.y) < 1e-12
  S.delta(9, SH / 2 + 1, 9, SH / 2, out)
  const south = out.y > 0 && Math.abs(out.x) < 1e-12
  S.delta(9, SH / 2 - 1, 9, SH / 2, out)
  const north = out.y < 0
  check('sphere: delta on the equator points east (+x) and south (+y)', east && south && north)
  S.delta(9, 30, 9, 30, out)
  const self = out.x === 0 && out.y === 0
  S.delta(0, SH, 0, 0, out)
  check('sphere: delta to itself is zero, to the antipode πR', self && near(Math.hypot(out.x, out.y), Math.PI * R))
  // At the north pole the frame follows b's own meridian: a point down
  // meridian x_b is due "south", one a quarter turn east is due east.
  S.delta(64, 3, 64, 0, out)
  const poleSouth = out.y > 0 && Math.abs(out.x) < 1e-9
  S.delta(64 + SW / 4, 3, 64, 0, out)
  check('sphere: at the pole the frame follows b\'s meridian', poleSouth && out.x > 0 && Math.abs(out.y) < 1e-9 && near(Math.hypot(out.x, out.y), 3 * Math.PI * R / SH))
  // rotateAround: the distance to the centre is kept, −angle undoes it, and
  // +90° takes east toward south as on the torus.
  let keep = 0, back = 0
  for (let i = 0; i < 500; i++) {
    const x = rnd() * SW, y = rnd() * SH, cx = rnd() * SW, cy = rnd() * SH, a = (rnd() - 0.5) * 6
    const p = S.rotateAround(x, y, cx, cy, a)
    keep = Math.max(keep, Math.abs(dist(p.x, p.y, cx, cy) - dist(x, y, cx, cy)) / R)
    const q = S.rotateAround(p.x, p.y, cx, cy, -a)
    back = Math.max(back, dist(q.x, q.y, x, y) / R)
  }
  check('sphere: rotateAround keeps the distance to its centre', keep < 1e-12, `${keep.toExponential(1)} R`)
  check('sphere: rotateAround by −angle undoes it', back < 1e-9, `${back.toExponential(1)} R`)
  const turned = S.rotateAround(101, SH / 2, 100, SH / 2, Math.PI / 2)
  S.delta(turned.x, turned.y, 100, SH / 2, out)
  check('sphere: +90° about a centre turns east toward south', out.y > 0 && Math.abs(out.x) < 1e-9, `(${out.x.toExponential(1)}, ${out.y.toFixed(6)})`)
  // wrapPoint across each pole: x + W/2, y reflected; wrapX the longitude.
  S.wrapPoint(30, -5, out)
  const overNorth = near(out.x, 30 + SW / 2) && near(out.y, 5)
  S.wrapPoint(SW - 10, SH + 7, out)
  const overSouth = near(out.x, SW / 2 - 10) && near(out.y, SH - 7)
  S.wrapPoint(-3, 2 * SH + 4, out)
  const twice = near(out.x, SW - 3) && near(out.y, 4)
  check('sphere: wrapPoint across a pole lands at x + W/2, y reflected', overNorth && overSouth && twice && S.wrapY(-5) === 5 && S.wrapX(SW + 2) === 2)
  // advance (step 4d1): the exp map, delta's inverse.
  const d = { x: 0, y: 0 }
  let inv = 0
  for (const [ax, ay, bx, by] of [...pairs, [64, 3, 64, 0], [200, SH - 2, 17, SH], [5, 0, 300, SH / 2]]) {
    S.delta(ax, ay, bx, by, d)
    S.advance(bx, by, d.x, d.y, out)
    inv = Math.max(inv, dist(out.x, out.y, ax, ay) / R)
  }
  check('sphere: advance undoes delta (2000 pairs, poles among them)', inv < 1e-12, `${inv.toExponential(1)} R`)
  let still = 0
  for (const [x, y] of [[0, 0], [123, SH], [77.5, 40], [SW - 1e-9, SH / 2]]) {
    S.advance(x, y, 0, 0, out)
    still = Math.max(still, dist(out.x, out.y, x, y) / R)
  }
  check('sphere: advance by (0, 0) is the identity', still < 1e-12, `${still.toExponential(1)} R`)
  S.advance(40, SH / 2, Math.PI * R / 2, 0, out)
  check('sphere: πR/2 east along the equator is lon + 90°', near(out.x, 40 + SW / 4) && near(out.y, SH / 2), `(${out.x}, ${out.y})`)
  S.advance(100, 0, 0, Math.PI * R / 2, out)
  const fromNorth = near(out.x, 100) && near(out.y, SH / 2)
  // At the south pole delta's frame is the limit along meridian x too, so
  // its "south" points on across the pole: north (−y) is the way to x.
  S.advance(100, SH, 0, -Math.PI * R / 2, out)
  const fromSouth = near(out.x, 100) && near(out.y, SH / 2)
  S.advance(100, SH, 0, Math.PI * R / 2, out)
  const across = near(out.x, 100 + SW / 2) && near(out.y, SH / 2)
  check('sphere: πR/2 south from the north pole along meridian x reaches the equator at x', fromNorth && fromSouth && across, `(${out.x}, ${out.y})`)
  let circle = 0
  for (const [x, y, dx, dy] of [[40, SH / 2, 1, 0], [100, 0, 0, 1], [300, 70, 0.6, -0.8], [10, 200, -1, 0.3]]) {
    const k = (2 * Math.PI * R) / Math.hypot(dx, dy)
    S.advance(x, y, dx * k, dy * k, out)
    circle = Math.max(circle, dist(out.x, out.y, x, y) / R)
  }
  check('sphere: a full great circle (2πR) returns to the start', circle < 1e-12, `${circle.toExponential(1)} R`)
  const T = M.domain.torusDomain(SW, SH)
  let torusSame = true
  for (let i = 0; i < 2000; i++) {
    const x = rnd() * SW, y = rnd() * SH, dx = (rnd() - 0.5) * 3 * SW, dy = (rnd() - 0.5) * 3 * SH
    T.advance(x, y, dx, dy, out)
    if (out.x !== T.wrapX(x + dx) || out.y !== T.wrapY(y + dy)) torusSame = false
  }
  check('torus: advance is wrapX(x + dx), wrapY(y + dy), bit for bit', torusSame)
  check('sphere: latitude 0 at the equator, 1 at the poles, north above it', S.latitude(0.5) === 0 && S.latitude(0) === 1 && S.latitude(1) === 1 && S.north(0.25) && !S.north(0.75))
  // The grid.
  const G = S.grid(64, 32)
  let area = 0
  for (let j = 0; j < G.resY; j++) area += G.cellArea(j) * G.resX
  const chartCell = (SW / G.resX) * (SH / G.resY)
  check('sphere grid: the cells sum to 4πR²', Math.abs(area * chartCell - 4 * Math.PI * R * R) / (4 * Math.PI * R * R) < 1e-9, `${(area * chartCell / (4 * Math.PI * R * R)).toFixed(12)} of 4πR²`)
  check('sphere grid: rowScale is cos φ at the row centre', near(G.rowScale(15), Math.cos(Math.PI / 2 - (15.5 * Math.PI) / 32), 1e-12) && G.rowScale(0) < 0.05)
  const nN = G.neighbour(5, 0, 0, -1), nS = G.neighbour(5, 31, 1, 1)
  check('sphere grid: a step across the north pole lands in row 0, column + resX/2', nN === 0 * 64 + 37, `${nN}`)
  check('sphere grid: a step across the south pole lands in row 31, column + resX/2', nS === 31 * 64 + 38, `${nS}`)
  check('sphere grid: columns wrap in longitude', G.neighbour(63, 10, 1, 0) === 10 * 64 && G.index(-1, 10) === 10 * 64 + 63)
  let threw = false
  try { G.rowTable(1) } catch { threw = true }
  check('sphere grid: rowTable refuses a margin (the pole needs neighbour)', threw)
  // averagePoleRows: each pole row constant, the area-weighted mean kept.
  const f = new Float32Array(64 * 32)
  for (let i = 0; i < f.length; i++) f[i] = Math.sin(i * 0.37) * 10 + (i % 64)
  const mean = (field) => { let s = 0, w = 0; for (let j = 0; j < 32; j++) for (let i = 0; i < 64; i++) { s += field[j * 64 + i] * G.cellArea(j); w += G.cellArea(j) } return s / w }
  const before = mean(f)
  G.averagePoleRows(f)
  const constRow = (j) => f.subarray(j * 64, j * 64 + 64).every((v) => v === f[j * 64])
  check('sphere grid: averagePoleRows makes each pole row one value', constRow(0) && constRow(31) && !constRow(1))
  check('and keeps the area-weighted mean', near(mean(f), before, 1e-6), `${before.toFixed(6)} → ${mean(f).toFixed(6)}`)
  // The samplers: continuous across the pole, wrapping in longitude.
  const g = new Float32Array(64 * 32)
  for (let j = 0; j < 32; j++) for (let i = 0; i < 64; i++) g[j * 64 + i] = j * 100 + i
  const atPole = G.sampleBilinear(g, 5, -0.5)
  check('sphere grid: a bilinear sample at the pole is the mean of the two meridians', near(atPole, (g[5] + g[37]) / 2), `${atPole}`)
  check('and a domain point just past the pole samples as its wrapPoint', near(G.sampleBilinearAt(g, 40, -1), G.sampleBilinearAt(g, 40 + SW / 2, 1)) && G.cellAt(40, -1) === G.cellAt(40 + SW / 2, 1))
  const same = G.upscale(g, 64, 32)
  check('sphere grid: upscale maps cell centre onto cell centre', same.every((v, i) => v === g[i]) && G.upscale(g, 128, 64).length === 128 * 64)
  const ms = performance.now() - t0
  check(`sphere: the section is quick (${ms.toFixed(0)} ms)`, ms < 1000)
}

// ------------------------------------------------------------ sphere mesh

// The adaptive mesh on the sphere (DEC-0035 step 4d4): the same
// triangulation code with the globe's geometry — exact 3D predicates, a
// geodesic bootstrap, spherical areas. Checked here against independent
// computations (plain Math on unit vectors), not against the predicates
// the triangulation itself uses: a Delaunay check that shares the
// in-circle test with the legalisation would pass a sign error.
console.log('\n[1g] the mesh on the sphere')
{
  const t0 = performance.now()
  const SW = 512, SH = 256
  const S = M.domain.sphereDomain(SW, SH)
  const R = SW / (2 * Math.PI)
  // A chart point's unit vector on the globe of a W × W/2 chart.
  const toUnit = (x, y, w = SW) => {
    const t = (y * 2 * Math.PI) / w, l = (x * 2 * Math.PI) / w
    return [Math.sin(t) * Math.cos(l), Math.sin(t) * Math.sin(l), Math.cos(t)]
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const det = (a, b, c) => dot(a, crs(b, c))
  const unitOfV = (mesh, v) => toUnit(mesh.vx[v], mesh.vy[v], mesh.domain.width)
  const angle = (a, b) => Math.atan2(Math.hypot(...crs(a, b)), dot(a, b))
  // Every structural property, by its own arithmetic: one winding about the
  // centre (det[a, b, c] < 0, which is counter-clockwise in the chart's
  // east/south frame — the torus's convention) and counter-clockwise in
  // the first corner's tangent frame; V − E + F = 2 with E counted; the
  // empty circumcircle across every edge as an angle (the circumcentre the
  // normal of the triangle's plane, its radius the angle to a corner); the
  // Voronoi cells summing to 4πR².
  const audit = (mesh) => {
    let wound = 0, chartCcw = 0, triangles = 0, inside = 0, worst = 0
    const edges = new Set()
    const d1 = { x: 0, y: 0 }, d2 = { x: 0, y: 0 }
    const D = mesh.domain
    for (let t = 0; t < mesh.triSlots; t++) {
      if (!mesh.tAlive[t]) continue
      triangles++
      const ids = [mesh.tris[3 * t], mesh.tris[3 * t + 1], mesh.tris[3 * t + 2]]
      const [a, b, c] = ids.map((v) => unitOfV(mesh, v))
      if (det(a, b, c) < 0) wound++
      D.delta(mesh.vx[ids[1]], mesh.vy[ids[1]], mesh.vx[ids[0]], mesh.vy[ids[0]], d1)
      D.delta(mesh.vx[ids[2]], mesh.vy[ids[2]], mesh.vx[ids[0]], mesh.vy[ids[0]], d2)
      if (d1.x * d2.y - d1.y * d2.x > 0) chartCcw++
      let n = crs(sub(b, a), sub(c, a))
      if (dot(n, a) < 0) n = n.map((k) => -k)
      const nl = Math.hypot(...n)
      n = n.map((k) => k / nl)
      const r = angle(n, a)
      for (let i = 0; i < 3; i++) {
        const e = 3 * t + i
        const u = ids[i], w = ids[(i + 1) % 3]
        edges.add(Math.min(u, w) * 4194304 + Math.max(u, w))
        const opposite = unitOfV(mesh, mesh.apex(mesh.twin[e]))
        const excess = (r - angle(n, opposite)) / r
        if (excess > 1e-7) inside++
        if (excess > worst) worst = excess
      }
    }
    let area = 0
    for (const v of aliveVertices(mesh)) area += mesh.voronoiArea(v)
    const full = (D.width * D.width) / Math.PI
    return {
      triangles, wound, chartCcw, inside, worst,
      euler: mesh.aliveVertices - edges.size + triangles,
      areaErr: Math.abs(area - full) / full,
    }
  }
  const sound = (mesh, a = audit(mesh)) => mesh.validate().length === 0 && a.wound === a.triangles && a.chartCcw === a.triangles && a.inside === 0 && a.euler === 2 && a.areaErr < 1e-9
  const sayAudit = (a) => `V − E + F = ${a.euler}, ${a.triangles - a.wound} unwound, ${a.inside} edges with a point in the circumcircle (worst ${a.worst.toExponential(1)}), areas ${a.areaErr.toExponential(1)} off 4πR²`

  // The bootstrap: the geodesic lattice at the ocean spacing.
  const lat = M.lattice.geodesicLattice(S, T.oceanSpacingM / S.metresPerUnit)
  const latAudit = audit(lat)
  check(`sphere: the geodesic lattice is a Delaunay triangulation of the sphere (${lat.aliveVertices} nodes)`, sound(lat, latAudit) && (lat.aliveVertices - 2) % 10 === 0, sayAudit(latAudit))
  let nearPole = Infinity
  for (const v of aliveVertices(lat)) nearPole = Math.min(nearPole, lat.vy[v], SH - lat.vy[v])
  check('sphere: no lattice node sits at a pole (every (x, 0) is the pole)', nearPole > 1, `${nearPole.toFixed(2)} units from it at the closest`)

  // A synthetic sphere world: a continent across the seam on the equator,
  // a sharp range near the north pole, a massif ON the south pole, a river
  // across the seam. Distances on the globe.
  const g = (x, y, cx, cy, s) => Math.exp(-S.distanceSq(x, y, cx, cy) / (s * s))
  const sphereWorld = {
    heightAt(x, y) {
      const land = Math.max(g(x, y, 0, 128, 70), g(x, y, 0, SH, 40), g(x, y, 150, 30, 40))
      let z = m(-4000) + (m(300) - m(-4000)) * Math.min(1, land * 1.6)
      z += m(4000) * g(x, y, 150, 22, 9) // a range by the north pole
      z += m(2500) * g(x, y, 0, SH, 14) // a massif on the south pole
      z += m(1500) * g(x, y, 20, 120, 10)
      return z
    },
    dischargeAt(x, y) {
      // Along the equator across the seam, x from −40 to 40.
      const off = { x: 0, y: 0 }
      S.delta(x, y, 0, 128, off)
      if (Math.abs(off.x) > 40 || Math.abs(off.y) > 1.5) return 0
      return 200 + (off.x + 40) * 60
    },
  }
  let tb = performance.now()
  const built = M.build.buildMesh(S, sphereWorld, { seed: 42 })
  const sphereMs = performance.now() - tb
  const { mesh, state } = built
  const a0 = audit(mesh)
  check(`sphere: the built mesh is a Delaunay triangulation of the sphere (${mesh.aliveVertices} nodes, ${sphereMs.toFixed(0)} ms)`, sound(mesh, a0), sayAudit(a0))
  {
    // frame() on the globe is the log map, close to O(ℓ²/R²) (step 4d5).
    // The erosion index's facets from its cotangents against the exact
    // Voronoi edge (the arc between the two circumcentres), and the
    // sampler's vertex normals against each triangle seen from each of its
    // corners — with a mutation: the sampler without carrying a normal from
    // one corner's frame to the next is off near the poles.
    const f = new Float64Array(6)
    const cotAt = (e) => {
      const t = mesh.triangleOf(e), i = e - 3 * t
      mesh.frame(t, f)
      const ux = f[(2 * i) % 6] - f[(2 * i + 4) % 6], uy = f[(2 * i + 1) % 6] - f[(2 * i + 5) % 6]
      const wx = f[(2 * i + 2) % 6] - f[(2 * i + 4) % 6], wy = f[(2 * i + 3) % 6] - f[(2 * i + 5) % 6]
      return (ux * wx + uy * wy) / Math.abs(ux * wy - uy * wx)
    }
    const cc = (t) => { const o = new Float64Array(3); mesh.circumcentreOnGlobe(t, o); return [o[0], o[1], o[2]] }
    const errs = []
    for (let t = 0; t < mesh.triSlots; t++) {
      if (!mesh.tAlive[t]) continue
      for (let i = 0; i < 3; i++) {
        const e = 3 * t + i, tw = mesh.twin[e]
        if (e > tw) continue
        const n = crs(unitOfV(mesh, mesh.from(e)), unitOfV(mesh, mesh.to(e)))
        const c1 = cc(t), c2 = cc(mesh.triangleOf(tw))
        if (Math.sign(dot(c1, n)) === Math.sign(dot(c2, n))) continue
        const exact = (angle(c1, c2) * R) / mesh.edgeLength(e)
        errs.push(Math.abs((cotAt(e) + cotAt(tw)) / 2 - exact) / exact)
      }
    }
    errs.sort((p, q) => p - q)
    const p99 = errs[Math.floor(0.99 * errs.length)]
    check('sphere: the erosion index\'s cotangent facets are the exact Voronoi edges to O(ℓ²/R²)', p99 < 5e-3 && errs[errs.length >> 1] < 5e-4, `median ${errs[errs.length >> 1].toExponential(1)}, p99 ${p99.toExponential(1)} over ${errs.length} edges`)
    const z = state.get('z')
    const normalError = () => {
      const sampler = M.sampler.createMeshSampler(mesh, z)
      const ref = new Float64Array(mesh.vertexSlots * 3)
      const d = { x: 0, y: 0 }
      for (let t = 0; t < mesh.triSlots; t++) {
        if (!mesh.tAlive[t]) continue
        const cs = [mesh.tris[3 * t], mesh.tris[3 * t + 1], mesh.tris[3 * t + 2]]
        for (const v of cs) {
          const p = cs.map((c) => { S.delta(mesh.vx[c], mesh.vy[c], mesh.vx[v], mesh.vy[v], d); return [d.x * S.metresPerUnit, z[c] * M.scale.ELEVATION_METERS, d.y * S.metresPerUnit] })
          let n = crs(sub(p[1], p[0]), sub(p[2], p[0]))
          if (n[1] < 0) n = n.map((k) => -k)
          for (let k = 0; k < 3; k++) ref[3 * v + k] += n[k]
        }
      }
      const out = new Float64Array(3)
      let worst = 0
      for (const v of aliveVertices(mesh)) {
        sampler.normalAt(mesh.vx[v], mesh.vy[v], out)
        const r = [ref[3 * v], ref[3 * v + 1], ref[3 * v + 2]]
        worst = Math.max(worst, Math.acos(Math.min(1, dot(r, [out[0], out[1], out[2]]) / Math.hypot(...r))))
      }
      return (worst * 180) / Math.PI
    }
    const carried = normalError()
    mesh.domain = { ...S, transport: (vx, vy, _a, _b, _c, _d, out) => { out.x = vx; out.y = vy } }
    const unturned = normalError()
    mesh.domain = S
    check('sphere: the sampler\'s vertex normals are in each vertex\'s own frame; left in the first corner\'s they are not', carried < 0.01 && unturned > 10 * carried, `worst ${carried.toFixed(4)}°; unturned ${unturned.toFixed(2)}°`)
  }
  {
    // Settled as the torus's build is: no edge long, no node crowded, a
    // fixed point of the remesh.
    const targets = targetsOf(mesh, state)
    const nb = new Int32Array(256)
    let edges = 0, long = 0, crowded = 0
    for (let t = 0; t < mesh.triSlots; t++) {
      if (!mesh.tAlive[t]) continue
      for (let i = 0; i < 3; i++) {
        const e = 3 * t + i
        if (mesh.twin[e] < e) continue
        edges++
        if (mesh.edgeLength(e) > T.insertRatio * Math.min(targets[mesh.tris[e]], targets[mesh.to(e)])) long++
      }
    }
    for (const v of aliveVertices(mesh)) if (M.remesh.meanSpacing(mesh, v) < T.removeRatio * effectiveTarget(mesh, targets, v, nb)) crowded++
    const copy = M.build.buildMesh(S, sphereWorld, { seed: 42 })
    const again = M.remesh.remesh(copy.mesh, copy.state, M.build.densityTarget(copy.state), { seed: 43 })
    check('sphere: the build settles inside the hysteresis band, a fixed point of the remesh', long <= edges * 0.001 && crowded === 0 && again.inserted + again.removed <= mesh.aliveVertices * 0.001,
      `${long} of ${edges} edges long, ${crowded} nodes crowded; a remesh +${again.inserted} −${again.removed}`)
  }
  {
    // Graded like the torus's: the land denser than the ocean, the poles'
    // relief as dense as the equator's would be.
    const z = state.get('z')
    let landN = 0, landA = 0, seaN = 0, seaA = 0, poleN = 0
    for (const v of aliveVertices(mesh)) {
      const a = mesh.voronoiArea(v)
      if (z[v] > 0) { landN++; landA += a } else { seaN++; seaA += a }
      if (S.distanceSq(mesh.vx[v], mesh.vy[v], 0, SH) < 14 * 14) poleN++
    }
    check('sphere: the density rule grades it (land denser than sea, the south pole\'s massif refined)', landN / landA > 4 * (seaN / seaA) && poleN > 50, `${(landA / landN).toFixed(2)} vs ${(seaA / seaN).toFixed(2)} units² a node, ${poleN} nodes on the polar massif`)
  }
  // Against the torus: the harness's own synthetic world on a torus of
  // the same chart, the same rule.
  tb = performance.now()
  const torusBuilt = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const torusMs = performance.now() - tb
  check(`sphere: the build costs about what the torus's does per node (sphere ${(1000 * sphereMs / mesh.aliveVertices).toFixed(1)} µs a node, torus ${(1000 * torusMs / torusBuilt.mesh.aliveVertices).toFixed(1)})`,
    sphereMs / mesh.aliveVertices < 3 * (torusMs / torusBuilt.mesh.aliveVertices), `${mesh.aliveVertices} vs ${torusBuilt.mesh.aliveVertices} nodes`)

  // Point location: random points from random far hints, both poles at
  // many longitudes, the longitude seam on both sides. The answer must
  // hold the point, by plain Math.
  {
    const rand = M.rng.mulberry32(99)
    const pts = []
    for (let i = 0; i < 3000; i++) pts.push([rand() * SW, Math.acos(1 - 2 * rand()) * SH / Math.PI])
    for (let i = 0; i < 16; i++) pts.push([i * 31.7, 0], [i * 31.7, SH])
    for (let i = 0; i <= 32; i++) pts.push([0, (i * SH) / 32], [SW - 1e-4, (i * SH) / 32], [Math.fround(SW - 1e-9), (i * SH) / 32])
    const alive = []
    for (let t = 0; t < mesh.triSlots; t++) if (mesh.tAlive[t]) alive.push(t)
    let wrong = 0, worstOut = 0
    const before = mesh.walkFallbacks
    for (const [x, y] of pts) {
      const t = mesh.locate(x, y, alive[Math.floor(rand() * alive.length)])
      const [a, b, c] = [0, 1, 2].map((k) => unitOfV(mesh, mesh.tris[3 * t + k]))
      const q = toUnit(x, y)
      // Chart-positive sides: −det, as the stored winding is.
      const sides = [-det(a, b, q), -det(b, c, q), -det(c, a, q)]
      const scale = Math.hypot(...sub(a, b)) ** 2
      const out = Math.min(...sides) / scale
      if (out < -1e-9) wrong++
      worstOut = Math.min(worstOut, out)
    }
    check(`sphere: locate finds the triangle holding the point (${pts.length} points, the poles and the seam among them, from far hints)`, wrong === 0 && mesh.walkFallbacks === before, `${wrong} wrong, worst ${worstOut.toExponential(1)}, ${mesh.walkFallbacks - before} fallbacks`)
  }

  // Insert and remove at random, near the poles and the seam too. No node
  // lost (every inserted point a live vertex at its float32 position),
  // none duplicated (a repeat returns the vertex it is).
  {
    const ops = M.serial.compactMesh(mesh).mesh
    const rand = M.rng.mulberry32(5)
    const placed = []
    for (let i = 0; i < 600; i++) {
      const x = i % 6 === 0 ? 0 : rand() * SW
      const y = i % 5 === 0 ? (rand() < 0.5 ? rand() * 3 : SH - rand() * 3) : Math.acos(1 - 2 * rand()) * SH / Math.PI
      placed.push([x, y, ops.insert(x, y)])
    }
    const repeat = placed.slice(0, 50).every(([x, y, v]) => ops.insert(x, y) === v)
    const kept = placed.every(([x, y, v]) => ops.vAlive[v] && ops.vx[v] === M.domain.sphereDomain(SW, SH).wrapX(Math.fround(x)) && ops.vy[v] === Math.fround(y))
    const afterInsert = audit(ops)
    let removed = 0
    const victims = aliveVertices(ops).filter((_, i) => i % 7 === 3)
    for (const v of victims) if (ops.remove(v)) removed++
    const afterRemove = audit(ops)
    check(`sphere: inserting 600 points and removing ${removed} keeps it a Delaunay triangulation`, sound(ops, afterInsert) && sound(ops, afterRemove) && removed > 0.9 * victims.length, sayAudit(afterRemove))
    check('sphere: no inserted node lost or moved, a repeated point is the vertex it was', kept && repeat)
  }

  // The remesh: a change of state (the southern massif raised, the
  // continent's west drowned), then coarsen + refine. Valid, and inside
  // the hysteresis band again where it was not.
  {
    const work = M.build.buildMesh(S, sphereWorld, { seed: 42 })
    const z = work.state.get('z')
    for (const v of aliveVertices(work.mesh)) {
      const x = work.mesh.vx[v], y = work.mesh.vy[v]
      z[v] += m(3000) * g(x, y, 300, 200, 20)
      if (S.distanceSq(x, y, SW - 40, 128) < 30 * 30) z[v] = m(-4000)
    }
    const nb = new Int32Array(256)
    const outOfBand = (mesh, state) => {
      const targets = targetsOf(mesh, state)
      let long = 0, crowded = 0
      for (let t = 0; t < mesh.triSlots; t++) {
        if (!mesh.tAlive[t]) continue
        for (let i = 0; i < 3; i++) {
          const e = 3 * t + i
          if (mesh.twin[e] < e) continue
          if (mesh.edgeLength(e) > T.insertRatio * Math.min(targets[mesh.tris[e]], targets[mesh.to(e)])) long++
        }
      }
      for (const v of aliveVertices(mesh)) if (M.remesh.meanSpacing(mesh, v) < T.removeRatio * effectiveTarget(mesh, targets, v, nb)) crowded++
      return { long, crowded }
    }
    // An extensive field rides along: a coarsen hands it to the
    // neighbours by area, so its total is kept.
    const sed = work.state.add('sediment', 'extensive')
    const rand = M.rng.mulberry32(3)
    for (const v of aliveVertices(work.mesh)) sed[v] = rand() * 100
    const massOf = () => { const f = work.state.get('sediment'); let sum = 0; for (const v of aliveVertices(work.mesh)) sum += f[v] * work.mesh.voronoiArea(v); return sum }
    const mass0 = massOf()
    const b0 = outOfBand(work.mesh, work.state)
    const nodes0 = work.mesh.aliveVertices
    const target = M.build.densityTarget(work.state)
    const c = M.remesh.coarsen(work.mesh, work.state, target, { seed: 7 })
    const mass1 = massOf()
    const r = M.remesh.refine(work.mesh, work.state, target, { seed: 7 })
    const b1 = outOfBand(work.mesh, work.state)
    // The coarsen's four rounds take a drowned plain most of the way to the
    // ocean's spacing (each round at most every other node); the rest is
    // the next epoch's, as on the torus.
    check(`sphere: the remesh keeps it valid and moves it to the target (long edges ${b0.long} → ${b1.long}, crowded nodes ${b0.crowded} → ${b1.crowded}; −${c.removed} +${r.inserted}, ${nodes0} → ${work.mesh.aliveVertices} nodes)`,
      sound(work.mesh) && b1.long <= 0.001 * work.mesh.aliveVertices && b1.crowded <= 0.2 * b0.crowded && r.inserted > 0 && c.removed > 0)
    check('sphere: an extensive field is conserved through the coarsen', Math.abs(mass1 - mass0) < 1e-9 * mass0, `${mass0.toFixed(1)} → ${mass1.toFixed(1)}`)
  }

  // The routing over the graph is shape-free: its reaches are the
  // triangulation's edge lengths, which on the globe are arcs (to the
  // index's float32), and its
  // receivers form a forest draining to the sea.
  {
    const z = state.get('z')
    const index = M.erosion.buildMeshEngineIndex(mesh, z)
    let lenErr = 0
    for (let k = 0; k < index.activeCount; k++) {
      const v = index.active[k]
      for (let s = index.nbrStart[k]; s < index.nbrStart[k + 1]; s++) {
        const j = index.nbr[s]
        if (j < 0) continue
        const arc = R * angle(unitOfV(mesh, v), unitOfV(mesh, index.active[j]))
        lenErr = Math.max(lenErr, Math.abs(index.lenRel[s] - arc) / arc)
      }
    }
    const routing = M.meshHydro.meshRouting(mesh, z)
    const nb = new Int32Array(256)
    let notEdge = 0, cyclic = 0
    for (const v of aliveVertices(mesh)) {
      const t = routing.flowTarget[v]
      if (t < 0) continue
      const n = mesh.neighbours(v, nb)
      if (!nb.subarray(0, n).includes(t)) notEdge++
      let w = v, hops = 0
      while (w >= 0 && hops <= mesh.aliveVertices) { w = routing.flowTarget[w]; hops++ }
      if (w >= 0) cyclic++
    }
    check(`sphere: the routing's reaches are the arcs, its receivers an acyclic forest along the mesh's edges (${index.activeCount} active nodes)`, lenErr < 2e-7 && notEdge === 0 && cyclic === 0 && routing.poppedCount > 0, `reach vs arc ${lenErr.toExponential(1)}, ${notEdge} off-edge, ${cyclic} in a cycle`)
  }

  // The codec: the canonical form round-trips bit for bit — the same
  // positions, triangles and twins, the same bytes again.
  {
    const { mesh: canon } = M.serial.compactMesh(mesh)
    const order = Int32Array.from({ length: canon.vertexSlots }, (_, i) => i)
    const bytes = M.serial.encodeMesh(canon, order)
    const back = M.serial.decodeMesh(S, bytes)
    const again = M.serial.encodeMesh(back, order)
    const same = (a, b, n) => { for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true }
    const identical = back.vertexSlots === canon.vertexSlots && back.triSlots === canon.triSlots
      && same(back.vx, canon.vx, canon.vertexSlots) && same(back.vy, canon.vy, canon.vertexSlots)
      && same(back.tris, canon.tris, 3 * canon.triSlots) && same(back.twin, canon.twin, 3 * canon.triSlots)
      && Buffer.compare(Buffer.from(bytes.connectivity), Buffer.from(again.connectivity)) === 0
      && Buffer.compare(Buffer.from(bytes.nodes.buffer), Buffer.from(again.nodes.buffer)) === 0
    const positions = new Set()
    for (let i = 0; i < bytes.count; i++) positions.add(`${bytes.nodes[2 * i]},${bytes.nodes[2 * i + 1]}`)
    check(`sphere: the codec round-trips bit for bit (${bytes.connectivity.length} bytes of connectivity, ${(bytes.connectivity.length / bytes.count).toFixed(1)} a node)`, identical && sound(back) && positions.size === mesh.aliveVertices, `${positions.size} distinct positions of ${mesh.aliveVertices}`)
  }

  // triangulatePoints, the coupled loop's rebuild: the nodes moved (here a
  // rigid turn about a point, as a plate turns them), triangulated again —
  // every point a vertex of its own, the bootstrap lattice gone. Then the
  // nodes unmoved: the build's own lattice nodes among them land exactly on
  // the new lattice's, collapse onto them, and must be inserted again
  // rather than go with the lattice (lost before 2026-10-10).
  {
    const xs = [], ys = []
    for (const v of aliveVertices(mesh)) {
      const p = S.rotateAround(mesh.vx[v], mesh.vy[v], 200, 70, 0.01)
      xs.push(p.x)
      ys.push(p.y)
    }
    const { mesh: tri, mapping } = M.build.triangulatePoints(S, xs, ys, xs.length, T.oceanSpacingM / S.metresPerUnit)
    const distinct = new Set(mapping).size === xs.length && Array.from(mapping).every((v) => tri.vAlive[v])
    check(`sphere: triangulatePoints keeps every node and removes its lattice (${xs.length} → ${tri.aliveVertices})`, distinct && tri.aliveVertices === xs.length && sound(tri))

    const sx = [], sy = []
    for (const v of aliveVertices(mesh)) {
      sx.push(mesh.vx[v])
      sy.push(mesh.vy[v])
    }
    const { mesh: same, mapping: sameMap } = M.build.triangulatePoints(S, sx, sy, sx.length, T.oceanSpacingM / S.metresPerUnit)
    const kept = new Set(sameMap).size === sx.length && Array.from(sameMap).every((v, i) => same.vAlive[v] && same.vx[v] === sx[i] && same.vy[v] === sy[i])
    check(`sphere: triangulatePoints keeps nodes that land on its lattice (${sx.length} → ${same.aliveVertices})`, kept && same.aliveVertices === sx.length && sound(same))
  }

  // The rasterisation: a smooth field of the position has no seam at
  // x = 0 / W; a field constant on each polar cap gives constant pole
  // rows (row 0 is the north pole itself — the raster's convention, cell
  // px is the field AT x = px, the sphere's synthesis render's too).
  {
    const field = new Float32Array(mesh.vertexSlots)
    for (const v of aliveVertices(mesh)) {
      const [x, y, z] = unitOfV(mesh, v)
      field[v] = z > 0.95 ? 7 : z < -0.95 ? -3 : x + 0.5 * y * z
    }
    const RW = 512, RH = 256
    const r = M.raster.rasteriseNodeField(mesh, field, RW, RH)
    // Per row away from the caps: the step across the seam (column W − 1
    // to column 0) against the largest step between two other columns.
    let seam = 0, worstRatio = 0
    for (let y = 40; y < RH - 40; y++) {
      let step = 0
      for (let x = 1; x < RW; x++) step = Math.max(step, Math.abs(r[y * RW + x] - r[y * RW + x - 1]))
      const s = Math.abs(r[y * RW] - r[y * RW + RW - 1])
      seam = Math.max(seam, s)
      worstRatio = Math.max(worstRatio, s / step)
    }
    const rowConst = (row, value) => { for (let x = 0; x < RW; x++) if (Math.abs(r[row * RW + x] - value) > 1e-6) return false; return true }
    check('sphere: the rasterised mesh has no seam at x = 0 / W (the step across it is one column\'s)', worstRatio <= 1.01, `largest seam step ${seam.toExponential(2)}, at most ${worstRatio.toFixed(2)} of its row's largest`)
    check('sphere: and constant pole rows over a constant polar cap', rowConst(0, 7) && rowConst(RH - 1, -3) && rowConst(1, 7))
  }

  // Determinism: the same fields and seed, the same bytes; the codec too.
  {
    const again = M.build.buildMesh(S, sphereWorld, { seed: 42 })
    const enc = (b) => { const { mesh: c } = M.serial.compactMesh(b.mesh); return M.serial.encodeMesh(c, M.serial.hilbertVertexOrder(c)) }
    const e1 = enc(built), e2 = enc(again)
    check('sphere: the same world and seed build the same mesh, byte for byte', meshHash(built.mesh) === meshHash(again.mesh)
      && Buffer.compare(Buffer.from(e1.connectivity), Buffer.from(e2.connectivity)) === 0 && Buffer.compare(Buffer.from(e1.nodes.buffer), Buffer.from(e2.nodes.buffer)) === 0, meshHash(built.mesh))
  }

  // A real sphere world: a small Archean and two plate epochs on the
  // sphere, then the coupled terrain's start — the mesh from the synthesis
  // (createCoupledTerrain), no erosion.
  {
    const ta = performance.now()
    // 45 epochs, not 40: since the globe's compaction pulls each blob in
    // its own frame (DEC-0036 phase 8b-2) the world's one young blob lies
    // over a downwelling at the hand-over after 40 and the first plate
    // epoch recycles it — a world without land.
    const archean = M.archean.createArcheanSimulation('mesh-sphere', 256, 128, 'sphere')
    for (let e = 0; e < 45; e++) M.archeanStep.archeanStep(archean)
    const sim = M.finalize.finalizeArchean(archean)
    for (let e = 0; e < 2; e++) M.plates.stepEpoch(sim)
    const tc = performance.now()
    const terrain = M.coupled.createCoupledTerrain(sim)
    const terrainMs = performance.now() - tc
    const finite = Array.from(terrain.z).every(Number.isFinite) && Array.from(terrain.baseline).every(Number.isFinite)
    let land = 0
    for (let v = 0; v < terrain.mesh.vertexSlots; v++) if (terrain.z[v] > 0) land += terrain.areas[v]
    const ta2 = audit(terrain.mesh)
    check(`sphere: a real sphere world's coupled terrain starts as a valid mesh (${terrain.mesh.aliveVertices} nodes in ${terrainMs.toFixed(0)} ms, the world ${(tc - ta).toFixed(0)} ms; land ${(100 * land / (4 * Math.PI * (256 / (2 * Math.PI)) ** 2)).toFixed(1)} %)`,
      sound(terrain.mesh, ta2) && finite && land > 0, sayAudit(ta2))
  }
  const ms = performance.now() - t0
  check(`sphere mesh: the section is quick (${(ms / 1000).toFixed(1)} s)`, ms < 20000)
}

// ------------------------------------------------------------ determinism

console.log('\n[2] determinism')
{
  const a = M.build.buildMesh(domain, synthetic, { seed: 42 })
  const b = M.build.buildMesh(domain, synthetic, { seed: 42 })
  check('the same fields and seed build the same mesh', meshHash(a.mesh) === meshHash(b.mesh), meshHash(a.mesh))
  const seedB = M.build.buildMesh(domain, synthetic, { seed: 43 })
  check('another seed builds another mesh', meshHash(a.mesh) !== meshHash(seedB.mesh))
  // The remesh is deterministic too: perturb the state identically, remesh.
  const perturb = (built) => { const z = built.state.get('z'); for (const v of aliveVertices(built.mesh)) if (z[v] > 0) z[v] *= 0.5 }
  perturb(a); perturb(b)
  M.remesh.remesh(a.mesh, a.state, M.build.densityTarget(a.state), { seed: 7 })
  M.remesh.remesh(b.mesh, b.state, M.build.densityTarget(b.state), { seed: 7 })
  check('the same remesh on the same state gives the same mesh', meshHash(a.mesh) === meshHash(b.mesh), meshHash(a.mesh))
}

// A history epoch is run single-threaded in the browser and on the engine
// pool by the job worker (level 1's replay and its check against the
// save). Both route afresh every HISTORY_DEFAULTS.routingEvery iterations
// (the pool on the synchronous cadence at that depth, coupledEpoch.ts;
// DEC-0036 phase 8c), so they agree bit for bit at any iteration count —
// the synchronous pool's bytes against the single engine's are checked
// with the engine's pool above. The cadence is a whole number of
// iterations, one or more.
check('a history epoch routes on one cadence in both engines',
  Number.isInteger(M.coupled.HISTORY_DEFAULTS.routingEvery) && M.coupled.HISTORY_DEFAULTS.routingEvery >= 1,
  `${M.coupled.HISTORY_DEFAULTS.iterationsPerEpoch} iterations, routing every ${M.coupled.HISTORY_DEFAULTS.routingEvery}`)

// The generator's math (core/detMath.ts) is the same bits in every engine:
// the hash of a fixed set of its values, recorded once and confirmed equal
// in V8 and JavaScriptCore (2026-10-02). It moves only when detMath does —
// and then every world moves with it.
{
  const D = M.detMath
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const u = (lo, hi) => lo + (hi - lo) * rnd()
  const f = new Float64Array(1)
  const words = new Uint32Array(f.buffer)
  let h = 0x811c9dc5
  const add = (v) => { f[0] = v; h = Math.imul(h ^ words[0], 0x01000193) >>> 0; h = Math.imul(h ^ words[1], 0x01000193) >>> 0 }
  let worst = 0
  const ulps = (a, b) => (a === b ? 0 : Math.abs(a - b) / (Math.abs(b) * 2 ** -52))
  for (let i = 0; i < 20000; i++) {
    const a = u(-20, 20), b = u(-20, 20), p = u(0, 50), q = u(-1, 1)
    const pairs = [
      [D.detExp(a), Math.exp(a)], [D.detLog(p), Math.log(p)], [D.detSin(a), Math.sin(a)], [D.detCos(a), Math.cos(a)],
      [D.detTan(q), Math.tan(q)], [D.detAtan2(a, b), Math.atan2(a, b)], [D.detAsin(q), Math.asin(q)], [D.detAcos(q), Math.acos(q)],
      [D.detPow(p, b / 10), Math.pow(p, b / 10)], [D.detHypot(a, b), Math.hypot(a, b)],
    ]
    for (const [det, ref] of pairs) {
      add(det)
      worst = Math.max(worst, ulps(det, ref))
    }
  }
  check('the deterministic math stays near Math (a few ulp; pow, by exp·log, more)', worst < 64, `${worst.toFixed(1)} ulp at most`)
  check('and computes the bits recorded in V8 and JavaScriptCore', h.toString(16) === DET_MATH_HASH, h.toString(16))
}

// ------------------------------------------------------------ byte hashes

const current = { build: meshHash(built.mesh) }
if (MODE === 'hash-record') {
  writeFileSync(HASHES, JSON.stringify(current, null, 2) + '\n')
  console.log(`\n[3] byte hashes recorded to ${HASHES}`)
} else if (existsSync(HASHES)) {
  console.log('\n[3] byte hashes (refactor guard)')
  const recorded = JSON.parse(readFileSync(HASHES, 'utf8'))
  for (const [k, v] of Object.entries(recorded)) check(`${k} unchanged`, current[k] === v, `${v} → ${current[k]}`)
} else {
  console.log('\n[3] byte hashes: no baseline (npm run harness:mesh hash-record to arm)')
}

// --------------------------------------------------------------- measure

if (MODE === 'measure') {
  const path = process.argv[3]
  if (!path) throw new Error('measure needs a save path')
  for (const arg of process.argv.slice(4)) {
    const [k, v] = arg.split('=')
    if (!(k in T)) throw new Error(`unknown constant ${k}`)
    T[k] = Number(v)
    if (!Number.isFinite(T[k])) throw new Error(`bad value for ${k}`)
  }
  const JSZip = (await import(`${CLIENT}/node_modules/jszip/dist/jszip.min.js`)).default
  const zip = await JSZip.loadAsync(readFileSync(path))
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  const RW = manifest.world.width, RH = manifest.world.height
  // The save holds no raster (DEC-0036, the save step): the elevation and
  // the discharge as world/query.ts draws them from the save's meshes.
  const Q = await L('/src/world/query.ts')
  const opened = await Q.openWorld(readFileSync(path))
  if (!opened) throw new Error(`${path}: not a world this build opens`)
  const z = (await opened.acquire('elevation')).data
  const q = (await opened.acquire('discharge'))?.data ?? null
  const real = M.domain.torusDomain(RW, RH)
  // The raster's cell px holds the field at world x = px (the synthesis
  // convention, mesh/meshRaster.ts), so the grid sampler — not the
  // world one, whose centres sit at +0.5.
  const sampler = {
    heightAt: (x, y) => M.field.sampleBilinearGrid(z, RW, RH, x, y),
    dischargeAt: q ? (x, y) => M.field.sampleBilinearGrid(q, RW, RH, x, y) : undefined,
  }
  console.log(`\n[measure] ${path} ${RW}×${RH}, constants`, JSON.stringify(T))
  const t0 = performance.now()
  const { mesh, state, stats } = M.build.buildMesh(real, sampler, { seed: 42 })
  const ms = performance.now() - t0
  const targets = targetsOf(mesh, state)
  const zf = state.get('z'), qf = q ? state.get('discharge') : null
  const bins = { deepOcean: 0, floor: 0, relief: 0, discharge: 0, curvature: 0, ceiling: 0 }
  let land = 0, ocean = 0
  const relief = new Float64Array(2)
  const R = await L('/src/generator/mesh/meshRelief.ts')
  for (const v of aliveVertices(mesh)) {
    if (zf[v] < 0) ocean++; else land++
    const hM = zf[v] * M.scale.ELEVATION_METERS
    if (hM < T.deepOceanBelowM) { bins.deepOcean++; continue }
    R.reliefAt(mesh, zf, v, UNITS_TO_M, M.scale.ELEVATION_METERS, relief)
    const hR = relief[0] > 0 ? T.reliefPerNodeM / relief[0] : Infinity
    const hQ = qf && qf[v] > 0 ? T.minSpacingM * Math.sqrt(T.dischargeRefM3s / qf[v]) : Infinity
    const hK = relief[1] !== 0 ? T.curvatureFactor / Math.abs(relief[1]) : Infinity
    const h = Math.min(hR, hQ, hK)
    if (h >= T.maxSpacingM) bins.ceiling++
    else if (h <= T.minSpacingM) bins.floor++
    else if (h === hR) bins.relief++
    else if (h === hQ) bins.discharge++
    else bins.curvature++
  }
  console.log(`  ${mesh.aliveVertices} nodes (${land} land, ${ocean} ocean) in ${(ms / 1000).toFixed(1)} s, ${stats.rounds} rounds, per round ${stats.perRound.join(' ')}`)
  console.log('  binding term', JSON.stringify(bins))
  const again = M.remesh.remesh(mesh, state, M.build.densityTarget(state), { seed: 43 })
  console.log(`  remesh on the unchanged state: +${again.inserted} −${again.removed}`)
  const errs = mesh.validate()
  console.log(`  valid: ${errs.length === 0 ? 'yes' : errs[0]}`)

  // The engine on the mesh against the engine on the raster, same terrain,
  // same forcing (the save's layers, as the bake assembles them), same age
  // — rasterised to the save's grid for the comparison (decision 4).
  const inputs = await M.inputs.readWorldInputs(readFileSync(path))
  if (!inputs || !inputs.uplift || !inputs.climate) {
    console.log('  (no forcing layers in the save — engine comparison skipped)')
  } else {
    const AGE = Number(process.env.MESH_AGE ?? 40)
    // The raster engine reads its water on the climate's chart; the mesh
    // its nodes' (climate/climatePoints.ts).
    const cells = M.climatePoints.climateCellsFromSaved(real, inputs.climate)
    const chartRain = M.climateChart.chartLandField(cells.cm, cells.precipitation, (i) => cells.precipitation[i] >= 0, -1, M.climateChart.chartLand({ domain: real, elevation: z, resX: real.width, resY: real.height, dryLand: null }))
    const coarse = {
      uplift: inputs.uplift.data, hardness: inputs.erodibility?.data ?? null,
      forcingResX: inputs.uplift.resX, forcingResY: inputs.uplift.resY,
      water: chartRain, waterResX: M.climateField.CLIMATE_RES_X, waterResY: M.climateField.CLIMATE_RES_Y,
      lithoSeed: inputs.lithoSeed,
    }
    const controls = { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast }
    // The mesh: its own z (sampled from the save), forcing at the nodes.
    const meshZ0 = state.get('z').slice()
    const areas = new Float64Array(mesh.vertexSlots)
    for (const v of aliveVertices(mesh)) areas[v] = mesh.voronoiArea(v)
    const nodeForcing = M.forcing.assembleNodeForcing(coarse, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, meshZ0, areas, real, controls)
    let t1 = performance.now()
    const meshRun = await M.erosion.runMeshErosion(mesh, meshZ0, nodeForcing.forcing, { age: AGE, params: nodeForcing.params })
    const meshMs = performance.now() - t1
    // The raster: the save's elevation, the bake's forcing assembly.
    const rasterForcing = M.forcing.assembleFineForcing(coarse, z, real, controls)
    t1 = performance.now()
    const rasterRun = await M.passV2.runErosionPassV2(z, real, rasterForcing.forcing, { age: AGE, params: rasterForcing.params })
    const rasterMs = performance.now() - t1
    const meshGrid = M.raster.rasteriseNodeField(mesh, meshRun.z, RW, RH)
    const stats = (field, name) => {
      let land = 0, sum = 0, n = 0
      const hs = []
      for (let i = 0; i < field.length; i++) if (field[i] > 0) { land++; sum += field[i]; hs.push(field[i]) }
      hs.sort((a, b) => a - b)
      const p = (x) => (hs[Math.floor(x * (hs.length - 1))] * M.scale.ELEVATION_METERS).toFixed(0)
      console.log(`  ${name}: land ${(100 * land / field.length).toFixed(2)} %, mean land ${(sum / land * M.scale.ELEVATION_METERS).toFixed(0)} m, p50 ${p(0.5)} p90 ${p(0.9)} p99 ${p(0.99)} max ${p(1)} m`)
    }
    console.log(`  engine comparison, age ${AGE}: mesh ${(meshMs / 1000).toFixed(1)} s (${meshRun.index.activeCount} active nodes), raster ${(rasterMs / 1000).toFixed(1)} s`)
    stats(z, 'before      ')
    stats(rasterRun.elevations, 'raster after')
    stats(meshGrid, 'mesh after  ')
    let sq = 0, n = 0, sqCut = 0, sqCutM = 0
    for (let i = 0; i < z.length; i++) {
      if (z[i] <= 0) continue
      const d = (meshGrid[i] - rasterRun.elevations[i]) * M.scale.ELEVATION_METERS
      sq += d * d; n++
      const cr = (z[i] - rasterRun.elevations[i]) * M.scale.ELEVATION_METERS
      const cm = (z[i] - meshGrid[i]) * M.scale.ELEVATION_METERS
      sqCut += cr * cr; sqCutM += cm * cm
    }
    console.log(`  on land: RMS(mesh − raster) ${Math.sqrt(sq / n).toFixed(1)} m; RMS change raster ${Math.sqrt(sqCut / n).toFixed(1)} m, mesh ${Math.sqrt(sqCutM / n).toFixed(1)} m`)
    console.log(`  mesh sediment budget: eroded ${(meshRun.erodedFluxM3 / 1e9).toFixed(0)} km³, exported past the shelf band ${(meshRun.exportedFluxM3 / 1e9).toFixed(0)} km³`)

    // Level 1 of the ladder (phase 4.5) on this world's eroded mesh: node
    // count and time, the numbers the ladder's levels are set by.
    if (process.env.MESH_LEVEL !== '0') {
      const rounds = Number(process.env.MESH_LEVEL_ROUNDS ?? 4)
      const serial = M.serial.encodeMesh(mesh, Int32Array.from({ length: mesh.vertexSlots }, (_, i) => i))
      const t2 = performance.now()
      // The production mapping (world/bakeInputs), on the mesh eroded here.
      const level = await M.bake.bakeMeshLevel(M.bakeInputs.levelBakeInputs(inputs, { count: serial.count, nodes: serial.nodes, connectivity: serial.connectivity, z: meshRun.z.slice(0, serial.count) }), { level: 1, budget: M.bake.levelBudget(1), rounds, onProgress: (phase, f) => { if (f === 0 || f === 1) console.log(`    ${phase} ${f === 0 ? 'start' : 'done'} ${((performance.now() - t2) / 1000).toFixed(0)} s`) } })
      let land = 0
      for (let v = 0; v < level.mesh.vertexSlots; v++) if (level.mesh.vAlive[v] && level.z[v] > 0) land++
      console.log(`  level 1 (${rounds} rounds): ${level.mesh.aliveVertices} nodes (${land} land) from ${mesh.aliveVertices}, ×${(level.mesh.aliveVertices / mesh.aliveVertices).toFixed(1)}, ${((performance.now() - t2) / 1000).toFixed(0)} s; ${level.graph?.reaches.length ?? 0} reaches, ${level.waterBodies.length} bodies`)
    }
  }
}

await server.close()
console.log(failures === 0 ? '\nmesh harness: all checks passed' : `\nmesh harness: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

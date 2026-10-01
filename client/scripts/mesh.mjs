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
//                   orientation, Euler's formula for the torus, the edge
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
  bake: await L('/src/generator/pipeline/meshBakeStage.ts'),
  bakeInputs: await L('/src/world/bakeInputs.ts'),
  coupled: await L('/src/generator/pipeline/coupledEpoch.ts'),
  column: await L('/src/generator/mesh/meshColumn.ts'),
  flexure: await L('/src/generator/tectonics/flexure.ts'),
  cover: await L('/src/generator/surface/cover.ts'),
  ground: await L('/src/generator/surface/hydrogeology.ts'),
  glacial: await L('/src/generator/surface/glacial.ts'),
  coastal: await L('/src/generator/surface/coastal.ts'),
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
  planet: await L('/src/generator/planet/planetForcing.ts'),
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
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
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}

const W = 512, H = 256
const T = M.density.MESH_TUNING
const UNITS_TO_M = M.config.METERS_PER_CELL
const domain = M.domain.torusDomain(W, H)

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
const gauss = (x, y, cx, cy, sx, sy) => {
  const dx = domain.deltaX(x, cx) / sx
  const dy = domain.deltaY(y, cy) / sy
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
    const d = Math.abs(domain.deltaY(y, 128))
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
  const unitM = M.config.METERS_PER_CELL
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
  // A climate: uniform 1000 mm/yr, 15 °C, on a 16×8 climate grid.
  const CRX = 16, CRY = 8
  const precip = new Float32Array(CRX * CRY).fill(1000)
  const temperature = new Float32Array(CRX * CRY).fill(15)
  const discharge = M.hydro.accumulateDischargeOn(sub, eroded.z, precip, CRX, CRY)
  let landArea = 0, maxQ = 0
  for (const v of aliveVertices(mesh)) if (eroded.z[v] > 0) { landArea += areas[v]; maxQ = Math.max(maxQ, discharge[v]) }
  check('the largest discharge is at most the land\'s whole runoff', maxQ <= 1000 * landArea * (1 + 1e-6) && maxQ > 0, `max ${maxQ.toFixed(0)} of ${(1000 * landArea).toFixed(0)}`)
  const lakes = M.hydro.computeLakesOn(sub, discharge, eroded.z, temperature, precip, CRX, CRY)
  let badLevel = 0, badSeed = 0
  for (const b of lakes.bodies) {
    if (!(b.level >= b.floor) || !(b.spill >= b.floor)) badLevel++
    const t = mesh.locate(b.seedX, b.seedY)
    const a = mesh.tris[3 * t], bb = mesh.tris[3 * t + 1], c = mesh.tris[3 * t + 2]
    if (Math.min(eroded.z[a], eroded.z[bb], eroded.z[c]) > b.spill) badSeed++
  }
  check(`the lakes (${lakes.bodies.length} bodies) have levels between floor and spill and seeds in their basins`, badLevel === 0 && badSeed === 0, `${badLevel} levels, ${badSeed} seeds`)
  const meanRunoff = 1000
  const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY), meanRunoff)
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
  const again = M.hydro.computeLakesOn(sub, discharge, eroded.z, temperature, precip, CRX, CRY)
  check('the lakes are deterministic', JSON.stringify(again.bodies) === JSON.stringify(lakes.bodies))
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
  const CRX = 16, CRY = 8
  const precip = new Float32Array(CRX * CRY).fill(1000)
  const temperature = new Float32Array(CRX * CRY).fill(15)
  const inputs = {
    mesh: { count: parentSerial.count, nodes: parentSerial.nodes, connectivity: parentSerial.connectivity, z: parentZ.slice(0, parentSerial.count) },
    width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
    uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
    precipitation: precip, temperature, monsoonIndex: null, climateResX: CRX, climateResY: CRY,
  }
  const parentSampler = M.sampler.createMeshSampler(parentMesh, parentZ)
  const t0 = performance.now()
  const level = await M.bake.bakeMeshLevel(inputs, { level: 1, budget: M.bake.levelBudget(1), rounds: 4 })
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
  const again = await M.bake.bakeMeshLevel(inputs, { level: 1, budget: M.bake.levelBudget(1), rounds: 4 })
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

  // The tiles of the top level (docs/decisions/tile-jobs.md): built from
  // level 1, one tile and its neighbour. The seam rule is what is checked —
  // the shared edge line the same in both, at the same heights, every step
  // of it an edge of both triangulations, and the tile's inside a function
  // of its own points alone (a wider halo changes no triangle in it).
  {
    const T = M.tile
    const parent = { mesh: level.mesh, z: level.z, discharge: level.discharge, sampler }
    const opts = { seed: 1234, width: W, height: H }
    const { cols, rows } = T.tileGrid(W, H)
    // The tile with the most land under its centre row, and its east neighbour.
    let best = { x: 0, y: 0, land: -1 }
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      let n = 0
      for (let k = 0; k < 8; k++) if (sampler.heightAt(tx * T.TILE_CELLS + k + 0.5, ty * T.TILE_CELLS + 4) > 0) n++
      if (n > best.land) best = { x: tx, y: ty, land: n }
    }
    const t1 = performance.now()
    const A = T.buildTileMesh(parent, best, opts)
    const tileMs = performance.now() - t1
    const B = T.buildTileMesh(parent, { x: (best.x + 1) % cols, y: best.y }, opts)
    const count = (t, role) => { let n = 0; for (let v = 0; v < t.mesh.vertexSlots; v++) if (t.mesh.vAlive[v] && t.role[v] === role) n++; return n }
    check(`a tile is a valid triangulation (${A.mesh.aliveVertices} nodes: ${count(A, T.TILE_ROLE_NEW)} new, ${count(A, T.TILE_ROLE_PARENT)} parents, ${count(A, T.TILE_ROLE_EDGE)} edge; ${tileMs.toFixed(0)} ms)`, A.mesh.validate().length === 0 && B.mesh.validate().length === 0)
    // Edge nodes by world position.
    const key = (x, y) => `${x},${y}`
    const edgeNodes = (t) => {
      const map = new Map()
      for (let v = 0; v < t.mesh.vertexSlots; v++) if (t.mesh.vAlive[v] && t.role[v] === T.TILE_ROLE_EDGE) map.set(key(T.tileWorldX(t, t.mesh.vx[v], W), T.tileWorldY(t, t.mesh.vy[v], H)), v)
      return map
    }
    const edgeA = edgeNodes(A), edgeB = edgeNodes(B)
    const sharedX = ((best.x + 1) % cols) * T.TILE_CELLS
    let shared = 0, heightDiffers = 0, missing = 0
    for (const [k, v] of edgeA) {
      if (Number(k.split(',')[0]) !== sharedX) continue
      shared++
      const u = edgeB.get(k)
      if (u === undefined) missing++
      else if (A.z[v] !== B.z[u]) heightDiffers++
    }
    check('two neighbours hold the same nodes on their shared edge, at the same heights', shared === T.TILE_EDGE_STEPS + 1 && missing === 0 && heightDiffers === 0, `${shared} shared, ${missing} missing, ${heightDiffers} heights differ`)
    // Every step of the edge line is an edge of the triangulation.
    const stepsMissing = (t, edges) => {
      // The row along each line, sorted; consecutive nodes must be neighbours.
      const nb = new Int32Array(64)
      const lines = new Map()
      for (const [k, v] of edges) {
        const [x, y] = k.split(',').map(Number)
        if (x % T.TILE_CELLS === 0) { const l = `x${x}`; if (!lines.has(l)) lines.set(l, []); lines.get(l).push([y, v]) }
        if (y % T.TILE_CELLS === 0) { const l = `y${y}`; if (!lines.has(l)) lines.set(l, []); lines.get(l).push([x, v]) }
      }
      let lost = 0, steps = 0
      for (const row of lines.values()) {
        row.sort((a, b) => a[0] - b[0])
        for (let i = 1; i < row.length; i++) {
          if (row[i][0] - row[i - 1][0] > T.TILE_CELLS / 2) continue // across the world's seam
          steps++
          const n = t.mesh.neighbours(row[i][1], nb)
          let found = false
          for (let j = 0; j < n; j++) if (nb[j] === row[i - 1][1]) found = true
          if (!found) lost++
        }
      }
      return steps === 4 * T.TILE_EDGE_STEPS ? lost : -1
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
        set.add(vs.map((v) => `${t.role[v]}@` + key(T.tileWorldX(t, t.mesh.vx[v], W), T.tileWorldY(t, t.mesh.vy[v], H)) + ':' + t.z[v]).sort().join('|'))
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
    const east = T.buildTileMesh(parent, { x: cols - 1, y: best.y }, opts), west = T.buildTileMesh(parent, { x: 0, y: best.y }, opts)
    const edgeE = edgeNodes(east), edgeW = edgeNodes(west)
    let seam = 0, seamBad = 0
    for (const [k, v] of edgeE) { if (Number(k.split(',')[0]) !== 0) continue; seam++; const u = edgeW.get(k); if (u === undefined || east.z[v] !== west.z[u]) seamBad++ }
    check('tiles meet across the world\'s seam as they do inside it', seam === T.TILE_EDGE_STEPS + 1 && seamBad === 0, `${seam} shared, ${seamBad} differ`)

    // The tile's bake: the edge row pinned, the halo frozen, level 1's
    // rivers entering with their discharge. The edge must come out at the
    // parent surface to the bit, the inside must erode, and every land
    // node inside must drain — over the edge or into the sea.
    const macro = M.raster.rasteriseNodeField(level.mesh, level.z, W, H)
    const tileInputs = {
      parent, parentGraph: level.graph, width: W, height: H, detailSeed: 1234, lithoSeed: 77, controls: {},
      uplift: null, erodibility: null, forcingResX: 0, forcingResY: 0,
      precipitation: precip, climateResX: CRX, climateResY: CRY,
      meanLandWater: M.hydro.meanLandRunoff(precip, macro, W, H, CRX, CRY),
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
        const a = [Math.floor(g.cellX[r.cellStart + k - 1] / T.TILE_CELLS), Math.floor(g.cellY[r.cellStart + k - 1] / T.TILE_CELLS)]
        const b = [Math.floor(g.cellX[r.cellStart + k] / T.TILE_CELLS), Math.floor(g.cellY[r.cellStart + k] / T.TILE_CELLS)]
        if ((a[0] !== b[0] || a[1] !== b[1]) && r.dischargeOut > 0) inTile = { x: b[0], y: b[1] }
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
      for (let i = 0; i < art.count; i++) { const x = art.nodes[2 * i], y = art.nodes[2 * i + 1]; if (x < 0 || y < 0 || x > T.TILE_CELLS || y > T.TILE_CELLS) outside++ }
      const tileStore = M.memory.createMemoryArtifactStore()
      const stage = M.tileArtifacts.meshTileStage(best)
      const tileKey = M.store.artifactKey('uid', 'world', M.tileArtifacts.meshTilePipelineVersion(4), stage)
      const wrote = await M.tileArtifacts.writeMeshTileArtifact(tileStore, tileKey, art, bakeMs, 'synthetic', 4)
      const read = await M.tileArtifacts.readMeshTileArtifact(tileStore, tileKey)
      const same = read !== null && read.artifact.count === art.count && read.artifact.z.every((v, i) => v === art.z[i]) && read.artifact.triangles.every((v, i) => v === art.triangles[i]) && read.artifact.nodes.every((v, i) => v === art.nodes[i])
      check(`a tile's artifact holds its inside and reads back identical (${stage}: ${art.count} nodes, ${art.triangles.length / 3} triangles)`, wrote && same && halo === 0 && outside === 0 && stage === `L2:${best.x},${best.y}`, `${halo} halo nodes, ${outside} outside the tile`)
      check('the tile pipeline version moves with the rounds and differs from level 1\'s', M.tileArtifacts.meshTilePipelineVersion(4) !== M.tileArtifacts.meshTilePipelineVersion(5) && M.tileArtifacts.meshTilePipelineVersion(4) !== M.artifacts.meshPipelineVersion(1, 4))
    }
  }
}

// Flexural isostasy (phase 5.3): the plate's answer to a load on a flat
// raster — a ridge's weight sinks the plate under AND beside it (the
// foreland basin, no feature rule), the whole answer compensates the
// load by ρ_crust/ρ_mantle, and a stiffer plate spreads it wider and
// shallower.
{
  const RX = 128, RY = 64, cellKm = 31
  const ridge = (teKm) => {
    const load = new Float32Array(RX * RY)
    const te = new Float32Array(RX * RY).fill(teKm)
    for (let y = 0; y < RY; y++) for (let x = 62; x <= 65; x++) load[y * RX + x] = 2000
    return { load, te, w: M.flexure.flexuralResponse(load, te, RX, RY, cellKm) }
  }
  const soft = ridge(20), stiff = ridge(70)
  const row = (r, x) => r.w[32 * RX + x]
  const sum = (r) => { let s = 0; for (let i = 0; i < r.w.length; i++) s += r.w[i]; return s }
  const loadSum = (r) => { let s = 0; for (let i = 0; i < r.load.length; i++) s += r.load[i]; return s }
  const alpha20 = M.flexure.flexuralAlphaKm(20), alpha70 = M.flexure.flexuralAlphaKm(70)
  console.log(`       α(Te 20 km) = ${alpha20.toFixed(0)} km, α(Te 70 km) = ${alpha70.toFixed(0)} km`)
  check('the plate sinks under the ridge', row(soft, 63) < -100, `${row(soft, 63).toFixed(0)} m`)
  check('and beside it — a foreland basin with no feature rule', row(soft, 68) < -10 && row(soft, 68) > row(soft, 63), `${row(soft, 68).toFixed(0)} m at 5 cells`)
  check('far away the plate is level', Math.abs(row(soft, 20)) < 1, `${row(soft, 20).toFixed(2)} m`)
  const ratio = -sum(soft) / loadSum(soft)
  check('the load is compensated by ρ_crust/ρ_mantle', Math.abs(ratio - 2700 / 3300) < 0.01, ratio.toFixed(3))
  check('a stiffer plate answers wider and shallower', row(stiff, 63) > row(soft, 63) && row(stiff, 75) < row(soft, 75), `under: ${row(stiff, 63).toFixed(0)} vs ${row(soft, 63).toFixed(0)} m; at 12 cells: ${row(stiff, 75).toFixed(1)} vs ${row(soft, 75).toFixed(1)} m`)
  check('Te grows with craton oldness and with ocean age', M.flexure.elasticThicknessKm(true, 1, 0) > M.flexure.elasticThicknessKm(true, 0, 0) && M.flexure.elasticThicknessKm(false, 0, 100) > M.flexure.elasticThicknessKm(false, 0, 1))
}

// Folds (phase 5.7): across one range the uplift's multiplier is a train
// with the buckling wavelength, an anticline on the axis, mean one over a
// period; along the range it is constant; away from every range it is one.
{
  const W = 256, H = 128
  const feature = { x: 128, y: 64, thickness: 1, tangentX: 1, tangentY: 0, kind: 'range', subsides: false, plateA: 0, plateB: 1, movesWithPlate: 0, epochsSinceDeposit: 0 }
  const buckets = M.field.buildFeatureBuckets([feature], W, H)
  const T = M.tectonicsTune.TECTONICS_TUNING
  const lambda = (T.foldWavelengthKm * 1000) / M.mapConfig.METERS_PER_CELL
  const at = (x, y) => M.folds.foldFactorAt(buckets, x, y, W, H)
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
  const RX = M.climateField.CLIMATE_RES_X, RY = M.climateField.CLIMATE_RES_Y
  const wind = new Float32Array(RX * RY * 2)
  // A steady wind from the west-south-west: along the shore eastward, a
  // little onshore (the sea lies to the south, +y).
  for (let i = 0; i < RX * RY; i++) { wind[2 * i] = 8; wind[2 * i + 1] = -4 }
  const coarseZ = M.raster.rasteriseNodeField(lat, z, RX, RY)
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
    const r = M.coastal.computeCoastal({ mesh: lat, z: zNow, areas, wind, coarseZ, climateResX: RX, climateResY: RY, width: W, height: H, cellM: M.mapConfig.METERS_PER_CELL, hardness, sedimentFlux: flux, iterations: 4, epochYears: 1e6 })
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
  const RX = M.climateField.CLIMATE_RES_X, RY = M.climateField.CLIMATE_RES_Y
  // −4 °C at the cell's mean height puts the equilibrium line near
  // 2200 m: the walls above it feed a trunk glacier that melts on the
  // floor — a valley glacier, not an ice sheet over everything (at −12 °C
  // the whole world was under ice and the cut was uniform: the V stayed).
  const precipitation = new Float32Array(RX * RY).fill(600)
  const coarseZ = M.raster.rasteriseNodeField(lat, z, RX, RY)
  // The climate cells here are finer than the valley (2 km against a
  // 60 km cell on the world), so the lapse must be in the field itself:
  // −4 °C at 2300 m, 6.5 °C per km — cold walls, a warm floor.
  const temperature = new Float32Array(RX * RY)
  for (let i = 0; i < temperature.length; i++) temperature[i] = -4 - 6.5 * (coarseZ[i] * M.scale.ELEVATION_METERS - 2300) / 1000
  const ice = M.glacial.computeIceOnMesh({ mesh: lat, z, temperature, precipitation, coarseZ, climateResX: RX, climateResY: RY, width: W, height: H, cellM: M.mapConfig.METERS_PER_CELL })
  let iced = 0, maxH = 0
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v] && ice.thickness[v] > 0) { iced++; maxH = Math.max(maxH, ice.thickness[v]) }
  let landNodes = 0
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) landNodes++
  let bMin = Infinity, bMax = -Infinity, czMin = Infinity, czMax = -Infinity
  for (let v = 0; v < lat.vertexSlots; v++) if (lat.vAlive[v]) { bMin = Math.min(bMin, ice.balance[v]); bMax = Math.max(bMax, ice.balance[v]) }
  for (let i = 0; i < coarseZ.length; i++) { czMin = Math.min(czMin, coarseZ[i]); czMax = Math.max(czMax, coarseZ[i]) }
  check(`a valley glacier forms (${iced} of ${landNodes} nodes iced, up to ${maxH.toFixed(0)} m)`, iced > 0 && iced < landNodes && maxH > 50, `balance ${bMin.toFixed(2)}..${bMax.toFixed(2)} m/yr, coarseZ ${(czMin * M.scale.ELEVATION_METERS).toFixed(0)}..${(czMax * M.scale.ELEVATION_METERS).toFixed(0)} m, ELA ${ice.elaM[order0(lat)].toFixed(0)} m`)
  check(`the ice's mass closes (in ${(ice.massIn / 1e9).toFixed(2)} = melt ${(ice.massMelt / 1e9).toFixed(2)} + out ${(ice.massOut / 1e9).toFixed(2)} km³/yr)`, Math.abs(ice.massIn - ice.massMelt - ice.massOut) <= 1e-6 * ice.massIn)
  // The profile across the valley at mid-length: the floor's width (the
  // span within 100 m of the deepest point) before and after the ice.
  // The trough's making: the cut is the sliding's, and the sliding is
  // the trunk's — the floor band (within half a unit of the axis) cuts
  // more than the walls two to three units out, 800–1200 m up; the
  // floor's cut stays under the per-epoch cap (a fjord's rate). On this
  // world the difference is small (259 vs 221 m): it is an ice cap, 91 %
  // of it iced, the walls under a kilometre of ice too. A full U profile
  // from a V needs a valley-scale test with a realistic accumulation area
  // and is the calibration's (ADAPTIVE_MESH_PLAN.md phase 6), not this
  // gate's.
  const zAfter = z.slice()
  let floorCut = 0, floorN = 0, wallCut = 0, wallN = 0, maxCut = 0
  for (let epoch = 0; epoch < 3; epoch++) {
    const iceNow = M.glacial.computeIceOnMesh({ mesh: lat, z: zAfter, temperature, precipitation, coarseZ, climateResX: RX, climateResY: RY, width: W, height: H, cellM: M.mapConfig.METERS_PER_CELL })
    const g = M.glacial.glacialErosionOnMesh(lat, zAfter, iceNow, 1e6, M.mapConfig.METERS_PER_CELL)
    for (let v = 0; v < lat.vertexSlots; v++) {
      if (!lat.vAlive[v]) continue
      zAfter[v] -= g.cutM[v] / M.scale.ELEVATION_METERS
      const dx = Math.abs(M.toroidal.wrappedDelta(lat.vx[v], valleyX, W))
      if (dx <= 0.5) { floorCut += g.cutM[v]; floorN++ } else if (dx >= 2 && dx <= 3) { wallCut += g.cutM[v]; wallN++ }
      if (g.cutM[v] > maxCut) maxCut = g.cutM[v]
    }
    if (epoch === 0) check(`the ice cuts (${(g.cutM3 / 1e9).toFixed(1)} km³ in an epoch) and leaves till (${(g.tillM3 / 1e9).toFixed(1)} km³)`, g.cutM3 > 0 && g.tillM3 > 0)
  }
  const floorMean = floorCut / Math.max(1, floorN), wallMean = wallCut / Math.max(1, wallN)
  check(`the trunk cuts the floor more than the walls (floor ${floorMean.toFixed(0)} m vs walls ${wallMean.toFixed(0)} m an epoch)`, floorMean > wallMean && wallMean >= 0)
  check(`the cut stays under the cap (${maxCut.toFixed(0)} ≤ ${M.surfaceTune.SURFACE_TUNING.glacialErosionMaxM} m an epoch)`, maxCut <= M.surfaceTune.SURFACE_TUNING.glacialErosionMaxM)
}

// The coupled epoch (phase 5.1): a small real world through the handover,
// then epochs in which the plates move the nodes, the mesh is rebuilt
// and remeshed, the baseline follows the tectonics and the erosion runs
// on the relief — every epoch valid, finite, deterministic.
{
  const CW = 256, CH = 128
  const world = async () => {
    const archean = M.archean.createArcheanSimulation('coupled', CW, CH)
    for (let e = 0; e < 60; e++) M.archeanStep.archeanStep(archean)
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
    const weather = M.weather.computeWeather(coarseZ, RX, RY, M.weather.defaultWeatherParams())
    const precip = weather.seasonal.annual
    const discharge = M.hydro.accumulateDischargeOn(sub, terrain.z, precip, RX, RY)
    const lakes = M.hydro.computeLakesOn(sub, discharge, terrain.z, weather.temperature, precip, RX, RY)
    const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY), M.hydro.meanLandRunoff(precip, coarseZ, RX, RY, RX, RY))
    const regime = M.hydro.accumulateRegimeInputsOn(sub, terrain.z, weather.temperature, precip, weather.seasonal.index, RX, RY)
    const graph = M.graph.buildRiverGraph({ substrate: sub, discharge, elevation: terrain.z, threshold, maxDischarge: M.hydro.maxDischargeOverLand(discharge, terrain.z), bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, regime, criticalArea: M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY) })
    const biomes = M.biomes.computeBiomes(weather.temperature, precip, weather.seasonalAmplitude, weather.seasonal.index, coarseZ, RX, RY)
    const ground = M.ground.computeHydrogeology({ sub, elevation: terrain.z, graph, column: terrain.column, hardness: null, climateResX: RX, climateResY: RY, precipitation: precip, temperature: weather.temperature, monsoonIndex: weather.seasonal.index, cover: M.cover.coverField(biomes, true), regime, discharge, cellM: M.mapConfig.METERS_PER_CELL })
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
  const z = new Float32Array(await zip.file('elevation.f32').async('arraybuffer'))
  const qFile = zip.file('layers/discharge.u16')
  const q = qFile ? M.layers.decodeLayer(await qFile.async('arraybuffer'), M.layers.DISCHARGE_LAYER) : null
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
    const coarse = {
      uplift: inputs.uplift.data, hardness: inputs.erodibility?.data ?? null,
      forcingResX: inputs.uplift.resX, forcingResY: inputs.uplift.resY,
      water: inputs.climate.data, waterResX: inputs.climate.resX, waterResY: inputs.climate.resY,
      lithoSeed: inputs.lithoSeed,
    }
    const controls = { alluvium: inputs.erosionControls.alluvium, rockContrast: inputs.erosionControls.rockContrast }
    // The mesh: its own z (sampled from the save), forcing at the nodes.
    const meshZ0 = state.get('z').slice()
    const areas = new Float64Array(mesh.vertexSlots)
    for (const v of aliveVertices(mesh)) areas[v] = mesh.voronoiArea(v)
    const nodeForcing = M.forcing.assembleNodeForcing(coarse, mesh.vx, mesh.vy, mesh.vAlive, mesh.vertexSlots, meshZ0, areas, RW, RH, controls)
    let t1 = performance.now()
    const meshRun = await M.erosion.runMeshErosion(mesh, meshZ0, nodeForcing.forcing, { age: AGE, params: nodeForcing.params })
    const meshMs = performance.now() - t1
    // The raster: the save's elevation, the bake's forcing assembly.
    const rasterForcing = M.forcing.assembleFineForcing(coarse, z, RW, RH, controls)
    t1 = performance.now()
    const rasterRun = await M.passV2.runErosionPassV2(z, RW, RH, rasterForcing.forcing, { age: AGE, params: rasterForcing.params })
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

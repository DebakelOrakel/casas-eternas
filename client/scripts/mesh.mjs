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
  }
}

await server.close()
console.log(failures === 0 ? '\nmesh harness: all checks passed' : `\nmesh harness: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

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
//                   tolerance. No baseline; a failure is a bug.
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
  layers: await L('/src/world/save/worldLayers.ts'),
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
  const sampler = {
    heightAt: (x, y) => M.field.sampleBilinearWorld(z, RW, RH, x, y, RW, RH),
    dischargeAt: q ? (x, y) => M.field.sampleBilinearWorld(q, RW, RH, x, y, RW, RH) : undefined,
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
}

await server.close()
console.log(failures === 0 ? '\nmesh harness: all checks passed' : `\nmesh harness: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

// Checks for the FIELD MESH and its operators (DEC-0036,
// docs/decisions/fields-on-meshes.md, phase 0): client/src/generator/fields/.
//
//   npm run harness:fields          every check, both shapes (~30 s)
//
// WHY THIS EXISTS. Phase 0 builds the operators the mantle, the ocean age,
// the climate and the flexure will run on, and no stage uses them yet —
// golden cannot see them. Every operator is held here against an
// ANALYTIC answer, the climate models' standard checks (Williamson et al.
// 1992): spherical harmonics, which the Laplacian has as eigenfunctions
// (−l(l + 1) / R²), for the diffusion, the gradient, the divergence and
// the elliptic solve; a cosine bell carried over both poles by a solid-
// body rotation for the transport; the torus's Fourier modes. The errors
// are measured at four spacings and their convergence ORDER is checked,
// which a wrong weight breaks before it breaks a single tolerance. The
// mutation checks at the end remove one ingredient each (the wall
// lengths, the areas, the frame transport) and require the check that
// guards it to fail — a check that cannot fail guards nothing.
//
// No baseline: every number is against an exact answer. The bands below
// were set from the measurement of 2026-10-11 with a margin; the
// measured values are in DEC-0036's Status.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  domain: await L('/src/generator/core/domain.ts'),
  fm: await L('/src/generator/fields/fieldMesh.ts'),
  op: await L('/src/generator/fields/fieldOperators.ts'),
  raster: await L('/src/generator/mesh/meshRaster.ts'),
  ocean: await L('/src/generator/climate/oceanCurrents.ts'),
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
}
const e = (x) => x.toExponential(2)
const f2 = (x) => x.toFixed(2)

const sphere = M.domain.sphereDomain(2048, 1024)
const torus = M.domain.torusDomain(2048, 1024)
const SPACINGS = [312e3, 156e3, 78e3, 39e3]
const meshes = new Map()
const meshOf = (domain, s) => {
  const key = `${domain.kind}:${s}`
  if (!meshes.has(key)) meshes.set(key, M.fm.createFieldMesh(domain, s))
  return meshes.get(key)
}

// ------------------------------------------------------------ analytics

// Real spherical harmonics as harmonic homogeneous polynomials of the unit
// vector, a mix of orders m per degree so no one lines up with the
// lattice: F and its 3D gradient.
const HARMONICS = [
  { l: 1, F: (x, y, z) => 0.3 * x - 0.5 * y + 0.8 * z, G: () => [0.3, -0.5, 0.8] },
  { l: 2, F: (x, y, z) => x * y + 0.4 * (2 * z * z - x * x - y * y), G: (x, y, z) => [y - 0.8 * x, x - 0.8 * y, 1.6 * z] },
  {
    l: 3,
    F: (x, y, z) => z * (2 * z * z - 3 * x * x - 3 * y * y) + 0.6 * x * (4 * z * z - x * x - y * y),
    G: (x, y, z) => [-6 * x * z + 0.6 * (4 * z * z - 3 * x * x - y * y), -6 * y * z + 0.6 * (-2 * x * y), 6 * z * z - 3 * x * x - 3 * y * y + 0.6 * 8 * x * z],
  },
  {
    l: 4,
    F: (x, y, z) => { const r2 = x * x + y * y + z * z; return 0.125 * (35 * z ** 4 - 30 * z * z * r2 + 3 * r2 * r2) + 1.5 * (x ** 3 * y - x * y ** 3) },
    G: (x, y, z) => { const r2 = x * x + y * y + z * z; return [0.125 * (-60 * z * z * x + 12 * r2 * x) + 1.5 * (3 * x * x * y - y ** 3), 0.125 * (-60 * z * z * y + 12 * r2 * y) + 1.5 * (x ** 3 - 3 * x * y * y), 0.125 * (80 * z ** 3 - 48 * z * r2)] },
  },
]
// The torus's modes: cos(2π(a x / W + b y / H) + c).
const MODES = [
  { a: 1, b: 0, c: 0.3 }, { a: 1, b: 1, c: 1.1 }, { a: 3, b: 2, c: 0.7 }, { a: 5, b: 4, c: 2.0 },
]
// Field values and analytic ∇² and gradient of a test function per cell.
const sphereField = (fm, h) => {
  const n = fm.count
  const v = new Float64Array(n), ge = new Float64Array(n), gs = new Float64Array(n)
  const R = fm.radiusM
  for (let i = 0; i < n; i++) {
    const x = fm.u[3 * i], y = fm.u[3 * i + 1], z = fm.u[3 * i + 2]
    v[i] = h.F(x, y, z)
    const g = h.G(x, y, z)
    const r = g[0] * x + g[1] * y + g[2] * z
    const tx = (g[0] - r * x) / R, ty = (g[1] - r * y) / R, tz = (g[2] - r * z) / R
    ge[i] = tx * fm.east[3 * i] + ty * fm.east[3 * i + 1] + tz * fm.east[3 * i + 2]
    gs[i] = tx * fm.south[3 * i] + ty * fm.south[3 * i + 1] + tz * fm.south[3 * i + 2]
  }
  return { v, ge, gs, eig: -(h.l * (h.l + 1)) / (R * R) }
}
const torusField = (fm, m) => {
  const n = fm.count
  const Wm = fm.domain.width * fm.unitM, Hm = fm.domain.height * fm.unitM
  const kx = (2 * Math.PI * m.a) / Wm, ky = (2 * Math.PI * m.b) / Hm
  const v = new Float64Array(n), ge = new Float64Array(n), gs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const ph = kx * fm.x[i] * fm.unitM + ky * fm.y[i] * fm.unitM + m.c
    v[i] = Math.cos(ph)
    ge[i] = -kx * Math.sin(ph)
    gs[i] = -ky * Math.sin(ph)
  }
  return { v, ge, gs, eig: -(kx * kx + ky * ky) }
}
const testFields = (fm) => (fm.globe ? HARMONICS.map((h) => ({ name: `l=${h.l}`, ...sphereField(fm, h) })) : MODES.map((m) => ({ name: `k=(${m.a},${m.b})`, ...torusField(fm, m) })))

// Area-weighted relative norms.
const relL2 = (fm, got, want) => {
  let num = 0, den = 0
  for (let i = 0; i < fm.count; i++) { num += fm.area[i] * (got[i] - want[i]) ** 2; den += fm.area[i] * want[i] ** 2 }
  return Math.sqrt(num / den)
}
const relLinf = (got, want) => {
  let num = 0, den = 0
  for (let i = 0; i < got.length; i++) { num = Math.max(num, Math.abs(got[i] - want[i])); den = Math.max(den, Math.abs(want[i])) }
  return num / den
}
const vecL2 = (fm, ge, gs, we, ws) => {
  let num = 0, den = 0
  for (let i = 0; i < fm.count; i++) { num += fm.area[i] * ((ge[i] - we[i]) ** 2 + (gs[i] - ws[i]) ** 2); den += fm.area[i] * (we[i] ** 2 + ws[i] ** 2) }
  return Math.sqrt(num / den)
}
const vecLinf = (ge, gs, we, ws) => {
  let num = 0, den = 0
  for (let i = 0; i < ge.length; i++) { num = Math.max(num, Math.hypot(ge[i] - we[i], gs[i] - ws[i])); den = Math.max(den, Math.hypot(we[i], ws[i])) }
  return num / den
}
const meanSpacing = (fm) => { let a = 0; for (let i = 0; i < fm.count; i++) a += fm.area[i]; return Math.sqrt(a / fm.count) }
const order = (errs, hs) => { const o = []; for (let k = 1; k < errs.length; k++) o.push(Math.log(errs[k - 1] / errs[k]) / Math.log(hs[k - 1] / hs[k])); return o }
const hashArrays = (arrays) => { const h = createHash('sha256'); for (const a of arrays) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)); return h.digest('hex').slice(0, 12) }
const time = (fn, reps = 5) => { fn(); const t = []; for (let k = 0; k < reps; k++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0) } t.sort((a, b) => a - b); return t[reps >> 1] }

// ================================================================ [1]
console.log('\n[1] the field mesh: structure and geometry')
for (const domain of [sphere, torus]) {
  for (const s of [156e3, 78e3]) {
    const t0 = performance.now()
    const fm = meshOf(domain, s)
    const ms = performance.now() - t0
    const label = `${domain.kind} ${s / 1e3} km`
    let areaSum = 0
    for (let i = 0; i < fm.count; i++) areaSum += fm.area[i]
    const exact = domain.kind === 'sphere' ? 4 * Math.PI * fm.radiusM ** 2 : domain.width * domain.height * fm.unitM ** 2
    const areaErr = Math.abs(areaSum - exact) / exact
    let minA = Infinity, maxA = 0, minWall = Infinity, asym = 0, back = 0, frameErr = 0, turnErr = 0, turnLen = 0
    for (let i = 0; i < fm.count; i++) {
      minA = Math.min(minA, fm.area[i]); maxA = Math.max(maxA, fm.area[i])
      for (let k = fm.nbrStart[i]; k < fm.nbrStart[i + 1]; k++) {
        minWall = Math.min(minWall, fm.wall[k])
        const r = fm.rev[k]
        if (fm.nbr[r] !== i) back++
        asym = Math.max(asym, Math.abs(fm.coupling[k] - fm.coupling[r]) / fm.coupling[k], Math.abs(fm.dist[k] - fm.dist[r]) / fm.dist[k])
        // The turn there and back is the identity; it keeps length.
        const c = fm.turnC[k] * fm.turnC[r] - fm.turnS[k] * fm.turnS[r]
        const sn = fm.turnS[k] * fm.turnC[r] + fm.turnC[k] * fm.turnS[r]
        turnErr = Math.max(turnErr, Math.hypot(c - 1, sn))
        turnLen = Math.max(turnLen, Math.abs(Math.hypot(fm.turnC[k], fm.turnS[k]) - 1))
      }
      if (fm.globe) {
        const u = [fm.u[3 * i], fm.u[3 * i + 1], fm.u[3 * i + 2]], ea = [fm.east[3 * i], fm.east[3 * i + 1], fm.east[3 * i + 2]], so = [fm.south[3 * i], fm.south[3 * i + 1], fm.south[3 * i + 2]]
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        frameErr = Math.max(frameErr, Math.abs(dot(u, ea)), Math.abs(dot(u, so)), Math.abs(dot(ea, so)), Math.abs(dot(ea, ea) - 1), Math.abs(dot(so, so) - 1))
      }
    }
    // The turn against Domain.transport on a sample of edges.
    let transportErr = 0
    const out = { x: 0, y: 0 }
    for (let i = 0; i < fm.count; i += 37) {
      for (let k = fm.nbrStart[i]; k < fm.nbrStart[i + 1]; k++) {
        const j = fm.nbr[k]
        domain.transport(0.6, -0.8, fm.x[j], fm.y[j], fm.x[i], fm.y[i], out)
        const c = fm.turnC[k], sn = fm.turnS[k]
        transportErr = Math.max(transportErr, Math.hypot(c * 0.6 - sn * -0.8 - out.x, sn * 0.6 + c * -0.8 - out.y))
      }
    }
    const errors = fm.tri.validate(true)
    console.log(`  ${label}: ${fm.count} cells (mean spacing ${(meanSpacing(fm) / 1e3).toFixed(1)} km), ${fm.pentagons} pentagons, max degree ${fm.maxDegree}, areas ${(minA / 1e6).toFixed(0)}–${(maxA / 1e6).toFixed(0)} km² (×${(maxA / minA).toFixed(2)}), min wall ${(minWall / 1e3).toFixed(1)} km, built in ${ms.toFixed(0)} ms`)
    check(`${label}: triangulation valid`, errors.length === 0, errors.slice(0, 2).join('; '))
    check(`${label}: areas sum to ${domain.kind === 'sphere' ? '4πR²' : 'W·H'}`, areaErr < 1e-12, `relative ${e(areaErr)}`)
    // The sphere's centroidal relaxation (DEC-0036 phase 3): × 2.0 on the
    // plain geodesic grid.
    check(`${label}: the areas within × ${domain.kind === 'sphere' ? '1.6' : '1.0001 (float32 positions)'}`, maxA / minA < (domain.kind === 'sphere' ? 1.6 : 1.0001), `× ${(maxA / minA).toPrecision(9)}`)
    check(`${label}: ${domain.kind === 'sphere' ? '12 pentagons, the rest hexagons' : 'every cell a hexagon'}`, domain.kind === 'sphere' ? fm.pentagons === 12 && fm.maxDegree === 6 : fm.pentagons === 0 && fm.maxDegree === 6)
    check(`${label}: neighbours symmetric, coupling and distance symmetric`, back === 0 && asym < 1e-12, `${back} broken, max asymmetry ${e(asym)}`)
    check(`${label}: every wall positive (Delaunay)`, minWall > 0)
    check(`${label}: frames orthonormal, turns rotations, there and back the identity`, frameErr < 1e-14 && turnLen < 1e-14 && turnErr < 1e-14, `frame ${e(frameErr)}, |turn| ${e(turnLen)}, round trip ${e(turnErr)}`)
    check(`${label}: the turn is Domain.transport`, transportErr < 1e-12, `max ${e(transportErr)}`)
  }
}

// ================================================================ [2]
console.log('\n[2] the Laplacian and diffusion (exact decay exp(λ κ t), λ = −l(l+1)/R² or −|k|²)')
const lapErr = { sphere: new Map(), torus: new Map() }
const LAP_BAND = { sphere: 1.5e-3, torus: 1e-2 }
const GRAD_BAND = { sphere: 3e-3, torus: 2e-2 }
const DIV_BAND = { sphere: 3e-3, torus: 2e-2 }
// The worst L2 error of an operator over the test fields on one mesh —
// the measure the mutation checks [8] hold against the same bands.
const worstLaplacian = (fm) => Math.max(...testFields(fm).map((t) => relL2(fm, M.op.laplacian(fm, t.v, new Float64Array(fm.count)), t.v.map((x) => x * t.eig))))
const worstGradient = (fm) => Math.max(...testFields(fm).map((t) => { const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count); M.op.gradient(fm, t.v, ge, gs); return vecL2(fm, ge, gs, t.ge, t.gs) }))
const worstDivergence = (fm) => Math.max(...testFields(fm).map((t) => relL2(fm, M.op.divergence(fm, t.ge, t.gs, new Float64Array(fm.count)), t.v.map((x) => x * t.eig))))
for (const domain of [sphere, torus]) {
  const hs = []
  const rows = new Map()
  for (const s of SPACINGS) {
    const fm = meshOf(domain, s)
    hs.push(meanSpacing(fm))
    const out = new Float64Array(fm.count)
    for (const t of testFields(fm)) {
      M.op.laplacian(fm, t.v, out)
      const want = t.v.map((x) => x * t.eig)
      if (!rows.has(t.name)) rows.set(t.name, { l2: [], linf: [] })
      rows.get(t.name).l2.push(relL2(fm, out, want))
      rows.get(t.name).linf.push(relLinf(out, want))
    }
  }
  console.log(`  ${domain.kind}: relative error of ∇²φ against λφ — L2 / L∞ per spacing (${SPACINGS.map((s) => s / 1e3).join(', ')} km), order`)
  for (const [name, r] of rows) {
    const o2 = order(r.l2, hs), oi = order(r.linf, hs)
    console.log(`    ${name.padEnd(9)} L2 ${r.l2.map(e).join(' ')}  order ${o2.map(f2).join(' ')} | L∞ ${r.linf.map(e).join(' ')}  order ${oi.map(f2).join(' ')}`)
    lapErr[domain.kind].set(name, r)
  }
  // The bands: the 78 km error (the climate's spacing) and the L2 order.
  // On the sphere's centroidal grid (DEC-0036 phase 3, mesh/lattice.ts
  // centroidalGeodesicLattice) the pointwise error does not converge at
  // the hexagons next to a pentagon — about 1 % of the field's ∇² there at
  // every spacing (Peixoto 2016) — so L∞ is held to a bound and the L2
  // order to above 1; the solves built on ∇² converge at second order
  // ([4]). The plain geodesic grid had L∞ at first order and L2 at
  // 1.7–1.9, with its areas varying × 2.0 (DEC-0036 Status).
  const at78 = SPACINGS.indexOf(78e3)
  const band = domain.kind === 'sphere' ? LAP_BAND.sphere : LAP_BAND.torus
  const worst78 = Math.max(...[...rows.values()].map((r) => r.l2[at78]))
  const minOrder = Math.min(...[...rows.values()].flatMap((r) => order(r.l2, hs)))
  const minOrderInf = Math.min(...[...rows.values()].flatMap((r) => order(r.linf, hs)))
  check(`${domain.kind}: ∇² of the test fields within ${e(band)} (L2) at 78 km`, worst78 < band, e(worst78))
  check(`${domain.kind}: ∇² converges in L2 (order > ${domain.kind === 'sphere' ? 1.0 : 1.9})`, minOrder > (domain.kind === 'sphere' ? 1.0 : 1.9), f2(minOrder))
  if (domain.kind === 'sphere') {
    const worstInf = Math.max(...[...rows.values()].flatMap((r) => r.linf))
    check('sphere: ∇² in L∞ bounded (within 2e-2 at every spacing, not growing)', worstInf < 2e-2 && minOrderInf > -0.1, `max ${e(worstInf)}, order ≥ ${f2(minOrderInf)}`)
  } else {
    check('torus: ∇² converges in L∞ (second order)', minOrderInf > 1.6, f2(minOrderInf))
  }
}

// Diffusion: explicit steps at half the stable step to the time the
// highest test field decays by 1/e, at the climate's spacing.
const diffusionDecay = (fm, kappa, steps = null) => {
  const fields = testFields(fm)
  const tEnd = -1 / fields[fields.length - 1].eig / kappa
  const dtMax = M.op.stableDiffusionStep(fm, kappa)
  const n = steps ?? Math.ceil(tEnd / (0.5 * dtMax))
  const dt = tEnd / n
  const res = []
  for (const t of fields) {
    let a = Float64Array.from(t.v), b = new Float64Array(fm.count)
    let m0 = 0, m1 = 0
    for (let i = 0; i < fm.count; i++) m0 += fm.area[i] * a[i]
    for (let k = 0; k < n; k++) { M.op.diffuseExplicit(fm, a, kappa, dt, b); [a, b] = [b, a] }
    for (let i = 0; i < fm.count; i++) m1 += fm.area[i] * a[i]
    const want = t.v.map((x) => x * Math.exp(t.eig * kappa * tEnd))
    res.push({ name: t.name, err: relL2(fm, a, want), decay: Math.exp(t.eig * kappa * tEnd), mass: Math.abs(m1 - m0) })
  }
  return { n, dt, dtMax, tEnd, res }
}
const KAPPA = 1e5
const diffusion = {}
for (const domain of [sphere, torus]) {
  const fm = meshOf(domain, 78e3)
  const d = diffusionDecay(fm, KAPPA)
  diffusion[domain.kind] = d
  console.log(`  ${domain.kind} 78 km, κ = 1e5 m²/s, ${d.n} explicit steps of ${(d.dt / 86400).toFixed(2)} d (stable ${(d.dtMax / 86400).toFixed(2)} d) to ${(d.tEnd / 86400).toFixed(0)} d:`)
  console.log(`    ${d.res.map((r) => `${r.name} decay ${r.decay.toFixed(3)} err ${e(r.err)}`).join(' | ')}`)
  check(`${domain.kind}: diffusion decays as exp(λκt) within 1 %`, d.res.every((r) => r.err < 0.01), `worst ${e(Math.max(...d.res.map((r) => r.err)))}`)
}
// Convergence of the decay itself on the sphere.
{
  const errs = [], hs = []
  for (const s of SPACINGS.slice(0, 3)) {
    const fm = meshOf(sphere, s)
    const d = diffusionDecay(fm, KAPPA)
    errs.push(d.res[3].err)
    hs.push(meanSpacing(fm))
  }
  console.log(`  sphere: l=4 decay error per spacing ${errs.map(e).join(' ')}, order ${order(errs, hs).map(f2).join(' ')}`)
  check('sphere: the diffusion decay converges at second order', order(errs, hs).every((o) => o > 1.7), order(errs, hs).map(f2).join(' '))
}

// ================================================================ [3]
console.log('\n[3] gradient (least squares) and divergence (finite volume)')
const gradErr = { sphere: new Map(), torus: new Map() }
const divErr = { sphere: new Map(), torus: new Map() }
for (const domain of [sphere, torus]) {
  const hs = []
  const g = new Map(), dv = new Map()
  for (const s of SPACINGS) {
    const fm = meshOf(domain, s)
    hs.push(meanSpacing(fm))
    const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count), div = new Float64Array(fm.count)
    for (const t of testFields(fm)) {
      M.op.gradient(fm, t.v, ge, gs)
      if (!g.has(t.name)) { g.set(t.name, { l2: [], linf: [] }); dv.set(t.name, { l2: [], linf: [] }) }
      g.get(t.name).l2.push(vecL2(fm, ge, gs, t.ge, t.gs))
      g.get(t.name).linf.push(vecLinf(ge, gs, t.ge, t.gs))
      // The divergence of the exact gradient is the Laplacian.
      M.op.divergence(fm, t.ge, t.gs, div)
      const want = t.v.map((x) => x * t.eig)
      dv.get(t.name).l2.push(relL2(fm, div, want))
      dv.get(t.name).linf.push(relLinf(div, want))
    }
  }
  for (const [label, table, store] of [['gradient', g, gradErr], ['divergence of the exact gradient', dv, divErr]]) {
    console.log(`  ${domain.kind}: ${label} — L2 / L∞ per spacing, order`)
    for (const [name, r] of table) {
      console.log(`    ${name.padEnd(9)} L2 ${r.l2.map(e).join(' ')}  order ${order(r.l2, hs).map(f2).join(' ')} | L∞ ${r.linf.map(e).join(' ')}  order ${order(r.linf, hs).map(f2).join(' ')}`)
      store[domain.kind].set(name, { ...r, hs })
    }
  }
  const fm78 = meshOf(domain, 78e3)
  check(`${domain.kind}: the gradient within ${e(GRAD_BAND[domain.kind])} (L2) at 78 km`, worstGradient(fm78) < GRAD_BAND[domain.kind], e(worstGradient(fm78)))
  check(`${domain.kind}: the divergence within ${e(DIV_BAND[domain.kind])} (L2) at 78 km`, worstDivergence(fm78) < DIV_BAND[domain.kind], e(worstDivergence(fm78)))
  const gOrder = Math.min(...[...g.values()].flatMap((r) => order(r.l2, hs)))
  const dOrder = Math.min(...[...dv.values()].flatMap((r) => order(r.l2, hs)))
  // The centroidal grid's gradient: second order in L2, above first in L∞
  // (the plain grid's was 1.55–1.84 and below 1); the divergence of an
  // exact gradient carries ∇²'s pointwise error next to the pentagons.
  const gOrderInf = Math.min(...[...g.values()].flatMap((r) => order(r.linf, hs)))
  check(`${domain.kind}: the gradient converges in L2 (order > ${domain.kind === 'sphere' ? 1.8 : 1.9})`, gOrder > (domain.kind === 'sphere' ? 1.8 : 1.9), f2(gOrder))
  check(`${domain.kind}: the gradient converges in L∞ (order > 1)`, gOrderInf > 1, f2(gOrderInf))
  check(`${domain.kind}: the divergence converges in L2 (order > ${domain.kind === 'sphere' ? 1.2 : 1.9})`, dOrder > (domain.kind === 'sphere' ? 1.2 : 1.9), f2(dOrder))
}
// sin φ (the latitude's sine, z): its gradient is cos φ / R northward.
{
  const fm = meshOf(sphere, 78e3)
  const v = new Float64Array(fm.count), ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) v[i] = fm.u[3 * i + 2]
  M.op.gradient(fm, v, ge, gs)
  let worst = 0
  for (let i = 0; i < fm.count; i++) {
    const cosPhi = Math.hypot(fm.u[3 * i], fm.u[3 * i + 1])
    worst = Math.max(worst, Math.hypot(ge[i], gs[i] + cosPhi / fm.radiusM) * fm.radiusM)
  }
  console.log(`  sphere 78 km: ∇ sin φ against (0, −cos φ / R) east/south: max error ${e(worst)} / R`)
  check('sphere: ∇ sin φ points north with cos φ / R', worst < 5e-3, e(worst))
}

// ================================================================ [4]
console.log('\n[4] elliptic solves: (∇² − α) φ = f by conjugate gradients')
const ellipticRows = []
for (const domain of [sphere, torus]) {
  for (const s of SPACINGS) {
    const fm = meshOf(domain, s)
    const fields = testFields(fm)
    const t = fields[2]
    const L = domain.kind === 'sphere' ? fm.radiusM : fm.domain.width * fm.unitM
    for (const alpha of [0, 10 / (L * L)]) {
      const phi = new Float64Array(fm.count)
      // f = t.v plus a constant, which the Poisson solve must remove.
      const fShift = alpha === 0 ? 0.25 : 0
      const rhs = t.v.map((x) => x + fShift)
      const t0 = performance.now()
      const rep = M.op.solveHelmholtz(fm, alpha, rhs, phi, { tolerance: 1e-10, maxIterations: 4000 })
      const ms = performance.now() - t0
      const want = t.v.map((x) => x / (t.eig - alpha))
      // The discrete residual, recomputed: (∇² − α) φ − (f − mean).
      const lap = M.op.laplacian(fm, phi, new Float64Array(fm.count))
      const res = new Float64Array(fm.count)
      for (let i = 0; i < fm.count; i++) res[i] = lap[i] - alpha * phi[i] - (rhs[i] - rep.removedMean)
      let rn = 0, fn = 0
      for (let i = 0; i < fm.count; i++) { rn += fm.area[i] * res[i] ** 2; fn += fm.area[i] * (rhs[i] - rep.removedMean) ** 2 }
      ellipticRows.push({ kind: domain.kind, s, alpha, rep, err: relL2(fm, phi, want), resid: Math.sqrt(rn / fn), ms, h: meanSpacing(fm), mean: rep.removedMean, fShift })
    }
  }
}
for (const r of ellipticRows) console.log(`  ${r.kind} ${String(r.s / 1e3).padStart(3)} km ${r.alpha === 0 ? 'Poisson  ' : 'Helmholtz'}: ${String(r.rep.iterations).padStart(4)} iterations, residual ${e(r.rep.residual)} (recomputed ${e(r.resid)}), error against exact ${e(r.err)}, ${r.ms.toFixed(0)} ms${r.alpha === 0 ? `, removed mean ${r.mean.toFixed(4)} of ${r.fShift}` : ''}`)
for (const kind of ['sphere', 'torus']) {
  for (const alpha0 of [true, false]) {
    const rows = ellipticRows.filter((r) => r.kind === kind && (r.alpha === 0) === alpha0)
    const o = order(rows.map((r) => r.err), rows.map((r) => r.h))
    const name = `${kind}: ${alpha0 ? 'Poisson' : 'Helmholtz'}`
    check(`${name} converges to 1e-10 at every spacing`, rows.every((r) => r.rep.converged && r.resid < 1e-9), rows.map((r) => r.rep.iterations).join(' ') + ' iterations')
    check(`${name} error against exact falls at second order`, o.every((x) => x > 1.6), `${rows.map((r) => e(r.err)).join(' ')}, order ${o.map(f2).join(' ')}`)
  }
  const p = ellipticRows.filter((r) => r.kind === kind && r.alpha === 0)
  check(`${kind}: Poisson removes the right-hand side's mean`, p.every((r) => Math.abs(r.mean - r.fShift) < 1e-3), p.map((r) => r.mean.toFixed(5)).join(' '))
}
// Implicit diffusion against the exact decay: backward Euler, 20 steps.
for (const domain of [sphere, torus]) {
  const fm = meshOf(domain, 78e3)
  const t = testFields(fm)[3]
  const tEnd = -1 / t.eig / KAPPA
  const n = 20
  let a = Float64Array.from(t.v)
  let its = 0
  for (let k = 0; k < n; k++) its += M.op.diffuseImplicit(fm, a, KAPPA, tEnd / n, a).iterations
  const beuler = t.v.map((x) => x * (1 / (1 - t.eig * KAPPA * tEnd / n)) ** n)
  const exact = t.v.map((x) => x * Math.exp(t.eig * KAPPA * tEnd))
  const errB = relL2(fm, a, beuler), errE = relL2(fm, a, exact)
  console.log(`  ${domain.kind} 78 km: implicit diffusion, ${n} steps of ${(tEnd / n / 86400).toFixed(1)} d (${Math.round(tEnd / n / M.op.stableDiffusionStep(fm, KAPPA))}× the explicit limit), ${(its / n).toFixed(0)} iterations a step: against backward Euler's decay ${e(errB)}, against the exact ${e(errE)}`)
  // The difference is the Laplacian's own error (k = (5, 4): 5e-3, [2]).
  check(`${domain.kind}: implicit diffusion is backward Euler's decay, to the Laplacian's error`, errB < 1e-2, e(errB))
}

// ================================================================ [4b]
console.log('\n[4b] the currents\' solve: (∇² + β ∂/∂x − α) ψ = f, not symmetric, by BiCGSTAB (DEC-0036 phase 4)')
// The operator as the currents assemble it (climate/oceanCurrents.ts
// solveStommel): finite volumes, the β term the flux of β ψ carried due
// east (fieldOperators.eastWallNormals), β a function of the latitude only
// (on the torus of y), so div(β ψ ê) = β ∂ψ/∂x. MANUFACTURED: the test
// fields with their exact ∇² and east derivative give f; the discrete
// solve must come back to them at second order. α keeps the closed
// surface's constants out of the null space.
const betaOf = (fm, i, b0) => {
  if (fm.globe) { const z = fm.u[3 * i + 2]; return b0 * Math.sqrt(Math.max(0, 1 - z * z)) }
  return b0 * (1 + 0.5 * Math.cos((2 * Math.PI * fm.y[i]) / fm.domain.height))
}
const stommelMatrix = (fm, beta, alpha) => {
  const we = M.op.eastWallNormals(fm)
  const rows = []
  for (let i = 0; i < fm.count; i++) {
    const row = [[i, alpha * fm.area[i]]]
    for (let e = fm.nbrStart[i]; e < fm.nbrStart[i + 1]; e++) {
      const j = fm.nbr[e]
      const b = 0.5 * (beta[i] + beta[j]) * we[e] * 0.5
      row.push([i, fm.coupling[e] - b], [j, -(fm.coupling[e] + b)])
    }
    rows.push(row)
  }
  return M.op.sparseMatrix(rows)
}
const stommelRows = []
for (const domain of [sphere, torus]) {
  for (const s of SPACINGS) {
    const fm = meshOf(domain, s)
    const t = testFields(fm)[2]
    const L = domain.kind === 'sphere' ? fm.radiusM : fm.domain.width * fm.unitM
    const alpha = 10 / (L * L)
    const b0 = 1 / 400e3
    const beta = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) beta[i] = betaOf(fm, i, b0)
    const A = stommelMatrix(fm, beta, alpha)
    // −A (∇² + β ∂x − α) ψ = −A f.
    const rhs = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) rhs[i] = -fm.area[i] * (t.eig * t.v[i] + beta[i] * t.ge[i] - alpha * t.v[i])
    const run = (pre) => { const x = new Float64Array(fm.count); const t0 = performance.now(); const rep = M.op.solveBiCGSTAB(fm.count, (v, o) => M.op.sparseApply(A, v, o), pre, rhs, x, { tolerance: 1e-10, maxIterations: 5000 }); return { x, rep, ms: performance.now() - t0 } }
    const jac = run((r, o) => { for (let i = 0; i < fm.count; i++) { let d = 0; for (let k = A.start[i]; k < A.start[i + 1]; k++) if (A.col[k] === i) d = A.val[k]; o[i] = r[i] / d } })
    const ilu = run(M.op.ilu0(A))
    const two = run(M.op.twoLevelPreconditioner(A, M.op.aggregate(A, 6)))
    // The true residual, recomputed.
    const q = new Float64Array(fm.count)
    M.op.sparseApply(A, two.x, q)
    let rn = 0, bn = 0
    for (let i = 0; i < fm.count; i++) { rn += (rhs[i] - q[i]) ** 2; bn += rhs[i] ** 2 }
    const twice = run(M.op.twoLevelPreconditioner(A, M.op.aggregate(A, 6)))
    stommelRows.push({ kind: domain.kind, s, h: meanSpacing(fm), err: relL2(fm, two.x, t.v), errInf: relLinf(two.x, t.v), jac, ilu, two, resid: Math.sqrt(rn / bn), same: hashArrays([two.x]) === hashArrays([twice.x]), agree: relL2(fm, jac.x, two.x) })
  }
}
for (const r of stommelRows) console.log(`  ${r.kind} ${String(r.s / 1e3).padStart(3)} km: iterations Jacobi ${r.jac.rep.iterations} / ILU(0) ${r.ilu.rep.iterations} / two-level ${r.two.rep.iterations} (${r.jac.ms.toFixed(0)} / ${r.ilu.ms.toFixed(0)} / ${r.two.ms.toFixed(0)} ms), residual ${e(r.two.rep.residual)} (recomputed ${e(r.resid)}), error against exact L2 ${e(r.err)} L∞ ${e(r.errInf)}`)
for (const kind of ['sphere', 'torus']) {
  const rows = stommelRows.filter((r) => r.kind === kind)
  const o = order(rows.map((r) => r.err), rows.map((r) => r.h))
  check(`${kind}: the non-symmetric solve converges to 1e-10 at every spacing, with each preconditioner`, rows.every((r) => [r.jac, r.ilu, r.two].every((x) => x.rep.converged) && r.resid < 1e-9), rows.map((r) => r.two.rep.iterations).join(' ') + ' two-level iterations')
  check(`${kind}: its error against the manufactured solution falls at second order`, o.every((x) => x > 1.6), `${rows.map((r) => e(r.err)).join(' ')}, order ${o.map(f2).join(' ')}`)
  check(`${kind}: the preconditioners reach the same answer (Jacobi against two-level, L2 < 1e-8)`, rows.every((r) => r.agree < 1e-8), rows.map((r) => e(r.agree)).join(' '))
  check(`${kind}: the two-level iterations do not grow with the mesh (39 km within 2 × the 312 km's)`, rows[rows.length - 1].two.rep.iterations <= 2 * Math.max(10, rows[0].two.rep.iterations), rows.map((r) => r.two.rep.iterations).join(' '))
  check(`${kind}: the solve is the same bytes twice`, rows.every((r) => r.same))
}
// STOMMEL'S BASIN (Stommel 1948): a rectangular sea, ψ = 0 on its coast,
// a curl −C sin(π y' / B) — the analytic ψ = (C / k²)(1 + p e^{r₊x'} +
// q e^{r₋x'}) sin(k y'), k = π / B, r± = (−β ± √(β² + 4k²)) / 2, with p and q
// from ψ = 0 at x' = 0 and L: a western boundary layer about 1 / β wide.
// Through the stage's own solve (oceanCurrents.solveStommel: the land one
// mass, its ψ the reference 0). The coast is the land cells' centres,
// up to a cell outside the box's edge: first order at best.
{
  const Lm = 6000e3, Bm = 3000e3, b0 = 1 / 300e3
  const fmOrder = []
  for (const s of [156e3, 78e3, 39e3]) {
    const fm = meshOf(torus, s)
    const x0 = 2000e3, y0 = 2500e3
    const k = Math.PI / Bm
    const rp = (-b0 + Math.sqrt(b0 * b0 + 4 * k * k)) / 2, rm = (-b0 - Math.sqrt(b0 * b0 + 4 * k * k)) / 2
    const p = (-1 + Math.exp(rm * Lm)) / (Math.exp(rp * Lm) - Math.exp(rm * Lm)), q = -1 - p
    const exact = (xp, yp) => (1 / (k * k)) * (1 + p * Math.exp(rp * xp) + q * Math.exp(rm * xp)) * Math.sin(k * yp)
    const land = new Uint8Array(fm.count), beta = new Float64Array(fm.count), curl = new Float64Array(fm.count), want = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) {
      const xp = fm.x[i] * fm.unitM - x0, yp = fm.y[i] * fm.unitM - y0
      const inside = xp > 0 && xp < Lm && yp > 0 && yp < Bm
      land[i] = inside ? 0 : 1
      beta[i] = b0
      curl[i] = inside ? -Math.sin(k * yp) : 0
      want[i] = inside ? exact(xp, yp) : 0
    }
    const t0 = performance.now()
    const sol = M.ocean.solveStommel(fm, land, beta, curl)
    const ms = performance.now() - t0
    let num = 0, den = 0, west = 0, east = 0
    for (let i = 0; i < fm.count; i++) {
      if (land[i]) continue
      num += fm.area[i] * (sol.psi[i] - want[i]) ** 2; den += fm.area[i] * want[i] ** 2
      const xp = fm.x[i] * fm.unitM - x0
      if (xp < 0.15 * Lm) west += fm.area[i] * Math.abs(sol.psi[i]); else if (xp > 0.85 * Lm) east += fm.area[i] * Math.abs(sol.psi[i])
    }
    // Where the gyre's centre (|ψ| max) lies along x, as a share of L.
    let best = 0, at = 0
    for (let i = 0; i < fm.count; i++) if (!land[i] && Math.abs(sol.psi[i]) > best) { best = Math.abs(sol.psi[i]); at = (fm.x[i] * fm.unitM - x0) / Lm }
    // The mutation: β's sign turned, the layer goes east.
    const flipped = M.ocean.solveStommel(fm, land, beta.map((b) => -b), curl)
    let bestF = 0, atF = 0
    for (let i = 0; i < fm.count; i++) if (!land[i] && Math.abs(flipped.psi[i]) > bestF) { bestF = Math.abs(flipped.psi[i]); atF = (fm.x[i] * fm.unitM - x0) / Lm }
    fmOrder.push({ s, h: meanSpacing(fm), err: Math.sqrt(num / den), at, atF, its: sol.solve.iterations, ms, converged: sol.solve.converged, landmasses: sol.landmasses, islands: sol.islands })
  }
  for (const r of fmOrder) console.log(`  torus ${r.s / 1e3} km basin: ${r.its} iterations, ${r.ms.toFixed(0)} ms, error against Stommel's ψ L2 ${e(r.err)}, the gyre's centre at x = ${f2(r.at)} L (β turned: ${f2(r.atF)} L), ${r.landmasses} landmass, ${r.islands} islands`)
  const o = order(fmOrder.map((r) => r.err), fmOrder.map((r) => r.h))
  // (The coast's jag of up to a cell about the box's edge does not shrink
  // evenly with the spacing: the order wanders, 1.05 then 0.23 measured.)
  check('torus: Stommel\'s basin — converged, the error against the analytic ψ under 5 % from 78 km on, and falling', fmOrder.every((r) => r.converged) && fmOrder.slice(1).every((r) => r.err < 0.05) && fmOrder.every((r, k) => k === 0 || r.err <= fmOrder[k - 1].err), `${fmOrder.map((r) => e(r.err)).join(' ')}, order ${o.map(f2).join(' ')}`)
  check('torus: the gyre is intensified at the WESTERN boundary (its centre in the western fifth)', fmOrder.every((r) => r.at < 0.2), fmOrder.map((r) => f2(r.at)).join(' '))
  check('mutation: with β turned the gyre goes to the eastern boundary', fmOrder.every((r) => r.atF > 0.8), fmOrder.map((r) => f2(r.atF)).join(' '))
}

// ================================================================ [5]
console.log('\n[5] semi-Lagrangian transport: a cosine bell, one revolution')
// Williamson et al. test 1, α = 90°: a cosine bell of radius R/3 carried by
// a solid-body rotation over both poles, one revolution in 12 days; the
// exact answer at the end is the start. The wind is a field on the mesh
// (as a stage's would be), the departures are computed once (the wind is
// steady) and every step reuses them.
const bellOnSphere = (fm, c) => {
  const v = new Float64Array(fm.count)
  const R = fm.radiusM, Rb = R / 3
  for (let i = 0; i < fm.count; i++) {
    const d = Math.max(-1, Math.min(1, fm.u[3 * i] * c[0] + fm.u[3 * i + 1] * c[1] + fm.u[3 * i + 2] * c[2]))
    const r = R * Math.acos(d)
    v[i] = r < Rb ? 500 * (1 + Math.cos(Math.PI * r / Rb)) : 0
  }
  return v
}
const norms = (fm, got, want) => {
  let l1 = 0, d1 = 0, l2 = 0, d2 = 0, li = 0, di = 0, m0 = 0, m1 = 0, mn = Infinity, mx = -Infinity
  for (let i = 0; i < fm.count; i++) {
    const a = fm.area[i], d = got[i] - want[i]
    l1 += a * Math.abs(d); d1 += a * Math.abs(want[i]); l2 += a * d * d; d2 += a * want[i] ** 2
    li = Math.max(li, Math.abs(d)); di = Math.max(di, Math.abs(want[i]))
    m0 += a * want[i]; m1 += a * got[i]; mn = Math.min(mn, got[i]); mx = Math.max(mx, got[i])
  }
  return { l1: l1 / d1, l2: Math.sqrt(l2 / d2), linf: li / di, mass: (m1 - m0) / m0, min: mn, max: mx }
}
const revolve = (fm, ve, vs, h0, steps, period, corrected, clip = false) => {
  const sampler = M.fm.createFieldSampler(fm)
  const dep = M.op.computeDepartures(fm, sampler, ve, vs, period / steps, M.op.departures(fm))
  let a = Float64Array.from(h0), b = new Float64Array(fm.count)
  const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
  for (let k = 0; k < steps; k++) {
    if (corrected) { M.op.gradient(fm, a, ge, gs); M.op.transportScalar(fm, dep, a, b, ge, gs, clip) } else M.op.transportScalar(fm, dep, a, b)
    ;[a, b] = [b, a]
  }
  return a
}
const transportRows = []
const DAY = 86400
for (const s of SPACINGS.slice(0, 3)) {
  const fm = meshOf(sphere, s)
  const R = fm.radiusM
  const period = 12 * DAY
  const omega = (2 * Math.PI) / period
  // Ω about +x: through (0, −1, 0) (λ = 3π/2 on the equator) and both poles.
  const ve = new Float64Array(fm.count), vs = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) {
    const y = fm.u[3 * i + 1], z = fm.u[3 * i + 2]
    const vy = -omega * R * z, vz = omega * R * y
    ve[i] = vy * fm.east[3 * i + 1] + vz * fm.east[3 * i + 2]
    vs[i] = vy * fm.south[3 * i + 1] + vz * fm.south[3 * i + 2]
  }
  const h0 = bellOnSphere(fm, [0, -1, 0])
  // A Courant number of about 1 (u0 = 2πR / 12 d ≈ 19 m/s), and 4 for a
  // long step.
  for (const courant of [1, 4]) {
    const steps = Math.round((2 * Math.PI * R) / (courant * meanSpacing(fm)))
    for (const [corrected, clip] of [[false, false], [true, false], [true, true]]) {
      const got = revolve(fm, ve, vs, h0, steps, period, corrected, clip)
      transportRows.push({ kind: 'sphere', s, steps, courant, corrected, clip, h: meanSpacing(fm), ...norms(fm, got, h0) })
    }
  }
  // Half a revolution: the bell sits on the antipode — over both poles, the
  // check that the frames and the departures carry it there.
  const steps = Math.round((Math.PI * R) / meanSpacing(fm))
  const sampler = M.fm.createFieldSampler(fm)
  const dep = M.op.computeDepartures(fm, sampler, ve, vs, period / 2 / steps, M.op.departures(fm))
  let a = Float64Array.from(h0), b = new Float64Array(fm.count)
  const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
  for (let k = 0; k < steps; k++) { M.op.gradient(fm, a, ge, gs); M.op.transportScalar(fm, dep, a, b, ge, gs); [a, b] = [b, a] }
  transportRows.push({ kind: 'sphere half', s, steps, courant: 1, corrected: true, h: meanSpacing(fm), ...norms(fm, a, bellOnSphere(fm, [0, 1, 0])) })
}
// The torus: the bell carried diagonally once across both seams, back to
// its start after one period.
for (const s of SPACINGS.slice(0, 3)) {
  const fm = meshOf(torus, s)
  const Wm = torus.width * fm.unitM, Hm = torus.height * fm.unitM
  const period = 12 * DAY
  const ve = new Float64Array(fm.count).fill(Wm / period), vs = new Float64Array(fm.count).fill(Hm / period)
  const h0 = new Float64Array(fm.count)
  const Rb = Hm / 6
  for (let i = 0; i < fm.count; i++) {
    const r = Math.sqrt(torus.distanceSq(fm.x[i], fm.y[i], 0.1 * torus.width, 0.5 * torus.height)) * fm.unitM
    h0[i] = r < Rb ? 500 * (1 + Math.cos(Math.PI * r / Rb)) : 0
  }
  const speed = Math.hypot(Wm, Hm)
  for (const courant of [1, 4]) {
    const steps = Math.round(speed / (courant * meanSpacing(fm)))
    for (const [corrected, clip] of [[false, false], [true, false], [true, true]]) {
      const got = revolve(fm, ve, vs, h0, steps, period, corrected, clip)
      transportRows.push({ kind: 'torus', s, steps, courant, corrected, clip, h: meanSpacing(fm), ...norms(fm, got, h0) })
    }
  }
}
for (const r of transportRows) console.log(`  ${r.kind.padEnd(11)} ${String(r.s / 1e3).padStart(3)} km, ${String(r.steps).padStart(4)} steps (Courant ~${r.courant}), ${r.corrected ? (r.clip ? 'Hermite, clipped  ' : 'Hermite           ') : 'linear            '}: L1 ${e(r.l1)} L2 ${e(r.l2)} L∞ ${e(r.linf)}, mass drift ${(100 * r.mass).toFixed(2)} %, range ${r.min.toFixed(1)}..${r.max.toFixed(1)}`)
for (const kind of ['sphere', 'torus']) {
  for (const [corrected, clip] of [[false, false], [true, false], [true, true]]) {
    const rows = transportRows.filter((r) => r.kind === kind && r.courant === 1 && r.corrected === corrected && !!r.clip === clip)
    const o = order(rows.map((r) => r.l2), rows.map((r) => r.h))
    const name = `${kind}: ${corrected ? (clip ? 'Hermite clipped' : 'Hermite') : 'linear'} transport`
    // Linear interpolation of the cosine bell (a kink at its rim) at a
    // fixed Courant number converges slowly: twice the steps, each half as
    // diffusive. The Hermite form at second order.
    check(`${name} converges${corrected ? ' at second order' : ''}`, o.every((x) => x > (corrected ? 1.7 : 0.2)), o.map(f2).join(' '))
    if (clip || !corrected) check(`${name} is monotone (no new extremes)`, rows.every((r) => r.min >= -1e-9 && r.max <= 1000 + 1e-9))
    if (corrected && !clip) check(`${name} keeps the mass to 0.1 % at 78 km`, Math.abs(rows[rows.length - 1].mass) < 1e-3, `${(100 * rows[rows.length - 1].mass).toFixed(3)} %`)
  }
}
{
  const r78 = transportRows.find((r) => r.kind === 'sphere' && r.s === 78e3 && r.courant === 1 && r.corrected && !r.clip)
  check('sphere 78 km: the bell comes back over both poles (Hermite L2 < 0.03)', r78.l2 < 0.03, `L2 ${e(r78.l2)}`)
  const half = transportRows.find((r) => r.kind === 'sphere half' && r.s === 78e3)
  check('sphere 78 km: half a revolution puts the bell on the antipode (L2 < 0.03)', half.l2 < 0.03, `L2 ${e(half.l2)}`)
}
// A vector carried by a solid-body rotation. The exact covariant
// advection (Dv/Dt = 0, the vector parallel-transported along its
// trajectory) of v = Ω × r is NOT v again: the trajectory is a small
// circle, whose geodesic curvature turns a transported vector against it
// by ω · dt · cos θ in a step (θ the angle from the axis). The transported
// wind must be the wind turned by exactly that angle, at its own length.
{
  const fm = meshOf(sphere, 78e3)
  const R = fm.radiusM
  const omega = (2 * Math.PI) / (12 * DAY)
  const dt = 3600
  const ve = new Float64Array(fm.count), vs = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) {
    const y = fm.u[3 * i + 1], z = fm.u[3 * i + 2]
    const vy = -omega * R * z, vz = omega * R * y
    ve[i] = vy * fm.east[3 * i + 1] + vz * fm.east[3 * i + 2]
    vs[i] = vy * fm.south[3 * i + 1] + vz * fm.south[3 * i + 2]
  }
  const sampler = M.fm.createFieldSampler(fm)
  const dep = M.op.computeDepartures(fm, sampler, ve, vs, dt, M.op.departures(fm))
  const oe = new Float64Array(fm.count), os = new Float64Array(fm.count)
  M.op.transportVector(fm, dep, ve, vs, oe, os)
  let angErr = 0, lenErr = 0, signSum = 0
  const vmax = omega * R
  for (let i = 0; i < fm.count; i++) {
    const cosT = fm.u[3 * i]
    if (Math.abs(cosT) > 0.99) continue
    const ang = Math.atan2(ve[i] * os[i] - vs[i] * oe[i], ve[i] * oe[i] + vs[i] * os[i])
    signSum += ang * cosT
    // The turn, in the chart's sense: the harness found its sign; its size is
    // the claim.
    angErr = Math.max(angErr, Math.abs(Math.abs(ang) - omega * dt * Math.abs(cosT)) * Math.hypot(ve[i], vs[i]) / vmax)
    lenErr = Math.max(lenErr, Math.abs(Math.hypot(oe[i], os[i]) - Math.hypot(ve[i], vs[i])) / vmax)
  }
  // Without the carrying (each corner's numbers summed as they stand): what
  // the frames are for.
  const naive = new Float64Array(fm.count), naiveS = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) for (let k = 3 * i; k < 3 * i + 3; k++) { naive[i] += dep.weights[k] * ve[dep.corners[k]]; naiveS[i] += dep.weights[k] * vs[dep.corners[k]] }
  console.log(`  sphere 78 km: Ω × r transported by itself for 1 h: turned by ω·dt·cos θ to ${e(angErr)} of |v|max (the turn itself up to ${e(omega * dt)}), length to ${e(lenErr)}, turn sign consistent ${signSum !== 0}; summed without frames the vector is off by ${e(vecLinf(naive, naiveS, ve, vs))}`)
  check('sphere: a solid-body wind carried by itself turns by the trajectory\'s curvature, at its length', angErr < 1e-3 && lenErr < 2e-3, `angle ${e(angErr)}, length ${e(lenErr)}`)
}

// ================================================================ [6]
console.log('\n[6] sampling and rasterising')
// A deterministic point set (an LCG), uniform on the globe / the torus.
const points = (domain, n, seed = 12345) => {
  let st = seed >>> 0
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st / 4294967296 }
  const xs = new Float64Array(n), ys = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    xs[k] = rnd() * domain.width
    ys[k] = domain.kind === 'sphere' ? (Math.acos(1 - 2 * rnd()) / Math.PI) * domain.height : rnd() * domain.height
  }
  return { xs, ys }
}
// The analytic test function at a chart point.
const analyticAt = (domain) => {
  if (domain.kind === 'sphere') {
    const h = HARMONICS[2]
    return (x, y) => { const t = (y / domain.height) * Math.PI, l = (x / domain.width) * 2 * Math.PI; return h.F(Math.sin(t) * Math.cos(l), Math.sin(t) * Math.sin(l), Math.cos(t)) }
  }
  const m = MODES[2]
  return (x, y) => Math.cos(2 * Math.PI * (m.a * x / domain.width + m.b * y / domain.height) + m.c)
}
for (const domain of [sphere, torus]) {
  const F = analyticAt(domain)
  const errs = [], hs = []
  for (const s of SPACINGS) {
    const fm = meshOf(domain, s)
    const sampler = M.fm.createFieldSampler(fm)
    const v = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) v[i] = F(fm.x[i], fm.y[i])
    const { xs, ys } = points(domain, 20000)
    let sq = 0
    for (let k = 0; k < xs.length; k++) sq += (sampler.sample(v, xs[k], ys[k]) - F(xs[k], ys[k])) ** 2
    errs.push(Math.sqrt(sq / xs.length))
    hs.push(meanSpacing(fm))
  }
  const o = order(errs, hs)
  console.log(`  ${domain.kind}: the sampler's RMS error at 20 000 random points ${errs.map(e).join(' ')}, order ${o.map(f2).join(' ')}`)
  check(`${domain.kind}: sampling converges at second order`, o.every((x) => x > 1.8), o.map(f2).join(' '))

  const fm = meshOf(domain, 78e3)
  const sampler = M.fm.createFieldSampler(fm)
  const v = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) v[i] = F(fm.x[i], fm.y[i])
  // The seam: the same point named at x = 0 and x = W (minus an ulp of it).
  let seam = 0
  for (let k = 0; k < 1000; k++) {
    const y = ((k + 0.5) / 1000) * domain.height
    seam = Math.max(seam, Math.abs(sampler.sample(v, 0, y) - sampler.sample(v, domain.width * (1 - 1e-15), y)))
  }
  check(`${domain.kind}: no seam at x = 0 / W in the sampler`, seam < 1e-9, `max ${e(seam)}`)
  if (domain.kind === 'sphere') {
    let spreadN = 0, spreadS = 0
    const n0 = sampler.sample(v, 0, 0), s0 = sampler.sample(v, 0, domain.height)
    for (let k = 0; k < 512; k++) {
      const x = (k / 512) * domain.width
      spreadN = Math.max(spreadN, Math.abs(sampler.sample(v, x, 0) - n0))
      spreadS = Math.max(spreadS, Math.abs(sampler.sample(v, x, domain.height) - s0))
    }
    // The north pole is one point exactly (sin 0 = 0); the south pole's
    // sin π is not 0 in the last bit, so its "point" is a ring of 1e-16.
    check('sphere: a pole is one value for every x (sampler)', spreadN === 0 && spreadS < 1e-12, `spread ${e(spreadN)} / ${e(spreadS)}`)
    const corner = M.raster.rasteriseNodeField(fm.tri, v, 512, 256)
    let rowSpread = 0
    for (let k = 0; k < 512; k++) rowSpread = Math.max(rowSpread, Math.abs(corner[k] - corner[0]))
    check('sphere: the corner-convention raster\'s pole row is one value (rasteriseNodeField)', rowSpread === 0, e(rowSpread))
    // The centre-convention row nearest the pole is a ring: it must be the
    // analytic ring, not a star.
    const centre = M.fm.rasteriseField(fm, v, 512, 256)
    let ringErr = 0
    for (let k = 0; k < 512; k++) ringErr = Math.max(ringErr, Math.abs(centre[k] - F((k + 0.5) * domain.width / 512, 0.5 * domain.height / 256)))
    check('sphere: the centre-convention raster\'s first row is the ring there', ringErr < 0.02, `max error ${e(ringErr)} of a field of amplitude ~2`)
  }
  // The raster's seam: the step from the last column to the first against
  // the field's steps inside the raster.
  const R256 = M.fm.rasteriseField(fm, v, 256, 128)
  let inner = 0, across = 0
  for (let j = 0; j < 128; j++) {
    for (let i = 0; i < 255; i++) inner = Math.max(inner, Math.abs(R256[j * 256 + i + 1] - R256[j * 256 + i]))
    across = Math.max(across, Math.abs(R256[j * 256] - R256[j * 256 + 255]))
  }
  check(`${domain.kind}: no seam in the raster (the step across x = 0 like any other)`, across <= inner * 1.01, `across ${e(across)}, inside up to ${e(inner)}`)

  // Round trip 1: an analytic 256 × 128 raster → mesh (centre samples) →
  // raster, against the raster.
  const grid = domain.grid(256, 128)
  const A = new Float32Array(256 * 128)
  for (let j = 0; j < 128; j++) for (let i = 0; i < 256; i++) A[j * 256 + i] = F((i + 0.5) * domain.width / 256, (j + 0.5) * domain.height / 128)
  const onMesh = M.fm.fieldFromRasterAtCentres(fm, A, 256, 128)
  const back = M.fm.rasteriseField(fm, onMesh, 256, 128)
  let rt2 = 0, rtw = 0, rti = 0, amax = 0
  for (let j = 0; j < 128; j++) for (let i = 0; i < 256; i++) { const w = grid.cellArea(j), d = back[j * 256 + i] - A[j * 256 + i]; rt2 += w * d * d; rtw += w * A[j * 256 + i] ** 2; rti = Math.max(rti, Math.abs(d)); amax = Math.max(amax, Math.abs(A[j * 256 + i])) }
  console.log(`  ${domain.kind} 78 km: raster 256×128 → mesh (centres) → raster: L2 ${e(Math.sqrt(rt2 / rtw))}, L∞ ${e(rti / amax)}`)
  check(`${domain.kind}: raster → mesh → raster within interpolation error (L2 < 1e-2)`, Math.sqrt(rt2 / rtw) < 1e-2, e(Math.sqrt(rt2 / rtw)))
  // Round trip 2: mesh → raster 2048 × 1024 → mesh (area-weighted), and
  // the mass the area-weighted mean keeps.
  const fine = M.fm.rasteriseField(fm, v, 2048, 1024)
  const backMesh = M.fm.fieldFromRasterAreaWeighted(fm, sampler, fine, 2048, 1024)
  const fineGrid = domain.grid(2048, 1024)
  let massR = 0, massM = 0, massRef = 0, absR = 0
  const chart = (domain.width / 2048) * (domain.height / 1024) * fm.unitM ** 2
  for (let j = 0; j < 1024; j++) for (let i = 0; i < 2048; i++) { massR += fineGrid.cellArea(j) * chart * fine[j * 2048 + i]; absR += fineGrid.cellArea(j) * chart * Math.abs(fine[j * 2048 + i]) }
  for (let i = 0; i < fm.count; i++) { massM += fm.area[i] * backMesh[i]; massRef += fm.area[i] * Math.abs(v[i]) }
  const rtMesh = relL2(fm, backMesh, v)
  console.log(`  ${domain.kind} 78 km: mesh → raster 2048×1024 → mesh (area-weighted): L2 ${e(rtMesh)}; Σ A·φ raster ${e(massR / absR)} vs mesh ${e(massM / absR)} (of Σ A·|φ|), difference ${e(Math.abs(massR - massM) / absR)}`)
  check(`${domain.kind}: mesh → raster → mesh within the cell average's smoothing (L2 < 5e-3)`, rtMesh < 5e-3, e(rtMesh))
  check(`${domain.kind}: the area-weighted mean keeps the raster's integral (to 1e-3 of Σ A·|φ|)`, Math.abs(massR - massM) / absR < 1e-3, e(Math.abs(massR - massM) / absR))
  // nearestCell is the brute-force nearest centre.
  const { xs, ys } = points(domain, 2000, 777)
  let wrong = 0
  for (let k = 0; k < xs.length; k++) {
    const got = sampler.nearestCell(xs[k], ys[k])
    let best = 0, bestD = Infinity
    for (let i = 0; i < fm.count; i++) { const d = domain.distanceSq(fm.x[i], fm.y[i], xs[k], ys[k]); if (d < bestD) { bestD = d; best = i } }
    if (got !== best && Math.abs(domain.distanceSq(fm.x[got], fm.y[got], xs[k], ys[k]) - bestD) > 1e-9 * bestD) wrong++
  }
  check(`${domain.kind}: nearestCell is the nearest centre (2000 points against a full scan)`, wrong === 0, `${wrong} wrong`)
}

// ================================================================ [7]
console.log('\n[7] determinism: the same inputs, the same bytes')
for (const domain of [sphere, torus]) {
  const run = () => {
    const fm = M.fm.createFieldMesh(domain, 78e3)
    const sampler = M.fm.createFieldSampler(fm)
    const t = testFields(fm)[2]
    const lap = M.op.laplacian(fm, t.v, new Float64Array(fm.count))
    const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
    M.op.gradient(fm, t.v, ge, gs)
    const div = M.op.divergence(fm, ge, gs, new Float64Array(fm.count))
    const dep = M.op.computeDepartures(fm, sampler, gs.map((x) => x * 1e7), ge.map((x) => -x * 1e7), 3600, M.op.departures(fm))
    const moved = M.op.transportScalar(fm, dep, t.v, new Float64Array(fm.count), ge, gs)
    const phi = new Float64Array(fm.count)
    M.op.solveHelmholtz(fm, 0, t.v, phi)
    const raster = M.fm.rasteriseField(fm, phi, 256, 128)
    return {
      geometry: hashArrays([fm.x, fm.y, fm.u, fm.east, fm.south, fm.area, fm.nbrStart, fm.nbr, fm.rev, fm.wall, fm.dist, fm.offE, fm.offS, fm.turnC, fm.turnS, fm.gradE, fm.gradS]),
      operators: hashArrays([lap, ge, gs, div, dep.x, dep.y, dep.corners, dep.weights, moved, phi, raster]),
    }
  }
  const a = run(), b = run()
  console.log(`  ${domain.kind} 78 km: geometry ${a.geometry}, operators ${a.operators}`)
  check(`${domain.kind}: the field mesh is the same bytes twice`, a.geometry === b.geometry)
  check(`${domain.kind}: every operator gives the same bytes twice`, a.operators === b.operators)
}

// ================================================================ [8]
console.log('\n[8] mutations: each ingredient removed, the check that guards it must fail')
{
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length
  for (const domain of [sphere, torus]) {
    const fm = meshOf(domain, 78e3)
    const kind = domain.kind
    // The wall lengths: every wall the mean wall.
    const w = mean(fm.wall)
    const noWall = { ...fm, coupling: fm.dist.map((d) => w / d) }
    const lapNoWall = worstLaplacian(noWall)
    if (kind === 'sphere') check(`${kind}: without the wall lengths ∇² leaves its band`, lapNoWall > LAP_BAND[kind], `${e(lapNoWall)} against ${e(LAP_BAND[kind])}`)
    else {
      // The torus's lattice is nearly regular (its rows are 0.3 % off √3/2
      // of its columns, to tile the period), so the mean wall is a small
      // error — but an inconsistent one, which does not fall with the
      // spacing: the convergence order catches it, the band does not.
      const errs = [], hs = []
      for (const sp of SPACINGS.slice(1)) {
        const m = meshOf(domain, sp)
        const wm = mean(m.wall)
        const mut = { ...m, coupling: m.dist.map((d) => wm / d) }
        const t = testFields(m)[0]
        errs.push(relL2(m, M.op.laplacian(mut, t.v, new Float64Array(m.count)), t.v.map((x) => x * t.eig)))
        hs.push(meanSpacing(m))
      }
      const o = order(errs, hs)
      check('torus: without the wall lengths ∇² loses its second order (k = (1, 0))', o.some((x) => x < 1.9), `${errs.map(e).join(' ')}, order ${o.map(f2).join(' ')}`)
    }
    if (kind === 'sphere') {
      // The areas: every cell the mean area.
      const noArea = { ...fm, area: new Float64Array(fm.count).fill(mean(fm.area)) }
      const lapNoArea = worstLaplacian(noArea)
      check('sphere: without the true areas ∇² leaves its band', lapNoArea > LAP_BAND.sphere, `${e(lapNoArea)} against ${e(LAP_BAND.sphere)}`)
      // The frame transport: a neighbour's vector read as it stands.
      const noTurn = { ...fm, turnC: new Float64Array(fm.turnC.length).fill(1), turnS: new Float64Array(fm.turnS.length) }
      const divNoTurn = worstDivergence(noTurn)
      check('sphere: without the frame transport the divergence leaves its band', divNoTurn > DIV_BAND.sphere, `${e(divNoTurn)} against ${e(DIV_BAND.sphere)}`)
      // The tangent plane: the offsets read in the chart (east not scaled by
      // cos φ) — the gradient is then the chart's, wrong away from the
      // equator.
      const chartOff = { ...fm }
      const offE = new Float64Array(fm.offE.length), offS = new Float64Array(fm.offS.length)
      for (let i = 0; i < fm.count; i++) for (let k = fm.nbrStart[i]; k < fm.nbrStart[i + 1]; k++) {
        const j = fm.nbr[k]
        let dx = fm.x[j] - fm.x[i]
        if (dx > domain.width / 2) dx -= domain.width
        if (dx < -domain.width / 2) dx += domain.width
        offE[k] = dx * fm.unitM
        offS[k] = (fm.y[j] - fm.y[i]) * fm.unitM
      }
      // Rebuild the least-squares weights from the chart offsets.
      const gradE = new Float64Array(offE.length), gradS = new Float64Array(offS.length)
      for (let i = 0; i < fm.count; i++) {
        let a = 0, b = 0, c = 0
        for (let k = fm.nbrStart[i]; k < fm.nbrStart[i + 1]; k++) { const q = 1 / (offE[k] ** 2 + offS[k] ** 2); a += q * offE[k] ** 2; b += q * offE[k] * offS[k]; c += q * offS[k] ** 2 }
        const det = a * c - b * b
        for (let k = fm.nbrStart[i]; k < fm.nbrStart[i + 1]; k++) { const q = 1 / (offE[k] ** 2 + offS[k] ** 2); gradE[k] = q * (c * offE[k] - b * offS[k]) / det; gradS[k] = q * (a * offS[k] - b * offE[k]) / det }
      }
      Object.assign(chartOff, { offE, offS, gradE, gradS })
      const gChart = worstGradient(chartOff)
      check('sphere: with chart offsets in place of the tangent plane the gradient leaves its band', gChart > GRAD_BAND.sphere, `${e(gChart)} against ${e(GRAD_BAND.sphere)}`)
    }
  }
  // The transport's half extension: the full one (×2) blows up.
  const fm = meshOf(sphere, 156e3)
  const dep0 = M.op.departures(fm)
  const R = fm.radiusM, omega = (2 * Math.PI) / (12 * DAY)
  const ve = new Float64Array(fm.count), vs = new Float64Array(fm.count)
  for (let i = 0; i < fm.count; i++) {
    const y = fm.u[3 * i + 1], z = fm.u[3 * i + 2]
    ve[i] = -omega * R * z * fm.east[3 * i + 1] + omega * R * y * fm.east[3 * i + 2]
    vs[i] = -omega * R * z * fm.south[3 * i + 1] + omega * R * y * fm.south[3 * i + 2]
  }
  const steps = Math.round((2 * Math.PI * R) / meanSpacing(fm))
  M.op.computeDepartures(fm, M.fm.createFieldSampler(fm), ve, vs, (12 * DAY) / steps, dep0)
  const h0 = bellOnSphere(fm, [0, -1, 0])
  let a = Float64Array.from(h0), b = new Float64Array(fm.count)
  const ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
  for (let k = 0; k < steps; k++) { M.op.gradient(fm, a, ge, gs); M.op.transportScalar(fm, dep0, a, b, ge.map((x) => 2 * x), gs.map((x) => 2 * x)); [a, b] = [b, a] }
  const full = norms(fm, a, h0)
  check('sphere: with the full extension in place of the half the transport leaves its band', full.l2 > 0.2, `L2 ${e(full.l2)}`)
}

// ================================================================ [9]
console.log('\n[9] timing (ms; the median of 5, of 3 for the solves and the departures, one run after a warm-up for the 2048 rasters)')
{
  const rows = []
  for (const domain of [sphere, torus]) {
    for (const s of [156e3, 78e3]) {
      const t0 = performance.now()
      const fm = M.fm.createFieldMesh(domain, s)
      const build = performance.now() - t0
      const t1 = performance.now()
      const sampler = M.fm.createFieldSampler(fm)
      const samplerMs = performance.now() - t1
      const t = testFields(fm)[2]
      const out = new Float64Array(fm.count), ge = new Float64Array(fm.count), gs = new Float64Array(fm.count)
      const ve = t.gs.map((x) => x * 1e7), vs = t.ge.map((x) => -x * 1e7)
      const dep = M.op.departures(fm)
      const phi = new Float64Array(fm.count)
      const { xs, ys } = points(domain, 100000)
      const r256 = M.fm.rasteriseField(fm, t.v, 256, 128)
      const r2048 = M.fm.rasteriseField(fm, t.v, 2048, 1024)
      const kappa = 1e5
      rows.push({
        label: `${domain.kind} ${s / 1e3} km (${fm.count})`,
        build, sampler: samplerMs,
        laplacian: time(() => M.op.laplacian(fm, t.v, out)),
        explicit: time(() => M.op.diffuseExplicit(fm, t.v, kappa, M.op.stableDiffusionStep(fm, kappa), out)),
        gradient: time(() => M.op.gradient(fm, t.v, ge, gs)),
        divergence: time(() => M.op.divergence(fm, ve, vs, out)),
        departures: time(() => M.op.computeDepartures(fm, sampler, ve, vs, 3600, dep), 3),
        linear: time(() => M.op.transportScalar(fm, dep, t.v, out)),
        hermite: time(() => { M.op.gradient(fm, t.v, ge, gs); M.op.transportScalar(fm, dep, t.v, out, ge, gs) }),
        vector: time(() => M.op.transportVector(fm, dep, ve, vs, ge, gs)),
        poisson: time(() => { phi.fill(0); M.op.solveHelmholtz(fm, 0, t.v, phi) }, 3),
        implicit: time(() => M.op.diffuseImplicit(fm, t.v, kappa, 20 * M.op.stableDiffusionStep(fm, kappa), out), 3),
        sample100k: time(() => { let z = 0; for (let k = 0; k < xs.length; k++) z += sampler.sample(t.v, xs[k], ys[k]); return z }, 3),
        raster256: time(() => M.fm.rasteriseField(fm, t.v, 256, 128)),
        raster2048: time(() => M.fm.rasteriseField(fm, t.v, 2048, 1024), 1),
        fromCentres256: time(() => M.fm.fieldFromRasterAtCentres(fm, r256, 256, 128)),
        fromArea2048: time(() => M.fm.fieldFromRasterAreaWeighted(fm, sampler, r2048, 2048, 1024), 1),
      })
    }
  }
  const keys = Object.keys(rows[0]).filter((k) => k !== 'label')
  console.log(`  ${'operator'.padEnd(15)} ${rows.map((r) => r.label.padStart(24)).join('')}`)
  for (const k of keys) console.log(`  ${k.padEnd(15)} ${rows.map((r) => r[k].toFixed(r[k] < 10 ? 2 : 0).padStart(24)).join('')}`)
}

await server.close()
console.log(failures === 0 ? '\nfields harness: all checks passed' : `\nfields harness: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)

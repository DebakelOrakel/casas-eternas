// Writes the module test fixture for the engine's domain: hashes of what
// the TypeScript engine's core/domain.ts (the domain and its grids),
// core/field.ts and the field mesh's raster readers give for fixed inputs
// on both shapes, which the Rust port must give bit for bit
// (docs/decisions/rust-engine.md, fork 5).
//
//   node engine/scripts/domainFixture.mjs           write the fixture
//   node engine/scripts/domainFixture.mjs --check   fail if it is stale
//
// crates/casas-engine/tests/domain.rs makes the same calls from the same
// generator: change one, change the other.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const OUT = new URL('../crates/casas-engine/tests/fixtures/domain.txt', import.meta.url)

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const D = await L('/src/generator/core/domain.ts')
const F = await L('/src/generator/core/field.ts')
const FM = await L('/src/generator/fields/fieldMesh.ts')
await server.close()

let state = 0
const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
const uniform = (lo, hi) => lo + (hi - lo) * (next() / 4294967296)
const int = (lo, hi) => Math.floor(uniform(lo, hi))

const f = new Float64Array(1)
const w = new Uint32Array(f.buffer)
let h = 0
const add = (v) => {
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
const addP = (p) => {
  add(p.x)
  add(p.y)
}
const lines = [
  '# Hashes of client/src/generator/core/domain.ts, core/field.ts and the field mesh raster readers, for crates/casas-engine/tests/domain.rs.',
  '# Written by engine/scripts/domainFixture.mjs; do not edit.',
]
const line = (name) => lines.push(`${name} ${h.toString(16).padStart(8, '0')}`)
const randomField = (n) => {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = uniform(-1, 1)
  return a
}

const DOMAINS = [
  ['torus', D.torusDomain(2048, 1024), [[256, 128], [63, 31]]],
  ['torus_small', D.torusDomain(512, 256, 0.1, 31200), [[64, 32]]],
  ['sphere', D.sphereDomain(2048, 1024), [[256, 128], [64, 32]]],
  ['sphere_scaled', D.sphereDomain(2048, 1024).scaledTo(256, 128), [[32, 16]]],
]
let seed = 1
for (const [name, d, grids] of DOMAINS) {
  state = seed++
  h = 0x811c9dc5
  add(d.width)
  add(d.height)
  add(d.metresPerUnit)
  add(d.metresAround)
  add(D.domainArea(d))
  const sd = d.scaledTo(1024, 512)
  add(sd.metresPerUnit)
  add(sd.latitude(0.3))
  const p = { x: 0, y: 0 }
  const gf = D.globeFrame()
  for (let k = 0; k < 20000; k++) {
    const ax = uniform(-0.5 * d.width, 1.5 * d.width)
    const ay = uniform(-0.2 * d.height, 1.2 * d.height)
    const bx = uniform(0, d.width)
    const by = uniform(0, d.height)
    const yn = uniform(-0.5, 1.5)
    add(d.latitude(yn))
    add(d.north(yn) ? 1 : 0)
    d.delta(ax, ay, bx, by, p)
    addP(p)
    const dx = uniform(-40, 40)
    const dy = uniform(-40, 40)
    d.advance(bx, by, dx, dy, p)
    addP(p)
    d.displace(bx, by, dx, dy, p)
    addP(p)
    d.fromPlane(bx + dx, by + dy, bx, by, p)
    addP(p)
    add(d.wrapX(ax))
    add(d.wrapY(ay))
    d.wrapPoint(ax, ay, p)
    addP(p)
    add(d.distanceSq(ax, ay, bx, by))
    addP(d.rotateAround(ax, ay, bx, by, uniform(-0.3, 0.3)))
    d.transport(dx, dy, ax, ay, bx, by, p)
    addP(p)
    if (d.noise.kind === 'globe') {
      d.noise.frame(ax, ay, gf)
      for (const v of Object.values(gf)) add(v)
      d.noise.locate(uniform(-1, 1), uniform(-1, 1), uniform(-1, 1), p)
      addP(p)
    }
  }
  line(`${name}_domain`)

  for (const [rx, ry] of grids) {
    const g = d.grid(rx, ry)
    const field = randomField(rx * ry)
    h = 0x811c9dc5
    for (let k = 0; k < 2000; k++) {
      add(g.wrapCol(uniform(-3 * rx, 3 * rx)))
      add(g.wrapRow(uniform(-3 * ry, 3 * ry)))
      add(g.wrapCol(int(-3 * rx, 3 * rx)))
      add(g.wrapRow(int(-3 * ry, 3 * ry)))
      add(g.index(int(-2 * rx, 2 * rx), int(-2 * ry, 2 * ry)))
      add(g.neighbour(int(0, rx), int(0, ry), int(-3, 4), int(-3, 4)))
    }
    addAll(g.colTable(3))
    addAll(g.rowTable(d.kind === 'sphere' ? 0 : 3))
    for (let y = -2; y < ry + 2; y++) {
      add(g.rowScale(y + 0.25))
      add(g.cellArea(y))
      add(g.edgeScale(y + 0.4))
    }
    const box = { x0: 0, x1: 0, y0: 0, y1: 0 }
    for (let k = 0; k < 2000; k++) {
      const radius = k % 50 === 0 ? uniform(0, 2 * d.width) : uniform(0, 0.2 * d.height)
      g.discBox(uniform(-0.2 * d.width, 1.2 * d.width), uniform(-0.1 * d.height, 1.1 * d.height), radius, box)
      // `+ 0`: Math.ceil gives −0 on (−1, 0); the Rust box holds integers.
      add(box.x0 + 0)
      add(box.x1 + 0)
      add(box.y0 + 0)
      add(box.y1 + 0)
    }
    const a = Float32Array.from(field)
    g.averagePoleRows(a)
    addAll(a)
    const b = Float32Array.from(field)
    const mask = new Uint8Array(rx * ry)
    for (let i = 0; i < mask.length; i++) mask[i] = next() & 1
    g.averagePoleRows(b, mask)
    addAll(b)
    const taps = D.bilinearTaps(1)
    for (let k = 0; k < 5000; k++) {
      const gx = uniform(-rx, 2 * rx)
      const gy = uniform(-1, ry)
      add(g.sampleBilinear(field, gx, gy))
      add(g.interpolate(field, uniform(-0.5, rx), uniform(-0.5, ry - 0.5)))
      const cx = int(0, rx)
      const cy = int(0, ry)
      const dx = uniform(-3, 3)
      const dy = uniform(-3, 3)
      g.tapsAt(cx, cy, dx, dy, taps, 0)
      addAll(taps.cells)
      addAll(taps.weights)
      add(D.sampleTaps(field, taps, 0))
      add(g.cellDisplaced(cx, cy, dx, dy))
      g.displaced(cx, cy, dx, dy, p)
      addP(p)
      const x = uniform(-0.2 * d.width, 1.2 * d.width)
      const y = uniform(0, d.height)
      add(g.sampleBilinearAt(field, x, y))
      add(g.cellAt(x, y))
      add(g.sampleNearestAt(field, x, y))
    }
    addAll(g.upscale(field, 2 * rx, 2 * ry))
    line(`${name}_grid_${rx}x${ry}`)
  }
}

// core/field's reductions, with footprints that are and are not whole.
state = 9
h = 0x811c9dc5
const full = randomField(256 * 128)
addAll(F.downsampleBox(full, 256, 128, 64, 32))
addAll(F.downsampleBox(full, 256, 128, 100, 50))
addAll(F.downsampleMax(full, 256, 128, 64, 32))
addAll(F.downsampleMax(full, 256, 128, 100, 50))
line('field_reductions')

// The field mesh's raster readers, a raster finer and one coarser than it.
for (const [name, d] of [['torus', D.torusDomain(2048, 1024)], ['sphere', D.sphereDomain(2048, 1024)]]) {
  state = 10
  const fm = FM.createFieldMesh(d, 300000)
  const sampler = FM.createFieldSampler(fm)
  h = 0x811c9dc5
  for (const [rx, ry] of [[128, 64], [32, 16]]) {
    const raster = randomField(rx * ry)
    addAll(FM.fieldFromRasterAtCentres(fm, raster, rx, ry))
    addAll(FM.fieldFromRasterAreaWeighted(fm, sampler, raster, rx, ry))
    const owners = FM.rasterOwners(sampler, rx, ry)
    addAll(FM.fieldFromRasterAreaWeighted(fm, sampler, raster, rx, ry, undefined, owners))
    addAll(FM.fieldMaxFromRaster(fm, raster, rx, ry, owners))
  }
  add(fm.tri.lastTri)
  add(fm.tri.walkSteps)
  line(`${name}_raster_readers`)
}

const text = lines.join('\n') + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('engine/crates/casas-engine/tests/fixtures/domain.txt is stale — run node engine/scripts/domainFixture.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(OUT, text)
  console.log(text)
}

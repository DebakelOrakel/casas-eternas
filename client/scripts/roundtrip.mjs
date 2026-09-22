// Round-trip check for the SAVE FORMAT — what golden.mjs does not reach.
//
//   npm run harness:roundtrip
//
// The golden harness guards the generator: given params, are the fields the same
// bytes. It says nothing about what happens to those fields on the way to disk
// and back. `loadWorldInputs`, `worldLayers`' quantisation, the artifact
// encoding and the identity hashes are all unguarded — which matters because
// part C moves every one of those files into a new `world/` module, and a move
// through unguarded territory is a move nobody can check.
//
// It is deliberately FAST (seconds, not the harness's thirteen minutes) on
// synthetic rasters, because a format check you cannot afford to run is a format
// check nobody runs.
//
// What it does NOT cover, stated so it is not mistaken for complete: the zip
// ASSEMBLY still lives in WorldGenScreen and needs a DOM, so this reads a zip it
// builds from `WORLD_LAYERS` itself rather than from the real writer. That gap
// closes when part C extracts the writer — at which point this file should call
// it instead of describing it.
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

const M = {
  layers: await L('/src/world/save/worldLayers.ts'),
  spec: await L('/src/world/save/worldSpec.ts'),
  inputs: await L('/src/world/save/loadWorldInputs.ts'),
  key: await L('/src/world/identity.ts'),
  artifact: await L('/src/world/artifacts.ts'),
  memory: await L('/src/storage/MemoryArtifactStore.ts'),
  amplify: await L('/src/generator/surface/amplify.ts'),
  settings: await L('/src/world/bakeSettings.ts'),
  hydro: await L('/src/generator/surface/hydrology.ts'),
}
const JSZip = (await import(`${CLIENT}/node_modules/jszip/dist/jszip.min.js`)).default

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}

// --- 1. layer quantisation -------------------------------------------------
//
// Every layer is stored as u8/u16/f32 with a scale+offset the manifest carries,
// and a reader dequantises with nothing but those two numbers. So the property
// to hold is: bake then decode lands within half a step of the input, across the
// layer's whole declared range. A wrong scale shows up as clipping at the ends,
// which a mid-range spot check would miss entirely.
console.log('\n— layer quantisation —')
for (const spec of [...M.layers.WORLD_LAYERS, M.layers.DISCHARGE_LAYER]) {
  const steps = spec.dtype === 'u8' ? 256 : spec.dtype === 'u16' ? 65536 : 1024
  const top = spec.offset + spec.scale * (steps - 1)
  const n = 512
  const field = new Float32Array(n)
  for (let i = 0; i < n; i++) field[i] = spec.offset + ((top - spec.offset) * i) / (n - 1)
  const back = M.layers.decodeLayer(M.layers.bakeLayer(field, spec), spec)
  let worst = 0
  for (let i = 0; i < n; i++) {
    // landOnly layers reserve a sentinel for ocean; the top code is not a value.
    if (spec.landOnly && back[i] !== back[i]) continue
    worst = Math.max(worst, Math.abs(back[i] - field[i]))
  }
  const tolerance = spec.dtype === 'f32' ? 1e-6 : spec.scale * 0.5 + 1e-9
  check(`${spec.name} (${spec.dtype})`, worst <= tolerance, `worst ${worst.toExponential(3)} > ${tolerance.toExponential(3)}`)
}

// --- 2. the recipe -----------------------------------------------------------
//
// Two different things: that a spec survives being written and read (values), and
// that the FILE LAYOUT has not moved (bytes). The second matters because the
// layout is a format promise to every save already written.
console.log('\n— recipe round-trip —')
const values = {}
M.spec.WORLD_SPEC_FIELDS.forEach((f, i) => { values[f.path] = f.input.min + ((i * 7) % 5) * f.input.step })
const written = ['spec:', ...M.spec.specToYamlLines({ seed: 'räuber-öl', values })].join('\n')
const read = M.spec.specFromYaml(written, 'räuber-öl')
const mismatched = M.spec.WORLD_SPEC_FIELDS.filter((f) => read.values[f.path] !== values[f.path])
check(`${M.spec.WORLD_SPEC_FIELDS.length} fields survive write → read`, mismatched.length === 0,
  mismatched.slice(0, 3).map((f) => f.path).join(', '))

// A key the file does not carry must come back as its control's default — the
// contract that lets a save written before a knob existed still open.
const partial = M.spec.specFromYaml('spec:\n  genesis:\n    water: 12\n', 'x')
const waterField = M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'genesis.water')
const otherField = M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'erosion.landscapeAge')
check('a missing key falls back to its declared default',
  partial.values['genesis.water'] === 12 && partial.values['erosion.landscapeAge'] === otherField.input.default,
  `water=${partial.values['genesis.water']} landscapeAge=${partial.values['erosion.landscapeAge']} (want ${waterField ? 12 : '?'}/${otherField.input.default})`)

// A key the file DOES carry but the spec no longer knows must be ignored, not
// crash or leak: riverDensity left the spec with erosion-v2 P4, and every save
// written before that carries it.
const legacy = M.spec.specFromYaml('spec:\n  genesis:\n    water: 12\n  hydrology:\n    riverDensity: 70\n', 'x')
check('a retired key in an old save is simply ignored',
  legacy.values['genesis.water'] === 12 && legacy.values['hydrology.riverDensity'] === undefined,
  `riverDensity=${legacy.values['hydrology.riverDensity']}`)

// Layout lock: indentation, nesting depth and field order, on the defaults.
const defaults = {}
for (const f of M.spec.WORLD_SPEC_FIELDS) defaults[f.path] = f.input.default
const layout = M.spec.specToYamlLines({ seed: 's', values: defaults })
check('layout: nesting and order unchanged',
  layout[0] === '  seed: "s"' && layout[1] === '  genesis:' && layout[2].startsWith('    ')
  && layout.some((l) => l === '    subsistence:') && layout.some((l) => l.startsWith('      arable: ')),
  layout.slice(0, 3).join(' | '))

// --- 3. identity -------------------------------------------------------------
//
// These two strings address every stored artifact, locally and on the server.
// deriveWorldId is FROZEN: it depends only on the bytes handed to it, so a change
// means the hash function moved and every cache entry in existence is orphaned.
console.log('\n— identity —')
const elev = new Float32Array(64 * 32)
for (let i = 0; i < elev.length; i++) elev[i] = Math.sin(i * 0.017) * 0.4
const precip = new Float32Array(16 * 8).fill(800)
// Re-frozen at the P5 teardown: v1's strength/refresh left the hash shape, a
// deliberate id break (ALGO v11 had already orphaned every older artifact).
const id = M.key.deriveWorldId({ elevation: elev, precipitation: precip, landscapeAge: 40, alluvium: 50, rockContrast: 50 })
check('deriveWorldId is stable for fixed bytes', id === '79f9328a6cf7c80c', `got ${id}`)
check('the id is a pure 16-hex hash (label dropped 2026-08-12)', /^[0-9a-f]{16}$/.test(id), id)

// Every constant the pipeline version LISTS must actually move it. This does not
// catch a constant that was never listed — that is the gap which let three
// values fall out of the amplification key (fixed 2026-08-09), and only reading
// the module catches it. What it does catch is a listed constant the hash skips.
const base = M.key.derivePipelineVersion(M.amplify.AMPLIFY_CONSTANTS)
const inert = Object.keys(M.amplify.AMPLIFY_CONSTANTS).filter((k) =>
  M.key.derivePipelineVersion({ ...M.amplify.AMPLIFY_CONSTANTS, [k]: M.amplify.AMPLIFY_CONSTANTS[k] + 1 }) === base)
check(`all ${Object.keys(M.amplify.AMPLIFY_CONSTANTS).length} listed constants move the pipeline version`,
  inert.length === 0, inert.join(', '))

// --- 4. the artifact store ---------------------------------------------------
console.log('\n— amplification artifact —')
const store = M.memory.createMemoryArtifactStore()
const key = { worldUid: 'test-uid', worldId: id, pipelineVersion: M.artifact.amplificationPipelineVersion(), stage: '2' }
const art = {
  elevation: Float32Array.from({ length: 40 }, (_, i) => -0.9 + (i / 39) * 1.8),
  width: 8, height: 5,
  riverPoints: Float32Array.from([1.5, 2.5, 3.5, 4.5, 10, 20]),
  riverLengths: Uint32Array.from([2, 1]),
}
// The feature graph rides in the artifact beside the rivers (phase 2): a
// two-reach toy, round-tripped through JSON + raw cells.
art.riverGraph = {
  width: 8, height: 5,
  nodes: [
    { id: 0, kind: 'source', cell: 9, x: 1.5, y: 1.5, body: -1, catchmentCells: 0 },
    { id: 1, kind: 'junction', cell: 18, x: 2.5, y: 2.5, body: -1, catchmentCells: 0 },
    { id: 2, kind: 'mouth', cell: 27, x: 3.5, y: 3.5, body: -1, catchmentCells: 7 },
  ],
  reaches: [
    { id: 0, kind: 'river', from: 0, to: 1, cellStart: 0, cellCount: 2, dischargeIn: 1, dischargeOut: 2, widthPx: 0.5, lengthKm: 11, dropM: 20, slope: 0.0018, sedimentM3: 0, bank: 3, order: 1 },
    { id: 1, kind: 'river', from: 1, to: 2, cellStart: 2, cellCount: 2, dischargeIn: 2, dischargeOut: 5, widthPx: 0.7, lengthKm: 11, dropM: 15, slope: 0.0014, sedimentM3: 4, bank: 3, order: 1 },
  ],
  cells: Int32Array.from([9, 18, 18, 27]),
  bodies: [],
}
const wrote = await M.artifact.writeAmplificationArtifact(store, key, art, 1234)
check('write reports success', wrote === true)
check('exists() finds it', await M.artifact.amplificationArtifactExists(store, key))
const back = await M.artifact.readAmplificationArtifact(store, key)
if (!back) check('read returns the entry', false)
else {
  let worst = 0
  for (let i = 0; i < art.elevation.length; i++) worst = Math.max(worst, Math.abs(back.artifact.elevation[i] - art.elevation[i]))
  // u16 over the -1..1 elevation range: 2/65535 per step, so half a step.
  check('elevation survives quantisation', worst <= 1 / 65535 + 1e-9, `worst ${worst.toExponential(3)}`)
  check('river points are exact', String(back.artifact.riverPoints) === String(art.riverPoints))
  check('river lengths are exact', String(back.artifact.riverLengths) === String(art.riverLengths))
  check('dimensions and bake cost survive', back.artifact.width === 8 && back.artifact.height === 5 && back.bakeMs === 1234)
  check('the river graph comes back whole', back.artifact.riverGraph !== null
    && JSON.stringify({ ...back.artifact.riverGraph, cells: undefined }) === JSON.stringify({ ...art.riverGraph, cells: undefined })
    && String(back.artifact.riverGraph.cells) === String(art.riverGraph.cells))
}

// The derived family (docs/decisions/derived-bake-tiers.md): the designated
// finest stage writes each coarser tier as a box-downsample of itself into
// the SAME entry, and the member read halves the dimensions and the river
// texel coordinates. A stage-2 write (above) must NOT gain family files.
{
  const finestKey = { ...key, stage: String(M.settings.AMPLIFY_FINEST_STAGE) }
  const fine = {
    elevation: Float32Array.from({ length: 8 * 4 }, (_, i) => Math.sin(i * 0.7) * 0.8),
    width: 8, height: 4,
    riverPoints: Float32Array.from([2, 2, 3]),
    riverLengths: Uint32Array.from([1]),
    lakeDepth: Float32Array.from({ length: 8 * 4 }, (_, i) => (i % 5 === 0 ? 0.1 : 0)),
  }
  check('a family is written only by the finest stage', (await M.artifact.readAmplificationArtifact(store, key, 2)) === null)
  await M.artifact.writeAmplificationArtifact(store, finestKey, fine, 99)
  const member = await M.artifact.readAmplificationArtifact(store, finestKey, 2)
  if (!member) check('the family member reads back', false)
  else {
    check('the member is half the finest resolution', member.artifact.width === 4 && member.artifact.height === 2)
    let worst = 0
    for (let gy = 0; gy < 2; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) sum += fine.elevation[(gy * 2 + dy) * 8 + gx * 2 + dx]
        worst = Math.max(worst, Math.abs(member.artifact.elevation[gy * 4 + gx] - sum / 4))
      }
    }
    check('the member is the box mean of the finest, to quantisation', worst <= 1 / 65535 + 1e-9, `worst ${worst.toExponential(3)}`)
    check('the member scales river texels and keeps the width', String(member.artifact.riverPoints) === String(Float32Array.from([1, 1, 3])))
    check('the member carries a lake layer at its own size', member.artifact.lakeDepth !== null && member.artifact.lakeDepth.length === 8)
  }
}

// --- 5. the zip reader -------------------------------------------------------
//
// readWorldInputs is the ONE reader the browser and the Node baker share, and it
// derives the artifact key itself so the two cannot disagree. The property that
// matters: the id it returns equals the id derived directly from the same bytes.
// If those ever drift, bakes are filed under a key nothing will ask for.
console.log('\n— zip reader —')
const W = 16, H = 8
const zipElev = new Float32Array(W * H)
for (let i = 0; i < zipElev.length; i++) zipElev[i] = Math.cos(i * 0.11) * 0.5
const precipSpec = M.layers.WORLD_LAYERS.find((s) => s.name === 'precipitation')
const zipPrecip = new Float32Array(W * H).fill(1200)
// The engine's forcing layers (erosion-v2 P3): raw f32, written by the save,
// consumed by the bake. U deliberately carries a negative (rift) value — the
// layer is signed, and a quantised range would have clipped it.
const zipUplift = new Float32Array(W * H)
const zipHardness = new Float32Array(W * H)
for (let i = 0; i < zipUplift.length; i++) {
  zipUplift[i] = Math.sin(i * 0.37) * 0.8
  zipHardness[i] = 1 + 0.4 * Math.cos(i * 0.21)
}
const forcingSpecs = Object.fromEntries(M.layers.FORCING_LAYERS.map((s) => [s.name, s]))

// The land-only climate layers, half ocean. Their -1 ocean sentinel does not
// survive quantisation (bakeLayer clamps it), so the reader has to put it back
// from landMask — see restoreLandOnlySentinel. A consumer that tells land from
// ocean by the sentinel (biomes.ts) otherwise classifies a fabricated 0.
const specOf = (name) => M.layers.WORLD_LAYERS.find((s) => s.name === name)
const isOcean = (i) => i % 2 === 1
const zipLandMask = new Float32Array(W * H)
const zipTemp = new Float32Array(W * H)
const zipPrecipEff = new Float32Array(W * H)
const zipAmplitude = new Float32Array(W * H)
const zipMonsoon = new Float32Array(W * H)
for (let i = 0; i < W * H; i++) {
  zipLandMask[i] = isOcean(i) ? 0 : 1
  zipTemp[i] = 12 + (i % 7)
  zipPrecipEff[i] = isOcean(i) ? -1 : 900 + i
  zipAmplitude[i] = isOcean(i) ? -1 : 8 + (i % 5)
  zipMonsoon[i] = isOcean(i) ? -1 : (i % 9) / 10 - 0.4 // both signs, since the index is signed
}
const zip = new JSZip()
zip.file('world.yaml', ['spec:', `  seed: "zip-welt"`, '  erosion:', '    landscapeAge: 25', '    alluvium: 60', '    rockContrast: 35', 'metadata:', '  uid: 0192abcd-0000-8000-8000-000000000000', ''].join('\n'))
zip.file('layers/elevation.f32', zipElev.buffer)
zip.file('layers/precipitation.u16', M.layers.bakeLayer(zipPrecip, precipSpec))
zip.file('layers/uplift.f32', M.layers.bakeLayer(zipUplift, forcingSpecs.uplift))
zip.file('layers/erodibility.f32', M.layers.bakeLayer(zipHardness, forcingSpecs.erodibility))
for (const [name, field] of [['landMask', zipLandMask], ['temperature', zipTemp], ['precipitationEffective', zipPrecipEff], ['seasonalAmplitude', zipAmplitude], ['monsoonIndex', zipMonsoon]]) {
  zip.file(`layers/${name}.bin`, M.layers.bakeLayer(field, specOf(name)))
}
// The standing-water list (phase 1 of the adaptive-mesh plan): a JSON table
// beside the rasters, formatVersion 2. One lake and one dry basin, in texel
// coordinates of this zip's raster.
const zipBodies = [
  { id: 0, kind: 'lake', level: 0.21, spill: 0.21, floor: 0.17, seedX: 3.5, seedY: 2.5, outletX: 4.5, outletY: 2.5, cells: 3, frozen: false },
  { id: 1, kind: 'dry', level: -0.05, spill: 0.02, floor: -0.05, seedX: 9.5, seedY: 5.5, outletX: 9.5, outletY: 4.5, cells: 2, frozen: false },
]
zip.file('layers/waterBodies.json', JSON.stringify(zipBodies))
zip.file('manifest.json', JSON.stringify({
  formatVersion: 2,
  world: { width: W, height: H, topology: 'torus' },
  layers: [
    { name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' },
    { name: 'elevation', file: 'layers/elevation.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    { name: 'precipitation', file: 'layers/precipitation.u16', kind: 'raster', resX: W, resY: H, dtype: precipSpec.dtype, encoding: { scale: precipSpec.scale, offset: precipSpec.offset } },
    { name: 'uplift', file: 'layers/uplift.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    { name: 'erodibility', file: 'layers/erodibility.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    ...['landMask', 'temperature', 'precipitationEffective', 'seasonalAmplitude', 'monsoonIndex'].map((name) => {
      const spec = specOf(name)
      return { name, file: `layers/${name}.bin`, kind: 'raster', resX: W, resY: H, dtype: spec.dtype, encoding: { scale: spec.scale, offset: spec.offset } }
    }),
  ],
}))
const loaded = await M.inputs.readWorldInputs(await zip.generateAsync({ type: 'arraybuffer' }))
if (!loaded) check('the zip reads back at all', false)
else {
  check('elevation comes back byte-identical', String(loaded.elevations) === String(zipElev))
  check('the recipe is read', loaded.seedText === 'zip-welt' && loaded.erosionControls.landscapeAge === 25 && loaded.erosionControls.alluvium === 60 && loaded.erosionControls.rockContrast === 35)
  check('the uid is read rather than derived', loaded.worldUid === '0192abcd-0000-8000-8000-000000000000')
  check('the water-body table comes back as written', JSON.stringify(loaded.waterBodies) === JSON.stringify(zipBodies))
  check('the forcing layers come back byte-identical, sign included',
    String(loaded.uplift?.data) === String(zipUplift) && String(loaded.erodibility?.data) === String(zipHardness))
  // The lithology seed is DERIVED (like detailSeed), so every reader of one
  // seed text must land on one lattice.
  check('the lithology seed is derived from the recipe', Number.isInteger(loaded.lithoSeed) && loaded.lithoSeed >>> 0 === loaded.lithoSeed)
  // The reader must reach the SAME id as deriving it here by hand — and it must
  // hash the STORED (dequantised) precipitation, never a raw float array.
  const direct = M.key.deriveWorldId({
    elevation: loaded.elevations, precipitation: loaded.climate?.data ?? null, landscapeAge: 25, alluvium: 60, rockContrast: 35,
  })
  check('reader and direct derivation agree on the worldId', loaded.worldId === direct, `${loaded.worldId} vs ${direct}`)

  // The land-only climate layers carry their ocean sentinel again.
  const bi = loaded.biomeInputs
  const oceanCells = (f) => { let n = 0; for (let i = 0; i < f.length; i++) if (isOcean(i) && f[i] === -1) n++; return n }
  const half = (W * H) / 2
  check('a land-only layer says -1 over ocean again', bi !== null
    && oceanCells(bi.precipitationEffective.data) === half
    && oceanCells(bi.seasonalAmplitude.data) === half
    && oceanCells(bi.monsoonIndex.data) === half)
  // Land must be untouched by the restoration, to the layer's own precision.
  const landOff = (f, want, tol) => { let m = 0; for (let i = 0; i < f.length; i++) if (!isOcean(i)) m = Math.max(m, Math.abs(f[i] - want[i])); return m <= tol }
  check('the land values are left alone', bi !== null
    && landOff(bi.precipitationEffective.data, zipPrecipEff, 0.2)
    && landOff(bi.seasonalAmplitude.data, zipAmplitude, 0.2)
    && landOff(bi.monsoonIndex.data, zipMonsoon, 0.01))
  // Temperature is NOT land-only — it means something over water and keeps it.
  check('temperature is not masked', bi !== null && bi.temperature.data[1] > 0)
  // The signed monsoon index has to survive the round trip as a sign, which is
  // what the -1 offset in its encoding is for.
  check('the monsoon index keeps its sign', bi !== null
    && [...bi.monsoonIndex.data].some((v, i) => !isOcean(i) && v < -0.05)
    && [...bi.monsoonIndex.data].some((v, i) => !isOcean(i) && v > 0.05))
}

// The lake layer derives from the list and the terrain: a bowl in a synthetic
// raster, one body at its spill, and lakeDepthFromBodies must find exactly the
// bowl — wet below the level, dry at the pour point, nothing beyond it.
{
  const bw = 12, bh = 6
  const bowl = new Float32Array(bw * bh).fill(0.3)
  const inBowl = (x, y) => x >= 3 && x <= 6 && y >= 2 && y <= 3
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (inBowl(x, y)) bowl[y * bw + x] = 0.1 + 0.02 * (x - 3)
  bowl[2 * bw + 7] = 0.2 // the pour point: at the spill, not below it
  bowl[2 * bw + 8] = 0.05 // the valley beyond it, lower than the lake
  const body = { id: 0, kind: 'lake', level: 0.2, spill: 0.2, floor: 0.1, seedX: 3.5, seedY: 2.5, outletX: 6.5, outletY: 2.5, cells: 8, frozen: false }
  const depth = M.hydro.lakeDepthFromBodies([body], bowl, bw, bh)
  let wet = 0, leaked = false
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const d = depth[y * bw + x]
    if (d > 0) wet++
    if (d > 0 && !inBowl(x, y)) leaked = true
  }
  check('the derived lake fills its bowl and stops at the pour point', wet === 8 && !leaked, `${wet} wet, leaked ${leaked}`)
  check('the derived depth is level minus terrain', Math.abs(depth[2 * bw + 3] - 0.1) < 1e-6)
  const field = M.hydro.waterLevelField([body], bowl, bw, bh)
  const near = (a, b) => Math.abs(a - b) < 1e-6
  check('the level field carries the level onto the rim', near(field.level[2 * bw + 7], 0.2) && near(field.level[1 * bw + 3], 0.2) && field.level[0] === 0 && field.level[2 * bw + 8] === 0)
}

// A zip that is not a world must be refused, not half-read.
check('a zip without a manifest is refused', (await M.inputs.readWorldInputs(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'arraybuffer' }))) === null)

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

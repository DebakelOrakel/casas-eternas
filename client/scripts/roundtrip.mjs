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
  amplify: await L('/src/worldgen/surface/amplify.ts'),
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
const otherField = M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'hydrology.riverDensity')
check('a missing key falls back to its declared default',
  partial.values['genesis.water'] === 12 && partial.values['hydrology.riverDensity'] === otherField.input.default,
  `water=${partial.values['genesis.water']} riverDensity=${partial.values['hydrology.riverDensity']} (want ${waterField ? 12 : '?'}/${otherField.input.default})`)

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
const id = M.key.deriveWorldId({ elevation: elev, precipitation: precip, erosionStrength: 2, drainageRefresh: 3 })
check('deriveWorldId is stable for fixed bytes', id === 'ba90bda173d581ef', `got ${id}`)
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
const wrote = await M.artifact.writeAmplificationArtifact(store, key, art, 1234, 55)
check('write reports success', wrote === true)
check('exists() finds it', await M.artifact.amplificationArtifactExists(store, key, 55))
check('exists() does NOT find another density', (await M.artifact.amplificationArtifactExists(store, key, 90)) === false)
const back = await M.artifact.readAmplificationArtifact(store, key, 55)
if (!back) check('read returns the entry', false)
else {
  let worst = 0
  for (let i = 0; i < art.elevation.length; i++) worst = Math.max(worst, Math.abs(back.artifact.elevation[i] - art.elevation[i]))
  // u16 over the -1..1 elevation range: 2/65535 per step, so half a step.
  check('elevation survives quantisation', worst <= 1 / 65535 + 1e-9, `worst ${worst.toExponential(3)}`)
  check('river points are exact', String(back.artifact.riverPoints) === String(art.riverPoints))
  check('river lengths are exact', String(back.artifact.riverLengths) === String(art.riverLengths))
  check('dimensions and bake cost survive', back.artifact.width === 8 && back.artifact.height === 5 && back.bakeMs === 1234)
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
const zip = new JSZip()
zip.file('world.yaml', ['spec:', `  seed: "zip-welt"`, '  erosion:', '    erosionStrength: 4', '    drainageRefresh: 1', 'metadata:', '  uid: 0192abcd-0000-8000-8000-000000000000', ''].join('\n'))
zip.file('layers/elevation.f32', zipElev.buffer)
zip.file('layers/precipitation.u16', M.layers.bakeLayer(zipPrecip, precipSpec))
zip.file('manifest.json', JSON.stringify({
  world: { width: W, height: H, topology: 'torus' },
  layers: [
    { name: 'elevation', file: 'layers/elevation.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    { name: 'precipitation', file: 'layers/precipitation.u16', kind: 'raster', resX: W, resY: H, dtype: precipSpec.dtype, encoding: { scale: precipSpec.scale, offset: precipSpec.offset } },
  ],
}))
const loaded = await M.inputs.readWorldInputs(await zip.generateAsync({ type: 'arraybuffer' }))
if (!loaded) check('the zip reads back at all', false)
else {
  check('elevation comes back byte-identical', String(loaded.elevations) === String(zipElev))
  check('the recipe is read', loaded.seedText === 'zip-welt' && loaded.erosionControls.strength === 4 && loaded.erosionControls.refresh === 1)
  check('the uid is read rather than derived', loaded.worldUid === '0192abcd-0000-8000-8000-000000000000')
  // The reader must reach the SAME id as deriving it here by hand — and it must
  // hash the STORED (dequantised) precipitation, never a raw float array.
  const direct = M.key.deriveWorldId({
    elevation: loaded.elevations, precipitation: loaded.climate?.data ?? null, erosionStrength: 4, drainageRefresh: 1,
  })
  check('reader and direct derivation agree on the worldId', loaded.worldId === direct, `${loaded.worldId} vs ${direct}`)
}

// A zip that is not a world must be refused, not half-read.
check('a zip without a manifest is refused', (await M.inputs.readWorldInputs(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'arraybuffer' }))) === null)

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

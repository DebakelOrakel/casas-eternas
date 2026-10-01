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
// The zip ASSEMBLY is covered since 2026-10-01, when the writer left the
// generator screen for world/save/worldArchive.ts: section 5b writes an
// archive with it and reads it back. Section 5 keeps a hand-built archive in
// an older format, for the reader's sake.
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
  memory: await L('/src/storage/MemoryArtifactStore.ts'),
  amplify: await L('/src/generator/surface/amplify.ts'),
  hydro: await L('/src/generator/surface/hydrology.ts'),
  history: await L('/src/world/save/worldHistory.ts'),
  refined: await L('/src/world/save/refinedLayers.ts'),
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
const otherField = M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'tectonics.alluvium')
check('a missing key falls back to its declared default',
  partial.values['genesis.water'] === 12 && partial.values['tectonics.alluvium'] === otherField.input.default,
  `water=${partial.values['genesis.water']} alluvium=${partial.values['tectonics.alluvium']} (want ${waterField ? 12 : '?'}/${otherField.input.default})`)
// A control that moved stage (the temperature offset as the Planet's
// greenhouse; the water, back with the genesis after a day on the planet)
// reads its old path when the new one is absent, and the new one wins when
// both are there.
const moved = M.spec.specFromYaml('spec:\n  planet:\n    water: 33\n  climate:\n    tempOffset: -4\n', 'x')
const both = M.spec.specFromYaml('spec:\n  planet:\n    water: 41\n  genesis:\n    water: 33\n', 'x')
check('a moved control reads its legacy path', moved.values['genesis.water'] === 33 && moved.values['planet.greenhouse'] === -4, `water=${moved.values['genesis.water']} greenhouse=${moved.values['planet.greenhouse']}`)
// The erosion's material controls moved to the tectonics with the coupled
// history (phase 5.1): a save from before reads them from their old place.
const movedErosion = M.spec.specFromYaml('spec:\n  erosion:\n    alluvium: 70\n    rockContrast: 20\n', 'x')
check('the erosion controls read their legacy paths', movedErosion.values['tectonics.alluvium'] === 70 && movedErosion.values['tectonics.rockContrast'] === 20, `alluvium=${movedErosion.values['tectonics.alluvium']} rockContrast=${movedErosion.values['tectonics.rockContrast']}`)
check('the current path wins over the legacy one', both.values['genesis.water'] === 33)

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
// The Planet stage opens the recipe since 2026-09-22 (F2), genesis follows it.
check('layout: nesting and order unchanged',
  layout[0] === '  seed: "s"' && layout[1] === '  planet:' && layout[2].startsWith('    ') && layout.some((l) => l === '  genesis:')
  && layout.some((l) => l === '    subsistence:') && layout.some((l) => l.startsWith('      arable: ')),
  layout.slice(0, 3).join(' | '))

// --- 2b. the run history -----------------------------------------------------
//
// The block that says which values each run had (worldHistory.ts): it goes
// round through the same dotted-path reader as the spec, so numbered maps
// stand in for lists, and a save without the block reads as no runs.
console.log('\n— run history —')
{
  const H = M.history
  const genesisValues = H.runValues(H.GENESIS_RUN_FIELDS, values)
  const tectonicsValues = H.runValues(H.TECTONICS_RUN_FIELDS, values)
  const history = H.emptyWorldHistory()
  H.openRun(history.genesis, genesisValues, 'build-a')
  H.tallyRun(history.genesis, 120, genesisValues, 'build-a')
  H.openRun(history.tectonics, tectonicsValues, 'build-a')
  H.tallyRun(history.tectonics, 45, tectonicsValues, 'build-a')
  // The same values again extend the run; changed values open the next one.
  H.openRun(history.tectonics, tectonicsValues, 'build-a')
  H.tallyRun(history.tectonics, 5, tectonicsValues, 'build-a')
  const changed = { ...tectonicsValues, 'tectonics.alluvium': tectonicsValues['tectonics.alluvium'] + 1 }
  H.openRun(history.tectonics, changed, 'build-a')
  H.tallyRun(history.tectonics, 12, changed, 'build-a')
  check('a run with the same values extends the entry', history.tectonics.length === 2 && history.tectonics[0].epochs === 50, JSON.stringify(history.tectonics.map((r) => r.epochs)))
  // A new build opens a run too — the seam between two generators is data.
  H.openRun(history.tectonics, changed, 'build-b')
  check('a new build opens a run of its own', history.tectonics.length === 3 && history.tectonics[2].generator === 'build-b')
  const yaml = ['spec:', ...M.spec.specToYamlLines({ seed: 's', values }), 'status:', '  erosionRun: 1', ...H.historyToYamlLines(history)].join('\n')
  const back = H.historyFromYaml(yaml)
  const same = JSON.stringify(back) === JSON.stringify(history)
  check('the history survives write → read', same, same ? '' : JSON.stringify(back).slice(0, 200))
  check('a save without the block has no runs', H.historyFromYaml(yaml.slice(0, yaml.indexOf('history:'))).tectonics.length === 0)
  check('nothing run writes no block', H.historyToYamlLines(H.emptyWorldHistory()).length === 0)
  // A control added after the run was written reads as its default, as in the spec.
  const older = H.historyFromYaml('history:\n  tectonics:\n    0:\n      epochs: 3\n      generator: x\n      values:\n        tectonics:\n          alluvium: 70\n')
  check('a value the run did not record reads as the default', older.tectonics[0].values['tectonics.alluvium'] === 70 && older.tectonics[0].values['climate.humidity'] === M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'climate.humidity').input.default)
}

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
// The snapshot (phase 5.8): a save that carries the mesh is identified by
// the mesh's bytes too — a different column under the same rasterisation is
// a different world; a save without one keeps the raster id above.
{
  const nodes = new Float32Array([1, 2, 3, 4]), z = new Float32Array([0.1, 0.2])
  const withMesh = M.key.deriveWorldId({ elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z } })
  const withColumn = M.key.deriveWorldId({ elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z, column: new Uint8Array([1, 0, 0, 0]) } })
  const otherColumn = M.key.deriveWorldId({ elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z, column: new Uint8Array([2, 0, 0, 0]) } })
  check('a mesh enters the identity', withMesh !== M.key.deriveWorldId({ elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50 }))
  check('the column enters the identity', withColumn !== withMesh && withColumn !== otherColumn)
}
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
// The raster amplification artifact's round trip lived here until it went
// (2026-09-29); the level artifact's is harness:mesh's (`the artifact reads
// back identical`).

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

// The climate step's refinement (formatVersion 6): taken apart into its
// per-month layers, quantised, decoded and put back, every value within half
// a step of its layer, and the wind back in model units.
{
  const n = 8 * 4
  const months = 12
  const rnd = (i) => Math.sin(i * 12.9898) * 0.5 + 0.5
  // Every third cell is sea: its rain is the OCEAN_PRECIP mark (−1).
  const sea = (i) => i % 3 === 0
  const r = {
    months,
    temperature: Float32Array.from({ length: months * n }, (_, i) => (rnd(i + 11) - 0.5) * 80),
    precipitation: Float32Array.from({ length: months * n }, (_, i) => (sea(i % n) ? -1 : 3000 * rnd(i + 13))),
    pressure: Float32Array.from({ length: months * n }, (_, i) => 995 + 30 * rnd(i)),
    wind: Float32Array.from({ length: months * n * 2 }, (_, i) => (rnd(i + 7) - 0.5) * 3),
    currents: Float32Array.from({ length: n * 2 }, (_, i) => rnd(i + 3) * 2 - 1),
    currentAnomaly: Float32Array.from({ length: n }, (_, i) => (rnd(i + 5) - 0.5) * 12),
    upwelling: Float32Array.from({ length: n }, (_, i) => (rnd(i + 9) - 0.3) * 6),
    salinity: Float32Array.from({ length: n }, (_, i) => 30 + 9 * rnd(i + 37)),
    deepWater: Float32Array.from({ length: n }, (_, i) => rnd(i + 41)),
    fog: Float32Array.from({ length: n }, (_, i) => rnd(i + 17)),
    foehn: Float32Array.from({ length: n }, (_, i) => rnd(i + 19) * 0.3),
    reliability: {
      rainVariability: Float32Array.from({ length: n }, (_, i) => rnd(i + 23) * 0.6),
      ensoPattern: Float32Array.from({ length: n }, (_, i) => rnd(i + 29) * 2 - 1),
      ensoPeriodYears: 4.5,
      ensoStrength: 0.3,
    },
    storms: Object.fromEntries(['cyclone', 'tornado', 'blizzard', 'dust', 'thunder'].map((k, j) => [k, Float32Array.from({ length: n }, (_, i) => rnd(i + 31 + j))])),
  }
  const sources = M.refined.refinedLayerSources(r, n)
  const decoded = new Map()
  for (const spec of M.layers.REFINED_LAYERS) decoded.set(spec.name, M.layers.decodeLayer(M.layers.bakeLayer(sources.get(spec.name), spec), spec))
  decoded.set('landMask', Float32Array.from({ length: n }, (_, i) => (sea(i) ? 0 : 1)))
  check('every refinement layer has a source', M.layers.REFINED_LAYERS.every((spec) => sources.has(spec.name)))
  const back = M.refined.refinedFromLayers((name) => decoded.get(name) ?? null, n)
  const ms = 8
  const worst = (a, b, tol) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - b[i]) / tol); return w }
  const stepOf = (name) => M.layers.REFINED_LAYERS.find((l) => l.name === name).scale
  const within = back !== null
    && worst(r.temperature, back.temperature, stepOf('temperature.01')) <= 0.51
    && worst(r.precipitation, back.precipitation, stepOf('precipitation.01')) <= 0.51
    && worst(r.pressure, back.pressure, stepOf('pressure.01')) <= 0.51
    && worst(r.wind, back.wind, stepOf('windU.01') / ms) <= 0.51
    && worst(r.currents, back.currents, stepOf('currentU')) <= 0.51
    && worst(r.currentAnomaly, back.currentAnomaly, stepOf('currentAnomaly')) <= 0.51
    && worst(r.upwelling, back.upwelling, stepOf('upwelling')) <= 0.51
    && worst(r.fog, back.fog, stepOf('fog')) <= 0.51
    && worst(r.salinity, back.salinity, stepOf('salinity')) <= 0.51
    && worst(r.deepWater, back.deepWater, stepOf('deepWater')) <= 0.51
    && worst(r.foehn, back.foehn, stepOf('foehn')) <= 0.51
    && ['cyclone', 'tornado', 'blizzard', 'dust', 'thunder'].every((k) => worst(r.storms[k], back.storms[k], stepOf(k)) <= 0.51)
  check('the refinement survives the save within half a step', within)
  decoded.delete('upwelling')
  check('a refinement with a layer missing is not one', M.refined.refinedFromLayers((name) => decoded.get(name) ?? null, n) === null)
}

// --- 5b. the zip writer ------------------------------------------------------
//
// The real writer (world/save/worldArchive.ts, out of the generator screen
// since 2026-10-01), read back by the real reader: what the screen saves is
// what a reader finds. The archive above is hand-built in an older format;
// this one is the current format, as written.
console.log('\n— zip writer —')
{
  const writer = await L('/src/world/save/worldArchive.ts')
  const query = await L('/src/world/query.ts')
  const { OCEAN_PRECIP } = await L('/src/generator/climate/precipitation.ts')
  const precipitation = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) precipitation[i] = isOcean(i) ? OCEAN_PRECIP : 600 + i
  const meshZ = new Float32Array([0.1, 0.2, 0.3])
  const yaml = ['spec:', '  seed: "writer-welt"', '  erosion:', '    landscapeAge: 30', '    alluvium: 40', '    rockContrast: 55', 'metadata:', '  uid: 0192abcd-0000-8000-8000-00000000beef', ''].join('\n')
  const written = await writer.writeWorldArchive({
    kind: 'tectonic', width: W, height: H, yaml, generatorVersion: 'roundtrip', preview: null, elevation: zipElev.buffer.slice(0),
    snapshot: { epoch: 3 }, mantle: new ArrayBuffer(8), latticeAccumulated: new ArrayBuffer(4), latticeLockedEpochs: new ArrayBuffer(2),
    latticeLastClassCode: new ArrayBuffer(1), oceanAge: new ArrayBuffer(4),
    forcing: { uplift: zipUplift, erodibility: zipHardness, resX: W, resY: H },
    mesh: { count: 3, nodes: new Float32Array([1, 1, 5, 2, 9, 6]).buffer, connectivity: new Uint8Array([7, 8, 9]).buffer, z: meshZ.buffer.slice(0) },
    fields: {
      climateResX: W, climateResY: H, temperature: zipTemp, precipitation, precipitationEffective: zipPrecipEff, biome: null,
      seasonalAmplitude: zipAmplitude, monsoonIndex: zipMonsoon, koppen: null, lakeDepth: null, waterTable: null, dischargeM3s: null,
      refined: null, waterBodies: zipBodies, coast: null, sedimentBasins: null,
    },
  })
  const manifest = JSON.parse(await (await JSZip.loadAsync(written)).file('manifest.json').async('string'))
  check('the writer stamps the current format version', manifest.formatVersion === writer.WORLD_ARCHIVE_FORMAT_VERSION)
  const back = await M.inputs.readWorldInputs(written)
  if (!back) check('the written archive reads back at all', false)
  else {
    check('the written elevation comes back byte-identical', String(back.elevations) === String(zipElev))
    check('the written recipe is read', back.seedText === 'writer-welt' && back.erosionControls.alluvium === 40 && back.worldUid === '0192abcd-0000-8000-8000-00000000beef')
    check('the written forcing comes back byte-identical', String(back.uplift?.data) === String(zipUplift) && String(back.erodibility?.data) === String(zipHardness))
    check('the written water bodies come back', JSON.stringify(back.waterBodies) === JSON.stringify(zipBodies))
    // The rain over land within half a step; the land mask the writer
    // derives from it puts the ocean sentinel back into the land-only
    // layers (the rain itself carries none — loadWorldInputs).
    const p = back.climate?.data
    let landOk = !!p
    for (let i = 0; p && i < W * H; i++) if (!isOcean(i)) landOk &&= Math.abs(p[i] - precipitation[i]) <= precipSpec.scale / 2 + 1e-6
    check('the written rain comes back within half a step over land', landOk)
    const eff = back.biomeInputs?.precipitationEffective.data
    let oceanOk = !!eff
    for (let i = 0; eff && i < W * H; i++) oceanOk &&= isOcean(i) ? eff[i] === OCEAN_PRECIP : eff[i] !== OCEAN_PRECIP
    check('the land mask the writer derives marks the ocean again', oceanOk)
    const savedMesh = await (await query.openWorld(written)).mesh()
    check('the written mesh comes back as written', savedMesh !== null && savedMesh.count === 3 && String(savedMesh.z) === String(meshZ) && String(savedMesh.connectivity) === '7,8,9')
  }
}

// A zip that is not a world must be refused, not half-read.
check('a zip without a manifest is refused', (await M.inputs.readWorldInputs(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'arraybuffer' }))) === null)

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

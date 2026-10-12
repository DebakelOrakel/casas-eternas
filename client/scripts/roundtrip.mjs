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
  domain: await L('/src/generator/core/domain.ts'),
  history: await L('/src/world/save/worldHistory.ts'),
  refined: await L('/src/world/save/refinedFields.ts'),
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
for (const spec of M.layers.WORLD_LAYERS) {
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
  // The code hash is the replay's key: another code opens a run, and a run
  // on a loaded world opens one marked `restored` even with nothing changed.
  H.openRun(history.tectonics, changed, 'build-b', 'code-2')
  H.tallyRun(history.tectonics, 4, changed, 'build-b', 'code-2')
  H.openRun(history.tectonics, changed, 'build-b', 'code-2', true)
  H.tallyRun(history.tectonics, 2, changed, 'build-b', 'code-2')
  check('another code opens a run, a load opens a marked one', history.tectonics.length === 5 && history.tectonics[3].code === 'code-2' && !history.tectonics[3].restored && history.tectonics[4].restored === true)
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

// --- 2c. the world record ----------------------------------------------------
// world/worldRecord.ts: what world.yaml says of a world, as one value. Written
// and read back it must be the same record, and compare as unchanged — the
// title bar's "unsaved" is this comparison.
{
  const WR = await L('/src/world/worldRecord.ts')
  const WH = await L('/src/world/save/worldHistory.ts')
  const values = Object.fromEntries(M.spec.WORLD_SPEC_FIELDS.map((f, i) => [f.path, f.input.min + ((i * 7) % 5) * ((f.input.max - f.input.min) / 5)]))
  const run = (fields, epochs, extra = {}) => ({ epochs, generator: 'abc1234', code: 'deadbeefdeadbeef', values: WH.runValues(fields, values), ...extra })
  const record = {
    kind: 'FlatWorld',
    uid: '0f8e5c1a-7b2d-4c3e-9a1f-123456789abc', name: 'Calvessor', revision: 7,
    spec: { seed: '983721401', values },
    history: { genesis: [run(WH.GENESIS_RUN_FIELDS, 41)], tectonics: [run(WH.TECTONICS_RUN_FIELDS, 30), run(WH.TECTONICS_RUN_FIELDS, 12, { restored: true })] },
    archeanEpochs: 41, epoch: 42, erosionRun: 42, progress: 'climate',
  }
  const yaml = WR.recordToYaml(record, 'abc1234')
  const back = WR.recordFromYaml(yaml, { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('a world record survives world.yaml unchanged', JSON.stringify(back) === JSON.stringify(record), WR.recordDiff(record, back).join('; '))
  check('and compares as unchanged', WR.recordSignature(back) === WR.recordSignature(record))
  const renamed = { ...record, name: 'Other' }
  check('a rename reads as a change, by name', WR.recordDiff(record, renamed).length === 1 && WR.recordDiff(record, renamed)[0].startsWith('name:'))
  const legacy = WR.recordFromYaml(yaml.replace(/  uid: .*\n/, '').replace(/  name: .*\n/, ''), { archeanEpochs: 0, epoch: 0 }, () => 'derived-uid')
  check('a save without uid or name takes the derived uid and the seed as its name', legacy.uid === 'derived-uid' && legacy.name === '983721401', `${legacy.uid} ${legacy.name}`)
  // The kind is the shape (DEC-0035): read back as written, and a kind this
  // client does not know — the first saves' `World` included — refused.
  const sphere = WR.recordFromYaml(WR.recordToYaml({ ...record, kind: 'SphereWorld' }, 'abc1234'), { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('the kind survives world.yaml', sphere.kind === 'SphereWorld' && back.kind === 'FlatWorld')
  let refused = 0
  for (const kind of ['World', 'MarsWorld', null]) {
    const text = kind ? yaml.replace('kind: FlatWorld', `kind: ${kind}`) : yaml.replace('kind: FlatWorld\n', '')
    try { WR.recordFromYaml(text, { archeanEpochs: 0, epoch: 0 }, () => 'x') } catch { refused++ }
  }
  // The progress (world/worldProgress.ts) is documentation: it reads back,
  // a save without one (or with a step this client does not know) has
  // none, and it is not part of the "unchanged" comparison.
  const unstarted = WR.recordFromYaml(WR.recordToYaml({ ...record, progress: null }, 'abc1234'), { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  const unknownStep = WR.recordFromYaml(yaml.replace('progress: climate', 'progress: weaving'), { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('the progress survives world.yaml, and none or an unknown step reads as none', back.progress === 'climate' && unstarted.progress === null && unknownStep.progress === null && !WR.recordToYaml({ ...record, progress: null }, 'x').includes('progress:'))
  // The rule that sets it: a move forward accepts every step before the one
  // it enters, a move back changes nothing, and it never goes down.
  const WP = await L('/src/world/worldProgress.ts')
  const order = [...WP.PROGRESS_STEPS, 'migration']
  const moves = [[0, 1], [1, 0], [1, 2], [2, 4], [4, 2], [2, 3], [5, 6]]
  const walked = []
  let progress = null
  for (const [from, to] of moves) walked.push(progress = WP.advanceProgress(progress, order, from, to))
  check('progress follows the forward moves only', walked.join(',') === 'world,world,genesis,climate,climate,climate,finishing', walked.join(','))
  check('a reset withdraws its step and the steps after it, not those before', WP.withdrawProgress('ecology', 'tectonics') === 'genesis' && WP.withdrawProgress('ecology', 'ecology') === 'climate' && WP.withdrawProgress('genesis', 'world') === null && WP.withdrawProgress('genesis', 'ecology') === 'genesis' && WP.withdrawProgress('climate', 'migration') === 'climate' && WP.withdrawProgress(null, 'genesis') === null)
  check('and counts on the chain without the aside', JSON.stringify(WP.progressPosition('genesis')) === '{"n":2,"all":6,"done":false}' && WP.progressPosition('finishing').done && WP.progressPosition(null) === null)
  check('a new progress reads as a change, by name', WR.recordDiff(record, { ...record, progress: 'finishing' }).some((d) => d.startsWith('progress:')))
  check('an unknown or missing kind is refused', refused === 3 && WR.worldKindOf(yaml) === 'FlatWorld', `${refused} of 3`)
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
// Re-frozen 2026-10-10: the save's kind entered the hash (DEC-0035), a
// deliberate break for every world saved before.
const id = M.key.deriveWorldId({ kind: 'FlatWorld', elevation: elev, precipitation: precip, landscapeAge: 40, alluvium: 50, rockContrast: 50 })
check('deriveWorldId is stable for fixed bytes', id === '4086cd3b4e2075bf', `got ${id}`)
check('the kind enters the identity', id !== M.key.deriveWorldId({ kind: 'SphereWorld', elevation: elev, precipitation: precip, landscapeAge: 40, alluvium: 50, rockContrast: 50 }))
// The snapshot (phase 5.8): a save that carries the mesh is identified by
// the mesh's bytes too — a different column under the same rasterisation is
// a different world; a save without one keeps the raster id above.
{
  const nodes = new Float32Array([1, 2, 3, 4]), z = new Float32Array([0.1, 0.2])
  const withMesh = M.key.deriveWorldId({ kind: 'FlatWorld', elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z } })
  const withColumn = M.key.deriveWorldId({ kind: 'FlatWorld', elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z, column: new Uint8Array([1, 0, 0, 0]) } })
  const otherColumn = M.key.deriveWorldId({ kind: 'FlatWorld', elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50, mesh: { nodes, z, column: new Uint8Array([2, 0, 0, 0]) } })
  check('a mesh enters the identity', withMesh !== M.key.deriveWorldId({ kind: 'FlatWorld', elevation: elev, precipitation: precip, alluvium: 50, rockContrast: 50 }))
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
const isOcean = (i) => i % 2 === 1
const zip = new JSZip()
zip.file('world.yaml', ['kind: FlatWorld', 'spec:', `  seed: "zip-welt"`, '  erosion:', '    landscapeAge: 25', '    alluvium: 60', '    rockContrast: 35', 'metadata:', '  uid: 0192abcd-0000-8000-8000-000000000000', ''].join('\n'))
zip.file('layers/elevation.f32', zipElev.buffer)
zip.file('layers/uplift.f32', M.layers.bakeLayer(zipUplift, forcingSpecs.uplift))
zip.file('layers/erodibility.f32', M.layers.bakeLayer(zipHardness, forcingSpecs.erodibility))
// The standing-water list (phase 1 of the adaptive-mesh plan): a JSON table
// beside the rasters, formatVersion 2. One lake and one dry basin, in texel
// coordinates of this zip's raster.
const zipBodies = [
  { id: 0, kind: 'lake', level: 0.21, spill: 0.21, floor: 0.17, seedX: 3.5, seedY: 2.5, outletX: 4.5, outletY: 2.5, cells: 3, frozen: false },
  { id: 1, kind: 'dry', level: -0.05, spill: 0.02, floor: -0.05, seedX: 9.5, seedY: 5.5, outletX: 9.5, outletY: 4.5, cells: 2, frozen: false },
]
zip.file('layers/waterBodies.json', JSON.stringify(zipBodies))
const zipManifest = {
  formatVersion: 2,
  world: { width: W, height: H },
  layers: [
    { name: 'waterBodies', file: 'layers/waterBodies.json', kind: 'table' },
    { name: 'elevation', file: 'layers/elevation.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    { name: 'uplift', file: 'layers/uplift.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
    { name: 'erodibility', file: 'layers/erodibility.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 } },
  ],
}
zip.file('manifest.json', JSON.stringify(zipManifest))
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
  check('a save without a climate reads as none', loaded.climate === null)
  // The reader must reach the SAME id as deriving it here by hand.
  const direct = M.key.deriveWorldId({
    kind: 'FlatWorld',
    elevation: loaded.elevations, precipitation: null, landscapeAge: 25, alluvium: 60, rockContrast: 35,
  })
  check('reader and direct derivation agree on the worldId', loaded.worldId === direct, `${loaded.worldId} vs ${direct}`)
}
// A save whose climate is still the raster layers (before DEC-0036 phase
// 7) is refused, not converted.
{
  const old = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  old.file('layers/temperature.u8', new Uint8Array(W * H).buffer)
  old.file('layers/biome.u8', new Uint8Array(W * H).buffer)
  check('a save with the climate as raster layers (before DEC-0036 phase 7) is refused', (await M.inputs.readWorldInputs(await old.generateAsync({ type: 'arraybuffer' }))) === null)
}
// A save whose hydrology is still the raster's (before DEC-0036 phase 7b):
// a discharge raster layer, or coast reaches over raster cells — refused.
{
  const old = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  old.file('layers/discharge.u16', new Uint16Array(W * H).buffer)
  check('a save with the discharge as a raster layer (before DEC-0036 phase 7b) is refused', (await M.inputs.readWorldInputs(await old.generateAsync({ type: 'arraybuffer' }))) === null)
  const cells = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  cells.file('layers/coast.json', JSON.stringify({ reaches: [], cells: [5, 6] }))
  check('a save with the coast over raster cells (before DEC-0036 phase 7b) is refused', (await M.inputs.readWorldInputs(await cells.generateAsync({ type: 'arraybuffer' }))) === null)
  const fine = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  fine.file('layers/coast.json', JSON.stringify({ reaches: [], nodes: [5, 6] }))
  check('a save with the coast over the mesh\'s nodes opens', (await M.inputs.readWorldInputs(await fine.generateAsync({ type: 'arraybuffer' }))) !== null)
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
  const bowlGrid = M.domain.torusDomain(bw, bh).grid(bw, bh)
  const depth = M.hydro.lakeDepthFromBodies([body], bowl, bowlGrid)
  let wet = 0, leaked = false
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const d = depth[y * bw + x]
    if (d > 0) wet++
    if (d > 0 && !inBowl(x, y)) leaked = true
  }
  check('the derived lake fills its bowl and stops at the pour point', wet === 8 && !leaked, `${wet} wet, leaked ${leaked}`)
  check('the derived depth is level minus terrain', Math.abs(depth[2 * bw + 3] - 0.1) < 1e-6)
  const field = M.hydro.waterLevelField([body], bowl, bowlGrid)
  const near = (a, b) => Math.abs(a - b) < 1e-6
  check('the level field carries the level onto the rim', near(field.level[2 * bw + 7], 0.2) && near(field.level[1 * bw + 3], 0.2) && field.level[0] === 0 && field.level[2 * bw + 8] === 0)
}

// The climate step's refinement (DEC-0036 phase 5): its values per cell of
// the climate's field mesh, written as Float32 files under refined/ with
// refined.json, through the real writer and read back by the loader's
// reader — every value bit for bit, the sea's rain mark kept, no raster
// layer of it in the manifest. A field missing, or a save from before the
// move (the raster layers, no refined.json), is refused; a save without a
// refinement reads as none.
{
  const writer = await L('/src/world/save/worldArchive.ts')
  const n = 8 * 4
  const months = 12
  const rnd = (i) => Math.sin(i * 12.9898) * 0.5 + 0.5
  // Every third cell is sea: its rain is the OCEAN_PRECIP mark (−1).
  const sea = (i) => i % 3 === 0
  const r = {
    months,
    cells: n,
    spacingM: 62400.125,
    temperature: Float32Array.from({ length: months * n }, (_, i) => (rnd(i + 11) - 0.5) * 80),
    precipitation: Float32Array.from({ length: months * n }, (_, i) => (sea(i % n) ? -1 : 3000 * rnd(i + 13))),
    pressure: Float32Array.from({ length: months * n }, (_, i) => 995 + 30 * rnd(i)),
    windE: Float32Array.from({ length: months * n }, (_, i) => (rnd(i + 7) - 0.5) * 3),
    windS: Float32Array.from({ length: months * n }, (_, i) => (rnd(i + 8) - 0.5) * 3),
    currentE: Float32Array.from({ length: n }, (_, i) => rnd(i + 3) * 2 - 1),
    currentS: Float32Array.from({ length: n }, (_, i) => rnd(i + 4) * 2 - 1),
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
  const write = (refined) => writer.writeWorldArchive({
    kind: 'tectonic', width: 4, height: 2, yaml: 'kind: FlatWorld\n', generatorVersion: 'roundtrip', preview: null, elevation: new Float32Array(8).buffer,
    snapshot: { epoch: 1 }, mantle: { values: new Float64Array(1).buffer, cells: 1, spacingM: 1 }, latticeAccumulated: new ArrayBuffer(4), latticeLockedEpochs: new ArrayBuffer(2),
    latticeLastClassCode: new ArrayBuffer(1), oceanAge: { values: new Float64Array(1).buffer, cells: 1, spacingM: 1 }, forcing: null, mesh: undefined,
    fields: {
      climate: null, land: null, lakeDepth: null, refined, waterBodies: null, coast: null, sedimentBasins: null,
    },
  })
  const zip = await JSZip.loadAsync(await write(r))
  const back = await writer.readRefined(zip)
  const fields = (v) => M.refined.REFINED_SAVE_FIELDS.map((f) => f.get(v))
  const same = back !== null && back.cells === n && back.spacingM === r.spacingM && back.months === months
    && fields(r).every((f, k) => f.length === fields(back)[k].length && f.every((x, i) => Object.is(x, fields(back)[k][i])))
    && back.reliability.ensoPeriodYears === 4.5 && back.reliability.ensoStrength === 0.3
  check('the refinement comes back as its mesh values, bit for bit, with its mesh and the sea\'s rain mark', same && back.precipitation[0] === -1)
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  check('the refinement writes no raster layer (no layers/temperature.01 … thunder, no enso table)', !manifest.layers.some((l) => /\.\d\d$/.test(l.name) || ['currentU', 'fog', 'cyclone', 'enso'].includes(l.name)) && zip.file(/^layers\/(temperature\.|enso|currentU|fog)/).length === 0)
  check('a world saved unrefined reads as unrefined', (await writer.readRefined(await JSZip.loadAsync(await write(null)))) === null)
  zip.remove('refined/upwelling.f32')
  let partial = false
  try { await writer.readRefined(zip) } catch { partial = true }
  check('a refinement with a field missing is refused', partial)
  const old = await JSZip.loadAsync(await write(null))
  old.file('layers/enso.json', '{}')
  old.file('layers/currentU.u16', new ArrayBuffer(2))
  let before = false
  try { await writer.readRefined(old) } catch { before = true }
  check('a save with the refinement as raster layers (before DEC-0036 phase 5) is refused', before)
  const RM = await L('/src/generator/climate/refinement.ts')
  const D = await L('/src/generator/core/domain.ts')
  const CMm = await L('/src/generator/climate/climateMesh.ts')
  const torus = D.torusDomain(2048, 1024)
  const cm = CMm.climateMesh(torus)
  check('a refinement fits its world\'s climate mesh only', RM.refinementFits(torus, cm.mesh.count, cm.cellM) && !RM.refinementFits(torus, cm.mesh.count + 1, cm.cellM) && !RM.refinementFits(torus, cm.mesh.count, cm.cellM * 2))
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
  const CMw = await L('/src/generator/climate/climateMesh.ts')
  const { OCEAN_PRECIP } = await L('/src/generator/climate/precipitation.ts')
  const meshZ = new Float32Array([0.1, 0.2, 0.3])
  // The mantle's field-mesh values (formatVersion 8): Float64, exact.
  const zipMantle = new Float64Array([0.1, -1 / 3, Math.PI])
  // The ocean age's the same (DEC-0036 phase 2, still formatVersion 8).
  const zipAge = new Float64Array([0, 12.5, 1 / 7, 180])
  // The climate per cell of this world's climate mesh (DEC-0036 phase 7):
  // Float32, every second cell sea (the rain's mark).
  const cm = CMw.climateMesh(M.domain.torusDomain(W, H))
  const nc = cm.mesh.count
  const cellSea = (i) => i % 2 === 1
  const zipClimate = {
    cells: nc, spacingM: cm.cellM,
    seaLevelTemperature: Float32Array.from({ length: nc }, (_, i) => 10 + (i % 17) / 3),
    precipitation: Float32Array.from({ length: nc }, (_, i) => (cellSea(i) ? OCEAN_PRECIP : 500 + (i % 91))),
    seasonalAmplitude: Float32Array.from({ length: nc }, (_, i) => (cellSea(i) ? -1 : 6 + (i % 7))),
    monsoonIndex: Float32Array.from({ length: nc }, (_, i) => (cellSea(i) ? OCEAN_PRECIP : (i % 9) / 10 - 0.4)),
  }
  const zipLand = { count: 3, biome: new Uint8Array([0, 6, 11]), koppen: new Uint8Array([0, 14, 29]), waterTable: new Float32Array([-1, 12.5, 0]), discharge: new Float32Array([0, 1234.5, 1 / 3]) }
  // The coast over the mesh's nodes (DEC-0036 phase 7b): vertex ids.
  const zipCoast = { reaches: [{ id: 0, nodeStart: 0, nodeCount: 2, lengthKm: 12.5, exposure: 0.4, reliefM: 30, hardness: 1, supply: 0, type: 'beach', mouthReach: -1 }], nodes: new Int32Array([1, 2]) }
  const yaml = ['kind: FlatWorld', 'spec:', '  seed: "writer-welt"', '  erosion:', '    landscapeAge: 30', '    alluvium: 40', '    rockContrast: 55', 'metadata:', '  uid: 0192abcd-0000-8000-8000-00000000beef', ''].join('\n')
  const written = await writer.writeWorldArchive({
    kind: 'tectonic', width: W, height: H, yaml, generatorVersion: 'roundtrip', preview: null, elevation: zipElev.buffer.slice(0),
    snapshot: { epoch: 3 }, mantle: { values: zipMantle.buffer.slice(0), cells: 3, spacingM: 125000.5 }, latticeAccumulated: new ArrayBuffer(4), latticeLockedEpochs: new ArrayBuffer(2),
    latticeLastClassCode: new ArrayBuffer(1), oceanAge: { values: zipAge.buffer.slice(0), cells: 4, spacingM: 62400.25 },
    forcing: { uplift: zipUplift, erodibility: zipHardness, resX: W, resY: H },
    mesh: { count: 3, nodes: new Float32Array([1, 1, 5, 2, 9, 6]).buffer, connectivity: new Uint8Array([7, 8, 9]).buffer, z: meshZ.buffer.slice(0) },
    fields: {
      climate: zipClimate, land: zipLand, lakeDepth: null,
      refined: null, waterBodies: zipBodies, coast: zipCoast, sedimentBasins: null,
    },
  })
  const manifest = JSON.parse(await (await JSZip.loadAsync(written)).file('manifest.json').async('string'))
  check('the writer stamps the current format version', manifest.formatVersion === writer.WORLD_ARCHIVE_FORMAT_VERSION)
  {
    const zip = await JSZip.loadAsync(written)
    const mantle = await writer.readField(zip, 'mantle')
    check('the mantle comes back as its mesh values, bit for bit, with its mesh', mantle.cells === 3 && mantle.spacingM === 125000.5 && String(new Float64Array(mantle.values)) === String(zipMantle) && zip.file('mantle.f32') === null)
    zip.remove('mantle.json')
    let refused = false
    try { await writer.readField(zip, 'mantle') } catch { refused = true }
    check('a save without the mantle mesh (before formatVersion 8) is refused', refused)
    const age = await writer.readField(zip, 'oceanAge')
    check('the ocean age comes back as its mesh values, bit for bit, with its mesh, and no raster', age.cells === 4 && age.spacingM === 62400.25 && String(new Float64Array(age.values)) === String(zipAge) && zip.file('oceanAge.f32') === null)
    zip.remove('oceanAge.f64')
    zip.file('oceanAge.f32', new ArrayBuffer(4))
    let ageRefused = false
    try { await writer.readField(zip, 'oceanAge') } catch { ageRefused = true }
    check('a version-8 save from before the ocean age moved (oceanAge.f32, no .f64) is refused', ageRefused)
  }
  {
    // The climate and the land fields on their meshes (DEC-0036 phase 7):
    // bit for bit, no raster layer of either.
    const zip = await JSZip.loadAsync(written)
    const climate = await writer.readClimate(zip)
    const sameF = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
    check('the climate comes back as its mesh values, bit for bit, with its mesh and the sea\'s marks', climate !== null && climate.cells === nc && climate.spacingM === cm.cellM
      && ['seaLevelTemperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex'].every((k) => sameF(climate[k], zipClimate[k])) && climate.precipitation[1] === OCEAN_PRECIP)
    const land = await writer.readLandFields(zip, 3)
    check('the land fields come back per node, bit for bit', land !== null && String(land.biome) === String(zipLand.biome) && String(land.koppen) === String(zipLand.koppen) && String(land.waterTable) === String(zipLand.waterTable))
    check('the discharge comes back per node, bit for bit, and no discharge raster is written', land !== null && land.discharge !== null && sameF(land.discharge, zipLand.discharge) && manifest.mesh?.files?.discharge === 'mesh/discharge.f32' && zip.file('layers/discharge.u16') === null && !manifest.layers.some((l) => l.name === 'discharge'))
    const coastBack = JSON.parse(await zip.file('layers/coast.json').async('string'))
    check('the coast comes back over the mesh\'s nodes, no raster cells', String(coastBack.nodes) === String(zipCoast.nodes) && coastBack.cells === undefined && JSON.stringify(coastBack.reaches) === JSON.stringify(zipCoast.reaches))
    let wrongCount = false
    try { await writer.readLandFields(zip, 4) } catch { wrongCount = true }
    check('land fields of another mesh are refused', wrongCount)
    check('no climate, biome, Köppen or water-table raster layer is written', !manifest.layers.some((l) => ['landMask', 'temperature', 'precipitation', 'precipitationEffective', 'biome', 'seasonalAmplitude', 'monsoonIndex', 'koppen', 'waterTable'].includes(l.name)) && zip.file(/^layers\/(landMask|temperature|precipitation|biome|seasonal|monsoon|koppen|waterTable)/).length === 0)
    check('the manifest names the climate and the land files', manifest.climate?.file === 'climate.json' && manifest.mesh?.files?.biome === 'mesh/biome.u8' && manifest.mesh?.files?.waterTable === 'mesh/waterTable.f32')
    zip.remove('climate/monsoonIndex.f32')
    let partial = false
    try { await writer.readClimate(zip) } catch { partial = true }
    check('a climate with a field missing is refused', partial)
  }
  const back = await M.inputs.readWorldInputs(written)
  if (!back) check('the written archive reads back at all', false)
  else {
    check('the written elevation comes back byte-identical', String(back.elevations) === String(zipElev))
    check('the written recipe is read', back.seedText === 'writer-welt' && back.erosionControls.alluvium === 40 && back.worldUid === '0192abcd-0000-8000-8000-00000000beef')
    check('the written forcing comes back byte-identical', String(back.uplift?.data) === String(zipUplift) && String(back.erodibility?.data) === String(zipHardness))
    check('the written water bodies come back', JSON.stringify(back.waterBodies) === JSON.stringify(zipBodies))
    check('the bake\'s climate is the saved cells', back.climate !== null && back.climate.cells === nc && back.climate.precipitation[2] === zipClimate.precipitation[2])
    const direct = M.key.deriveWorldId({
      kind: 'FlatWorld', elevation: back.elevations, precipitation: zipClimate.precipitation, landscapeAge: 30, alluvium: 40, rockContrast: 55,
      mesh: { nodes: new Float32Array([1, 1, 5, 2, 9, 6]), z: meshZ },
    })
    check('the worldId hashes the climate\'s cells', back.worldId === direct, `${back.worldId} vs ${direct}`)
    const world = await query.openWorld(written)
    const savedMesh = await world.mesh()
    check('the written mesh comes back as written', savedMesh !== null && savedMesh.count === 3 && String(savedMesh.z) === String(meshZ) && String(savedMesh.connectivity) === '7,8,9')
    // The query's views of the climate: its chart, the sea's mark on the
    // chart's sea (the elevation raster's), the temperature at the texel's
    // height.
    const rain = await world.acquire('precipitation')
    const mask = await world.acquire('landMask')
    let marked = rain !== null && mask !== null && rain.resX === 256
    for (let i = 0; marked && i < rain.data.length; i++) if (mask.data[i] === 0 && rain.data[i] !== OCEAN_PRECIP) marked = false
    check('the query draws the climate\'s chart, the rain marked on its sea', marked && world.has('temperature') && !world.has('precipitationEffective'))
  }
}

// A zip that is not a world must be refused, not half-read.
check('a zip without a manifest is refused', (await M.inputs.readWorldInputs(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'arraybuffer' }))) === null)

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

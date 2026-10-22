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
// generator screen for world/save/worldArchive.ts: sections 5 and 5b write
// an archive with it and read it back — on a real (tiny) mesh since the
// save holds no raster (DEC-0036, the save step), the reader drawing the
// rasters from it. Section 5 also refuses what older saves hold. Section 2d
// holds the world list's merge rules (ui/worldChooser/worldCards.ts): which
// copies are one world.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The engine's WASM build, as the browser loads it: the world layer reads
// a save's forcing through it (DEC-0044, fork 7b).
const ENGINE = await import(`${CLIENT}/../engine/dist/wasm/casas-engine.js`)
await ENGINE.default({ module_or_path: await (await import('node:fs/promises')).readFile(`${CLIENT}/../engine/dist/wasm/casas-engine_bg.wasm`) })

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

// --- 1. the sample world's quantisation ------------------------------------
//
// The save holds no quantised layer since DEC-0036's save step; the sample
// world (scripts/sampleWorld.mjs → the Planet step) still stores its
// elevation as u16 with a scale and offset, and the screen dequantises it
// with nothing but those two numbers. So: bake then decode lands within half
// a step of the input across the whole range — a wrong scale shows up as
// clipping at the ends, which a mid-range spot check would miss.
console.log('\n— sample world quantisation —')
{
  const spec = M.layers.ELEVATION_ENCODING
  const top = spec.offset + spec.scale * 65535
  const n = 512
  const field = new Float32Array(n)
  for (let i = 0; i < n; i++) field[i] = spec.offset + ((top - spec.offset) * i) / (n - 1)
  const back = M.layers.decodeLayer(M.layers.bakeLayer(field, spec), spec)
  let worst = 0
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(back[i] - field[i]))
  const tolerance = spec.scale * 0.5 + 1e-7
  check(`the sample world's elevation (${spec.dtype})`, worst <= tolerance, `worst ${worst.toExponential(3)} > ${tolerance.toExponential(3)}`)
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
const partial = M.spec.specFromYaml('spec:\n  genesis:\n    landShare: 22\n', 'x')
const otherField = M.spec.WORLD_SPEC_FIELDS.find((f) => f.path === 'tectonics.alluvium')
check('a missing key falls back to its declared default',
  partial.values['genesis.landShare'] === 22 && partial.values['tectonics.alluvium'] === otherField.input.default,
  `landShare=${partial.values['genesis.landShare']} alluvium=${partial.values['tectonics.alluvium']} (want 22/${otherField.input.default})`)
// A control that moved stage (the temperature offset as the Planet's
// greenhouse) reads its old path when the new one is absent, and the new
// one wins when both are there.
const moved = M.spec.specFromYaml('spec:\n  climate:\n    tempOffset: -4\n', 'x')
const both = M.spec.specFromYaml('spec:\n  climate:\n    tempOffset: -4\n  planet:\n    greenhouse: 3\n', 'x')
check('a moved control reads its legacy path', moved.values['planet.greenhouse'] === -4, `greenhouse=${moved.values['planet.greenhouse']}`)
// The erosion's material controls moved to the tectonics with the coupled
// history (phase 5.1): a save from before reads them from their old place.
const movedErosion = M.spec.specFromYaml('spec:\n  erosion:\n    alluvium: 70\n    rockContrast: 20\n', 'x')
check('the erosion controls read their legacy paths', movedErosion.values['tectonics.alluvium'] === 70 && movedErosion.values['tectonics.rockContrast'] === 20, `alluvium=${movedErosion.values['tectonics.alluvium']} rockContrast=${movedErosion.values['tectonics.rockContrast']}`)
check('the current path wins over the legacy one', both.values['planet.greenhouse'] === 3)

// A key the file DOES carry but the spec no longer knows must be ignored, not
// crash or leak: riverDensity left the spec with erosion-v2 P4, and every save
// written before that carries it.
const legacy = M.spec.specFromYaml('spec:\n  genesis:\n    landShare: 22\n  hydrology:\n    riverDensity: 70\n', 'x')
check('a retired key in an old save is simply ignored',
  legacy.values['genesis.landShare'] === 22 && legacy.values['hydrology.riverDensity'] === undefined,
  `riverDensity=${legacy.values['hydrology.riverDensity']}`)

// A recipe with the water control (replaced by the land share, DEC-0036
// phase 8b-1) is refused, under its genesis path and its day on the planet:
// its world was made from a sea-level offset no generator of today applies.
let waterRefused = 0
for (const text of ['spec:\n  genesis:\n    water: 50\n', 'spec:\n  planet:\n    water: 50\n']) {
  try { M.spec.specFromYaml(text, 'x') } catch { waterRefused++ }
}
check('a recipe with the former water control is refused', waterRefused === 2, `${waterRefused} of 2 refused`)

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
  H.openRun(history.genesis, genesisValues)
  H.tallyRun(history.genesis, 120, genesisValues)
  H.openRun(history.tectonics, tectonicsValues)
  H.tallyRun(history.tectonics, 45, tectonicsValues)
  // The same values again extend the run; changed values open the next one.
  H.openRun(history.tectonics, tectonicsValues)
  H.tallyRun(history.tectonics, 5, tectonicsValues)
  const changed = { ...tectonicsValues, 'tectonics.alluvium': tectonicsValues['tectonics.alluvium'] + 1 }
  H.openRun(history.tectonics, changed)
  H.tallyRun(history.tectonics, 12, changed)
  check('a run with the same values extends the entry', history.tectonics.length === 2 && history.tectonics[0].epochs === 50, JSON.stringify(history.tectonics.map((r) => r.epochs)))
  // A run on a loaded world opens one marked `restored` even with nothing
  // changed.
  H.openRun(history.tectonics, changed, true)
  H.tallyRun(history.tectonics, 2, changed)
  check('a load opens a marked run', history.tectonics.length === 3 && history.tectonics[2].restored === true)
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
  const run = (fields, epochs, extra = {}) => ({ epochs, values: WH.runValues(fields, values), ...extra })
  const record = {
    kind: 'FlatWorld',
    uid: '0f8e5c1a-7b2d-4c3e-9a1f-123456789abc', name: 'Calvessor',
    annotations: { 'casas-eternas/copied-from': '11111111-2222-4333-8444-555555555555' }, revision: 7, pipeline: 'v11-0123456789abcdef',
    spec: { seed: '983721401', values },
    history: { genesis: [run(WH.GENESIS_RUN_FIELDS, 41)], tectonics: [run(WH.TECTONICS_RUN_FIELDS, 30), run(WH.TECTONICS_RUN_FIELDS, 12, { restored: true })] },
    archeanEpochs: 41, epoch: 42, erosionRun: 42, progress: 'climate',
  }
  const yaml = WR.recordToYaml(record, 'abc1234')
  const back = WR.recordFromYaml(yaml, { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('a world record survives world.yaml unchanged', JSON.stringify(back) === JSON.stringify(record), WR.recordDiff(record, back).join('; '))
  check('and compares as unchanged', WR.recordSignature(back) === WR.recordSignature(record))
  // The pipeline that made a world (worldPipeline.ts): `status.pipeline`;
  // for a world before it, the frozen engine's file hash in every run
  // names this pipeline, any other code or a mix none.
  const PL = await L('/src/world/worldPipeline.ts')
  const legacyYaml = (codes) => ['status:', '  revision: 1', 'history:', '  genesis:', ...codes.flatMap((code, i) => [`    ${i}:`, '      epochs: 3', '      generator: bb6a054-dirty', `      code: ${code}`])].join('\n')
  check('a world records its pipeline, and one from before the field is the frozen engine\'s by its code',
    PL.recordedPipeline(yaml) === 'v11-0123456789abcdef' && PL.recordedPipeline(legacyYaml(['54ee802771966159', '54ee802771966159'])) === PL.WORLD_PIPELINE
      && PL.recordedPipeline(legacyYaml(['54ee802771966159', 'abcdefabcdefabcd'])) === '' && PL.recordedPipeline(legacyYaml(['abcdefabcdefabcd'])) === '',
    PL.WORLD_PIPELINE)
  // A pipeline that makes the same worlds as this one reads as this one:
  // v11, whose code moved into the engine with no byte changed (v12).
  check('a world v11 made is v12\'s', PL.recordedPipeline('status:\n  pipeline: v11-1b1f7f4a8b14250e') === PL.WORLD_PIPELINE, PL.WORLD_PIPELINE)
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
  check('and counts the steps up to the ecology, the finishing as the last of them', JSON.stringify(WP.progressPosition('genesis')) === '{"n":1,"all":4,"done":false}' && WP.progressPosition('ecology').done && JSON.stringify(WP.progressPosition('finishing')) === '{"n":4,"all":4,"done":true}' && WP.progressPosition(null) === null)
  check('the terrain id goes into world.yaml when known, and only then', WR.recordToYaml(record, 'x', '0123456789abcdef').includes('\n  terrain: 0123456789abcdef\n') && !WR.recordToYaml(record, 'x').includes('terrain:'))
  check('a new progress reads as a change, by name', WR.recordDiff(record, { ...record, progress: 'finishing' }).some((d) => d.startsWith('progress:')))
  check('an unknown or missing kind is refused', refused === 3 && WR.worldKindOf(yaml) === 'FlatWorld', `${refused} of 3`)
  // The annotations (template worlds: where a copy came from) survive a
  // load and a save, are absent while there is none, and are no change.
  const plain = WR.recordFromYaml(WR.recordToYaml({ ...record, annotations: {} }, 'x'), { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('the annotations survive world.yaml, and none writes no block', back.annotations['casas-eternas/copied-from'] === record.annotations['casas-eternas/copied-from'] && Object.keys(plain.annotations).length === 0 && !WR.recordToYaml({ ...record, annotations: {} }, 'x').includes('annotations:'))
  check('and are no change', WR.recordSignature(plain) === WR.recordSignature(record))
  // Values that YAML would read otherwise are quoted on write, and read back
  // as they were; plain ones stay plain. Keys may hold a "." (2026-10-16).
  const awkward = {
    'example.com/colon': 'a: b', 'example/quote': '"hi" \\ back', 'example/inner': 'say "hi" \\ back', 'example/empty': '', 'example/lead': ' lead',
    'example/trail': 'trail ', 'example/hash': 'x #y', 'example/start-hash': '#x', 'example/dash': '- item', 'example/brace': '{a}',
    'example/star': '*ref', 'example/single': "'q'", 'example/plain': 'plain value', 'example/url': 'https://example.com/x',
  }
  const awkwardYaml = WR.recordToYaml({ ...record, annotations: awkward }, 'x')
  const awkwardBack = WR.recordFromYaml(awkwardYaml, { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('annotation values survive world.yaml as they were', JSON.stringify(awkwardBack.annotations) === JSON.stringify(awkward), JSON.stringify(awkwardBack.annotations))
  const line = (k) => awkwardYaml.split('\n').find((l) => l.startsWith(`    ${k}:`))
  check('and are quoted only when needed', line('example.com/colon') === '    example.com/colon: "a: b"' && line('example/quote') === '    example/quote: "\\"hi\\" \\\\ back"' && line('example/inner') === '    example/inner: say "hi" \\ back' && line('example/empty') === '    example/empty: ""' && line('example/plain') === '    example/plain: plain value' && line('example/url') === '    example/url: https://example.com/x', [line('example.com/colon'), line('example/quote'), line('example/empty'), line('example/plain')].join(' | '))
  const WCopy = await L('/src/world/worldCopy.ts')
  const copiedBack = WR.recordFromYaml(WCopy.withCopyIdentity(awkwardYaml, 'c', 's'), { archeanEpochs: 41, epoch: 42 }, () => 'unused')
  check('and survive a copy', JSON.stringify(copiedBack.annotations) === JSON.stringify({ ...awkward, [WCopy.COPIED_FROM_ANNOTATION]: 's' }), JSON.stringify(copiedBack.annotations))
}

// --- 2c'. a copy's world.yaml -----------------------------------------------
// world/worldCopy.ts: a copy is the same world under a new uid, with the
// source named as an annotation — the same text the server writes
// (internal/modules/world/save.go, withCopyIdentity; its test holds the same
// expected file as this one).
{
  console.log('\n— a copy of a world —')
  const WCopy = await L('/src/world/worldCopy.ts')
  const WR = await L('/src/world/worldRecord.ts')
  const key = WCopy.COPIED_FROM_ANNOTATION
  const yaml = `apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: a\n  uid: old\n  annotations:\n    example/note: kept\n    ${key}: older\nspec:\n  seed: s\n`
  const want = `apiVersion: casas-eternas/v1alpha1\nkind: FlatWorld\nmetadata:\n  name: a\n  uid: new\n  annotations:\n    example/note: kept\n    ${key}: old\nspec:\n  seed: s\n`
  check('the copy\'s identity is written as the server writes it', WCopy.withCopyIdentity(yaml, 'new', 'old') === want, JSON.stringify(WCopy.withCopyIdentity(yaml, 'new', 'old')))
  check('a file without metadata is no world to copy', WCopy.withCopyIdentity('spec:\n  seed: s\n', 'new', 'old') === null)
  // The table the server's rewrite passes too (save_test.go): the same text.
  const table = JSON.parse(readFileSync(`${CLIENT}/../internal/modules/world/testdata/copy-identity.json`, 'utf8'))
  for (const c of table.cases) {
    const got = WCopy.withCopyIdentity(c.in, table.uid, table.source)
    check(`copy table: ${c.name}`, got === c.want, JSON.stringify(got))
  }
  // From the record the generator writes: the uid moves, the spec does not,
  // and the record reads the source back.
  const record = { kind: 'FlatWorld', uid: 'src-uid', name: 'N', annotations: {}, revision: 2, pipeline: '', spec: { seed: '9', values: Object.fromEntries(M.spec.WORLD_SPEC_FIELDS.map((f) => [f.path, f.input.default])) }, history: { genesis: [], tectonics: [] }, archeanEpochs: 0, epoch: 0, erosionRun: 0, progress: null }
  const written = WR.recordToYaml(record, 'b')
  const copied = WR.recordFromYaml(WCopy.withCopyIdentity(written, 'copy-uid', 'src-uid'), { archeanEpochs: 0, epoch: 0 }, () => 'x')
  check('a copied record has the new uid, the source as annotation, the same recipe', copied.uid === 'copy-uid' && copied.annotations[key] === 'src-uid' && WR.recordSignature(copied) === WR.recordSignature(record))
  // The archive: world.yaml rewritten, every other entry the same bytes.
  const zip = new JSZip()
  zip.file('world.yaml', written)
  zip.file('state.json', '{"epoch":3}')
  const archive = new Blob([await zip.generateAsync({ type: 'uint8array' })])
  const back = await JSZip.loadAsync(await (await WCopy.copyArchive(archive, 'copy-uid', 'src-uid')).arrayBuffer())
  check('a copied archive keeps every other entry', (await back.file('state.json').async('string')) === '{"epoch":3}' && (await back.file('world.yaml').async('string')).includes(`    ${key}: src-uid`))
}

// --- 2d. the world list's merge ---------------------------------------------
// ui/worldChooser/worldCards.ts: one card per world, wherever its copies are.
// Pure, so the rules the list shows are checked here and not by clicking.
{
  console.log('\n— world list merge —')
  const WC = await L('/src/ui/worldChooser/worldCards.ts')
  const copy = (where, uid, extra = {}) => ({ where, uid, name: uid, seed: 's', kind: 'FlatWorld', progress: null, bytes: 1, savedAt: '2026-10-01T10:00:00Z', generator: 'g', contentHash: 'aa', template: false, visibility: where === 'server' ? 'private' : '', actions: where === 'server' ? ['world.read', 'world.write', 'world.share', 'world.delete'] : [], ...extra })
  const opensAll = () => true
  const cards = WC.mergeWorldCopies(
    [copy('browser', 'same'), copy('browser', 'diverged', { contentHash: 'bb', savedAt: '2026-10-02T10:00:00Z' }), copy('browser', 'nohash', { contentHash: '' }), copy('browser', 'local', { kind: 'SphereWorld' })],
    [copy('server', 'same'), copy('server', 'diverged', { contentHash: 'cc' }), copy('server', 'nohash', { contentHash: '' }), copy('server', 'remote', { kind: null })],
  )
  const card = (uid) => cards.find((c) => c.uid === uid)
  check('a world in both places is one card', cards.length === 5 && card('same').browser && card('same').server)
  const same = card('same')
  check('the same hash in both places: same, no newer, Open loads the browser copy', same.state === 'same' && same.newer === null && WC.cardOpenCopy(same, opensAll)?.where === 'browser')
  const diverged = card('diverged')
  check('a different hash: diverged, the later save marked newer and shown, Open disabled', diverged.state === 'diverged' && diverged.newer === 'browser' && diverged.shown === diverged.browser && WC.cardOpenCopy(diverged, opensAll) === null)
  const serverNewer = WC.mergeWorldCopies([copy('browser', 'x', { contentHash: 'bb' })], [copy('server', 'x', { savedAt: '2026-10-03T10:00:00Z' })])[0]
  check('and the server\'s copy when it is the later one', serverNewer.newer === 'server' && serverNewer.shown === serverNewer.server)
  const nohash = card('nohash')
  check('a missing hash on both sides reads as diverged, never as the same', nohash.state === 'diverged' && WC.cardOpenCopy(nohash, opensAll) === null)
  const oneHash = WC.mergeWorldCopies([copy('browser', 'x', { contentHash: '' })], [copy('server', 'x')])[0]
  check('and so does a hash missing on one side', oneHash.state === 'diverged')
  const local = card('local')
  check('one copy: single, Open loads it where the screen opens it', local.state === 'single' && WC.cardOpenCopy(local, opensAll) === local.browser && WC.cardOpenCopy(local, (where) => where === 'server') === null)
  check('the cards come newest first', cards[0].uid === 'diverged')
  const under = (where, shape) => cards.filter((c) => WC.cardMatches(c, where, shape)).map((c) => c.uid).sort().join(',')
  check('the shape filter keeps its shape', under('all', 'sphere') === 'local' && under('all', 'flat') === 'diverged,nohash,same', `${under('all', 'sphere')} | ${under('all', 'flat')}`)
  check('a card of unknown shape shows under both shapes only', under('all', 'anyShape').includes('remote') && !under('all', 'flat').includes('remote') && !under('all', 'sphere').includes('remote'))
  check('the place filter keeps the cards with a copy there', under('server', 'anyShape') === 'diverged,nohash,remote,same' && under('browser', 'anyShape') === 'diverged,local,nohash,same', `${under('server', 'anyShape')} | ${under('browser', 'anyShape')}`)
  const mixedKind = WC.mergeWorldCopies([copy('browser', 'x', { kind: null })], [copy('server', 'x', { kind: 'SphereWorld' })])[0]
  check('the shape comes from whichever copy knows it', mixedKind.kind === 'SphereWorld' && WC.cardMatches(mixedKind, 'all', 'sphere'))
  // Templates (docs/decisions/template-worlds.md): the server copy's mark
  // makes the card one; a template the caller may not write is not opened
  // but copied, the owner's and the admin's open as usual (by the actions
  // the server states, DEC-0040).
  const templates = WC.mergeWorldCopies([copy('browser', 'mine')], [copy('server', 'theirs', { template: true, actions: ['world.read'] }), copy('server', 'owned', { template: true }), copy('server', 'ruled', { template: true, actions: ['world.read', 'world.write', 'world.share', 'world.delete', 'world.publish', 'world.template'] }), copy('server', 'plain')])
  const tcard = (uid) => templates.find((c) => c.uid === uid)
  const tunder = (where) => templates.filter((c) => WC.cardMatches(c, where, 'anyShape')).map((c) => c.uid).sort().join(',')
  check('the template filter keeps the templates, All keeps everything', tunder('template') === 'owned,ruled,theirs' && tunder('all') === 'mine,owned,plain,ruled,theirs', `${tunder('template')} | ${tunder('all')}`)
  check('someone else\'s template does not open, the owner\'s and the admin\'s do', WC.cardOpenCopy(tcard('theirs'), opensAll) === null && WC.foreignTemplate(tcard('theirs').server) && WC.cardOpenCopy(tcard('owned'), opensAll)?.uid === 'owned' && WC.cardOpenCopy(tcard('ruled'), opensAll)?.uid === 'ruled')
}

// --- 3. identity -------------------------------------------------------------
//
// These two strings address every stored artifact, locally and on the server.
// deriveWorldId is FROZEN: it depends only on the bytes handed to it, so a change
// means the hash function moved and every cache entry in existence is orphaned.
console.log('\n— identity —')
// Re-frozen 2026-10-12 (DEC-0036, the save step): the id hashes the mesh, the
// climate's cells, the forcing and the field meshes, no raster — a
// deliberate break for every world saved before (its artifacts are made
// again). Before that: the P5 teardown, the kind (DEC-0035, 2026-10-10).
const idInputs = (over = {}) => ({
  kind: 'FlatWorld', landscapeAge: 40, alluvium: 50, rockContrast: 50,
  mesh: { nodes: new Float32Array([1, 2, 3, 4]), z: new Float32Array([0.1, 0.2]) },
  climate: { seaLevelTemperature: new Float32Array([14, 15]), precipitation: new Float32Array([800, -1]), seasonalAmplitude: new Float32Array([6, -1]), monsoonIndex: new Float32Array([0.1, -1]) },
  forcing: { uplift: new Float32Array([0, 0.5, -0.2]), erodibility: new Float32Array([1, 1.2, 0.8]) },
  mantle: new Float64Array([0.25, -1 / 3]),
  oceanAge: new Float64Array([0, 12.5, 180]),
  ...over,
})
const id = M.key.deriveWorldId(idInputs())
check('deriveWorldId is stable for fixed bytes', id === '5e7492a5133a8979', `got ${id}`)
check('the kind enters the identity', id !== M.key.deriveWorldId(idInputs({ kind: 'SphereWorld' })))
check('the mesh\'s heights enter the identity', id !== M.key.deriveWorldId(idInputs({ mesh: { nodes: new Float32Array([1, 2, 3, 4]), z: new Float32Array([0.1, 0.25]) } })))
{
  const withColumn = M.key.deriveWorldId(idInputs({ mesh: { nodes: new Float32Array([1, 2, 3, 4]), z: new Float32Array([0.1, 0.2]), column: new Uint8Array([1, 0, 0, 0]) } }))
  const otherColumn = M.key.deriveWorldId(idInputs({ mesh: { nodes: new Float32Array([1, 2, 3, 4]), z: new Float32Array([0.1, 0.2]), column: new Uint8Array([2, 0, 0, 0]) } }))
  check('the column enters the identity', withColumn !== id && withColumn !== otherColumn)
}
check('the climate enters the identity, and none is not an empty one', id !== M.key.deriveWorldId(idInputs({ climate: null })) && id !== M.key.deriveWorldId(idInputs({ climate: { ...idInputs().climate, precipitation: new Float32Array([801, -1]) } })))
check('the forcing enters the identity', id !== M.key.deriveWorldId(idInputs({ forcing: { uplift: new Float32Array([0, 0.5, -0.3]), erodibility: new Float32Array([1, 1.2, 0.8]) } })))
check('the field meshes enter the identity', id !== M.key.deriveWorldId(idInputs({ mantle: new Float64Array([0.25, -0.3]) })) && id !== M.key.deriveWorldId(idInputs({ oceanAge: new Float64Array([0, 12.5, 181]) })))
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
//
// Since DEC-0036's save step the save holds no raster: the archive here is
// the real writer's on a real (tiny) mesh, and the reader draws the
// elevation from the mesh, the lakes from the water body per node, the
// forcing from the snapshot — each checked against the generator's own
// function on the same input. What an older save holds is refused.
console.log('\n— zip reader —')
const W = 16, H = 8
const MM = {
  lattice: await L('/src/generator/mesh/lattice.ts'),
  serial: await L('/src/generator/mesh/meshSerial.ts'),
  raster: await L('/src/generator/mesh/meshRaster.ts'),
  hydro: await L('/src/generator/mesh/meshHydrology.ts'),
}
const writer = await L('/src/world/save/worldArchive.ts')
const zipDomain = M.domain.torusDomain(W, H)
// A canonical mesh (Hilbert-numbered, as the session's after every epoch),
// its heights a bowl in a slope.
const zipMesh = MM.serial.compactMesh(MM.lattice.hexLattice(zipDomain, 2)).mesh
const zipSerial = MM.serial.encodeMesh(zipMesh, Int32Array.from({ length: zipMesh.aliveVertices }, (_, i) => i))
const zipCount = zipSerial.count
const meshZ = Float32Array.from({ length: zipCount }, (_, i) => 0.3 * Math.cos(zipMesh.vx[i] * 0.4) - 0.2 + 0.02 * zipMesh.vy[i])
// Two bodies: a lake over the lowest nodes, a dry basin over a few others.
const zipBodies = [
  { id: 0, kind: 'lake', level: 0.21, spill: 0.21, floor: 0.17, seedX: 3.5, seedY: 2.5, outletX: 4.5, outletY: 2.5, cells: 3, frozen: false },
  { id: 1, kind: 'dry', level: -0.05, spill: 0.02, floor: -0.05, seedX: 9.5, seedY: 5.5, outletX: 9.5, outletY: 4.5, cells: 2, frozen: false },
]
const zipLakeBody = Int32Array.from({ length: zipCount }, (_, i) => (i % 5 === 0 ? 0 : i % 7 === 0 ? 1 : -1))
// The snapshot the forcing is derived from: what the reader reads of it.
const zipSnapshot = { width: W, height: H, epoch: 3, archeanEpochs: 40, warpSeed: 77, features: [], rafts: [], sutures: [], seeds: [], motions: [], ages: [], hotspots: [], initialPlateCount: 0, supercontinentActive: false, continentalRiftCooldownUntil: 0, rngState: 1 }
const zipMantle = new Float64Array([0.1, -1 / 3, Math.PI])
const zipAge = new Float64Array([0, 12.5, 1 / 7, 180])
const zipYaml = (seed, uid) => ['kind: FlatWorld', 'spec:', `  seed: "${seed}"`, '  erosion:', '    landscapeAge: 25', '  tectonics:', '    alluvium: 60', '    rockContrast: 35', 'metadata:', `  uid: ${uid}`, ''].join('\n')
const zipParts = (over = {}) => ({
  kind: 'tectonic', width: W, height: H, yaml: zipYaml('zip-welt', '0192abcd-0000-8000-8000-000000000000'), generatorVersion: 'roundtrip', preview: null,
  snapshot: structuredClone(zipSnapshot), mantle: { values: zipMantle.buffer.slice(0), cells: 3, spacingM: 125000.5 }, latticeAccumulated: new ArrayBuffer(4), latticeLockedEpochs: new ArrayBuffer(2),
  latticeLastClassCode: new ArrayBuffer(1), oceanAge: { values: zipAge.buffer.slice(0), cells: 4, spacingM: 62400.25 },
  mesh: { count: zipCount, nodes: zipSerial.nodes.slice().buffer, connectivity: zipSerial.connectivity.slice().buffer, z: meshZ.slice().buffer, sedimentFlux: new Float32Array(zipCount).buffer, preErosionZ: meshZ.slice().buffer },
  fields: {
    climate: null,
    land: { count: zipCount, biome: new Uint8Array(zipCount).fill(6), koppen: new Uint8Array(zipCount), waterTable: null, discharge: null, lakeBody: zipLakeBody.slice() },
    refined: null, waterBodies: zipBodies, coast: null, sedimentBasins: null,
  },
  ...over,
})
const zip = await JSZip.loadAsync(await writer.writeWorldArchive(zipParts()))
const zipElev = MM.raster.rasteriseNodeField(MM.serial.decodeMesh(zipDomain, zipSerial), meshZ, W, H)
const zipForcing = ENGINE.forcingOfSnapshot(zipDomain.kind, structuredClone(zipSnapshot))
const loaded = await M.inputs.readWorldInputs(await zip.generateAsync({ type: 'arraybuffer' }), ENGINE)
if (!loaded) check('the zip reads back at all', false)
else {
  // The save's own payloads, as it holds them: the engine derives the
  // seeds, the forcing and the raster (DEC-0044, fork 7b).
  check('the mesh and the snapshot are read as the save holds them', loaded.mesh?.count === zipCount && String(loaded.mesh?.z) === String(meshZ) && loaded.snapshot?.epoch === zipSnapshot.epoch && loaded.width === W && loaded.height === H)
  check('the recipe is read', loaded.seedText === 'zip-welt' && loaded.erosionControls.landscapeAge === 25 && loaded.erosionControls.alluvium === 60 && loaded.erosionControls.rockContrast === 35)
  check('the uid is read rather than derived', loaded.worldUid === '0192abcd-0000-8000-8000-000000000000')
  check('the water-body table comes back as written', JSON.stringify(loaded.waterBodies) === JSON.stringify(zipBodies))
  check('a save without a climate reads as none', loaded.climate === null)
  // The reader must reach the SAME id as deriving it here by hand.
  const direct = M.key.deriveWorldId({
    kind: 'FlatWorld', landscapeAge: 25, alluvium: 60, rockContrast: 35,
    mesh: { nodes: zipSerial.nodes, z: meshZ }, climate: null,
    forcing: { uplift: zipForcing.uplift, erodibility: zipForcing.hardness }, mantle: zipMantle, oceanAge: zipAge,
  })
  check('reader and direct derivation agree on the worldId', loaded.worldId === direct, `${loaded.worldId} vs ${direct}`)
  const query = await L('/src/world/query.ts')
  const world = await query.openWorld(await zip.generateAsync({ type: 'arraybuffer' }), ENGINE)
  const lakes = await world.acquire('lakeDepth')
  const direct2 = MM.hydro.waterFieldsFromMesh(MM.serial.decodeMesh(zipDomain, zipSerial), zipLakeBody, zipBodies, zipElev, W, H).depth
  check('the lakes\' depth is the mesh\'s lakes drawn on that raster, byte for byte', lakes !== null && String(lakes.data) === String(direct2) && direct2.some((d) => d > 0) && world.has('lakeDepth'))
}
// What an older save holds is refused, not converted (fork 5).
const refused = async (label, edit) => {
  const old = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  edit(old)
  check(label, (await M.inputs.readWorldInputs(await old.generateAsync({ type: 'arraybuffer' }), ENGINE)) === null)
}
// A save with a chart raster the save step took out (DEC-0036): the
// elevation, the lakes' depth, the forcing — or a tectonic save without
// its mesh.
await refused('a save with the elevation raster (before the save step) is refused', (z) => z.file('elevation.f32', new Float32Array(W * H).buffer))
await refused('a save with the lakes\' depth raster (before the save step) is refused', (z) => z.file('layers/lakeDepth.u8', new Uint8Array(W * H).buffer))
await refused('a save with the forcing rasters (before the save step) is refused', (z) => { z.file('layers/uplift.f32', new Float32Array(4).buffer); z.file('layers/erodibility.f32', new Float32Array(4).buffer) })
await refused('a tectonic save without its mesh is refused', (z) => z.remove('mesh/nodes.f32'))
// A save whose climate is still the raster layers (before DEC-0036 phase
// 7) is refused, not converted.
await refused('a save with the climate as raster layers (before DEC-0036 phase 7) is refused', (z) => { z.file('layers/temperature.u8', new Uint8Array(W * H).buffer); z.file('layers/biome.u8', new Uint8Array(W * H).buffer) })
// A save whose hydrology is still the raster's (before DEC-0036 phase 7b):
// a discharge raster layer, or coast reaches over raster cells — refused.
await refused('a save with the discharge as a raster layer (before DEC-0036 phase 7b) is refused', (z) => z.file('layers/discharge.u16', new Uint16Array(W * H).buffer))
await refused('a save with the coast over raster cells (before DEC-0036 phase 7b) is refused', (z) => z.file('layers/coast.json', JSON.stringify({ reaches: [], cells: [5, 6] })))
{
  const fine = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  fine.file('layers/coast.json', JSON.stringify({ reaches: [], nodes: [5, 6] }))
  check('a save with the coast over the mesh\'s nodes opens', (await M.inputs.readWorldInputs(await fine.generateAsync({ type: 'arraybuffer' }), ENGINE)) !== null)
}
{
  // The screen's own refusal is the same function (GeneratorScreen's load).
  let threw = false
  const old = await JSZip.loadAsync(await zip.generateAsync({ type: 'arraybuffer' }))
  old.file('elevation.f32', new ArrayBuffer(4))
  try { writer.refuseFormerRasters(old) } catch { threw = true }
  let fine = true
  try { writer.refuseFormerRasters(zip) } catch { fine = false }
  check('the screen\'s refusal refuses the same, and opens the current form', threw && fine)
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
  const write = (refined) => writer.writeWorldArchive(zipParts({
    fields: { climate: null, land: null, refined, waterBodies: null, coast: null, sedimentBasins: null },
  }))
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
  const query = await L('/src/world/query.ts')
  const CMw = await L('/src/generator/climate/climateMesh.ts')
  const { OCEAN_PRECIP } = await L('/src/generator/climate/precipitation.ts')
  // What the last epoch left per node (MeshPayload): the flux, the start,
  // the ice — Float32, exact. The mantle's field-mesh values (formatVersion
  // 8) and the ocean age's (DEC-0036 phase 2) are section 5's: Float64, exact.
  const perNode = (f) => Float32Array.from({ length: zipCount }, (_, i) => f(i))
  const zipFlux = perNode((i) => (i % 3 === 0 ? 0 : i * 1234.5 / 7)), zipStart = perNode((i) => meshZ[i] + 0.01), zipIce = perNode((i) => (i % 4 === 1 ? 812.25 : 0))
  const zipEpoch = () => ({ sedimentFlux: zipFlux.buffer.slice(0), preErosionZ: zipStart.buffer.slice(0), ice: zipIce.buffer.slice(0) })
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
  const zipLand = { count: zipCount, biome: Uint8Array.from({ length: zipCount }, (_, i) => [0, 6, 11][i % 3]), koppen: Uint8Array.from({ length: zipCount }, (_, i) => [0, 14, 29][i % 3]), waterTable: perNode((i) => [-1, 12.5, 0][i % 3]), discharge: perNode((i) => [0, 1234.5, 1 / 3][i % 3]), lakeBody: zipLakeBody.slice() }
  // The coast over the mesh's nodes (DEC-0036 phase 7b): vertex ids.
  const zipCoast = { reaches: [{ id: 0, nodeStart: 0, nodeCount: 2, lengthKm: 12.5, exposure: 0.4, reliefM: 30, hardness: 1, supply: 0, type: 'beach', mouthReach: -1 }], nodes: new Int32Array([1, 2]) }
  const yaml = ['kind: FlatWorld', 'spec:', '  seed: "writer-welt"', '  erosion:', '    landscapeAge: 30', '    alluvium: 40', '    rockContrast: 55', 'metadata:', '  uid: 0192abcd-0000-8000-8000-00000000beef', ''].join('\n')
  const base = zipParts()
  const written = await writer.writeWorldArchive({
    ...base, yaml,
    mesh: { ...base.mesh, ...zipEpoch() },
    fields: {
      climate: zipClimate, land: zipLand,
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
    // The last epoch per node (2026-10-12): bit for bit, named in the
    // manifest; a save with a mesh and without the flux or the start is
    // refused, one without the ice (no epoch ran) is not.
    const zip = await JSZip.loadAsync(written)
    const sameF = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
    const epoch = await writer.readMeshEpochFiles(zip, zipCount)
    check('the last epoch\'s flux, start and ice come back per node, bit for bit', sameF(new Float32Array(epoch.sedimentFlux), zipFlux) && sameF(new Float32Array(epoch.preErosionZ), zipStart) && epoch.ice !== undefined && sameF(new Float32Array(epoch.ice), zipIce))
    check('the manifest names the last epoch\'s files', manifest.mesh?.files?.sedimentFlux === 'mesh/sedimentFlux.f32' && manifest.mesh?.files?.preErosionZ === 'mesh/preErosionZ.f32' && manifest.mesh?.files?.ice === 'mesh/ice.f32')
    let wrongCount = false
    try { await writer.readMeshEpochFiles(zip, zipCount + 1) } catch { wrongCount = true }
    check('the last epoch\'s files of another mesh are refused', wrongCount)
    zip.remove('mesh/ice.f32')
    check('a save without the ice (no epoch ran) reads, without it', (await writer.readMeshEpochFiles(zip, zipCount)).ice === undefined)
    zip.remove('mesh/sedimentFlux.f32')
    let refused = false
    try { await writer.readMeshEpochFiles(zip, zipCount) } catch { refused = true }
    check('a save with a mesh and without the sediment flux (a version-8 save from before it) is refused', refused)
  }
  {
    // The climate and the land fields on their meshes (DEC-0036 phase 7):
    // bit for bit, no raster layer of either.
    const zip = await JSZip.loadAsync(written)
    const climate = await writer.readClimate(zip)
    const sameF = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
    check('the climate comes back as its mesh values, bit for bit, with its mesh and the sea\'s marks', climate !== null && climate.cells === nc && climate.spacingM === cm.cellM
      && ['seaLevelTemperature', 'precipitation', 'seasonalAmplitude', 'monsoonIndex'].every((k) => sameF(climate[k], zipClimate[k])) && climate.precipitation[1] === OCEAN_PRECIP)
    const land = await writer.readLandFields(zip, zipCount)
    check('the land fields come back per node, bit for bit', land !== null && String(land.biome) === String(zipLand.biome) && String(land.koppen) === String(zipLand.koppen) && String(land.waterTable) === String(zipLand.waterTable))
    check('the water body per node comes back, bit for bit, named in the manifest', land !== null && String(land.lakeBody) === String(zipLakeBody) && manifest.mesh?.files?.lakeBody === 'mesh/lakeBody.i32')
    check('the discharge comes back per node, bit for bit, and no discharge raster is written', land !== null && land.discharge !== null && sameF(land.discharge, zipLand.discharge) && manifest.mesh?.files?.discharge === 'mesh/discharge.f32' && zip.file('layers/discharge.u16') === null && !manifest.layers.some((l) => l.name === 'discharge'))
    const coastBack = JSON.parse(await zip.file('layers/coast.json').async('string'))
    check('the coast comes back over the mesh\'s nodes, no raster cells', String(coastBack.nodes) === String(zipCoast.nodes) && coastBack.cells === undefined && JSON.stringify(coastBack.reaches) === JSON.stringify(zipCoast.reaches))
    let wrongCount = false
    try { await writer.readLandFields(zip, zipCount + 1) } catch { wrongCount = true }
    check('land fields of another mesh are refused', wrongCount)
    check('no climate, biome, Köppen or water-table raster layer is written', !manifest.layers.some((l) => ['landMask', 'temperature', 'precipitation', 'precipitationEffective', 'biome', 'seasonalAmplitude', 'monsoonIndex', 'koppen', 'waterTable'].includes(l.name)) && zip.file(/^layers\/(landMask|temperature|precipitation|biome|seasonal|monsoon|koppen|waterTable)/).length === 0)
    check('the manifest names the climate and the land files', manifest.climate?.file === 'climate.json' && manifest.mesh?.files?.biome === 'mesh/biome.u8' && manifest.mesh?.files?.waterTable === 'mesh/waterTable.f32')
    zip.remove('climate/monsoonIndex.f32')
    let partial = false
    try { await writer.readClimate(zip) } catch { partial = true }
    check('a climate with a field missing is refused', partial)
  }
  const back = await M.inputs.readWorldInputs(written, ENGINE)
  if (!back) check('the written archive reads back at all', false)
  else {
    check('the written mesh reads back', back.mesh?.count === zipCount && String(back.mesh?.z) === String(meshZ))
    check('the written recipe is read', back.seedText === 'writer-welt' && back.erosionControls.alluvium === 40 && back.worldUid === '0192abcd-0000-8000-8000-00000000beef')
    check('the written water bodies come back', JSON.stringify(back.waterBodies) === JSON.stringify(zipBodies))
    check('the bake\'s climate is the saved cells', back.climate !== null && back.climate.cells === nc && back.climate.precipitation[2] === zipClimate.precipitation[2])
    const direct = M.key.deriveWorldId({
      kind: 'FlatWorld', landscapeAge: 30, alluvium: 40, rockContrast: 55,
      mesh: { nodes: zipSerial.nodes, z: meshZ }, climate: zipClimate,
      forcing: { uplift: zipForcing.uplift, erodibility: zipForcing.hardness }, mantle: zipMantle, oceanAge: zipAge,
    })
    check('the worldId hashes the mesh, the climate\'s cells, the forcing and the field meshes', back.worldId === direct, `${back.worldId} vs ${direct}`)
    const world = await query.openWorld(written, ENGINE)
    const savedMesh = await world.mesh()
    check('the written mesh comes back as written', savedMesh !== null && savedMesh.count === zipCount && String(savedMesh.z) === String(meshZ) && String(savedMesh.connectivity) === String(zipSerial.connectivity))
    check('the manifest lists no raster layer', manifest.layers.every((l) => l.kind === 'table'))
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
check('a zip without a manifest is refused', (await M.inputs.readWorldInputs(await new JSZip().file('a.txt', 'x').generateAsync({ type: 'arraybuffer' }), ENGINE)) === null)

await server.close()
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

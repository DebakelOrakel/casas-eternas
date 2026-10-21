// Loads both builds from engine/dist/ and checks that they answer the same
// as each other through the engine's surface (docs/decisions/rust-engine.md,
// fork 4: WASM gives the native bits), on both shapes: the version; an
// Archean grown, rendered, saved and restored; the hand-over; coupled
// epochs (one shape under another planet) and their renders; the climate
// step, the hydrology with the climate v2, the refinement and the
// hydrology on it, the ecology on both, with its months, and what the
// migration reads of them; the tectonic save; a world restored from it,
// its climate with the saved refinement, its hydrology, its ecology, a
// stage's reset and its next epoch; the planet preview's climate; the
// replay at level 0 and the world it ends on. Then, native only, level 1
// by replay with its checkpoints and resumed from one, the tile plan on it
// and a level-3 tile baked with what it waits for, on two leaf splits. A
// save goes through JSON and back, as it does through a file.
//
// And the READ SIDE (fork 7b): the world layer's TypeScript that reads a
// save must give the engine's bits — the terrain's raster from the saved
// mesh, the lakes from the saved water bodies, the erosion's forcing from
// the snapshot.
//
// Until 2026-10-21 each value was also TypeScript's; the TypeScript engine
// went with fork 7c. Run by `make test` after `make engine`.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/', import.meta.url)
const wasm = await import(new URL('wasm/casas-engine.js', dist).href)
await wasm.default({ module_or_path: await readFile(new URL('wasm/casas-engine_bg.wasm', dist)) })

const CLIENT = fileURLToPath(new URL('../../client', import.meta.url))
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
// The native build through the job worker's loader.
const native = (await L('/scripts/engineNative.ts')).loadNativeEngine(fileURLToPath(new URL('casas-engine.node', dist)))
const { domainOfKind } = await L('/src/generator/core/domain.ts')
const { decodeMesh } = await L('/src/generator/mesh/meshSerial.ts')
const { rasteriseNodeField } = await L('/src/generator/mesh/meshRaster.ts')
const { waterFieldsFromMesh } = await L('/src/generator/mesh/meshHydrology.ts')
const { coarseForcingFields } = await L('/src/generator/pipeline/erosionForcing.ts')
const { defaultWeatherParams } = await L('/src/generator/climate/weather.ts')
const { DEFAULT_PLANET_FORCING } = await L('/src/generator/planet/planetForcing.ts')
const { TECTONICS_INPUTS } = await L('/src/generator/tectonics/tectonicsInputParams.ts')
const { sampleWorldElevation } = await L('/src/generator/planet/sampleWorld.ts')
const { SHELF_BREAK } = await L('/src/generator/elevation/elevationScale.ts')
const { CLIMATE_RES_X, CLIMATE_RES_Y } = await L('/src/generator/climate/climateField.ts')
const MT = await L('/src/generator/mesh/meshTile.ts')
const { cubeTileSamples } = await L('/src/generator/mesh/meshTileCube.ts')
await server.close()

let failed = false
const fail = (message) => {
  console.error(`engine: ${message}`)
  failed = true
}

if (native.version() !== wasm.version()) fail(`native ${native.version()} and wasm ${wasm.version()} differ`)

// A value as canonical JSON: keys sorted, typed arrays as their bytes'
// hex, so two values compare equal when their data does.
const canonical = (v) => {
  if (ArrayBuffer.isView(v)) return `"${v.constructor.name}:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')}"`
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const viaJson = (v) => JSON.parse(JSON.stringify(v))
// The builds' answers to the same call, each against the first's; the
// first's answer is returned.
const agree = (label, builds, read) => {
  const entries = Object.entries(builds)
  const want = read(entries[0][1])
  const text = canonical(want)
  for (const [name, b] of entries.slice(1)) if (canonical(read(b)) !== text) fail(`${label}: ${name} differs from ${entries[0][0]}`)
  return want
}
const each = (builds, f) => Object.values(builds).forEach(f)
const same = (label, a, b) => { if (canonical(a) !== canonical(b)) fail(label) }

// THE READ SIDE on a plates world: the raster of its saved mesh, the lakes
// of its saved water bodies after a hydrology, its forcing.
const readSide = (shape, w, rendered, hydrology) => {
  const m = w.meshPayload()
  const snap = w.snapshot()
  const domain = domainOfKind(shape, snap.width, snap.height)
  const mesh = decodeMesh(domain, { count: m.count, nodes: m.nodes, connectivity: m.connectivity })
  same(`${shape}: the read side's raster of the saved mesh differs from the engine's render`, rasteriseNodeField(mesh, m.z, snap.width, snap.height), rendered.elevations)
  const water = waterFieldsFromMesh(mesh, w.landPayload().lakeBody, hydrology.waterBodies, rendered.elevations, snap.width, snap.height)
  same(`${shape}: the read side's lakes from the saved water bodies differ from the engine's`, water.depth, hydrology.lakeDepth)
  const forcing = coarseForcingFields({ features: snap.features, rafts: snap.rafts, sutures: snap.sutures ?? [], epoch: snap.epoch, archeanEpochs: snap.archeanEpochs ?? 0, warpSeed: snap.warpSeed }, domain)
  same(`${shape}: the read side's forcing from the snapshot differs from the engine's`, forcing, w.forcing())
}

const SLIDERS = [
  { carryingCapacity: 100, concentration: 0, provinceStrength: 0.45 },
  { carryingCapacity: 140, concentration: 30, provinceStrength: 0.8, tinRarity: 0.6, weights: { fish: 1.5, gold: 0.5, copper: 1.2 } },
]
// Returns how many of the months asked had a month to give.
const agreeEcology = (label, worlds) => {
  SLIDERS.forEach((params, k) => agree(`${label} (sliders ${k + 1})`, worlds, (w) => w.ecology(params)))
  let months = 0
  for (const [field, month] of [['fish', 1], ['arable', 7], ['salt', 12], ['timber', 3]]) {
    if (agree(`${label}: ${field} in month ${month}`, worlds, (w) => w.ecologyMonth(field, month)).data.length > 0) months++
  }
  return months
}
const saveFields = (w) => [w.climatePayload(), w.landPayload()]

const STEPS = 60
const EPOCHS = 6
for (const shape of ['torus', 'sphere']) {
  const [seed, width, height, diffusion, landShare] = ['smoke', 512, 256, 2, 0.4]
  const worlds = { native: native.World.genesis(seed, width, height, shape, diffusion, landShare), wasm: wasm.World.genesis(seed, width, height, shape, diffusion, landShare) }
  for (let i = 0; i < STEPS; i++) {
    each(worlds, (w) => w.archeanStep())
    if (i % 20 === 19) agree(`${shape}: the Archean's render at step ${i + 1}`, worlds, (w) => w.render(i % 40 === 19 ? 2 : 1))
  }
  // The Archean's save, through JSON as a file takes it, restored and
  // stepped on in both builds under other controls.
  const save = agree(`${shape}: the Archean's save`, worlds, (w) => w.archeanSave())
  const saved = { snapshot: viaJson(save.snapshot), mantle: save.mantle, streak: Int16Array.from(save.streak) }
  const again = {
    native: native.World.restoreArchean(shape, saved.snapshot, saved.mantle, saved.streak, diffusion, landShare),
    wasm: wasm.World.restoreArchean(shape, saved.snapshot, saved.mantle, saved.streak, diffusion, landShare),
  }
  each(again, (w) => w.setArcheanControls(diffusion + 0.5, landShare))
  for (let i = 0; i < 5; i++) each(again, (w) => w.archeanStep())
  agree(`${shape}: the restored Archean`, again, (w) => w.mantle())
  again.wasm.free()

  // The hand-over and the coupled epochs; the torus under another planet.
  each(worlds, (w) => w.finalize())
  const weather = shape === 'torus' ? { ...defaultWeatherParams(), planet: { ...DEFAULT_PLANET_FORCING, obliquityDeg: 31, rotationHours: 30 } } : defaultWeatherParams()
  const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default, weather }
  let rendered = agree(`${shape}: the hand-over's render`, worlds, (w) => w.render(1))
  let eventCount = 0
  for (let e = 0; e < EPOCHS; e++) {
    eventCount += agree(`${shape}: epoch ${e + 1}'s events`, worlds, (w) => w.epoch(controls)).length
    if (e % 2 === 1) rendered = agree(`${shape}: epoch ${e + 1}'s render`, worlds, (w) => w.render(1))
  }

  // The climate step, its refinement, the hydrology, the ecology.
  agree(`${shape}: the climate`, worlds, (w) => w.climate(weather))
  agree(`${shape}: the migration's inputs on the climate`, worlds, (w) => w.migrationInputs())
  const planet = weather.planet ?? null
  agree(`${shape}: the hydrology with the v2`, worlds, (w) => w.hydrology(planet))
  agree(`${shape}: the migration's inputs on the hydrology`, worlds, (w) => w.migrationInputs())
  agreeEcology(`${shape}: the ecology on the annual climate`, worlds)
  const refinement = agree(`${shape}: the refinement`, worlds, (w) => w.refineClimate(null))
  const routed = agree(`${shape}: the hydrology`, worlds, (w) => w.hydrology(planet))
  agree(`${shape}: the hydrology again`, worlds, (w) => w.hydrology(planet))
  agree(`${shape}: the migration's inputs on the refinement`, worlds, (w) => w.migrationInputs())
  const months = agreeEcology(`${shape}: the ecology on the refinement`, worlds)
  const water = `${routed.riverGraph.reaches.length} reaches, ${routed.waterBodies.length} water bodies, ${routed.coast.reaches.length} coast reaches, ${routed.sedimentBasins.length} sediment basins`
  readSide(shape, worlds.native, rendered, routed)

  // The tectonic save; its JSON as the world layer writes it.
  agree(`${shape}: the save's climate and land fields`, worlds, saveFields)
  const snapshot = agree(`${shape}: the snapshot`, worlds, (w) => w.snapshot())
  const json = JSON.stringify(snapshot)
  each(worlds, (w) => { if (JSON.stringify(w.snapshot()) !== json) fail(`${shape}: the snapshot's JSON differs`) })
  const [mantle, oceanAge] = agree(`${shape}: the saved fields`, worlds, (w) => w.savedFields())
  const lattice = agree(`${shape}: the lattice`, worlds, (w) => w.lattice())
  const mesh = agree(`${shape}: the mesh payload`, worlds, (w) => w.meshPayload())
  agree(`${shape}: the forcing`, worlds, (w) => w.forcing())

  // The world restored from its save goes on as the world it was saved
  // from: its next epoch is the uninterrupted one's.
  const back = JSON.parse(json)
  const restored = {
    native: native.World.restorePlates(shape, back, oceanAge, mantle, lattice, mesh),
    wasm: wasm.World.restorePlates(shape, back, oceanAge, mantle, lattice, mesh),
  }
  same(`${shape}: the restored world's snapshot differs`, restored.native.snapshot(), snapshot)
  const all = { ...worlds, ...Object.fromEntries(Object.entries(restored).map(([k, w]) => [`restored ${k}`, w])) }
  agree(`${shape}: the render of the world and of its restore`, all, (w) => w.render(1))
  agree(`${shape}: the climate of the world and of its restore`, all, (w) => w.climate(weather))
  agree(`${shape}: the saved refinement`, all, (w) => w.refineClimate(refinement.refined.refined))
  agree(`${shape}: the hydrology of the world and of its restore`, all, (w) => w.hydrology(planet))
  agreeEcology(`${shape}: the ecology of the world and of its restore`, all)
  agree(`${shape}: the climate and land fields of the world and of its restore`, all, saveFields)
  each(all, (w) => w.dropStage('climate'))
  agree(`${shape}: the land fields after a reset of the climate`, all, (w) => w.landPayload())
  each(all, (w) => w.epoch(controls))
  agree(`${shape}: the next epoch of the world and of its restore`, all, (w) => [w.snapshot(), w.meshPayload()])
  each(all, (w) => { if (JSON.stringify(w.snapshot()) !== JSON.stringify(all.native.snapshot())) fail(`${shape}: the next epoch's snapshot JSON differs`) })
  restored.wasm.free()
  worlds.wasm.free()
  console.log(`engine: ${shape} — ${STEPS} Archean steps saved and restored; the hand-over, ${EPOCHS} epochs (${eventCount} events, ${mesh.count} nodes) saved and restored; the climate, the hydrology (${water}), the ecology (${months} of 4 months given), the read side: native and wasm agree`)
}

// THE PLANET PREVIEW (the runtime's handlePlanetPreview): the climate on
// the sample world of both shapes, twice under other controls (the
// meshes' walks go on from the first), on one Preview of each build.
{
  const previews = { native: new native.Preview(), wasm: new wasm.Preview() }
  const [width, height] = [128, 64]
  for (const shape of ['torus', 'sphere']) {
    const elevation = sampleWorldElevation(domainOfKind(shape, width, height))
    for (const params of [defaultWeatherParams(), { ...defaultWeatherParams(), temperatureOffset: 3, humidity: 1.2 }]) {
      agree(`${shape}: the preview's climate`, previews, (p) => p.climate(shape, width, height, elevation, params))
    }
  }
  console.log('engine: the planet preview on both shapes, twice each: native and wasm agree')
}

// THE REPLAY AT LEVEL 0 (the runtime's handleReplayRuns): the world a
// plan's replay ends on.
const controls = { alluvium: TECTONICS_INPUTS.alluvium.default, rockContrast: TECTONICS_INPUTS.rockContrast.default }
const planOf = (seed, width, height, shape) => ({
  seed, width, height, shape,
  genesis: [{ epochs: 40, diffusion: 2, landShare: 0.4 }],
  tectonics: [{ epochs: 4, controls, weather: defaultWeatherParams() }, { epochs: 3, controls, weather: { ...defaultWeatherParams(), temperatureOffset: -2 }, restored: true }],
})
for (const shape of ['torus', 'sphere']) {
  const plan = planOf('level0', 256, 128, shape)
  const worlds = {}
  for (const [name, build] of Object.entries({ native, wasm })) {
    const replay = build.Replay.start(plan, 0)
    while (replay.step());
    worlds[name] = replay.world()
  }
  const [snapshot] = agree(`${shape}: the replayed world`, worlds, (w) => [w.snapshot(), w.meshPayload()])
  worlds.wasm.free()
  console.log(`engine: ${shape} — a plan replayed at level 0 (${snapshot.epoch} epochs): native and wasm agree`)
}

// A level's tiles with land or shelf on the save's raster, as the job
// worker's landTiles and cubeLandTiles find them (scripts/jobWorker.ts;
// copied, since that module runs a worker when it loads).
const landTilesOf = (world, elevations, level) => {
  const spec = MT.tileSpec(level)
  const { width, height } = world
  const out = []
  if (world.kind === 'sphere') {
    cubeTileSamples(world, spec.level, spec.cells, (tile, xs, ys) => {
      for (let k = 0; k < xs.length; k++) {
        const x = Math.min(width - 1, Math.floor(xs[k]))
        const y = Math.min(height - 1, Math.max(0, Math.floor(ys[k])))
        if (elevations[y * width + x] > SHELF_BREAK) { out.push([tile.x, tile.y]); return }
      }
    })
    return out
  }
  const { cols, rows } = MT.tileGrid(width, height, spec)
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const corner = MT.tileCorner({ level, x: tx, y: ty }, spec)
      let found = false
      for (let dy = 0; dy < spec.cells && !found; dy++) {
        const y = (corner.y + dy) % height
        for (let dx = 0; dx < spec.cells; dx++) if (elevations[y * width + (corner.x + dx) % width] > SHELF_BREAK) { found = true; break }
      }
      if (found) out.push([tx, ty])
    }
  }
  return out
}
// The tiles a tile waits for, itself last, deduplicated: what a worker
// bakes before it.
const closureOf = (plan, target) => {
  const byKey = new Map(plan.map((p) => [`${p.tile.level}:${p.tile.x},${p.tile.y}`, p]))
  const order = []
  const seen = new Set()
  const visit = (t) => {
    const k = `${t.level}:${t.x},${t.y}`
    if (seen.has(k)) return
    seen.add(k)
    const p = byKey.get(k)
    for (const d of [...p.parents, ...p.upstream]) visit(d)
    order.push(p)
  }
  visit(target)
  return order
}

// LEVEL 1 BY REPLAY, native only (fork 3): the plan replayed at level 1's
// budget one epoch at a time with its checkpoints, the level's waters on
// its end as the artifact holds them, and the replay resumed from its last
// checkpoint, its state through JSON as a checkpoint's state.json goes,
// landing on the same level. Then the tile levels on it: the plan, and a
// level-3 tile with its closure baked in order — the level-2 parents with
// their upstream tiles, the level-3 upstream ones — on one baker, as a
// worker does, once on four leaf blocks and once on one (the pooled
// scheme gives the same bytes for every split).
for (const shape of ['torus', 'sphere']) {
  const [width, height, detailSeed] = [512, 256, 12345]
  const plan = planOf('replay', width, height, shape)
  const replay = native.Replay.start(plan, 1, null, 4)
  const due = []
  for (;;) {
    const position = replay.checkpointDue()
    if (position) due.push({ position, snapshot: replay.snapshot() })
    if (!replay.step()) break
  }
  const level = replay.level(width, detailSeed)
  if (due.length === 0) fail(`${shape}: level 1's replay offered no checkpoint`)
  else {
    const at = due[due.length - 1]
    const resumed = native.Replay.start(plan, 1, { position: at.position, snapshot: { ...at.snapshot, state: viaJson(at.snapshot.state) } }, null)
    while (resumed.step());
    same(`${shape}: level 1 resumed from its checkpoint differs`, resumed.level(width, detailSeed), level)
  }

  // The save's inputs a tile bake reads, from the world at level 0 the
  // same plan replays to.
  const r0 = native.Replay.start(plan, 0)
  while (r0.step());
  const w0 = r0.world()
  const elevations = w0.render(1).elevations
  const land = Object.fromEntries([2, 3].map((l) => [l, landTilesOf(domainOfKind(shape, width, height), elevations, l)]))
  const tilePlan = native.planTiles(level, width, height, shape, land)
  const third = tilePlan.filter((p) => p.tile.level === 3).map((p) => closureOf(tilePlan, p.tile))
  const withUpstream = third.filter((c) => c.some((p) => p.upstream.length > 0))
  const bakes = (withUpstream.length ? withUpstream : third).sort((a, b) => a.length - b.length)[0]
  w0.climate(defaultWeatherParams())
  const { uplift, hardness } = w0.forcing()
  const save = { width, height, shape, detailSeed, lithoSeed: 777, controls, uplift, erodibility: hardness, forcingResX: CLIMATE_RES_X, forcingResY: CLIMATE_RES_Y, climate: w0.climatePayload() }
  const keyOf = (t) => `${t.level}:${t.x},${t.y}`
  const bakeAll = (leafWorkers) => {
    const baker = native.TileBaker.open(level, save, leafWorkers)
    const done = new Map()
    for (const p of bakes) {
      const t = p.tile
      const upstream = p.upstream.map((u) => done.get(keyOf(u))).map((a) => ({ tile: a.tile, count: a.count, nodes: a.nodes, outflow: a.outflow }))
      const pieces = t.level === 3 ? p.parents.map((q) => done.get(keyOf(q))).map((a) => ({ tile: a.tile, count: a.count, nodes: a.nodes, z: a.z })) : null
      done.set(keyOf(t), baker.bake(t, pieces, upstream, 2))
    }
    return [...done.values()]
  }
  same(`${shape}: the tiles baked on four leaf blocks and on one differ`, bakeAll(4), bakeAll(1))
  console.log(`engine: ${shape} — level 1 replayed (${level.count} nodes, ${level.graph.reaches.length} reaches), ${due.length} checkpoints, resumed; the tile plan (${tilePlan.length} tiles), ${bakes.length} tiles baked on two leaf splits (${bakes.filter((p) => p.upstream.length).length} with upstream): the same`)
}

if (failed) process.exit(1)
console.log(`engine: native and wasm ${wasm.version()}`)
process.exit(0)

// Regression harness for the worldgen pipeline — three layers, deliberately,
// plus a fourth that only exists while someone is refactoring.
//
//   npm run harness:golden          run every layer, exit non-zero on a failure
//   npm run harness:golden:record   overwrite golden.json with the current measurements
//   npm run harness:golden:hash     write golden-hashes.json — the refactor guard (layer 4)
//
// WHY THIS IS NOT A HASH HARNESS ANY MORE. It used to hash the raw bytes of
// every stage and compare them against a recorded file. That is exactly right
// for catching a refactor that was meant to change nothing — and exactly wrong
// as the ONLY check, because every deliberate tuning change also breaks it. A
// gate that goes red when you did the right thing teaches people to ignore it,
// and that is measurably what happened: the baseline sat unchanged through
// thirty-odd worldgen commits while the harness reported 105 of 135 hashes
// "wrong", none of which were bugs.
//
// What it caught in that time was never a hash. It was NaN carryingCapacity on
// every land cell, and a migration origin that landed in the ocean on all three
// seeds — invariants, found because someone read the code. So:
//
//   1. INVARIANTS   things that must hold in every world, ever. No baseline, so
//                   they cannot go stale, and a failure is always a bug.
//   2. DETERMINISM  one seed built twice in the same run, hashed, compared to
//                   itself. This is where bit-exactness genuinely belongs: it
//                   answers "is the pipeline reproducible", which is a property
//                   of the code and needs no stored file.
//   3. METRICS      measured magnitudes against golden.json, with tolerances,
//                   reported as deltas ("land 8.52% -> 11.31%, +2.79pp"). A
//                   tuning change still shows up — but as a number you can
//                   judge and then re-record on purpose, not as a wall of
//                   changed hex.
//   4. BYTE HASHES  the wall above, back — but OPT-IN and temporary. It does
//                   not exist unless someone records a baseline, so it cannot
//                   go stale on anyone who did not ask for it, and deleting
//                   golden-hashes.json removes the layer entirely. Its one job
//                   is a refactor that is supposed to change NOTHING, which the
//                   other three cannot check: metrics carry a 2% tolerance, so a
//                   sub-percent shift passes green, and determinism only ever
//                   compares a run against itself inside one process, never
//                   against a previous version of the code.
//
// It goes through Vite's SSR pipeline rather than plain node, because the
// worldgen modules use extensionless imports that node will not resolve.
//
// Worlds are built the way the program builds them: an Archean run, then the
// handover to plate tectonics. That matters — this harness used to call the old
// createPlateSimulation with the four Genesis sliders, and so guarded a code
// path nothing reached any more while the live one went unguarded.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const OUT = fileURLToPath(new URL('./golden.json', import.meta.url))
// Layer 4's baseline, kept in its OWN file rather than as a section of
// golden.json: the two have opposite lifetimes. golden.json is permanent and
// re-recorded on purpose whenever tuning moves; this one is scaffolding that
// gets deleted when a refactor lands, and deleting a file is a cleaner way to
// end a layer than editing a shared one.
const HASHES = fileURLToPath(new URL('./golden-hashes.json', import.meta.url))
const MODE = process.argv[2] ?? 'check'
const SEEDS = ['calibration', 'alpha', 'bravo']
const EPOCHS = 50
const ARCHEAN_EPOCHS = 180
const W = 2048, H = 1024

// How far a measurement may drift before it is reported. 2% is tight enough
// that a real change surfaces and loose enough that floating-point summation
// order does not. Per-metric overrides go in TOLERANCE_OVERRIDES, keyed by
// exact name or by prefix — counts of rare things (peaks, delta cells) swing
// harder than field means for reasons that are not regressions.
const TOLERANCE = 0.02
const TOLERANCE_OVERRIDES = [
  ['erosion.deltaCells', 0.25],
  ['erosion.peaks', 0.10],
  ['hydro.lakeCells', 0.10],
  ['.rich', 0.15],
  ['tectonics.', 0.10],
  ['mig.', 0.10],
]

const toleranceFor = (name) => {
  for (const [key, value] of TOLERANCE_OVERRIDES) if (name === key || name.startsWith(key) || name.endsWith(key)) return value
  return TOLERANCE
}

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

// Modules are loaded by PATH. If files move, this block is the only thing to update.
const M = {
  sim: await L('/src/worldgen/tectonics/plateSimulation.ts'),
  params: await L('/src/worldgen/tectonics/tectonicsTuneParams.ts'),
  field: await L('/src/worldgen/elevation/elevationField.ts'),
  ridged: await L('/src/worldgen/elevation/ridgedNoise.ts'),
  erosion: await L('/src/worldgen/surface/erosion.ts'),
  routing: await L('/src/worldgen/surface/flowRouting.ts'),
  hydro: await L('/src/worldgen/surface/hydrology.ts'),
  scale: await L('/src/worldgen/elevation/elevationScale.ts'),
  climateField: await L('/src/worldgen/climate/climateField.ts'),
  temperature: await L('/src/worldgen/climate/temperature.ts'),
  wind: await L('/src/worldgen/climate/wind.ts'),
  currents: await L('/src/worldgen/climate/oceanCurrents.ts'),
  precip: await L('/src/worldgen/climate/precipitation.ts'),
  seasonality: await L('/src/worldgen/climate/seasonality.ts'),
  monsoon: await L('/src/worldgen/climate/monsoon.ts'),
  biomes: await L('/src/worldgen/climate/biomes.ts'),
  ecology: await L('/src/worldgen/ecology/ecologyField.ts'),
  migration: await L('/src/worldgen/migration/migrationField.ts'),
  rafts: await L('/src/worldgen/crust/raftField.ts'),
  volcanoes: await L('/src/worldgen/tectonics/volcanoes.ts'),
  archean: await L('/src/worldgen/archean/archeanState.ts'),
  archeanStep: await L('/src/worldgen/archean/archeanStep.ts'),
  finalize: await L('/src/worldgen/archean/finalizeArchean.ts'),
  // Not part of building a world — see PIPELINE_VERSION below.
  artifact: await L('/src/world/artifacts.ts'),
}

const SEA = M.scale.SEA_LEVEL
const METRES = M.scale.ELEVATION_METERS

// The key every cached 4k/8k bake is addressed by, local and on the server.
//
// It is not a world property and nothing here builds one — it is in the guard
// because it is a PRODUCT OF CONSTANTS, and those constants are exactly what
// part B regroups into objects. Rename one key in AMPLIFY_CONSTANTS and this
// string moves; every stored artifact is then orphaned under a key that still
// claims to describe it, which reads as a physics bug rather than a cache
// fault. That is the failure the artifact design exists to prevent, and until
// now nothing checked it.
//
// Calls the REAL function rather than reassembling the spread, which this line
// used to do — a guard that rebuilds what it is guarding cannot notice the two
// drifting apart. Every caller now goes through `amplificationPipelineVersion`
// (part B3), so this checks the same thing the screens and the baker do.
const PIPELINE_VERSION = M.artifact.amplificationPipelineVersion()

// Float32 hashing has to be bit-exact, so hash the raw bytes rather than any
// rounded form — a refactor that changes the last mantissa bit is still a
// change, and the determinism layer is the only thing that will catch it.
const hashBytes = (typed) => createHash('sha256').update(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)).digest('hex').slice(0, 16)

// --- measurement helpers ---------------------------------------------------

function stats(values) {
  let min = Infinity, max = -Infinity, sum = 0, nonFinite = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) { nonFinite++; continue }
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  const counted = values.length - nonFinite
  return { min, max, mean: counted > 0 ? sum / counted : 0, nonFinite }
}

const countWhere = (values, predicate) => {
  let n = 0
  for (let i = 0; i < values.length; i++) if (predicate(values[i])) n++
  return n
}

// Mean drop from a local maximum to its eight neighbours, in metres — the
// measure that made the ridgeline work assessable at all. A crest is sharp, a
// dome is not, and no hash can tell you which way it moved.
function crestMetrics(el) {
  let peaks = 0, sharpness = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const v = el[i]
      if (v <= SEA) continue
      let drop = 0, isMax = true
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const n = el[(y + dy) * W + ((x + dx + W) % W)]
          if (n >= v) { isMax = false; break }
          drop += v - n
        }
      }
      if (!isMax) continue
      peaks++
      sharpness += (drop / 8) * METRES
    }
  }
  return { peaks, sharpness: peaks > 0 ? sharpness / peaks : 0 }
}

// --- building one world ----------------------------------------------------

async function buildWorld(seed) {
  const archean = M.archean.createArcheanSimulation(seed, W, H)
  for (let e = 0; e < ARCHEAN_EPOCHS; e++) M.archeanStep.archeanStep(archean)
  const sim = M.finalize.finalizeArchean(archean)
  for (let e = 0; e < EPOCHS; e++) M.sim.stepEpoch(sim)

  const baseline = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, W, H, sim.warpSeed)
  const buckets = M.field.buildFeatureBuckets(sim.features, W, H)
  const fineSalt = (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0
  const raw = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
      raw[y * W + x] = M.field.computeElevation(s.wx, s.wy, baseline[y * W + x], buckets, W, H,
        M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed),
        M.ridged.fineDetailNoise(s.wx, s.wy, W, H, fineSalt))
    }
  }

  const ero = await M.erosion.runErosionPass(raw, W, H, M.erosion.DEFAULT_EROSION_PASS_PARAMS)
  const el = ero.elevations

  const temperature = M.temperature.computeTemperature(el, W, H)
  const wind = M.wind.computeWind()
  const currents = M.currents.computeOceanCurrents(el, wind, W, H)
  M.currents.applyOceanSST(temperature, currents, el, W, H)
  const seasonal = M.seasonality.computeSeasonalAmplitude(el, W, H)
  const seasonalPrecip = M.monsoon.computeSeasonalPrecipitation(el, temperature, seasonal, wind, W, H, 1, 0)
  let precipitation = seasonalPrecip.annual
  const biomes = M.biomes.computeBiomes(temperature, precipitation, seasonal, seasonalPrecip.index, el, W, H)
  // The worker computes BOTH, and only the coarse one was guarded here. The
  // fine one is what the user sees and what the save bakes (worldLayers marks
  // `biome` fullRes), so leaving it out meant the harness watched the path with
  // the fewer consequences. Same arguments as above, deliberately — a
  // divergence between the two calls would be the harness's own bug.
  const biomesFine = M.biomes.computeBiomesFine(temperature, precipitation, seasonal, seasonalPrecip.index, el, W, H)

  const routing = await M.routing.fillDepressionsAndRouteFlow(el, W, H, 0)
  const CRX = M.climateField.CLIMATE_RES_X, CRY = M.climateField.CLIMATE_RES_Y
  const meanRunoff = M.hydro.meanLandRunoff(precipitation, el, W, H, CRX, CRY)
  let discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
  let maxDis = M.hydro.maxDischargeOverLand(discharge, el)
  // Terminal-basin refinement, mirroring the worker (k=1): lakes v1 -> if any
  // dry basin floor, climate v2 with the land override -> discharge/lakes v2.
  let lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, temperature, precipitation, CRX, CRY)
  if (lakes.dryBasin.some((v) => v === 1)) {
    const t2 = M.temperature.computeTemperature(el, W, H, 0, 1, 0, lakes.dryBasin)
    const c2 = M.currents.computeOceanCurrents(el, wind, W, H, lakes.dryBasin)
    M.currents.applyOceanSST(t2, c2, el, W, H, lakes.dryBasin)
    const s2 = M.seasonality.computeSeasonalAmplitude(el, W, H, 0, lakes.dryBasin)
    const sp2 = M.monsoon.computeSeasonalPrecipitation(el, t2, s2, wind, W, H, 1, 0, lakes.dryBasin)
    precipitation = sp2.annual
    discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
    maxDis = M.hydro.maxDischargeOverLand(discharge, el)
    lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, t2, precipitation, CRX, CRY)
  }

  const cratonAge = M.rafts.computeCratonOldnessField(sim.rafts, sim.epoch, CRX, CRY, W, H)
  // Real volcanoes and sutures, and real params — through the very function the
  // worker uses, not a copy of it. This used to pass empty arrays and `{}`,
  // which made carryingCapacity NaN on every land cell. Being JS, nothing
  // complained; the NaN hashed consistently, so those stages guarded nothing.
  // That is the bug INVARIANTS now catch directly.
  const volcanoes = M.volcanoes.collectVolcanoes(sim.features)
  const eco = M.ecology.computeEcology({
    temperature, precipitation, biomes, currents, elevation: el,
    discharge, maxDischarge: maxDis, lakeDepth: lakes.depth, volcanoes,
    orogenPoints: sim.sutures.map((s) => ({ x: s.x, y: s.y })),
    cratonAge, warpSeed: sim.warpSeed, worldWidth: W, worldHeight: H,
  }, { carryingCapacity: 100, concentration: 0 })

  // The origin has to be picked FROM the world, not fixed by index. It used to
  // be cell CRX*CRY*0.4, and at 3-11% land that cell was ocean on all three
  // seeds — so the spread never ran and three outputs were constants that
  // hashed identically no matter what happened upstream.
  let originCell = -1, bestCapacity = -Infinity
  for (let i = 0; i < CRX * CRY; i++) {
    if (precipitation[i] === M.precip.OCEAN_PRECIP) continue
    const cap = eco.fields.carryingCapacity[i]
    if (cap > bestCapacity) { bestCapacity = cap; originCell = i }
  }
  const mig = M.migration.computeMigration(
    eco.fields.carryingCapacity, precipitation, el, null, 0,
    [{ cell: originCell, race: 0 }], W, H,
    { spreadBudget: 400, seaCrossing: 0.3 },
  )

  return { sim, raw, ero, el, temperature, wind, currents, seasonal, seasonalPrecip, precipitation, biomes, biomesFine, routing, discharge, maxDis, meanRunoff, lakes, volcanoes, eco, mig, originCell, CRX, CRY }
}

// --- layer 1: invariants ---------------------------------------------------
//
// Every one of these is a statement about ANY world, so none of them has a
// recorded value and none can go stale. A failure here is a bug, never a
// judgement call — which is the difference from the metrics below.

function invariants(w) {
  const failures = []
  const fail = (name, detail) => failures.push(`${name}: ${detail}`)

  const rasters = {
    'elevation.raw': w.raw,
    'elevation.eroded': w.el,
    temperature: w.temperature,
    precipitation: w.precipitation,
    discharge: w.discharge,
    'lakes.depth': w.lakes.depth,
    seasonality: w.seasonal,
    ...Object.fromEntries(Object.keys(w.eco.fields).map((k) => [`eco.${k}`, w.eco.fields[k]])),
  }
  // NaN is the failure mode this pipeline actually has: it propagates silently
  // through float maths, hashes consistently, and only shows up as a blank
  // patch on a map weeks later.
  for (const [name, raster] of Object.entries(rasters)) {
    const s = stats(raster)
    if (s.nonFinite > 0) fail(name, `${s.nonFinite} non-finite values`)
  }

  const land = countWhere(w.el, (v) => v > SEA) / (W * H)
  if (!(land > 0.01 && land < 0.6)) fail('land fraction', `${(land * 100).toFixed(2)}% is outside 1–60%`)

  const elev = stats(w.el)
  if (elev.max * METRES > METRES + 1) fail('elevation', `max ${(elev.max * METRES).toFixed(0)} m exceeds the clamp`)
  if (elev.min * METRES < -METRES - 1) fail('elevation', `min ${(elev.min * METRES).toFixed(0)} m exceeds the clamp`)

  // The plate-count floor exists because a simulation that collapses to one
  // plate is kinematically frozen for the rest of the run. The ceiling is the
  // other direction of the same runaway, which had never been checked.
  const plates = w.sim.seeds.length
  if (plates < M.params.TECTONICS_TUNING.minPlateCount) fail('plates', `${plates} is below minPlateCount ${M.params.TECTONICS_TUNING.minPlateCount}`)
  if (plates > 40) fail('plates', `${plates} — runaway upward`)
  if (w.sim.rafts.length === 0) fail('rafts', 'no continental crust survived')
  if (w.sim.features.length === 0) fail('features', 'no terrain features')
  if (w.volcanoes.length === 0) fail('volcanoes', 'none collected — the ecology inputs would be empty')

  // Rivers have to exist, or hydrology, ecology and migration are all running
  // on a world with no fresh water.
  const channels = countWhere(w.discharge, (v) => v >= 2000)
  if (channels === 0) fail('rivers', 'no channel cells')

  // Every land cell must be classified, or the map renders a hole.
  //
  // This check used to read `w.biomes[i] < 0` and could never fire: the field
  // is a Uint8Array, so it has no negative values to find. It is the same dead
  // guard the coverage layer exists to expose, and it survived because nothing
  // compares invariants across seeds the way metrics are compared.
  //
  // The live form uses the FINE field, where a biome cell and an elevation cell
  // are the same cell, so "land" needs no resampling: `Biome.Ocean` on a cell
  // above sea level means classify() returned nothing usable.
  let unclassified = 0
  for (let i = 0; i < w.el.length; i++) {
    if (w.el[i] > SEA && w.biomesFine[i] === M.biomes.Biome.Ocean) unclassified++
  }
  if (unclassified > 0) fail('biomes', `${unclassified} land cells are unclassified (Ocean above sea level)`)

  // Ecology writes ECOLOGY_OCEAN (-1) on open water as a documented sentinel,
  // so "no negatives" was the wrong invariant — the first run flagged all 14
  // fields on all 3 seeds. What must hold is that a cell is EITHER unscored or
  // non-negative: a scored cell going negative is the actual bug class, and it
  // would otherwise hide behind the sentinel.
  for (const [name, field] of Object.entries(w.eco.fields)) {
    let below = 0
    for (let i = 0; i < field.length; i++) {
      if (field[i] < 0 && field[i] !== M.ecology.ECOLOGY_OCEAN) below++
    }
    if (below > 0) fail(`eco.${name}`, `${below} scored cells are negative`)
  }

  if (w.originCell < 0) fail('migration', 'no land origin found')
  const reached = countWhere(w.mig.density, (v) => v > 0)
  if (reached === 0) fail('migration', 'the spread reached no cells')

  return failures
}

// --- layer 3: metrics ------------------------------------------------------

function metrics(w) {
  const out = {}
  const put = (name, value) => { out[name] = Number(value.toFixed(6)) }

  put('tectonics.plates', w.sim.seeds.length)
  put('tectonics.rafts', w.sim.rafts.length)
  put('tectonics.features', w.sim.features.length)
  put('tectonics.sutures', w.sim.sutures.length)
  put('tectonics.volcanoes', w.volcanoes.length)

  const rawLand = countWhere(w.raw, (v) => v > SEA) / (W * H)
  const land = countWhere(w.el, (v) => v > SEA) / (W * H)
  put('elevation.landFractionRaw', rawLand * 100)
  put('elevation.landFraction', land * 100)
  const elev = stats(w.el)
  put('elevation.maxM', elev.max * METRES)
  put('elevation.minM', elev.min * METRES)

  const crest = crestMetrics(w.el)
  put('erosion.peaks', crest.peaks)
  put('erosion.crestM', crest.sharpness)
  // Cells the pass raised from below sea level — the delta signal, and the one
  // the delta-gate rescaling moved.
  let deltaCells = 0
  for (let i = 0; i < w.el.length; i++) if (w.raw[i] <= SEA && w.el[i] > w.raw[i] + 1e-6) deltaCells++
  put('erosion.deltaCells', deltaCells)

  const temp = stats(w.temperature)
  put('climate.tempMeanC', temp.mean)
  put('climate.tempMinC', temp.min)
  put('climate.tempMaxC', temp.max)
  put('climate.precipMean', stats(w.precipitation).mean)
  // Biome mix as fractions: a shift here is a climate change with a visible
  // consequence, which a hash could never express.
  const biomeCounts = new Map()
  for (let i = 0; i < w.biomes.length; i++) biomeCounts.set(w.biomes[i], (biomeCounts.get(w.biomes[i]) ?? 0) + 1)
  for (const id of [...biomeCounts.keys()].sort((a, b) => a - b)) {
    put(`biome.${id}`, (biomeCounts.get(id) / w.biomes.length) * 100)
  }

  put('hydro.meanRunoff', w.meanRunoff)
  put('hydro.maxDischarge', w.maxDis)
  put('hydro.channelCells', countWhere(w.discharge, (v) => v >= 2000))
  put('hydro.lakeCells', countWhere(w.lakes.depth, (v) => v > 0))
  put('hydro.saltFlatCells', countWhere(w.lakes.saltFlat, (v) => v > 0))
  put('hydro.dryBasinCells', countWhere(w.lakes.dryBasin, (v) => v === 1))

  // Measured over SCORED cells only. Averaging the ocean sentinel in made every
  // eco mean a land-fraction proxy (all three seeds came out near -0.6…-0.9,
  // tracking land, not ecology). And `.max` is dropped: several fields clamp at
  // 1, so their maximum was identical on every seed — a metric that cannot vary
  // guards nothing, which the coverage layer duly reported.
  for (const name of Object.keys(w.eco.fields).sort()) {
    const field = w.eco.fields[name]
    let sum = 0, scored = 0, rich = 0
    for (let i = 0; i < field.length; i++) {
      if (field[i] === M.ecology.ECOLOGY_OCEAN) continue
      scored++
      sum += field[i]
      if (field[i] > 0.5) rich++
    }
    put(`eco.${name}.mean`, scored > 0 ? sum / scored : 0)
    put(`eco.${name}.rich`, rich)
  }

  put('mig.reached', countWhere(w.mig.density, (v) => v > 0))
  const finiteCost = [...w.mig.cost].filter(Number.isFinite)
  put('mig.meanCost', finiteCost.length > 0 ? finiteCost.reduce((a, b) => a + b, 0) / finiteCost.length : 0)

  return out
}

// Per-stage byte hashes, named so a difference points at a stage instead of at
// the whole pipeline. TWO layers read this — determinism (a run against another
// run in the same process) and the opt-in refactor guard — from one list, so
// the two cannot drift apart.
function fingerprints(w) {
  const out = {}
  const put = (name, typed) => { out[name] = hashBytes(typed) }

  // Tectonic state. Elevation depends on rafts, oceanAge and features, so it
  // covers most of this transitively — but the lattice accumulators are the
  // rift/merge TRIGGERS, and a change there can take many epochs to reach a
  // height, or never reach one on a given seed.
  put('tectonics.oceanAge', w.sim.oceanAge)
  put('tectonics.mantle', w.sim.mantle)
  put('tectonics.latticeAccum', w.sim.latticeAccumulated)
  put('tectonics.latticeLocked', w.sim.latticeLockedEpochs)
  put('tectonics.latticeClass', w.sim.latticeLastClassCode)

  put('elevation.raw', w.raw)
  put('elevation.eroded', w.el)
  put('elevation.preFill', w.ero.preFillElevations)
  put('erosion.accumulation', w.ero.accumulation)

  put('climate.wind', w.wind)
  put('climate.currents', w.currents)
  put('climate.temperature', w.temperature)
  put('climate.seasonal', w.seasonal)
  // The PRE-refinement monsoon index: when a world has dry basins the chain
  // above re-runs climate and keeps only the second precipitation, leaving this
  // one from the first pass. Hashing it still guards the monsoon code; it just
  // is not the same generation as `climate.precipitation` below.
  put('climate.monsoonIndex', w.seasonalPrecip.index)
  put('climate.precipitation', w.precipitation)
  put('climate.biomes', w.biomes)
  put('climate.biomesFine', w.biomesFine)

  put('hydro.discharge', w.discharge)
  put('hydro.lakeDepth', w.lakes.depth)
  put('hydro.saltFlat', w.lakes.saltFlat)
  put('hydro.dryBasin', w.lakes.dryBasin)

  for (const k of Object.keys(w.eco.fields).sort()) put(`eco.${k}`, w.eco.fields[k])

  put('mig.cost', w.mig.cost)
  put('mig.density', w.mig.density)

  // Stored as the STRING, not a hash of it — every other entry here is opaque
  // by necessity, but this one is short and a diff that reads
  // `v4-5fadfe0c… -> v4-91b3ac…` says immediately what happened.
  out['artifact.pipelineVersion'] = PIPELINE_VERSION
  return out
}

// --- run -------------------------------------------------------------------

const started = Date.now()
process.stderr.write(`golden: mode=${MODE}, guard=${existsSync(HASHES) ? 'on' : 'off'}\n`)
const worlds = {}
const measured = {}
const hashed = {}
let failed = 0

for (const seed of SEEDS) {
  process.stderr.write(`  ${seed} … `)
  worlds[seed] = await buildWorld(seed)
  measured[seed] = metrics(worlds[seed])
  hashed[seed] = fingerprints(worlds[seed])
  process.stderr.write('ok\n')
}

console.log('\n— invariants —')
for (const seed of SEEDS) {
  const failures = invariants(worlds[seed])
  if (failures.length === 0) {
    console.log(`  ok    ${seed}`)
  } else {
    failed += failures.length
    for (const f of failures) console.log(`  FAIL  ${seed}  ${f}`)
  }
}

// A measurement identical across three different worlds is not measuring the
// world, and it would keep matching its recorded value forever — it looks
// exactly like a passing check. That is how three migration stages sat dead
// from the day they were added. Checked in both modes, because the failure is
// invisible in a comparison by construction.
const SEED_INDEPENDENT = new Set(['elevation.maxM', 'elevation.minM', 'climate.tempMaxC', 'climate.tempMinC'])
const constant = Object.keys(measured[SEEDS[0]]).filter(
  (name) => !SEED_INDEPENDENT.has(name) && new Set(SEEDS.map((s) => measured[s][name])).size === 1,
)
console.log('\n— coverage —')
if (constant.length === 0) {
  console.log(`  ok    all ${Object.keys(measured[SEEDS[0]]).length} metrics vary across seeds`)
} else {
  failed += constant.length
  for (const name of constant) console.log(`  FAIL  ${name} is identical on all ${SEEDS.length} seeds and guards nothing`)
}

console.log('\n— determinism —')
process.stderr.write(`  rebuilding ${SEEDS[0]} … `)
const repeat = await buildWorld(SEEDS[0])
process.stderr.write('ok\n')
const before = hashed[SEEDS[0]], after = fingerprints(repeat)
const unstable = Object.keys(before).filter((name) => before[name] !== after[name])
if (unstable.length === 0) {
  console.log(`  ok    ${SEEDS[0]} rebuilds bit-identically across ${Object.keys(before).length} stages`)
} else {
  failed += unstable.length
  console.log(`  FAIL  ${SEEDS[0]} is not reproducible — ${unstable.length} of ${Object.keys(before).length} stages differ`)
  for (const name of unstable) console.log(`          ${name}  ${before[name]} -> ${after[name]}`)
}

await server.close()

if (MODE === 'record') {
  // Refused rather than written: a baseline taken from a world that fails its
  // own invariants bakes the breakage in as "expected", and the next person to
  // run this would see green.
  if (failed > 0) {
    console.error(`\nrefusing to record — ${failed} hard failures above must be fixed first`)
    process.exit(1)
  }
  writeFileSync(OUT, JSON.stringify(measured, null, 2) + '\n')
  console.log(`\nrecorded ${SEEDS.length} seeds × ${Object.keys(measured[SEEDS[0]]).length} metrics -> golden.json`)
  process.exit(0)
}

if (MODE === 'hash-record') {
  // Refused only on NON-REPRODUCIBILITY, and deliberately not on a failed
  // invariant — the two records make different claims. golden.json says "this
  // is correct", so recording a broken world there bakes the breakage in as
  // expected. This file only says "this is what the code does today", which is
  // exactly what you want to hold fixed while refactoring something that is
  // already wrong. But if the pipeline does not rebuild identically, the
  // baseline is noise and every later run would go red at random.
  if (unstable.length > 0) {
    console.error(`\nrefusing to record — the pipeline is not reproducible (${unstable.length} stages), so a hash baseline would be meaningless`)
    process.exit(1)
  }
  if (failed > 0) console.error(`\nwarning: recording despite ${failed} hard failures — the baseline freezes current behaviour, correct or not`)
  writeFileSync(HASHES, JSON.stringify(hashed, null, 2) + '\n')
  console.log(`\nrecorded ${SEEDS.length} seeds × ${Object.keys(hashed[SEEDS[0]]).length} stage hashes -> golden-hashes.json`)
  console.log('refactor now; every `npm run harness:golden` compares against this. delete the file when you are done.')
  process.exit(0)
}

console.log('\n— metrics —')
if (!existsSync(OUT)) {
  console.error('  no golden.json — run `npm run harness:golden:record` first')
  process.exit(2)
}
const golden = JSON.parse(readFileSync(OUT, 'utf8'))
let drifted = 0, compared = 0
for (const seed of SEEDS) {
  for (const [name, value] of Object.entries(measured[seed])) {
    const want = golden[seed]?.[name]
    if (want === undefined) { console.log(`  NEW   ${seed}.${name} = ${value}`); continue }
    compared++
    const span = Math.abs(want) > 1e-9 ? Math.abs((value - want) / want) : Math.abs(value - want)
    if (span <= toleranceFor(name)) continue
    drifted++
    const delta = value - want
    console.log(`  DRIFT ${seed}.${name}: ${want} -> ${value}  (${delta >= 0 ? '+' : ''}${delta.toFixed(4)}, ${(span * 100).toFixed(1)}% > ${(toleranceFor(name) * 100).toFixed(0)}%)`)
  }
}
console.log(drifted === 0
  ? `  ok    ${compared} metrics within tolerance`
  : `  ${drifted} of ${compared} metrics drifted — judge them, then \`npm run harness:golden:record\` if intended`)

// --- layer 4: byte hashes (opt-in refactor guard) --------------------------
//
// The baseline is MACHINE-LOCAL, so it is not committed. Determinism holds
// within a process, but Math results can move between V8 versions, and a
// baseline recorded on another machine would go red for reasons that are not
// your change. Record it where you are refactoring.
let movedStages = 0
if (existsSync(HASHES)) {
  console.log('\n— byte hashes (refactor guard) —')
  const baseline = JSON.parse(readFileSync(HASHES, 'utf8'))
  for (const seed of SEEDS) {
    const want = baseline[seed]
    if (!want) { console.log(`  NEW   ${seed} is not in the baseline`); continue }
    const moved = Object.keys(hashed[seed]).filter((name) => want[name] !== undefined && want[name] !== hashed[seed][name])
    const added = Object.keys(hashed[seed]).filter((name) => want[name] === undefined)
    const gone = Object.keys(want).filter((name) => hashed[seed][name] === undefined)
    for (const name of added) console.log(`  NEW   ${seed}.${name}`)
    for (const name of gone) console.log(`  GONE  ${seed}.${name} was in the baseline and is no longer produced`)
    if (moved.length === 0 && gone.length === 0) {
      console.log(`  ok    ${seed}  ${Object.keys(hashed[seed]).length - added.length} stages byte-identical`)
      continue
    }
    movedStages += moved.length + gone.length
    for (const name of moved) console.log(`  MOVED ${seed}.${name}  ${want[name]} -> ${hashed[seed][name]}`)
    // How many held still, which the list of what moved does not tell you. The
    // difference between "one stage moved" and "everything moved" is the
    // difference between a deliberate change and a broken refactor, and reading
    // it off the length of a list is exactly the arithmetic nobody does at 2am.
    console.log(`        ${seed}: ${Object.keys(want).length - moved.length - gone.length} of ${Object.keys(want).length} stages unchanged`)
  }
  if (movedStages > 0) console.log('  a refactor should move nothing. if the change was intended, `npm run harness:golden:hash` to re-freeze — or delete golden-hashes.json to end the guard.')
}

const seconds = ((Date.now() - started) / 1000).toFixed(0)
const total = failed + drifted + movedStages
console.log(`\n${total === 0 ? 'PASS' : 'FAIL'} — ${failed} hard failures, ${drifted} drifted metrics, ${movedStages} moved stages, ${seconds}s`)
process.exit(total === 0 ? 0 : 1)

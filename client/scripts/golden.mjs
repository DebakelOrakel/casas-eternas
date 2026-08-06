// Golden-hash regression harness for the worldgen pipeline.
//
// Runs the real pipeline and hashes the raw bytes of every stage — tectonics state,
// elevation, erosion, hydrology, climate, ecology, migration. A refactor that is
// meant to preserve behaviour must produce bit-identical hashes; a difference is a
// bug, not a judgement call. When a change is meant to alter behaviour, re-record
// and say so — the point is that the choice becomes explicit.
//
//   npm run golden          compare against golden.json, exit 1 on any difference
//   npm run golden record   overwrite golden.json with the current output
//
// It goes through Vite's SSR pipeline rather than plain node, because the worldgen
// modules use extensionless imports that node will not resolve.
//
// Worlds are built the way the program builds them: an Archean run, then the handover
// to plate tectonics. That matters — this harness used to call the old
// createPlateSimulation with the four Genesis sliders, and so guarded a code path
// nothing reached any more while the live one went unguarded.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The client root, resolved from this file so the harness works from any checkout.
const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const OUT = fileURLToPath(new URL('./golden.json', import.meta.url))
const MODE = process.argv[2] ?? 'check'
const SEEDS = ['calibration', 'alpha', 'bravo']
const EPOCHS = 50
const W = 2048, H = 1024

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)

// Modules are loaded by PATH. If files move, this block is the only thing to update.
const M = {
  sim: await L('/src/worldgen/tectonics/plateSimulation.ts'),
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
}

// How many Archean epochs run before the handover. Inside the usable stopping
// window (150-250) and short enough that the harness stays quick.
const ARCHEAN_EPOCHS = 180

// Float32 hashing has to be bit-exact, so hash the raw bytes rather than any
// rounded/stringified form — a refactor that changes the last mantissa bit is
// still a change, and this is the only check that will catch it.
const hashBytes = (typed) => createHash('sha256').update(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)).digest('hex').slice(0, 16)
const hashNums = (arr) => hashBytes(Float64Array.from(arr))

function buildElevation(sim) {
  const base = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, W, H, sim.warpSeed)
  const bk = M.field.buildFeatureBuckets(sim.features, W, H)
  const el = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
      el[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, W, H, M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed), M.ridged.fineDetailNoise(s.wx, s.wy, W, H, (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0))
    }
  }
  return el
}

async function stageHashes(seed) {
  const out = {}
  // Built the way the program builds worlds: an Archean run, then the handover to
  // plate tectonics. This used to call createPlateSimulation with the four sliders
  // that the Genesis panel no longer has — so the harness was guarding a code path
  // nothing reached any more, and the path everything DOES reach was unguarded.
  const archean = M.archean.createArcheanSimulation(seed, W, H)
  for (let e = 0; e < ARCHEAN_EPOCHS; e++) M.archeanStep.archeanStep(archean)
  const sim = M.finalize.finalizeArchean(archean)
  for (let e = 0; e < EPOCHS; e++) M.sim.stepEpoch(sim)

  // --- tectonics state ---
  out.oceanAge = hashBytes(sim.oceanAge)
  out.mantle = hashBytes(sim.mantle)
  out.seeds = hashNums(sim.seeds.flatMap((s) => [s.x, s.y]))
  out.motions = hashNums(sim.motions.flatMap((m) => [m.driftX, m.driftY, m.spin, m.centroidX, m.centroidY]))
  out.features = hashNums(sim.features.flatMap((f) => [f.x, f.y, f.thickness, f.tangentX, f.tangentY]))
  out.rafts = hashNums(sim.rafts.flatMap((r) => r.blobs.flatMap((b) => [b.x, b.y, b.radius, b.birthEpoch ?? 0])))
  out.raftNames = createHash('sha256').update(sim.rafts.map((r) => r.name).join('|')).digest('hex').slice(0, 16)
  out.sutures = hashNums(sim.sutures.flatMap((s) => [s.x, s.y, s.tangentX, s.tangentY, s.epoch]))
  out.counts = `${sim.seeds.length}/${sim.rafts.length}/${sim.features.length}/${sim.sutures.length}`

  // --- elevation ---
  const raw = buildElevation(sim)
  out.elevation = hashBytes(raw)

  // --- erosion ---
  const ero = await M.erosion.runErosionPass(raw, W, H, M.erosion.DEFAULT_EROSION_PASS_PARAMS)
  out.eroded = hashBytes(ero.elevations)
  out.filled = hashBytes(ero.routing.filled)
  out.flowTarget = hashBytes(ero.routing.flowTarget)
  out.accumulation = hashBytes(ero.accumulation)
  const el = ero.elevations

  // --- climate (same call order as the worker's computeClimate) ---
  const temperature = M.temperature.computeTemperature(el, W, H)
  const wind = M.wind.computeWind()
  const currents = M.currents.computeOceanCurrents(el, wind, W, H)
  M.currents.applyOceanSST(temperature, currents, el, W, H)
  const seasonal = M.seasonality.computeSeasonalAmplitude(el, W, H)
  const seasonalPrecip = M.monsoon.computeSeasonalPrecipitation(el, temperature, seasonal, wind, W, H, 1, 0)
  const precipitation = seasonalPrecip.annual
  const biomes = M.biomes.computeBiomes(temperature, precipitation, seasonal, seasonalPrecip.index, el, W, H)
  out.temperature = hashBytes(temperature)
  out.wind = hashBytes(wind)
  out.currents = hashBytes(currents)
  out.precipitation = hashBytes(precipitation)
  out.precipWet = hashBytes(seasonalPrecip.wet)
  out.precipDry = hashBytes(seasonalPrecip.dry)
  out.seasonality = hashBytes(seasonal)
  out.monsoon = hashBytes(seasonalPrecip.index)
  out.biomes = hashBytes(biomes)

  // --- hydrology ---
  const routing = await M.routing.fillDepressionsAndRouteFlow(el, W, H, 0)
  const CRX = M.climateField.CLIMATE_RES_X, CRY = M.climateField.CLIMATE_RES_Y
  const meanRunoff = M.hydro.meanLandRunoff(precipitation, el, W, H, CRX, CRY)
  let discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
  const maxDis = M.hydro.maxDischargeOverLand(discharge, el)
  // Terminal-basin refinement, mirroring the worker (k=1): lakes v1 -> if any
  // dry basin floor, climate v2 with the land override -> discharge/lakes v2.
  let lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, temperature, precipitation, CRX, CRY)
  if (lakes.dryBasin.some((v) => v === 1)) {
    const t2 = M.temperature.computeTemperature(el, W, H, 0, 1, 0, lakes.dryBasin)
    const c2 = M.currents.computeOceanCurrents(el, wind, W, H, lakes.dryBasin)
    M.currents.applyOceanSST(t2, c2, el, W, H, lakes.dryBasin)
    const s2 = M.seasonality.computeSeasonalAmplitude(el, W, H, 0, lakes.dryBasin)
    const sp2 = M.monsoon.computeSeasonalPrecipitation(el, t2, s2, wind, W, H, 1, 0, lakes.dryBasin)
    discharge = M.hydro.accumulateDischarge(routing, el, sp2.annual, CRX, CRY)
    lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, t2, sp2.annual, CRX, CRY)
    out.temperatureV2 = hashBytes(t2)
    out.precipitationV2 = hashBytes(sp2.annual)
  }
  const lakeDepth = lakes.depth
  out.discharge = hashBytes(discharge)
  out.lakeDepth = hashBytes(lakeDepth)
  out.saltFlat = hashBytes(lakes.saltFlat)
  out.dryBasin = hashBytes(lakes.dryBasin)
  out.hydroScalars = `${meanRunoff.toFixed(9)}/${maxDis.toFixed(6)}`
  let lakeCells = 0
  for (const v of lakeDepth) if (v > 0) lakeCells++
  out.lakeCells = String(lakeCells)

  // --- ecology + migration ---
  const cratonAge = M.rafts.computeCratonOldnessField(sim.rafts, sim.epoch, CRX, CRY, W, H)
  // Real volcanoes and sutures, and real params — through the very function the worker
  // uses, not a copy of it. This used to pass `volcanoes: []`, `orogenPoints: []` and
  // `{}`, which left copper, tin, obsidian, gold, silver and gems on empty inputs and
  // made carryingCapacity NaN on every land cell (`params.carryingCapacity / 100` with
  // no value). Being JS, nothing complained; the NaN hashed consistently, so those
  // stages and the three migration ones below guarded nothing at all.
  const volcanoes = M.volcanoes.collectVolcanoes(sim.features)
  const eco = M.ecology.computeEcology({
    temperature, precipitation, biomes, currents, elevation: el,
    discharge, maxDischarge: maxDis, lakeDepth, volcanoes,
    orogenPoints: sim.sutures.map((s) => ({ x: s.x, y: s.y })),
    cratonAge, warpSeed: sim.warpSeed, worldWidth: W, worldHeight: H,
  }, { carryingCapacity: 100, concentration: 0 })
  for (const k of Object.keys(eco.fields).sort()) out[`eco.${k}`] = hashBytes(eco.fields[k])

  // The origin has to be picked FROM the world, not fixed by index. It used to be
  // cell CRX*CRY*0.4, and at 3-11% land that cell was ocean on all three seeds — so
  // computeMigration skipped the only origin, the heap stayed empty, and all three
  // outputs were constants (cost all-Infinity, density all-zero, race all -1). They
  // hashed identically no matter what the whole pipeline upstream did: nine of the
  // 132 hashes guarded nothing. Picking the most habitable land cell keeps it
  // deterministic while guaranteeing the spread actually runs.
  let originCell = -1
  let bestCapacity = -Infinity
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
  out['mig.origin'] = `${originCell}`
  out['mig.cost'] = hashBytes(mig.cost)
  out['mig.density'] = hashBytes(mig.density)
  out['mig.race'] = hashBytes(mig.race)

  return out
}

const result = {}
for (const seed of SEEDS) {
  process.stderr.write(`  ${seed} … `)
  result[seed] = await stageHashes(seed)
  process.stderr.write('ok\n')
}
await server.close()

// A stage that hashes the same for three different worlds is not computing anything
// about the world, and it will keep matching its golden value forever — it looks
// exactly like a passing guard. That is how the three migration stages sat dead from
// the day they were added until 2026-08-01: the origin was a fixed cell index that
// landed in the ocean on every seed, so cost/density/race came out all-Infinity /
// all-zero / all -1 every time. Checked on every run, in both modes, because the
// failure is invisible in a diff-against-golden by construction.
//
// `wind` is the one legitimate constant: computeWind() takes no arguments — it is the
// prescribed three-cell circulation, identical in every world.
const SEED_INDEPENDENT = new Set(['wind'])
const constantStages = Object.keys(result[SEEDS[0]]).filter(
  (stage) => !SEED_INDEPENDENT.has(stage) && new Set(SEEDS.map((s) => result[s][stage])).size === 1,
)
if (constantStages.length > 0) {
  console.error(`\nTOT — diese Stufen sind über alle ${SEEDS.length} Seeds identisch und bewachen nichts:`)
  for (const stage of constantStages) console.error(`         ${stage} = ${result[SEEDS[0]][stage]}`)
  process.exit(3)
}

if (MODE === 'record') {
  writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`recorded ${Object.keys(result).length} seeds × ${Object.keys(result[SEEDS[0]]).length} stages -> golden.json`)
  process.exit(0)
}

if (!existsSync(OUT)) { console.error('no golden.json — run `node golden.mjs record` first'); process.exit(2) }
const golden = JSON.parse(readFileSync(OUT, 'utf8'))
let bad = 0, checked = 0
for (const seed of SEEDS) {
  for (const [stage, val] of Object.entries(result[seed])) {
    const want = golden[seed]?.[stage]
    checked++
    if (want === undefined) { console.log(`  NEW    ${seed}.${stage} = ${val}`); continue }
    if (want !== val) { console.log(`  DIFF   ${seed}.${stage}\n           golden ${want}\n           now    ${val}`); bad++ }
  }
}
console.log(bad === 0 ? `\nOK — ${checked} Hashes identisch` : `\nFAIL — ${bad} von ${checked} abweichend`)
process.exit(bad === 0 ? 0 : 1)

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
      el[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, W, H, M.ridged.ridgedMultifractal(s.wx, s.wy, W, H))
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
  const discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
  const maxDis = M.hydro.maxDischargeOverLand(discharge, el)
  const lakeDepth = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, temperature, CRX, CRY)
  out.discharge = hashBytes(discharge)
  out.lakeDepth = hashBytes(lakeDepth)
  out.hydroScalars = `${meanRunoff.toFixed(9)}/${maxDis.toFixed(6)}`
  let lakeCells = 0
  for (const v of lakeDepth) if (v > 0) lakeCells++
  out.lakeCells = String(lakeCells)

  // --- ecology + migration ---
  const cratonAge = M.rafts.computeCratonOldnessField(sim.rafts, sim.epoch, CRX, CRY, W, H)
  const eco = M.ecology.computeEcology({
    temperature, precipitation, biomes, currents, elevation: el,
    discharge, maxDischarge: maxDis, lakeDepth, volcanoes: [], orogenPoints: [],
    cratonAge, warpSeed: sim.warpSeed, worldWidth: W, worldHeight: H,
  }, {})
  for (const k of Object.keys(eco.fields).sort()) out[`eco.${k}`] = hashBytes(eco.fields[k])

  const mig = M.migration.computeMigration(
    eco.fields.carryingCapacity, precipitation, el, null, 0,
    [{ cell: Math.floor(CRX * CRY * 0.4), race: 0 }], W, H,
    { spreadBudget: 400, seaCrossing: 0.3 },
  )
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

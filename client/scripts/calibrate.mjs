// The calibration's measurement (DEC-0036 phase 8): many worlds of both
// shapes at the real size, 2048 × 1024, built the way the screen builds
// them, and the distributions the calibration is judged on — land, plates,
// heights, ice, lakes, Köppen, the zonal climate, rivers, the sea, the
// time per stage — plus the planet's and the genesis's sliders swept on a
// subset of the seeds. Not a gate: nothing here passes or fails; it prints
// the tables and writes them as JSON.
//
//   npm run calibrate                          12 seeds per shape, the sweeps on 3
//   node scripts/calibrate.mjs [key=value …]
//     seeds=12 shapes=torus,sphere epochs=40 stabilised=0.5 archeanMax=600
//     archeanMa=0 landShare=30 jobs=5 sweep=1 sweepSeeds=3 out=<dir> label=<name>
//     archeanMa: run the Archean to this world age as well (the screen's
//     user stops it at 1000–1500 Ma); 0 = to the gate only. landShare: the
//     genesis.landShare control for every world (a sweep's value wins).
//     TECTONICS_TUNING.splitGap=… (any tuning object's key, set in every child)
//   node scripts/calibrate.mjs report <run.json> [<before.json>]
//     the summary of a run, with the deltas against another one
//
// THE FLOW (the screen's defaults, GeneratorScreen.ts): the Archean runs
// until its stabilised crust reaches MIN_ARCHEAN_STABILISED (0.5 — the
// gate the screen sets before the tectonics may start) and the world is
// `archeanMa` old, capped at `archeanMax` epochs; the hand-over; `epochs` coupled epochs at
// HISTORY_DEFAULTS (the screen asks for 30 before the climate step,
// MIN_TECTONIC_EPOCHS, and stops itself at 100; 40 is the default here — a
// world a player takes a little past the gate); then the climate step as
// the screen runs it — the static climate, its refinement (automatic since
// 2026-09-29), the hydrology on the refined climate (no v2 pass: the
// runtime skips it over a refinement), the riparian biomes and the river
// graph. Everything at the sliders' declared defaults unless a sweep sets
// one.
//
// Each world is its own child process (the generator's state is per
// module, and a world at 2048 × 1024 holds a few GB); `jobs` run at once.
//
// Results: <out>/<label>.json — `worlds` (one record per world) and
// `summary`. The default <out> is $CALIBRATION_OUT, else the system's
// temporary directory (casas-calibration/): a run is a measurement, not a
// file of the repository.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import os from 'node:os'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SELF = fileURLToPath(import.meta.url)
const W = 2048, H = 1024
const SEEDS = ['calibration', 'alpha', 'zulu', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett',
  'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor']

// The sweeps: each slider a few values around its default (the default
// run is the base), on `sweepSeeds` seeds. Values in the slider's own
// units (the spec's).
const SWEEPS = {
  'planet.obliquity': [10, 35],
  'planet.rotation': [16, 36],
  'planet.greenhouse': [-8, 8],
  'climate.contrast': [60, 140],
  'climate.humidity': [60, 160],
  'genesis.landShare': [15, 40],
}
const DEFAULTS = {
  'planet.obliquity': 23.5, 'planet.rotation': 24, 'planet.greenhouse': 0,
  'climate.contrast': 100, 'climate.humidity': 100, 'genesis.landShare': 30, 'genesis.mantleVigour': 4,
}

// --- Earth's references ------------------------------------------------------

// Annual mean surface air temperature by |latitude|, both hemispheres
// averaged, °C, land and sea: rounded from the ERA5 1991–2020 zonal means
// (as tabulated e.g. in Hartmann, Global Physical Climatology, 2nd ed.,
// fig. 2.8 and ch. 7) — 10° bands, ±2 °C.
const EARTH_T = [26.5, 25.5, 21.5, 15.5, 8.5, 1.5, -7, -16, -27]
// Annual precipitation over LAND by |latitude|, mm/yr, both hemispheres
// averaged: rounded from GPCC/GPCP land climatologies (e.g. Adler et al.
// 2003; Schneider et al. 2014) — 10° bands, ±20 %.
const EARTH_P_LAND = [1900, 1100, 600, 600, 650, 550, 400, 250, 150]

// --- the shared reading ------------------------------------------------------

function parseArgs(argv) {
  const opt = { seeds: 12, shapes: 'torus,sphere', epochs: 40, stabilised: 0.5, archeanMax: 600, archeanMa: 0, landShare: 30, jobs: 5, sweep: 1, sweepSeeds: 3, out: process.env.CALIBRATION_OUT || `${os.tmpdir()}/casas-calibration`, label: 'run', only: '' }
  const tune = {}
  for (const a of argv) {
    const at = a.indexOf('=')
    if (at < 0) continue
    const k = a.slice(0, at), v = a.slice(at + 1)
    if (k.includes('_TUNING.')) tune[k] = Number(v)
    else if (k in opt) opt[k] = typeof opt[k] === 'number' ? Number(v) : v
    else { console.error(`unknown option ${k}`); process.exit(2) }
  }
  return { opt, tune }
}

const q = (sorted, p) => {
  if (!sorted.length) return NaN
  const at = (sorted.length - 1) * p
  const lo = Math.floor(at), hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}
function dist(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  return { n: v.length, median: q(v, 0.5), p10: q(v, 0.1), p90: q(v, 0.9), min: v[0], max: v.at(-1) }
}

// --- one world (the child) ----------------------------------------------------

async function buildOne(job) {
  const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
  const server = await createServer({ root: CLIENT, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' })
  const L = (p) => server.ssrLoadModule(p)
  const M = {
    archean: await L('/src/generator/archean/archeanState.ts'),
    archeanStep: await L('/src/generator/archean/archeanStep.ts'),
    archeanLand: await L('/src/generator/archean/archeanLand.ts'),
    finalize: await L('/src/generator/archean/finalizeArchean.ts'),
    raft: await L('/src/generator/crust/raftField.ts'),
    coupled: await L('/src/generator/pipeline/coupledEpoch.ts'),
    worldTime: await L('/src/generator/core/worldTime.ts'),
    tectonicsInputs: await L('/src/generator/tectonics/tectonicsInputParams.ts'),
    meshRaster: await L('/src/generator/mesh/meshRaster.ts'),
    meshHydro: await L('/src/generator/mesh/meshHydrology.ts'),
    hydro: await L('/src/generator/surface/hydrology.ts'),
    graph: await L('/src/generator/surface/riverGraph.ts'),
    surfaceTune: await L('/src/generator/surface/surfaceTuneParams.ts'),
    scale: await L('/src/generator/elevation/elevationScale.ts'),
    weather: await L('/src/generator/climate/weather.ts'),
    climateMesh: await L('/src/generator/climate/climateMesh.ts'),
    climatePoints: await L('/src/generator/climate/climatePoints.ts'),
    climateChart: await L('/src/generator/climate/climateChart.ts'),
    refinement: await L('/src/generator/climate/refinement.ts'),
    biomes: await L('/src/generator/climate/biomes.ts'),
    koppen: await L('/src/generator/climate/koppen.ts'),
    precip: await L('/src/generator/climate/precipitation.ts'),
    mantle: await L('/src/generator/mantle/mantleField.ts'),
    oceanAge: await L('/src/generator/tectonics/oceanAge.ts'),
    runParams: await L('/src/world/runParams.ts'),
  }
  const TUNING_MODULES = {
    TECTONICS_TUNING: '/src/generator/tectonics/tectonicsTuneParams.ts', CLIMATE_TUNING: '/src/generator/climate/climateTuneParams.ts',
    SURFACE_TUNING: '/src/generator/surface/surfaceTuneParams.ts', ELEVATION_TUNING: '/src/generator/elevation/elevationTuneParams.ts',
    MANTLE_TUNING: '/src/generator/mantle/mantleTuneParams.ts', MESH_TUNING: '/src/generator/mesh/meshDensity.ts',
    COLUMN_TUNING: '/src/generator/mesh/meshColumn.ts', COVER_TUNING: '/src/generator/surface/cover.ts',
  }
  for (const [key, value] of Object.entries(job.tune ?? {})) {
    const [obj, name] = key.split('.')
    const mod = await L(TUNING_MODULES[obj])
    if (!(name in mod[obj])) throw new Error(`no ${key}`)
    mod[obj][name] = value
  }
  const SEA = M.scale.SEA_LEVEL, METRES = M.scale.ELEVATION_METERS
  const values = { ...DEFAULTS, 'genesis.landShare': job.landShare ?? DEFAULTS['genesis.landShare'], ...(job.set ?? {}) }
  const value = (path) => values[path]
  const weatherParams = M.runParams.weatherParamsFrom(value)
  const time = {}
  let t0 = performance.now()
  const lap = (name) => { const t = performance.now(); time[name] = (t - t0) / 1000; t0 = t }

  // THE ARCHEAN until the screen's gate and the asked-for age: its land
  // (archeanLand.archeanLandShare, what its controller steers) per epoch.
  const archean = M.archean.createArcheanSimulation(job.seed, W, H, job.shape)
  const target = M.runParams.landShareFromControl(value('genesis.landShare'))
  const archeanParams = { ...M.archeanStep.DEFAULT_ARCHEAN_PARAMS, diffusion: M.runParams.mantleDiffusionFromVigour(value('genesis.mantleVigour')), landShare: target }
  const ageEpochs = Math.ceil((job.archeanMa ?? 0) / M.worldTime.ARCHEAN_MA_PER_EPOCH)
  let stabilised = 0
  let gateEpoch = -1
  let reachEpoch = -1
  let nucleated = 0
  const aim = M.archeanLand.archeanLandAim(target, archeanParams.land)
  const archeanLandAt = {}
  while (archean.epoch < job.archeanMax) {
    M.archeanStep.archeanStep(archean, archeanParams)
    nucleated += archean.lastNucleated
    stabilised = M.raft.stabilisedFraction(archean.rafts, archean.epoch, M.archeanStep.DEFAULT_ARCHEAN_PARAMS.stabilisationEpochs)
    if (gateEpoch < 0 && stabilised >= job.stabilised) gateEpoch = archean.epoch
    if (reachEpoch < 0 || archean.epoch % 50 === 0) {
      const land = M.archeanLand.archeanLandShare(archean)
      if (reachEpoch < 0 && land >= aim - 0.01) reachEpoch = archean.epoch
      if (archean.epoch % 50 === 0) archeanLandAt[archean.epoch * M.worldTime.ARCHEAN_MA_PER_EPOCH] = +land.toFixed(4)
    }
    if (gateEpoch >= 0 && archean.epoch >= ageEpochs) break
  }
  const archeanEpochs = archean.epoch
  const archeanRafts = archean.rafts.length
  const archeanLand = M.archeanLand.archeanLandShare(archean)
  lap('archean')
  const sim = M.finalize.finalizeArchean(archean)
  const handoverPlates = sim.seeds.length
  lap('handover')

  // THE HISTORY at HISTORY_DEFAULTS, the screen's controls.
  const CONTROLS = {
    alluvium: M.tectonicsInputs.TECTONICS_INPUTS.alluvium.default,
    rockContrast: M.tectonicsInputs.TECTONICS_INPUTS.rockContrast.default,
  }
  sim.epochMa = M.worldTime.TECTONIC_MA_PER_EPOCH
  const coupled = M.coupled.createCoupledTerrain(sim, M.coupled.HISTORY_DEFAULTS.budget)
  lap('meshBuild')
  const meshLand = () => {
    let land = 0, all = 0
    for (let v = 0; v < coupled.mesh.vertexSlots; v++) {
      if (!coupled.mesh.vAlive[v]) continue
      const a = coupled.mesh.voronoiArea(v)
      all += a
      if (coupled.z[v] > SEA) land += a
    }
    return land / all
  }
  const handoverLand = meshLand()
  const landPerEpoch = []
  for (let e = 0; e < job.epochs; e++) {
    await M.coupled.stepCoupledEpoch(sim, coupled, { ...M.coupled.HISTORY_DEFAULTS, controls: CONTROLS, weather: weatherParams })
    if (e % 5 === 4 || e === job.epochs - 1) landPerEpoch.push(+meshLand().toFixed(4))
  }
  lap('history')
  const domain = sim.domain
  const mesh = coupled.mesh
  const el = M.meshRaster.rasteriseNodeField(mesh, coupled.z, W, H)
  lap('rasterise')

  // THE CLIMATE STEP as the screen runs it.
  const CP = M.climatePoints
  const w1 = M.weather.computeWeather(M.climateMesh.climateTerrain(domain, el, W, H), weatherParams)
  lap('climate')
  const refined = M.refinement.refineClimate(el, domain, weatherParams, w1.mesh.temperature, w1.mesh.wind)
  const rTerrain = M.climateMesh.climateTerrain(domain, el, W, H)
  const cells = CP.climateCellsFromRefined(refined, rTerrain)
  lap('refine')
  const points = CP.meshPoints(mesh, coupled.z, null)
  const climate = CP.climateAtPoints(cells, points)
  const land = { points, climate, ...M.biomes.classifyPoints(climate, points, domain) }
  const sub = M.meshHydro.meshSubstrate(mesh, coupled.routing, coupled.areas)
  const discharge = M.hydro.accumulateDischargeOn(sub, coupled.z, climate.precipitation, climate.temperature)
  const lakes = M.hydro.computeLakesOn(sub, discharge, coupled.z, climate.temperature)
  const maxDis = M.hydro.maxDischargeOverLand(discharge, coupled.z)
  const meanRunoff = CP.meanLandRunoff(cells)
  const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY, domain), meanRunoff)
  lap('lakes')
  const precipEff = M.hydro.riparianPrecipitationOn(sub, coupled.z, discharge, threshold, maxDis, lakes.depth, lakes.frozen, climate.precipitation)
  const nodeBiome = M.biomes.classifyPoints(climate, points, domain, precipEff).biome
  const regime = M.hydro.accumulateRegimeInputsOn(sub, coupled.z, climate.temperature, climate.precipitation, climate.monsoonIndex)
  const graph = M.graph.buildRiverGraph({
    substrate: sub, discharge, elevation: coupled.z, threshold, maxDischarge: maxDis,
    bodies: lakes.bodies, body: lakes.body, lakeDepth: lakes.depth, sedimentFlux: coupled.sedimentFlux, biomes: nodeBiome,
    regime, criticalArea: M.hydro.densityToCriticalArea(M.hydro.CANONICAL_RIVER_DENSITY, domain),
  })
  lap('rivers')

  // --- the measurements ------------------------------------------------------
  const m2 = domain.metresPerUnit ** 2
  const km2 = (a) => (a * m2) / 1e6
  let total = 0, landA = 0, cont = 0, lakeA = 0, lakeLiquidA = 0, iceA = 0, iceV = 0
  const above = [0, 0, 0, 0] // 1, 2, 4, 6 km
  let peak = -Infinity
  const ocean = []
  const landH = []
  const koppenA = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  let koppenTotal = 0
  const continental = new Uint8Array(sub.count)
  const ICE_MIN = M.surfaceTune.SURFACE_TUNING.iceMinThicknessM
  for (let v = 0; v < mesh.vertexSlots; v++) {
    if (!mesh.vAlive[v]) continue
    const a = mesh.voronoiArea(v)
    total += a
    const z = coupled.z[v]
    const inBasin = lakes.body[v] >= 0
    if (z > SEA || inBasin) { cont += a; continental[v] = 1 }
    if (lakes.depth[v] > 0) { lakeA += a; if (!lakes.frozen[v]) lakeLiquidA += a }
    if (z > SEA) {
      landA += a
      const h = (z - SEA) * METRES
      landH.push([h, a])
      if (h > peak) peak = h
      if (h > 1000) above[0] += a
      if (h > 2000) above[1] += a
      if (h > 4000) above[2] += a
      if (h > 6000) above[3] += a
      const ice = coupled.ice[v] ?? 0
      if (ice >= ICE_MIN) { iceA += a; iceV += ice * a }
      const code = M.koppen.koppenCode(land.koppen[v])
      if (code) { koppenA[code[0]] += a; koppenTotal += a }
    } else if (!inBasin) {
      ocean.push([(SEA - z) * METRES, a])
    }
  }
  const weighted = (pairs, p) => {
    pairs.sort((x, y) => x[0] - y[0])
    let sum = 0
    for (const [, a] of pairs) sum += a
    let acc = 0
    for (const [h, a] of pairs) { acc += a; if (acc >= p * sum) return h }
    return pairs.at(-1)?.[0] ?? NaN
  }
  let oceanMean = 0, oceanArea = 0
  for (const [d, a] of ocean) { oceanMean += d * a; oceanArea += a }
  oceanMean /= Math.max(1e-12, oceanArea)
  let meanLandH = 0
  for (const [h, a] of landH) meanLandH += h * a
  meanLandH /= Math.max(1e-12, landA)

  // Landmasses: the continental nodes' components over the mesh's links.
  const comp = new Int32Array(sub.count).fill(-1)
  const sizes = []
  const nb = new Int32Array(256)
  const stack = []
  for (let s = 0; s < sub.count; s++) {
    if (!continental[s] || comp[s] >= 0) continue
    const id = sizes.length
    let area = 0
    comp[s] = id
    stack.push(s)
    while (stack.length) {
      const c = stack.pop()
      area += mesh.voronoiArea(c)
      const k = sub.facetNeighbours(c, nb)
      for (let i = 0; i < k; i++) { const o = nb[i]; if (continental[o] && comp[o] < 0) { comp[o] = id; stack.push(o) } }
    }
    sizes.push(km2(area))
  }
  sizes.sort((a, b) => b - a)

  // The zonal climate on the climate's mesh: the refinement's year, per
  // 10° of |latitude| (the Domain's latitude), all cells for the
  // temperature, land cells for the rain.
  const cm = rTerrain.cm
  const annual = M.refinement.annualFromMonths(refined, refined.cells)
  const bandT = new Array(9).fill(0), bandTA = new Array(9).fill(0), bandP = new Array(9).fill(0), bandPA = new Array(9).fill(0)
  let meanT = 0, meanTA = 0
  for (let i = 0; i < cm.mesh.count; i++) {
    const lat = domain.latitude(cm.yNorm[i]) * 90
    const b = Math.min(8, Math.floor(lat / 10))
    const a = cm.mesh.area[i]
    bandT[b] += annual.temperature[i] * a; bandTA[b] += a
    meanT += annual.temperature[i] * a; meanTA += a
    if (rTerrain.land[i] && annual.precipitation[i] !== M.precip.OCEAN_PRECIP && annual.precipitation[i] >= 0) { bandP[b] += annual.precipitation[i] * a; bandPA[b] += a }
  }

  // THE ARTEFACTS (phase 8 c): the field meshes' twelve pentagons against
  // the hexagons — a cell's anomaly is its value less its neighbours'
  // mean, as a z-score over the hexagons' anomalies — the seam at x = 0 / W
  // on the chart and the world raster, the pole rows, the zonal steps.
  const pentagonCheck = (fm, field) => {
    const anomaly = new Float64Array(fm.count)
    for (let i = 0; i < fm.count; i++) {
      let s = 0, n = 0
      for (let e = fm.nbrStart[i]; e < fm.nbrStart[i + 1]; e++) { s += field[fm.nbr[e]]; n++ }
      anomaly[i] = field[i] - s / n
    }
    let hs = 0, hs2 = 0, hn = 0
    const pent = []
    for (let i = 0; i < fm.count; i++) {
      const deg = fm.nbrStart[i + 1] - fm.nbrStart[i]
      if (deg === 5) { pent.push(i); continue }
      hs += anomaly[i]; hs2 += anomaly[i] ** 2; hn++
    }
    const mean = hs / hn, sd = Math.sqrt(Math.max(0, hs2 / hn - mean * mean))
    const zs = pent.map((i) => (anomaly[i] - mean) / (sd || 1))
    const absAll = []
    for (let i = 0; i < fm.count; i++) if (fm.nbrStart[i + 1] - fm.nbrStart[i] !== 5) absAll.push(Math.abs(anomaly[i]))
    absAll.sort((a, b) => a - b)
    const rank = (x) => { let lo = 0, hi = absAll.length; while (lo < hi) { const m = (lo + hi) >> 1; if (absAll[m] < x) lo = m + 1; else hi = m } return lo / absAll.length }
    return {
      pentagons: pent.length,
      maxAbsZ: zs.length ? Math.max(...zs.map(Math.abs)) : 0,
      meanAbsZ: zs.length ? zs.reduce((s, z) => s + Math.abs(z), 0) / zs.length : 0,
      meanRank: pent.length ? pent.reduce((s, i) => s + rank(Math.abs(anomaly[i])), 0) / pent.length : 0,
    }
  }
  const cellSpeed = (e, s) => Float64Array.from(e, (x, i) => Math.hypot(x, s[i]))
  const annualOf = (stack) => {
    const n = refined.cells, out = new Float64Array(n)
    for (let m = 0; m < refined.months; m++) for (let i = 0; i < n; i++) out[i] += stack[m * n + i] / refined.months
    return out
  }
  const pAnnual = Float64Array.from(annual.precipitation, (x) => (x < 0 ? 0 : x))
  const mm = M.mantle.mantleMesh(domain).mesh
  const om = M.oceanAge.oceanAgeMesh(domain).mesh
  const artefacts = {
    pentagons: {
      temperature: pentagonCheck(cm.mesh, annual.temperature),
      precipitation: pentagonCheck(cm.mesh, pAnnual),
      pressure: pentagonCheck(cm.mesh, annualOf(refined.pressure)),
      currents: pentagonCheck(cm.mesh, cellSpeed(refined.currentE, refined.currentS)),
      wind: pentagonCheck(cm.mesh, cellSpeed(annualOf(refined.windE), annualOf(refined.windS))),
      mantle: pentagonCheck(mm, sim.mantle),
      oceanAge: pentagonCheck(om, sim.oceanAge),
    },
  }
  // The seam and the poles on the charts.
  const RX = 256, RY = 128
  const chart = M.climateChart.refinedChart(refined, rTerrain)
  const chartAnnual = M.refinement.annualFromMonths(chart, RX * RY)
  const seamRatio = (f, rx, ry, skip = (x) => !Number.isFinite(x)) => {
    let seam = 0, sn = 0, inner = 0, inn = 0
    for (let y = 0; y < ry; y++) {
      for (let x = 0; x < rx; x++) {
        const a = f[y * rx + x], b = f[y * rx + ((x + 1) % rx)]
        if (skip(a) || skip(b)) continue
        if (x === rx - 1) { seam += Math.abs(a - b); sn++ } else { inner += Math.abs(a - b); inn++ }
      }
    }
    if (!sn || !inn) return NaN
    return (seam / sn) / Math.max(1e-12, inner / inn)
  }
  const poleRowSpread = (f, rx, ry) => {
    const sd = (y) => { let s = 0, s2 = 0; for (let x = 0; x < rx; x++) { s += f[y * rx + x]; s2 += f[y * rx + x] ** 2 } const m = s / rx; return Math.sqrt(Math.max(0, s2 / rx - m * m)) }
    let all = 0
    for (let y = 0; y < ry; y++) all += sd(y)
    return { top: sd(0), bottom: sd(ry - 1), meanRow: all / ry }
  }
  const zonalSteps = (f, rx, ry) => {
    const zm = []
    for (let y = 0; y < ry; y++) { let s = 0; for (let x = 0; x < rx; x++) s += f[y * rx + x]; zm.push(s / rx) }
    const d2 = []
    for (let y = 1; y < ry - 1; y++) d2.push(Math.abs(zm[y + 1] - 2 * zm[y] + zm[y - 1]))
    const sorted = d2.slice().sort((a, b) => a - b)
    return { maxSecondDiff: sorted.at(-1), medianSecondDiff: q(sorted, 0.5) }
  }
  artefacts.seam = {
    elevation: seamRatio(el, W, H),
    temperature: seamRatio(chartAnnual.temperature, RX, RY),
    precipitation: seamRatio(chartAnnual.precipitation, RX, RY, (x) => !Number.isFinite(x) || x < 0),
  }
  artefacts.poleRows = { temperature: poleRowSpread(chartAnnual.temperature, RX, RY) }
  artefacts.zonal = { temperature: zonalSteps(chartAnnual.temperature, RX, RY) }

  const discharges = []
  for (let v = 0; v < sub.count; v++) if (continental[v] && coupled.z[v] > SEA) discharges.push(discharge[v])
  discharges.sort((a, b) => a - b)
  let terminal = 0, lakeBodies = 0, dry = 0
  for (const b of lakes.bodies) { if (b.kind === 'terminal') terminal++; else if (b.kind === 'lake') lakeBodies++; else dry++ }

  const out = {
    seed: job.seed, shape: job.shape, set: job.set ?? {}, tune: job.tune ?? {},
    landShareTarget: target, landShareAim: aim, archeanEpochs, archeanMa: archeanEpochs * M.worldTime.ARCHEAN_MA_PER_EPOCH, gateEpoch, reachMa: reachEpoch < 0 ? null : reachEpoch * M.worldTime.ARCHEAN_MA_PER_EPOCH,
    nucleated, archeanLand, archeanLandAt, handoverLand, archeanRafts, stabilised, handoverPlates,
    plates: sim.seeds.length, rafts: sim.rafts.length,
    nodes: mesh.aliveVertices,
    landFraction: landA / total, continentalFraction: cont / total, landPerEpoch,
    landmasses: sizes.filter((s) => s >= 1e4).length, continents: sizes.filter((s) => s >= 1e6).length,
    largestLandmassShare: sizes.length ? sizes[0] / km2(cont) : 0,
    peakM: peak, landP99M: weighted(landH.slice(), 0.99), meanLandM: meanLandH,
    above1km: above[0] / landA, above2km: above[1] / landA, above4km: above[2] / landA, above6km: above[3] / landA,
    iceVolumeKm3: (iceV * m2) / 1e9, iceShareOfLand: iceA / landA,
    lakeShareOfLand: lakeA / cont, liquidLakeShareOfLand: lakeLiquidA / cont,
    lakes: lakeBodies, terminalSeas: terminal, dryBasins: dry,
    maxDischarge: maxDis, p99Discharge: q(discharges, 0.99),
    koppen: Object.fromEntries(Object.entries(koppenA).map(([k, a]) => [k, a / Math.max(1e-12, koppenTotal)])),
    meanT: meanT / meanTA,
    bandT: bandT.map((s, i) => (bandTA[i] ? s / bandTA[i] : null)),
    bandPLand: bandP.map((s, i) => (bandPA[i] ? s / bandPA[i] : null)),
    reaches: graph.reaches.length,
    eustaticM: sim.eustaticM,
    oceanMeanDepthM: oceanMean, oceanMedianDepthM: weighted(ocean.slice(), 0.5), oceanP90DepthM: weighted(ocean.slice(), 0.9),
    oceanMaxDepthM: ocean.reduce((m, [d]) => Math.max(m, d), 0),
    artefacts,
    time,
  }
  await server.close()
  return out
}

// --- the orchestration ----------------------------------------------------------

function runChild(job) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=8192', SELF, 'one', JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{"seed"'))
      if (code !== 0 || !line) { resolve({ seed: job.seed, shape: job.shape, set: job.set ?? {}, error: (err || out).slice(-2000) }); return }
      resolve(JSON.parse(line))
    })
  })
}

async function pool(jobs, n, onDone) {
  const results = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++
      results[i] = await runChild(jobs[i])
      onDone(results[i], i)
    }
  }))
  return results
}

// The fields every summary row reads, with the user's target band
// (DEC-0036 phase 8a's brief) where there is one.
const ROWS = [
  ['landFraction', '%', 100, [25, 35]],
  ['archeanLand', '%', 100],
  ['handoverLand', '%', 100],
  ['reachMa', 'Ma', 1],
  ['archeanRafts', '', 1],
  ['nucleated', '', 1],
  ['gateEpoch', '', 1],
  ['continentalFraction', '%', 100],
  ['plates', '', 1],
  ['handoverPlates', '', 1],
  ['rafts', '', 1],
  ['landmasses', '', 1],
  ['continents', '', 1],
  ['largestLandmassShare', '%', 100],
  ['archeanEpochs', '', 1],
  ['peakM', 'm', 1, [8000, 9000]],
  ['landP99M', 'm', 1],
  ['meanLandM', 'm', 1, [700, 900]],
  ['above1km', '%', 100],
  ['above2km', '%', 100],
  ['above4km', '%', 100],
  ['above6km', '%', 100],
  ['iceVolumeKm3', 'km³', 1e-6, null, 'M km³'],
  ['iceShareOfLand', '%', 100, [8, 12]],
  ['lakeShareOfLand', '%', 100, [0, 10]],
  ['liquidLakeShareOfLand', '%', 100],
  ['lakes', '', 1],
  ['terminalSeas', '', 1],
  ['reaches', '', 1],
  ['maxDischarge', '', 1e-6, null, 'M'],
  ['meanT', '°C', 1, [13, 16]],
  ['eustaticM', 'm', 1],
  ['oceanMeanDepthM', 'm', 1, [3500, 3800]],
  ['oceanMedianDepthM', 'm', 1],
  ['oceanP90DepthM', 'm', 1],
  ['oceanMaxDepthM', 'm', 1],
]

let beckCache = null
function earthKoppen() {
  if (beckCache) return beckCache
  const bytes = readFileSync(`${CLIENT}/scripts/fixtures/earth-koppen.tif`)
  const ifd = bytes.readUInt32LE(4)
  const tags = new Map()
  for (let k = 0; k < bytes.readUInt16LE(ifd); k++) {
    const o = ifd + 2 + 12 * k
    const type = bytes.readUInt16LE(o + 2), count = bytes.readUInt32LE(o + 4)
    const size = type === 3 ? 2 : 4
    const at = count * size <= 4 ? o + 8 : bytes.readUInt32LE(o + 8)
    const vals = []
    for (let j = 0; j < Math.min(count, 64); j++) vals.push(type === 3 ? bytes.readUInt16LE(at + 2 * j) : bytes.readUInt32LE(at + 4 * j))
    tags.set(bytes.readUInt16LE(o), vals)
  }
  const width = tags.get(256)[0], height = tags.get(257)[0]
  const px = new Uint8Array(width * height)
  let at = 0
  const offsets = tags.get(273), lengths = tags.get(279)
  for (let k = 0; k < offsets.length; k++) {
    const strip = inflateSync(bytes.subarray(offsets[k], offsets[k] + lengths[k]))
    px.set(strip.subarray(0, Math.min(strip.length, px.length - at)), at)
    at += strip.length
  }
  const legend = new Map(readFileSync(`${CLIENT}/scripts/fixtures/earth-koppen-legend.txt`, 'utf8').split('\n').slice(1)
    .map((l) => l.split('\t')).filter((f) => f.length > 1 && f[1] !== '-').map((f) => [Number(f[0]), f[1]]))
  const all = { A: 0, B: 0, C: 0, D: 0, E: 0 }, noAnt = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180
    const w = Math.cos((lat * Math.PI) / 180)
    for (let x = 0; x < width; x++) {
      const code = legend.get(px[y * width + x])
      if (!code) continue
      all[code[0]] += w
      if (lat > -60) noAnt[code[0]] += w
    }
  }
  const norm = (o) => { const s = Object.values(o).reduce((a, b) => a + b, 0); return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / s])) }
  beckCache = { all: norm(all), noAntarctica: norm(noAnt) }
  return beckCache
}

function summarise(worlds) {
  const ok = worlds.filter((w) => !w.error)
  const summary = {}
  for (const shape of [...new Set(ok.map((w) => w.shape))]) {
    const base = ok.filter((w) => w.shape === shape && !Object.keys(w.set).length)
    const s = {}
    for (const [key] of ROWS) s[key] = dist(base.map((w) => w[key]))
    s.koppen = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((g) => [g, dist(base.map((w) => w.koppen[g]))]))
    s.bandT = Array.from({ length: 9 }, (_, b) => dist(base.map((w) => w.bandT[b] ?? NaN)))
    s.bandPLand = Array.from({ length: 9 }, (_, b) => dist(base.map((w) => w.bandPLand[b] ?? NaN)))
    s.time = Object.fromEntries(Object.keys(base[0]?.time ?? {}).map((k) => [k, dist(base.map((w) => w.time[k]))]))
    s.pentagons = Object.fromEntries(Object.keys(base[0]?.artefacts.pentagons ?? {}).map((k) => [k, {
      maxAbsZ: dist(base.map((w) => w.artefacts.pentagons[k].maxAbsZ)),
      meanAbsZ: dist(base.map((w) => w.artefacts.pentagons[k].meanAbsZ)),
      meanRank: dist(base.map((w) => w.artefacts.pentagons[k].meanRank)),
    }]))
    s.seam = Object.fromEntries(Object.keys(base[0]?.artefacts.seam ?? {}).map((k) => [k, dist(base.map((w) => w.artefacts.seam[k]))]))
    s.poleRows = { top: dist(base.map((w) => w.artefacts.poleRows.temperature.top)), bottom: dist(base.map((w) => w.artefacts.poleRows.temperature.bottom)), meanRow: dist(base.map((w) => w.artefacts.poleRows.temperature.meanRow)) }
    s.zonal = { max: dist(base.map((w) => w.artefacts.zonal.temperature.maxSecondDiff)), median: dist(base.map((w) => w.artefacts.zonal.temperature.medianSecondDiff)) }
    // The sweeps: per slider value, the mean change against the same
    // seeds' default worlds.
    const sweeps = {}
    for (const w of ok.filter((x) => x.shape === shape && Object.keys(x.set).length)) {
      const [path, v] = Object.entries(w.set)[0]
      const ref = base.find((b) => b.seed === w.seed)
      if (!ref) continue
      const key = `${path}=${v}`
      sweeps[key] ??= { n: 0, d: {} }
      sweeps[key].n++
      const metrics = { landFraction: 100, iceShareOfLand: 100, lakeShareOfLand: 100, meanT: 1, peakM: 1, reaches: 1, plates: 1, 'koppen.A': 100, 'koppen.B': 100, 'koppen.C': 100, 'koppen.D': 100, 'koppen.E': 100, 'bandT.0': 1, 'bandT.6': 1, 'bandPLand.0': 1, 'bandPLand.2': 1 }
      for (const [m, f] of Object.entries(metrics)) {
        const [a, b] = m.split('.')
        const get = (x) => (b === undefined ? x[a] : x[a][b])
        sweeps[key].d[m] = (sweeps[key].d[m] ?? 0) + ((get(w) ?? NaN) - (get(ref) ?? NaN)) * f
      }
    }
    for (const k of Object.keys(sweeps)) for (const m of Object.keys(sweeps[k].d)) sweeps[k].d[m] /= sweeps[k].n
    s.sweeps = sweeps
    s.worlds = base.length
    summary[shape] = s
  }
  return summary
}

const fmt = (x, f = 1, digits) => {
  if (!Number.isFinite(x)) return '—'
  const v = x * f
  const d = digits ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2)
  return v.toFixed(d)
}

function printSummary(summary, before) {
  const beck = earthKoppen()
  for (const [shape, s] of Object.entries(summary)) {
    console.log(`\n=== ${shape} (${s.worlds} worlds) ===`)
    console.log(`${'metric'.padEnd(24)} ${'median'.padStart(8)} ${'p10'.padStart(8)} ${'p90'.padStart(8)} ${'min'.padStart(8)} ${'max'.padStart(8)}  target${before ? '   Δmedian' : ''}`)
    for (const [key, unit, f, target, label] of ROWS) {
      const d = s[key]
      if (!d) continue
      const b = before?.[shape]?.[key]
      const delta = b ? `   ${fmt(d.median - b.median, f)}` : ''
      console.log(`${`${key} ${label ?? unit}`.padEnd(24)} ${fmt(d.median, f).padStart(8)} ${fmt(d.p10, f).padStart(8)} ${fmt(d.p90, f).padStart(8)} ${fmt(d.min, f).padStart(8)} ${fmt(d.max, f).padStart(8)}  ${target ? `${target[0]}–${target[1]}` : ''}${delta}`)
    }
    console.log('Köppen group, % of land (median p10–p90)   Earth: Beck 1991–2020 all land / without Antarctica')
    for (const g of ['A', 'B', 'C', 'D', 'E']) {
      const d = s.koppen[g]
      console.log(`  ${g}  ${fmt(d.median, 100).padStart(6)}  ${fmt(d.p10, 100)}–${fmt(d.p90, 100)}    Earth ${fmt(beck.all[g], 100)} / ${fmt(beck.noAntarctica[g], 100)}`)
    }
    console.log('|lat| band   T °C median (p10–p90)   Earth    P land mm/yr median (p10–p90)   Earth')
    for (let b = 0; b < 9; b++) {
      const t = s.bandT[b], p = s.bandPLand[b]
      console.log(`  ${String(b * 10).padStart(2)}–${String(b * 10 + 10).padStart(2)}°   ${fmt(t.median, 1, 1).padStart(6)} (${fmt(t.p10, 1, 1)}–${fmt(t.p90, 1, 1)})   ${String(EARTH_T[b]).padStart(6)}    ${fmt(p.median, 1, 0).padStart(6)} (${fmt(p.p10, 1, 0)}–${fmt(p.p90, 1, 0)})   ${EARTH_P_LAND[b]}`)
    }
    console.log('time per stage, s (median, max): ' + Object.entries(s.time).map(([k, d]) => `${k} ${fmt(d.median, 1, 1)}/${fmt(d.max, 1, 1)}`).join(', '))
    console.log('pentagons (anomaly vs hexagons: max |z| median, mean |z| median, mean rank of |anomaly| median):')
    for (const [k, d] of Object.entries(s.pentagons)) console.log(`  ${k.padEnd(14)} max|z| ${fmt(d.maxAbsZ.median, 1, 2)} (max ${fmt(d.maxAbsZ.max, 1, 2)})  mean|z| ${fmt(d.meanAbsZ.median, 1, 2)}  rank ${fmt(d.meanRank.median, 1, 2)}`)
    console.log('seam |Δ| at x = 0/W over the inner columns\' (median, max): ' + Object.entries(s.seam).map(([k, d]) => `${k} ${fmt(d.median, 1, 2)}/${fmt(d.max, 1, 2)}`).join(', '))
    console.log(`pole rows' temperature spread °C (median): top ${fmt(s.poleRows.top.median, 1, 2)}, bottom ${fmt(s.poleRows.bottom.median, 1, 2)}, a row's mean ${fmt(s.poleRows.meanRow.median, 1, 2)}; zonal T's |second difference| per row max ${fmt(s.zonal.max.median, 1, 2)} vs median ${fmt(s.zonal.median.median, 1, 3)}`)
    if (Object.keys(s.sweeps).length) {
      console.log('sweeps (mean change against the same seeds\' defaults):')
      const keys = Object.keys(Object.values(s.sweeps)[0].d)
      console.log(`  ${'setting'.padEnd(24)} ${keys.map((k) => k.padStart(9)).join(' ')}`)
      for (const [k, v] of Object.entries(s.sweeps).sort()) console.log(`  ${`${k} (${v.n})`.padEnd(24)} ${keys.map((m) => fmt(v.d[m], 1, 1).padStart(9)).join(' ')}`)
    }
  }
}

// --- main --------------------------------------------------------------------------

const mode = process.argv[2]
if (mode === 'one') {
  const job = JSON.parse(process.argv[3])
  const out = await buildOne(job)
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exit(0)
} else if (mode === 'report') {
  const run = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  const before = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], 'utf8')).summary : null
  printSummary(summarise(run.worlds), before)
  process.exit(0)
} else {
  const { opt, tune } = parseArgs(process.argv.slice(2))
  mkdirSync(opt.out, { recursive: true })
  const shapes = opt.shapes.split(',')
  const seeds = SEEDS.slice(0, opt.seeds)
  const base = { epochs: opt.epochs, stabilised: opt.stabilised, archeanMax: opt.archeanMax, archeanMa: opt.archeanMa, landShare: opt.landShare, tune }
  const jobs = []
  for (const shape of shapes) for (const seed of seeds) jobs.push({ ...base, seed, shape })
  if (opt.sweep) {
    for (const shape of shapes) for (const seed of seeds.slice(0, opt.sweepSeeds)) {
      for (const [path, vals] of Object.entries(SWEEPS)) for (const v of vals) jobs.push({ ...base, seed, shape, set: { [path]: v } })
    }
  }
  const filtered = opt.only ? jobs.filter((j) => `${j.shape}:${j.seed}:${JSON.stringify(j.set ?? {})}`.includes(opt.only)) : jobs
  const file = `${opt.out}/${opt.label}.json`
  console.log(`${filtered.length} worlds, ${opt.jobs} at once (${os.cpus().length} cores) → ${file}`)
  const started = Date.now()
  const done = []
  const worlds = await pool(filtered, opt.jobs, (r) => {
    done.push(r)
    const what = `${r.shape} ${r.seed}${Object.keys(r.set ?? {}).length ? ` ${JSON.stringify(r.set)}` : ''}`
    console.log(r.error ? `  FAILED ${what}: ${r.error.split('\n').slice(-6).join(' | ')}` : `  ${what}: land ${(r.landFraction * 100).toFixed(1)} %, plates ${r.plates}, peak ${r.peakM.toFixed(0)} m, ${Object.values(r.time).reduce((a, b) => a + b, 0).toFixed(0)} s`)
    writeFileSync(file, JSON.stringify({ options: opt, tune, partial: true, worlds: done }, null, 1))
  })
  const summary = summarise(worlds)
  writeFileSync(file, JSON.stringify({ options: opt, tune, minutes: (Date.now() - started) / 60000, worlds, summary }, null, 1))
  printSummary(summary)
  console.log(`\n${((Date.now() - started) / 60000).toFixed(1)} min; ${file}`)
}

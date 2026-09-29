// The hydrology CALIBRATION instrument: a lake census by elevation band (with
// basin provenance — did the depression exist before erosion?) and drawn
// river-network density by precipitation band, against a runoff-floored
// counterfactual. Run it whenever a constant that shapes lakes or the channel
// criterion moves; it answers "what changed, where" without a browser.
//
//   node --max-old-space-size=8192 scripts/measureHydrology.mjs
//
// The chain mirrors golden.mjs exactly (climate v1 on the raw terrain ->
// erosion -> refined climate on the eroded field -> discharge/lakes), at two
// control sets: the 2026-08-16 finding's slider values (400/100/65) and the
// declared defaults. First finding measured with it, for calibration: the
// P4 runoff-floor removal is NOT what densified drawn rivers (the floored
// counterfactual sits within 3-10%, the floor even ADDED channels — the
// "too many rivers" screenshot was the unfiltered 8K network at world zoom),
// and every >3000 m lake sat in a PRE-EROSION tectonic basin (800-1400 m
// deep at 6-7 km altitude), held brim-full by the cold PET floor at -50 °C —
// the erosion engine itself drains basins (age 400 left 5 lakes of 279).
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  sim: await L('/src/generator/tectonics/plateSimulation.ts'),
  field: await L('/src/generator/elevation/elevationField.ts'),
  dynamic: await L('/src/generator/elevation/dynamicTopography.ts'),
  mantle: await L('/src/generator/mantle/mantleField.ts'),
  ridged: await L('/src/generator/elevation/ridgedNoise.ts'),
  scale: await L('/src/generator/elevation/elevationScale.ts'),
  erosionForcing: await L('/src/generator/pipeline/erosionForcing.ts'),
  erosionPassV2: await L('/src/generator/surface/erosionPassV2.ts'),
  routing: await L('/src/generator/surface/flowRouting.ts'),
  hydro: await L('/src/generator/surface/hydrology.ts'),
  temperature: await L('/src/generator/climate/temperature.ts'),
  wind: await L('/src/generator/climate/wind.ts'),
  currents: await L('/src/generator/climate/oceanCurrents.ts'),
  seasonality: await L('/src/generator/climate/seasonality.ts'),
  monsoon: await L('/src/generator/climate/monsoon.ts'),
  climateField: await L('/src/generator/climate/climateField.ts'),
  precip: await L('/src/generator/climate/precipitation.ts'),
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
  finalize: await L('/src/generator/archean/finalizeArchean.ts'),
}

const W = 2048, H = 1024
const CRX = M.climateField.CLIMATE_RES_X, CRY = M.climateField.CLIMATE_RES_Y
const SEA = M.scale.SEA_LEVEL
const toM = M.scale.elevationToMeters
const KM2_PER_CELL = 7.8 * 7.8
const log = (s) => process.stderr.write(s + '\n')

log('building world (alpha, archean 180 + 50 epochs) ...')
let t0 = Date.now()
const archean = M.archean.createArcheanSimulation('alpha', W, H)
for (let e = 0; e < 180; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
for (let e = 0; e < 50; e++) M.sim.stepEpoch(sim)
const base = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, W, H, sim.warpSeed)
{ // dynamic topography (F3), as the pipeline adds it
  const dyn = M.dynamic.dynamicTopographyField(sim.mantle, M.mantle.MANTLE_RES_X, M.mantle.MANTLE_RES_Y, W, H, W, H)
  for (let i = 0; i < base.length; i++) base[i] += dyn[i]
}
const bk = M.field.buildFeatureBuckets(sim.features, W, H)
const salt = (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0
const raw = new Float32Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
  raw[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, W, H,
    M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed),
    M.ridged.fineDetailNoise(s.wx, s.wy, W, H, salt))
}
log(`world built in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

// Pre-erosion closed-basin depth: which depressions exist BEFORE the engine
// runs (tectonic) — the provenance test for high lakes.
const rawRouting = await M.routing.fillDepressionsAndRouteFlow(raw, W, H, 0)
const rawBasinDepth = new Float32Array(W * H)
for (let i = 0; i < raw.length; i++) rawBasinDepth[i] = rawRouting.filled[i] - raw[i]

const wrap = (x, y) => ((y + H) % H) * W + ((x + W) % W)

function lakeCensus(lakes, el, tCoarse) {
  const seen = new Uint8Array(W * H)
  const queue = new Int32Array(W * H)
  const regions = []
  for (let s = 0; s < W * H; s++) {
    if (lakes.depth[s] <= 0 || seen[s]) continue
    let head = 0, tail = 0
    queue[tail++] = s; seen[s] = 1
    let area = 0, maxDepth = 0, surface = -Infinity, floor = Infinity
    let tSum = 0, rawBasinMax = 0
    while (head < tail) {
      const c = queue[head++]
      area++
      if (lakes.depth[c] > maxDepth) maxDepth = lakes.depth[c]
      const lvl = el[c] + lakes.depth[c]
      if (lvl > surface) surface = lvl
      if (el[c] < floor) floor = el[c]
      if (rawBasinDepth[c] > rawBasinMax) rawBasinMax = rawBasinDepth[c]
      const cx = c % W, cy = (c - cx) / W
      const gx = Math.min(CRX - 1, Math.floor((cx / W) * CRX))
      const gy = Math.min(CRY - 1, Math.floor((cy / H) * CRY))
      tSum += tCoarse[gy * CRX + gx]
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nb = wrap(cx + dx, cy + dy)
        if (lakes.depth[nb] > 0 && !seen[nb]) { seen[nb] = 1; queue[tail++] = nb }
      }
    }
    const tMean = tSum / area
    regions.push({ area, maxDepthM: toM(maxDepth), surfaceM: toM(surface - SEA), tMean, pet: M.hydro.evaporationPotential(tMean), rawBasinMaxM: toM(rawBasinMax) })
  }
  return regions
}

const BANDS = [[-Infinity, 500], [500, 1500], [1500, 3000], [3000, 4500], [4500, 6000], [6000, Infinity]]
const bandName = ([a, b]) => `${a === -Infinity ? '<' : a + '-'}${b === Infinity ? '6000+' : b} m`

function precipBandStats(mask, el, precip) {
  // channel cells per coarse-precip band (land only)
  const edges = [250, 600, 1200]
  const counts = [0, 0, 0, 0], landCounts = [0, 0, 0, 0]
  for (let c = 0; c < W * H; c++) {
    if (el[c] <= SEA) continue
    const cx = c % W, cy = (c - cx) / W
    const gx = Math.min(CRX - 1, Math.floor((cx / W) * CRX))
    const gy = Math.min(CRY - 1, Math.floor((cy / H) * CRY))
    const p = precip[gy * CRX + gx]
    const band = p < edges[0] ? 0 : p < edges[1] ? 1 : p < edges[2] ? 2 : 3
    landCounts[band]++
    if (mask[c]) counts[band]++
  }
  return counts.map((n, i) => `${['<250', '250-600', '600-1200', '1200+'][i]}mm: ${n} ch / ${(landCounts[i] / 1000).toFixed(0)}k land (${(n / Math.max(1, landCounts[i]) * 1000).toFixed(1)}/1k)`)
}

async function measure(name, controls) {
  log(`\n=== ${name} (age ${controls.age}, alluvium ${controls.alluvium}, rockContrast ${controls.rockContrast}) ===`)
  t0 = Date.now()
  const { forcing, params } = M.erosionForcing.assembleErosionForcing(sim, raw, W, H, controls)
  const ero = await M.erosionPassV2.runErosionPassV2(raw, W, H, forcing, { age: controls.age, params })
  const el = ero.elevations
  log(`erosion solved in ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  // Climate v1 on raw (as the worker does), then the refinement on eroded.
  let temperature = M.temperature.computeTemperature(raw, W, H)
  const wind = M.wind.computeWind()
  let currents = M.currents.computeOceanCurrents(raw, wind, W, H)
  M.currents.applyOceanSST(temperature, currents, raw, W, H, wind)
  let seasonal = M.seasonality.computeSeasonalAmplitude(raw, W, H)
  let precipitation = M.monsoon.computeSeasonalPrecipitation(raw, temperature, seasonal, wind, W, H, 1, 0).annual

  const routing = await M.routing.fillDepressionsAndRouteFlow(el, W, H, 0)
  let discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
  let lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, temperature, precipitation, CRX, CRY)
  const t2 = M.temperature.computeTemperature(el, W, H, 0, 1, 0, lakes.dryBasin)
  const c2 = M.currents.computeOceanCurrents(el, wind, W, H, lakes.dryBasin)
  M.currents.applyOceanSST(t2, c2, el, W, H, wind, lakes.dryBasin)
  const s2 = M.seasonality.computeSeasonalAmplitude(el, W, H, 0, lakes.dryBasin)
  precipitation = M.monsoon.computeSeasonalPrecipitation(el, t2, s2, wind, W, H, 1, 0, lakes.dryBasin).annual
  discharge = M.hydro.accumulateDischarge(routing, el, precipitation, CRX, CRY)
  const maxDis = M.hydro.maxDischargeOverLand(discharge, el)
  lakes = M.hydro.computeLakes(routing, discharge, ero.preFillElevations, t2, precipitation, CRX, CRY)

  // --- terrain shape ---
  let land = 0, over3k = 0, over45 = 0, over6k = 0
  for (let i = 0; i < el.length; i++) {
    if (el[i] <= SEA) continue
    land++
    const m = toM(el[i] - SEA)
    if (m > 3000) over3k++
    if (m > 4500) over45++
    if (m > 6000) over6k++
  }
  console.log(`\n--- ${name} ---`)
  console.log(`land ${(land / el.length * 100).toFixed(1)}%; of land: >3000m ${(over3k / land * 100).toFixed(2)}%  >4500m ${(over45 / land * 100).toFixed(2)}%  >6000m ${(over6k / land * 100).toFixed(3)}%`)

  // --- A. lakes ---
  const regions = lakeCensus(lakes, el, t2)
  console.log(`lakes total: ${regions.length}, area ${(regions.reduce((s, r) => s + r.area, 0) * KM2_PER_CELL / 1000).toFixed(0)}k km2`)
  for (const band of BANDS) {
    const rs = regions.filter((r) => r.surfaceM > band[0] && r.surfaceM <= band[1])
    if (!rs.length) continue
    const area = rs.reduce((s, r) => s + r.area, 0) * KM2_PER_CELL
    const tectonic = rs.filter((r) => r.rawBasinMaxM > 8) // basin existed pre-erosion (above the lake gate)
    console.log(`  ${bandName(band).padEnd(12)} ${String(rs.length).padStart(4)} lakes, ${(area / 1000).toFixed(1).padStart(8)}k km2, maxDepth p100 ${Math.max(...rs.map((r) => r.maxDepthM)).toFixed(0)} m, tectonic-basin ${tectonic.length}/${rs.length}, meanT ${(rs.reduce((s, r) => s + r.tMean, 0) / rs.length).toFixed(1)}°C, PET ${(rs.reduce((s, r) => s + r.pet, 0) / rs.length).toFixed(0)}`)
  }
  const high = regions.filter((r) => r.surfaceM > 3000).sort((a, b) => b.area - a.area).slice(0, 8)
  if (high.length) {
    console.log('  largest lakes above 3000 m:')
    for (const r of high) console.log(`    ${(r.area * KM2_PER_CELL).toFixed(0).padStart(7)} km2 @ ${r.surfaceM.toFixed(0)} m, depth ${r.maxDepthM.toFixed(0)} m, pre-erosion basin ${r.rawBasinMaxM.toFixed(1)} m, T ${r.tMean.toFixed(1)}°C, PET ${r.pet.toFixed(0)} mm`)
  }

  // --- B. rivers, real vs floored counterfactual ---
  const CANON = M.hydro.CANONICAL_RIVER_DENSITY
  const stats = (precipField) => {
    const meanRunoff = M.hydro.meanLandRunoff(precipField, el, W, H, CRX, CRY)
    const dis = M.hydro.accumulateDischarge(routing, el, precipField, CRX, CRY)
    const threshold = M.hydro.channelThreshold(M.hydro.densityToCriticalArea(CANON), meanRunoff)
    const mask = M.hydro.buildChannelMask(routing, el, dis, threshold)
    let cells = 0
    for (let i = 0; i < mask.length; i++) if (mask[i]) cells++
    const rivers = M.hydro.extractRiverPolylines(routing, dis, el, threshold, maxDis)
    return { meanRunoff, threshold, cells, polylines: rivers.lengths.length, vertices: rivers.points.length / 3, mask, dis }
  }
  const real = stats(precipitation)
  const floored = precipitation.slice()
  for (let i = 0; i < floored.length; i++) if (floored[i] !== M.precip.OCEAN_PRECIP && floored[i] < 200) floored[i] = 200
  const ctf = stats(floored)
  console.log(`rivers (canonical density ${CANON}):`)
  console.log(`  REAL      meanRunoff ${real.meanRunoff.toFixed(0)}, channel cells ${real.cells} (${(real.cells / land * 1000).toFixed(1)}/1k land), polylines ${real.polylines}, vertices ${real.vertices}`)
  console.log(`  FLOOR200  meanRunoff ${ctf.meanRunoff.toFixed(0)}, channel cells ${ctf.cells} (${(ctf.cells / land * 1000).toFixed(1)}/1k land), polylines ${ctf.polylines}, vertices ${ctf.vertices}`)
  console.log('  REAL channel density by precip band:')
  for (const line of precipBandStats(real.mask, el, precipitation)) console.log(`    ${line}`)
  console.log('  FLOOR200 channel density by precip band:')
  for (const line of precipBandStats(ctf.mask, el, floored)) console.log(`    ${line}`)
}

await measure('USER 400/100/65', { age: 400, alluvium: 100, rockContrast: 65 })
await measure('DEFAULTS 40/50/50', { age: 40, alluvium: 50, rockContrast: 50 })
await server.close()
log('done')

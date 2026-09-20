// Which ridged-noise octave band gives the GENERATOR angular mountains?
//
// The amplification bake already proved the diagnosis at its own tier: the
// shipped table's dominant octave sits at ~500 km, which is mountain-RANGE
// scale, so it modulates ranges rather than texturing them. This asks the
// same question of the generator's authoritative 2048x1024 raster, on a REAL
// world (Archean -> plate tectonics, exactly as golden.mjs builds one) rather
// than a synthetic bump, because the ridge term is modulated by feature-driven
// uplift and a synthetic world has no features.
//
// Metrics, all after erosion (which is what the eye actually sees):
//   crest sharpness — mean drop from a local maximum to its 8 neighbours, in
//                     metres. A crest is sharp, a dome is not.
//   peaks           — how many local maxima exist at all; a few big bulges
//                     versus a genuine ridge network.
//   land fraction   — the guard rail. The ridge term is gated to uplift > 0,
//                     so coastlines should barely move; if they do, the
//                     candidate is rewriting geography, not texturing it.
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const W = 2048, H = 1024
const EPOCHS = 50, ARCHEAN_EPOCHS = 180
const SEED = 'alpha'

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  sim: await L('/src/generator/tectonics/plateSimulation.ts'),
  field: await L('/src/generator/elevation/elevationField.ts'),
  ridged: await L('/src/generator/elevation/ridgedNoise.ts'),
  erosionForcing: await L('/src/generator/pipeline/erosionForcing.ts'),
  erosionPassV2: await L('/src/generator/surface/erosionPassV2.ts'),
  scale: await L('/src/generator/elevation/elevationScale.ts'),
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
  finalize: await L('/src/generator/archean/finalizeArchean.ts'),
}

// World width in km, for reporting octave wavelengths in something physical.
const WORLD_KM = (W * 7800) / 1000 // METERS_PER_CELL

const CANDIDATES = [
  { name: 'A shipped         ', cells: [32, 64, 128, 256], amps: [1, 0.5, 0.25, 0.125] },
  { name: 'C crest-weighted  ', cells: [32, 64, 128, 256, 512], amps: [0.4, 0.5, 0.7, 1, 0.7] },
  { name: 'F crest-heavy     ', cells: [32, 64, 128, 256, 512], amps: [0.2, 0.25, 0.4, 1, 1] },
  { name: 'G crest-heaviest  ', cells: [32, 64, 128, 256, 512], amps: [0.15, 0.2, 0.3, 0.7, 1] },
  { name: 'E finest-dominant ', cells: [256, 512], amps: [1, 0.5] },
]

// ridgedMultifractal with an INJECTED octave table — otherwise identical to
// the shipped function (fold, square, halving salt), so the comparison is
// about the band and nothing else.
function ridgedWith(cells, amps, x, y, seed) {
  let sum = 0, ampSum = 0, octaveSeed = seed >>> 0
  for (let k = 0; k < cells.length; k++) {
    const cx = cells[k], cy = cells[k] / 2
    const n = M.ridged.periodicValueNoise2D((x / W) * cx, (y / H) * cy, cx, cy, octaveSeed)
    const ridge = 1 - Math.abs(2 * n - 1)
    sum += ridge * ridge * amps[k]
    ampSum += amps[k]
    octaveSeed = (octaveSeed * 1664525 + 1013904223) >>> 0
  }
  return sum / ampSum
}

// The centring constant is table-specific: fold-and-square biases the mean,
// and the shipped RIDGE_MEAN was MEASURED for the shipped table. Any
// candidate needs its own, or the term stops being zero-mean and silently
// raises or lowers all uplifted terrain.
function measureMean(cells, amps, seed) {
  let sum = 0, n = 0
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { sum += ridgedWith(cells, amps, x, y, seed); n++ }
  return sum / n
}

function crestMetrics(el) {
  const M9000 = 9000
  const sea = M.scale.SEA_LEVEL
  let peaks = 0, sharpness = 0, land = 0
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (el[i] > sea) land++
      if (el[i] <= sea) continue
      let drop = 0, isMax = true
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const n = el[(y + dy) * W + ((x + dx + W) % W)]
          if (n >= el[i]) { isMax = false; break }
          drop += el[i] - n
        }
      }
      if (!isMax) continue
      peaks++
      sharpness += (drop / 8) * M9000
    }
  }
  return { peaks, sharpness: peaks > 0 ? sharpness / peaks : 0, landFraction: land / (W * H) }
}

// One world, built once — every candidate is scored on the SAME tectonics, so
// any difference is the ridge band and not a different planet.
const archean = M.archean.createArcheanSimulation(SEED, W, H)
for (let e = 0; e < ARCHEAN_EPOCHS; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
for (let e = 0; e < EPOCHS; e++) M.sim.stepEpoch(sim)
const baseline = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, W, H, sim.warpSeed)
const buckets = M.field.buildFeatureBuckets(sim.features, W, H)
const fineSalt = (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0
console.log(`world "${SEED}": ${sim.rafts.length} rafts, ${sim.features.length} features\n`)

for (const c of CANDIDATES) {
  const mean = measureMean(c.cells, c.amps, sim.warpSeed)
  const el = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
      const ridge = ridgedWith(c.cells, c.amps, s.wx, s.wy, sim.warpSeed)
      // computeElevation subtracts RIDGE_MEAN internally, so hand it a value
      // already re-centred onto that constant: ridge - mean + RIDGE_MEAN.
      el[y * W + x] = M.field.computeElevation(s.wx, s.wy, baseline[y * W + x], buckets, W, H,
        ridge - mean + M.ridged.RIDGE_MEAN,
        M.ridged.fineDetailNoise(s.wx, s.wy, W, H, fineSalt))
    }
  }
  const raw = crestMetrics(el)
  // The v2 engine at default controls (age = the slider's declared default),
  // forced by the sim — v1's pass is gone (P5 teardown); "after erosion" now
  // means the same solve the generator runs.
  const { forcing, params } = M.erosionForcing.assembleErosionForcing(sim, el, W, H, {})
  const ero = await M.erosionPassV2.runErosionPassV2(el, W, H, forcing, { age: 40, params })
  const m = crestMetrics(ero.elevations)
  const km = c.cells.map((n) => Math.round(WORLD_KM / n)).join('/')
  console.log(`${c.name} mean=${mean.toFixed(4)}  ${km} km` +
    `\n   raw    peaks=${String(raw.peaks).padStart(6)}  crest=${raw.sharpness.toFixed(1).padStart(6)} m  land=${(raw.landFraction * 100).toFixed(2)}%` +
    `\n   eroded peaks=${String(m.peaks).padStart(6)}  crest=${m.sharpness.toFixed(1).padStart(6)} m  land=${(m.landFraction * 100).toFixed(2)}%`)
}

await server.close()

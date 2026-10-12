// Builds a REAL world through the same path the golden harness uses and packs
// it as a save .zip, so the server-side baker can be tested against terrain
// that actually has a drainage network. Synthetic ridges do not: they shed
// water in parallel sheets with no confluence, so no cell ever accumulates
// enough upstream area to become a channel.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const OUT = process.argv[2] ?? '/tmp/real-world.zip'
const W = 2048, H = 1024

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p) => server.ssrLoadModule(p)
const M = {
  sim: await L('/src/generator/tectonics/plateSimulation.ts'),
  field: await L('/src/generator/elevation/elevationField.ts'),
  ridged: await L('/src/generator/elevation/ridgedNoise.ts'),
  erosionForcing: await L('/src/generator/pipeline/erosionForcing.ts'),
  erosionPassV2: await L('/src/generator/surface/erosionPassV2.ts'),
  surfaceInputs: await L('/src/generator/surface/surfaceInputParams.ts'),
  climateField: await L('/src/generator/climate/climateField.ts'),
  weather: await L('/src/generator/climate/weather.ts'),
  climateMesh: await L('/src/generator/climate/climateMesh.ts'),
  climatePoints: await L('/src/generator/climate/climatePoints.ts'),
  climateFields: await L('/src/world/save/climateFields.ts'),
  archean: await L('/src/generator/archean/archeanState.ts'),
  archeanStep: await L('/src/generator/archean/archeanStep.ts'),
  finalize: await L('/src/generator/archean/finalizeArchean.ts'),
}

process.stderr.write('building a real world … ')
const archean = M.archean.createArcheanSimulation('alpha', W, H)
for (let e = 0; e < 180; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
for (let e = 0; e < 50; e++) M.sim.stepEpoch(sim)
const base = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, sim.domain, sim.warpSeed)
const bk = M.field.buildFeatureBuckets(sim.features, sim.domain)
const salt = (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0
const raw = new Float32Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const s = M.field.warpedSamplePoint(x, y, sim.domain, sim.warpSeed)
  raw[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, sim.domain,
    M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed),
    M.ridged.fineDetailNoise(s.wx, s.wy, W, H, salt))
}
// The v2 engine at the sliders' declared defaults, forced by the sim itself —
// the same step golden.mjs runs.
const CONTROLS = {
  age: M.surfaceInputs.SURFACE_INPUTS.landscapeAge.default,
  alluvium: M.surfaceInputs.SURFACE_INPUTS.alluvium.default,
  rockContrast: M.surfaceInputs.SURFACE_INPUTS.rockContrast.default,
}
const { forcing, params } = M.erosionForcing.assembleErosionForcing(sim, raw, sim.domain, CONTROLS)
const ero = await M.erosionPassV2.runErosionPassV2(raw, sim.domain, forcing, { age: CONTROLS.age, params })
const el = ero.elevations

// The static climate on its field mesh (DEC-0036 phase 3), its cells as
// the save holds them (climate.json + climate/, phase 7) — through the
// save's own writer, so the fixture cannot describe them otherwise.
const weather = M.weather.computeWeather(M.climateMesh.climateTerrain(sim.domain, el, sim.domain.width, sim.domain.height), M.weather.defaultWeatherParams())
const climate = M.climateFields.climateEntries(M.climatePoints.climateCellValues(M.climatePoints.climateCellsFromWeather(weather)))
process.stderr.write('ok\n')

const zip = new JSZip()
zip.file('manifest.json', JSON.stringify({
  formatVersion: 1, generatorVersion: 'casas-eternas/v1alpha1',
  world: { width: W, height: H },
  layers: [
    { name: 'elevation', file: 'elevation.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 }, unit: 'relative', landOnly: false },
  ],
}, null, 2))
zip.file('world.yaml', [
  'apiVersion: casas-eternas/v1alpha1', 'kind: FlatWorld', 'metadata:', '  name: alpha',
  '  uid: 7c9e6679-7425-40de-944b-e07fc1f90ae7', 'spec:', '  seed: "alpha"', '  erosion:',
  // The sliders' declared defaults, matching the CONTROLS the pass above ran
  // with — so the save's recipe and its terrain agree, as a real save's do.
  `    landscapeAge: ${CONTROLS.age}`, `    alluvium: ${CONTROLS.alluvium}`, `    rockContrast: ${CONTROLS.rockContrast}`,
  'status:', '  erosionRun: 1', '  revision: 1', '',
].join('\n'))
zip.file('elevation.f32', el.buffer)
zip.file('climate.json', climate.meta)
for (const [file, bytes] of climate.files) zip.file(file, bytes)
writeFileSync(OUT, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
await server.close()
console.log(`wrote ${OUT}`)

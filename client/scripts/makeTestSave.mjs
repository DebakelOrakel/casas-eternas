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
  sim: await L('/src/worldgen/tectonics/plateSimulation.ts'),
  field: await L('/src/worldgen/elevation/elevationField.ts'),
  ridged: await L('/src/worldgen/elevation/ridgedNoise.ts'),
  erosion: await L('/src/worldgen/surface/erosion.ts'),
  climateField: await L('/src/worldgen/climate/climateField.ts'),
  temperature: await L('/src/worldgen/climate/temperature.ts'),
  wind: await L('/src/worldgen/climate/wind.ts'),
  currents: await L('/src/worldgen/climate/oceanCurrents.ts'),
  seasonality: await L('/src/worldgen/climate/seasonality.ts'),
  monsoon: await L('/src/worldgen/climate/monsoon.ts'),
  layers: await L('/src/worldgen/worldSave/worldLayers.ts'),
  archean: await L('/src/worldgen/archean/archeanState.ts'),
  archeanStep: await L('/src/worldgen/archean/archeanStep.ts'),
  finalize: await L('/src/worldgen/archean/finalizeArchean.ts'),
}

process.stderr.write('building a real world … ')
const archean = M.archean.createArcheanSimulation('alpha', W, H)
for (let e = 0; e < 180; e++) M.archeanStep.archeanStep(archean)
const sim = M.finalize.finalizeArchean(archean)
for (let e = 0; e < 50; e++) M.sim.stepEpoch(sim)
const base = M.field.computeRaftBaseline(sim.rafts, sim.oceanAge, W, H, W, H, sim.warpSeed)
const bk = M.field.buildFeatureBuckets(sim.features, W, H)
const salt = (sim.warpSeed ^ M.ridged.FINE_DETAIL_SEED_SALT) >>> 0
const raw = new Float32Array(W * H)
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
  raw[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, W, H,
    M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed),
    M.ridged.fineDetailNoise(s.wx, s.wy, W, H, salt))
}
const ero = await M.erosion.runErosionPass(raw, W, H, M.erosion.DEFAULT_EROSION_PASS_PARAMS)
const el = ero.elevations

const temperature = M.temperature.computeTemperature(el, W, H)
const wind = M.wind.computeWind()
const currents = M.currents.computeOceanCurrents(el, wind, W, H)
M.currents.applyOceanSST(temperature, currents, el, W, H)
const seasonal = M.seasonality.computeSeasonalAmplitude(el, W, H)
const precipitation = M.monsoon.computeSeasonalPrecipitation(el, temperature, seasonal, wind, W, H, 1, 0).annual
const CRX = M.climateField.CLIMATE_RES_X, CRY = M.climateField.CLIMATE_RES_Y
process.stderr.write('ok\n')

// Quantised through the save's own writer AND its own canonical spec.
// Inventing scale/offset here was a real bug in this fixture: `scale: 1`
// decoded to a 18288 mm maximum with zero ocean sentinels, so the hydrology
// re-run found no channels and every baked world came out riverless — which
// looked exactly like a broken baker.
const PRECIP_SPEC = M.layers.WORLD_LAYERS.find((l) => l.name === 'precipitation')
if (!PRECIP_SPEC) throw new Error('no precipitation spec in WORLD_LAYERS')
const precipBytes = M.layers.bakeLayer(precipitation, PRECIP_SPEC)

const zip = new JSZip()
zip.file('manifest.json', JSON.stringify({
  formatVersion: 1, generatorVersion: 'casas-eternas/v1alpha1',
  world: { width: W, height: H, topology: 'torus' },
  layers: [
    { name: 'elevation', file: 'elevation.f32', kind: 'raster', resX: W, resY: H, dtype: 'f32', encoding: { scale: 1, offset: 0 }, unit: 'relative', landOnly: false },
    { name: 'precipitation', file: 'precipitation.u16', kind: 'raster', resX: CRX, resY: CRY, dtype: PRECIP_SPEC.dtype, encoding: { scale: PRECIP_SPEC.scale, offset: PRECIP_SPEC.offset }, unit: PRECIP_SPEC.unit, landOnly: PRECIP_SPEC.landOnly },
  ],
}, null, 2))
zip.file('world.yaml', [
  'apiVersion: casas-eternas/v1alpha1', 'kind: FlatWorld', 'metadata:', '  name: alpha',
  '  uid: 7c9e6679-7425-40de-944b-e07fc1f90ae7', 'spec:', '  seed: "alpha"', '  erosion:',
  // Slider RANGES, not invented numbers. Writing erosionStrength: 100 here —
  // a plausible-looking "percent" — set the pass's timeStep to 100x and planed
  // every continent to sea level, which looked exactly like a broken baker.
  // The slider is 1..5, default 2.
  '    erosionStrength: 2', '    drainageRefresh: 3', '  hydrology:', '    riverDensity: 55',
  'status:', '  erosionRun: 1', '  revision: 1', '',
].join('\n'))
zip.file('elevation.f32', el.buffer)
zip.file('precipitation.u16', precipBytes)
writeFileSync(OUT, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
await server.close()
console.log(`wrote ${OUT}`)

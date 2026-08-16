// The first run of the REAL P2 configuration: raw tectonic terrain as the
// initial condition, the exported U(x) (elevation/upliftField.ts) as the
// forcing — against the P0 stand-in (smoothed standing relief ^1.5) on the
// same world. Builds a real world headless through the same path
// makeTestSave.mjs uses, then runs the v2 engine twice at 512 and reports
// where the two forcings agree, and what each does to the landscape.
//
//   npx tsx scripts/erosion-v2-uplift-check.mts <outDir>
//
// Writes artifact-shaped outputs (elevation.u16 + meta.json) for the raw
// terrain and both engine runs into <outDir>/{raw,standin,real}, so any
// crop/metric instrument can read them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const OUT = process.argv[2]
if (!OUT) {
  console.error('usage: npx tsx scripts/erosion-v2-uplift-check.mts <outDir>')
  process.exit(2)
}
const W = 2048
const H = 1024

const { createServer } = await import(`${CLIENT}/node_modules/vite/dist/node/index.js`)
const server = await createServer({ root: CLIENT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = (p: string) => server.ssrLoadModule(p)
const M = {
  sim: await L('/src/worldgen/tectonics/plateSimulation.ts'),
  field: await L('/src/worldgen/elevation/elevationField.ts'),
  ridged: await L('/src/worldgen/elevation/ridgedNoise.ts'),
  uplift: await L('/src/worldgen/elevation/upliftField.ts'),
  erodibility: await L('/src/worldgen/elevation/erodibilityField.ts'),
  engine: await L('/src/worldgen/surface/erosionEngine.ts'),
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
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const s = M.field.warpedSamplePoint(x, y, W, H, sim.warpSeed)
    raw[y * W + x] = M.field.computeElevation(s.wx, s.wy, base[y * W + x], bk, W, H,
      M.ridged.ridgedMultifractal(s.wx, s.wy, W, H, sim.warpSeed),
      M.ridged.fineDetailNoise(s.wx, s.wy, W, H, salt))
  }
}
process.stderr.write(`ok (${sim.features.length} features)\n`)

// --- the two forcings at 256×128 --------------------------------------------
const FW = 256
const FH = 128
const uReal = M.uplift.computeUpliftField(sim.features, W, H, FW, FH)

const uStandin = new Float32Array(FW * FH)
{
  const fx = W / FW
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let s = 0
      for (let dy = 0; dy < fx; dy++) {
        for (let dx = 0; dx < fx; dx++) s += raw[(y * fx + dy) * W + x * fx + dx]
      }
      uStandin[y * FW + x] = Math.pow(Math.max(0, s / (fx * fx)), 1.5)
    }
  }
  const tmp = uStandin.slice()
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) s += tmp[((y + dy + FH) % FH) * FW + ((x + dx + FW) % FW)]
      }
      uStandin[y * FW + x] = s / 9
    }
  }
  let peak = 0
  for (let i = 0; i < uStandin.length; i++) if (uStandin[i] > peak) peak = uStandin[i]
  if (peak > 0) for (let i = 0; i < uStandin.length; i++) uStandin[i] /= peak
}

// Where do the two forcings put their weight, relative to each other and to
// the mountains? Pearson correlation over the frame, plus each field's mass
// share on high ground.
{
  let sumR = 0
  let sumS = 0
  for (let i = 0; i < FW * FH; i++) { sumR += uReal[i]; sumS += uStandin[i] }
  const meanR = sumR / (FW * FH)
  const meanS = sumS / (FW * FH)
  let covariance = 0
  let varR = 0
  let varS = 0
  for (let i = 0; i < FW * FH; i++) {
    const a = uReal[i] - meanR
    const b = uStandin[i] - meanS
    covariance += a * b
    varR += a * a
    varS += b * b
  }
  const correlation = covariance / Math.sqrt(varR * varS)
  let massHighR = 0
  let massR = 0
  let massHighS = 0
  let massS = 0
  const fx = W / FW
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let s = 0
      for (let dy = 0; dy < fx; dy++) {
        for (let dx = 0; dx < fx; dx++) s += raw[(y * fx + dy) * W + x * fx + dx]
      }
      const highGround = s / (fx * fx) > 0.15 // ~1350 m
      const i = y * FW + x
      const positiveR = Math.max(0, uReal[i])
      massR += positiveR
      massS += uStandin[i]
      if (highGround) { massHighR += positiveR; massHighS += uStandin[i] }
    }
  }
  let negativeShare = 0
  let totalAbs = 0
  for (let i = 0; i < FW * FH; i++) { totalAbs += Math.abs(uReal[i]); if (uReal[i] < 0) negativeShare += -uReal[i] }
  console.log(`forcing comparison at ${FW}×${FH}:`)
  console.log(`  correlation(real, standin) = ${correlation.toFixed(3)}`)
  console.log(`  mass on high ground: real ${(100 * massHighR / massR).toFixed(1)} %  standin ${(100 * massHighS / massS).toFixed(1)} %`)
  console.log(`  negative (subsiding) share of real U: ${(100 * negativeShare / totalAbs).toFixed(1)} %`)
}

// --- the K-factor field -------------------------------------------------------
// sim.epoch + archeanEpochs, NOT sim.epoch: blob birthEpochs are stamped in
// ARCHEAN epochs and never remapped at finalizeArchean, while the tectonic
// clock restarts at 0 — against sim.epoch alone a young world's oldness
// clamps to 0 everywhere (measured: hardness field came out neutral). The
// combined axis is right for archean-born blobs and wrong only for the few
// tectonic-era accretions — a KNOWN pre-existing defect of the birthEpoch
// axis itself (also distorts the cratonAge overlay and ecology iron on
// young worlds), reported 2026-08-16, fix pending a decision.
const hardness = M.erodibility.computeErodibilityField(
  sim.rafts, sim.sutures, sim.features, sim.epoch + sim.archeanEpochs, W, H, FW, FH)
{
  let min = Infinity
  let max = -Infinity
  let below = 0
  let above = 0
  for (let i = 0; i < hardness.length; i++) {
    if (hardness[i] < min) min = hardness[i]
    if (hardness[i] > max) max = hardness[i]
    if (hardness[i] < 0.95) below++
    if (hardness[i] > 1.05) above++
  }
  console.log(`hardness field: range ${min.toFixed(2)}–${max.toFixed(2)}, hardened ${(100 * below / hardness.length).toFixed(1)} %, softened ${(100 * above / hardness.length).toFixed(1)} % of cells (${sim.sutures.length} sutures)`)
}

// --- engine runs at 512 -------------------------------------------------------
const RES_X = 512
const RES_Y = 256
const n = RES_X * RES_Y
const factor = W / RES_X
const z0 = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    let s = 0
    for (let dy = 0; dy < factor; dy++) {
      for (let dx = 0; dx < factor; dx++) s += raw[(y * factor + dy) * W + x * factor + dx]
    }
    z0[y * RES_X + x] = s / (factor * factor)
  }
}
const upsample = (coarse: Float32Array): Float32Array => {
  const out = new Float32Array(n)
  for (let y = 0; y < RES_Y; y++) {
    for (let x = 0; x < RES_X; x++) {
      const u = (x / RES_X) * FW
      const v = (y / RES_Y) * FH
      const x0 = Math.floor(u)
      const y0 = Math.floor(v)
      const tx = u - x0
      const ty = v - y0
      const at = (xx: number, yy: number): number => coarse[(((yy % FH) + FH) % FH) * FW + (((xx % FW) + FW) % FW)]
      out[y * RES_X + x] = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
    }
  }
  return out
}
const LITHO_SIGMA = 1.4
const LITHO_SEED = 0x51702e77
const erodibility = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    erodibility[y * RES_X + x] = Math.exp(LITHO_SIGMA * M.ridged.fineDetailNoise((x * 512) / RES_X, (y * 256) / RES_Y, 512, 256, LITHO_SEED))
  }
}
const coastMask = new Uint8Array(n)
for (let i = 0; i < n; i++) if (z0[i] > 0) coastMask[i] = 1

const AGE = 100
const writeOut = (name: string, field: Float32Array, extra: Record<string, unknown>): void => {
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  const u16 = new Uint16Array(field.length)
  for (let i = 0; i < field.length; i++) {
    const v = Math.round(((field[i] + 1) / 2) * 65535)
    u16[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }
  writeFileSync(join(dir, 'elevation.u16'), Buffer.from(u16.buffer))
  writeFileSync(join(dir, 'rivers-64.f32'), Buffer.alloc(0))
  writeFileSync(join(dir, 'riverLengths-64.u32'), Buffer.alloc(0))
  const width = field.length === n ? RES_X : W
  const height = field.length === n ? RES_Y : H
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    key: { worldUid: 'p2', worldId: 'uplift-check', pipelineVersion: 'v2-p2', stage: `${width}` },
    width, height, ...extra,
  }))
}
writeOut('raw', raw, { engine: 'tectonics-raw' })

const stats = (z: Float32Array): string => {
  let land = 0
  for (let i = 0; i < n; i++) if (z[i] > 0) land++
  return `land ${(100 * land / n).toFixed(1)} %`
}
const hardnessUp = upsample(hardness)
const erodibilityReal = new Float32Array(n)
for (let i = 0; i < n; i++) erodibilityReal[i] = erodibility[i] * hardnessUp[i]
for (const [name, forcing, erod] of [
  ['standin', uStandin, erodibility],
  ['real', uReal, erodibility],
  ['realk', uReal, erodibilityReal],
] as const) {
  const engine = new M.engine.ErosionEngine(RES_X, RES_Y, z0, {
    uplift: upsample(forcing),
    erodibility: erod,
    coastMask,
  })
  const t0 = performance.now()
  const residual = engine.run(AGE, 4)
  writeOut(name, engine.z, { engine: `erosion-v2 age ${AGE}, forcing ${name}`, residualM: residual })
  console.log(`${name.padEnd(7)} age ${AGE}: ${stats(engine.z)}  residual ${residual.toFixed(1)} m  (${((performance.now() - t0) / 1000).toFixed(0)} s)`)
}

await server.close()

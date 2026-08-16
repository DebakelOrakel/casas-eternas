// Port gate for the erosion-v2 engine core (src/worldgen/surface/erosionEngine.ts):
// runs the TS engine and the measured threading spike (erosion-v2-spike.mjs)
// on the same input, forcing and parameters, and compares the resulting
// terrain BYTE FOR BYTE. The two implement the same algorithm to the same
// float-op order; any divergence is a port bug, not noise.
//
//   npx tsx scripts/erosion-v2-engine-check.mts <artifactDir> [res] [iters]
//
// Defaults: 512×256, 20 iterations, routing refresh every iteration —
// small enough to run freely (~10 s), long enough that a routing or
// physics divergence has amplified into visible bytes (capture chaos
// doubles any difference within a few iterations, which makes this gate
// SHARP: after 20 iterations even a one-ulp deviation shows).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErosionEngine, DEFAULT_ENGINE_PARAMS } from '../src/worldgen/surface/erosionEngine'
import { PooledErosionEngine, PipelinedErosionEngine } from '../src/worldgen/surface/erosionEnginePool'
import { Worker as NodeWorker } from 'node:worker_threads'
import { fineDetailNoise } from '../src/worldgen/elevation/ridgedNoise'

const [artifactDir, resArg, itersArg] = process.argv.slice(2)
if (!artifactDir) {
  console.error('usage: npx tsx scripts/erosion-v2-engine-check.mts <artifactDir> [res] [iters]')
  process.exit(2)
}
const RES_X = Number(resArg ?? 512)
const RES_Y = RES_X / 2
const ITERS = Number(itersArg ?? 20)
const n = RES_X * RES_Y

// --- inputs, identical to the spike's own construction -----------------------
const meta = JSON.parse(readFileSync(join(artifactDir, 'meta.json'), 'utf8'))
const srcW = meta.width as number
const raw = new Uint16Array(readFileSync(join(artifactDir, 'elevation.u16')).buffer.slice(0))
const factor = srcW / RES_X
if (!Number.isInteger(factor)) throw new Error(`source ${srcW} not divisible by ${RES_X}`)
const z = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    let s = 0
    for (let dy = 0; dy < factor; dy++) {
      for (let dx = 0; dx < factor; dx++) s += raw[(y * factor + dy) * srcW + x * factor + dx]
    }
    z[y * RES_X + x] = (s / (factor * factor)) * (2 / 65535) - 1
  }
}

// U forcing from the common 256×128 frame (the P0 stand-in for the tectonic
// export), erodibility from the world-space lithology noise — both exactly
// as the spike builds them.
const FW = 256
const FH = 128
const uCoarse = new Float32Array(FW * FH)
{
  const f2 = srcW / FW
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let s = 0
      for (let dy = 0; dy < f2; dy++) {
        for (let dx = 0; dx < f2; dx++) s += raw[(y * f2 + dy) * srcW + x * f2 + dx]
      }
      const v = (s / (f2 * f2)) * (2 / 65535) - 1
      uCoarse[y * FW + x] = Math.pow(Math.max(0, v), 1.5)
    }
  }
  const tmp = uCoarse.slice()
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) s += tmp[((y + dy + FH) % FH) * FW + ((x + dx + FW) % FW)]
      }
      uCoarse[y * FW + x] = s / 9
    }
  }
}
const uplift = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    const u = (x / RES_X) * FW
    const v = (y / RES_Y) * FH
    const x0 = Math.floor(u)
    const y0 = Math.floor(v)
    const fx = u - x0
    const fy = v - y0
    const at = (xx: number, yy: number): number => uCoarse[(((yy % FH) + FH) % FH) * FW + (((xx % FW) + FW) % FW)]
    uplift[y * RES_X + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
}
const LITHO_SIGMA = 1.4
const LITHO_SEED = 0x51702e77
const erodibility = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    const noise = fineDetailNoise((x * 512) / RES_X, (y * 256) / RES_Y, 512, 256, LITHO_SEED)
    erodibility[y * RES_X + x] = Math.exp(LITHO_SIGMA * noise)
  }
}

// --- the engine --------------------------------------------------------------
const engine = new ErosionEngine(RES_X, RES_Y, z, { uplift, erodibility }, DEFAULT_ENGINE_PARAMS)
const t0 = performance.now()
const residual = engine.run(ITERS, 1)
const engineMs = performance.now() - t0
const engineU16 = new Uint16Array(n)
for (let i = 0; i < n; i++) {
  const v = Math.round(((engine.z[i] + 1) / 2) * 65535)
  engineU16[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
}

// --- the spike, same inputs --------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'erosion-v2-check-'))
try {
  const lithoFile = join(work, 'litho.f32')
  writeFileSync(lithoFile, Buffer.from(erodibility.buffer))
  const outDir = join(work, 'spike-out')
  execFileSync('node', [
    join(import.meta.dirname, 'erosion-v2-spike.mjs'),
    artifactDir, lithoFile, String(RES_X), String(ITERS), '0', outDir, '1',
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  const spikeU16 = new Uint16Array(readFileSync(join(outDir, 'elevation.u16')).buffer.slice(0))

  let differing = 0
  let maxDelta = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs(engineU16[i] - spikeU16[i])
    if (d > 0) differing++
    if (d > maxDelta) maxDelta = d
  }
  console.log(`engine: ${ITERS} iters at ${RES_X}×${RES_Y} in ${(engineMs / 1000).toFixed(1)} s, residual ${residual.toFixed(2)} m`)
  if (differing === 0) {
    console.log('PASS — engine output is byte-identical to the spike')
  } else {
    console.log(`FAIL — ${differing} of ${n} cells differ (max ${maxDelta} u16 quanta = ${(maxDelta * 2 * 9000 / 65535).toFixed(2)} m)`)
    process.exitCode = 1
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

// --- the worker pool: byte parity across worker counts -----------------------
// The pooled engine runs the SAME kernels over the same state layout, so
// its output must equal the single-threaded engine's exactly, for any
// worker count. Workers are Node worker_threads loading the TS entry —
// execArgv is inherited from the tsx parent, which is what makes that
// possible in this harness (the browser spawns the same file via ?worker).
const workerUrl = new URL('../src/worldgen/surface/erosionEngineWorker.ts', import.meta.url)
for (const workerCount of [2, 8]) {
  const pool = await PooledErosionEngine.create(
    RES_X, RES_Y, z, { uplift, erodibility },
    () => new NodeWorker(workerUrl) as never,
    workerCount, DEFAULT_ENGINE_PARAMS)
  const t1 = performance.now()
  pool.run(ITERS, 1)
  const poolMs = performance.now() - t1
  await pool.close()
  let differing = 0
  for (let i = 0; i < n; i++) {
    const v = Math.round(((pool.z[i] + 1) / 2) * 65535)
    const clamped = v < 0 ? 0 : v > 65535 ? 65535 : v
    if (clamped !== engineU16[i]) differing++
  }
  if (differing === 0) {
    console.log(`PASS — pool(${workerCount}) byte-identical to single-threaded (${(poolMs / 1000).toFixed(1)} s vs ${(engineMs / 1000).toFixed(1)} s)`)
  } else {
    console.log(`FAIL — pool(${workerCount}): ${differing} of ${n} cells differ`)
    process.exitCode = 1
  }
}

// --- the pipelined engine: deterministic across worker splits ----------------
// Pipelining changes the routing-staleness SCHEDULE (fixed depth D, swap at
// fixed boundaries), so its output legitimately differs from the
// synchronous engine — but it must be byte-identical across ANY worker
// split, and statistically indistinguishable from the synchronous run.
let pipelineReference: Uint16Array | null = null
for (const [stencilWorkers, refreshWorkers] of [[2, 1], [4, 2]] as const) {
  const pipeline = await PipelinedErosionEngine.create(
    RES_X, RES_Y, z, { uplift, erodibility },
    () => new NodeWorker(workerUrl) as never,
    { stencilWorkers, refreshWorkers, pipelineDepth: 8 })
  const t2 = performance.now()
  pipeline.run(ITERS)
  const pipeMs = performance.now() - t2
  await pipeline.close()
  const bytes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const v = Math.round(((pipeline.z[i] + 1) / 2) * 65535)
    bytes[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }
  if (!pipelineReference) {
    pipelineReference = bytes
    let land = 0
    let landSync = 0
    for (let i = 0; i < n; i++) {
      if (bytes[i] > 32767) land++
      if (engineU16[i] > 32767) landSync++
    }
    console.log(`pipelined(D=8): land ${(100 * land / n).toFixed(1)} % vs sync ${(100 * landSync / n).toFixed(1)} % (${(pipeMs / 1000).toFixed(1)} s)`)
  } else {
    let differing = 0
    for (let i = 0; i < n; i++) if (bytes[i] !== pipelineReference[i]) differing++
    if (differing === 0) {
      console.log(`PASS — pipelined byte-identical across worker splits (2+1 vs ${stencilWorkers}+${refreshWorkers})`)
    } else {
      console.log(`FAIL — pipelined split mismatch: ${differing} of ${n} cells`)
      process.exitCode = 1
    }
  }
}

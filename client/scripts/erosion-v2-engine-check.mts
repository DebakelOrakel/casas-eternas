// Gates for the erosion-v2 engine (src/generator/surface/erosionEngine.ts):
// the shelf band's cost in sediment, byte parity of the worker pool with the
// single-threaded engine (which is also what proves the basin-parallel walks
// independent of the worker split), determinism of the pipelined engine
// across worker splits, the hydrology bridge, and the pass adapter's
// contract.
//
//   npx tsx scripts/erosion-v2-engine-check.mts <artifactDir> [res] [iters]
//
// Defaults: 512×256, 20 iterations, routing refresh every iteration —
// small enough to run freely (~10 s), long enough that a routing or
// physics divergence has amplified into visible bytes (capture chaos
// doubles any difference within a few iterations, which makes the parity
// gates SHARP: after 20 iterations even a one-ulp deviation shows).
//
// The input is a bake artifact directory (meta.json + elevation.u16) — a
// real world with a drainage network; synthetic ridges shed water in
// parallel sheets and never make a channel.
//
// History: until phase 0 of the adaptive-mesh plan this script also
// compared the engine byte for byte against the P1 threading spike
// (erosion-v2-spike.mjs). The spike floods in sixteen strips and the engine
// no longer does, so that comparison ended with the strips; the spike stays
// in the tree as the measured record it always was.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErosionEngine, DEFAULT_ENGINE_PARAMS } from '../src/generator/surface/erosionEngine'
import { PooledErosionEngine, PipelinedErosionEngine } from '../src/generator/surface/erosionEnginePool'
import { Worker as NodeWorker } from 'node:worker_threads'
import { fineDetailNoise } from '../src/generator/elevation/ridgedNoise'
import { ELEVATION_METERS } from '../src/generator/elevation/elevationScale'
import { EROSION_LITHO_SEED_SALT } from '../src/generator/surface/erosionForcingFields'
import { engineFlowRouting } from '../src/generator/surface/erosionEngineBridge'
import { runErosionPassV2 } from '../src/generator/surface/erosionPassV2'
import { accumulateDischarge, computeLakes } from '../src/generator/surface/hydrology'

const [artifactDir, resArg, itersArg] = process.argv.slice(2)
if (!artifactDir) {
  console.error('usage: npx tsx scripts/erosion-v2-engine-check.mts <artifactDir> [res] [iters]')
  process.exit(2)
}
const RES_X = Number(resArg ?? 512)
const RES_Y = RES_X / 2
const ITERS = Number(itersArg ?? 20)
const n = RES_X * RES_Y

// --- inputs ------------------------------------------------------------------
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
// export), erodibility from the world-space lithology noise.
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
const LITHO_SEED = EROSION_LITHO_SEED_SALT
const erodibility = new Float32Array(n)
for (let y = 0; y < RES_Y; y++) {
  for (let x = 0; x < RES_X; x++) {
    const noise = fineDetailNoise((x * 512) / RES_X, (y * 256) / RES_Y, 512, 256, LITHO_SEED)
    erodibility[y * RES_X + x] = Math.exp(LITHO_SIGMA * noise)
  }
}

const toU16 = (field: Float32Array): Uint16Array => {
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const v = Math.round(((field[i] + 1) / 2) * 65535)
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v
  }
  return out
}
const landStats = (field: Float32Array): { fraction: number; meanM: number } => {
  let land = 0
  let sum = 0
  for (let i = 0; i < n; i++) if (field[i] > 0) { land++; sum += field[i] }
  return { fraction: land / n, meanM: land > 0 ? (sum / land) * ELEVATION_METERS : 0 }
}

// --- the engine --------------------------------------------------------------
const engine = new ErosionEngine(RES_X, RES_Y, z, { uplift, erodibility }, DEFAULT_ENGINE_PARAMS)
const t0 = performance.now()
const residual = engine.run(ITERS, 1)
const engineMs = performance.now() - t0
const engineZ = engine.expandZ(z)
const engineU16 = toU16(engineZ)
const active = engine.index.activeCount
console.log(`engine: ${ITERS} iters at ${RES_X}×${RES_Y} in ${(engineMs / 1000).toFixed(1)} s, residual ${residual.toFixed(2)} m, active ${(100 * active / n).toFixed(1)} % of cells`)

// --- the shelf band: what the frozen ocean costs -----------------------------
// The gate is the LAND: with the default band the engine must make,
// statistically, the land it makes with the whole ocean active (bytes may
// differ — the flood's epsilon chains and the marine tail both see the
// band — but land fraction and mean land height must not). The export
// past the rim is reported, not gated: marine deposition is capped per
// iteration, so a trunk river's load runs on as a submarine fan far past
// any band, and with the whole ocean active it only spread over the abyss.
{
  const exportShare = engine.erodedFluxM3 > 0 ? engine.exportedFluxM3 / engine.erodedFluxM3 : 0
  const wide = new ErosionEngine(RES_X, RES_Y, z, { uplift, erodibility }, { ...DEFAULT_ENGINE_PARAMS, shelfBandKm: 1e9 })
  const t1 = performance.now()
  wide.run(ITERS, 1)
  const wideMs = performance.now() - t1
  const wideZ = wide.expandZ(z)
  const a = landStats(engineZ)
  const b = landStats(wideZ)
  const wideU16 = toU16(wideZ)
  let landDiffering = 0
  let landCells = 0
  for (let i = 0; i < n; i++) {
    if (engineU16[i] <= 32767 && wideU16[i] <= 32767) continue
    landCells++
    if (wideU16[i] !== engineU16[i]) landDiffering++
  }
  const fractionOk = Math.abs(a.fraction - b.fraction) < 0.002
  const meanOk = Math.abs(a.meanM - b.meanM) < 5
  const ok = fractionOk && meanOk
  console.log(`${ok ? 'PASS' : 'FAIL'} — shelf band ${DEFAULT_ENGINE_PARAMS.shelfBandKm} km: land ${(100 * a.fraction).toFixed(2)} % / mean ${a.meanM.toFixed(1)} m vs whole-ocean ${(100 * b.fraction).toFixed(2)} % / ${b.meanM.toFixed(1)} m (${landDiffering} of ${landCells} land cells differ; ${(engineMs / 1000).toFixed(1)} s vs ${(wideMs / 1000).toFixed(1)} s at ${(100 * wide.index.activeCount / n).toFixed(0)} % active); rim exports ${(100 * exportShare).toFixed(1)} % of the eroded volume`)
  if (!ok) process.exitCode = 1
}

// --- the worker pool: byte parity across worker counts -----------------------
// The pooled engine runs the SAME kernels over the same state layout, so
// its output must equal the single-threaded engine's exactly, for any
// worker count. Workers are Node worker_threads loading the TS entry —
// execArgv is inherited from the tsx parent, which is what makes that
// possible in this harness (the browser spawns the same file via ?worker).
const workerUrl = new URL('../src/generator/surface/erosionEngineWorker.ts', import.meta.url)
for (const workerCount of [2, 8]) {
  const pool = await PooledErosionEngine.create(
    RES_X, RES_Y, z, { uplift, erodibility },
    () => new NodeWorker(workerUrl) as never,
    workerCount, DEFAULT_ENGINE_PARAMS)
  const t1 = performance.now()
  pool.run(ITERS, 1)
  const poolMs = performance.now() - t1
  await pool.close()
  const poolU16 = toU16(pool.expandZ(z))
  let differing = 0
  for (let i = 0; i < n; i++) if (poolU16[i] !== engineU16[i]) differing++
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
  const bytes = toU16(pipeline.expandZ(z))
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

// --- the hydrology bridge: the lakes/discharge on the engine's own network --
// Smoke gate, not physics: the hydrology must RUN on the engine's routing
// via the bridge and produce a sane water world — positive discharge on
// land, concentrated onto channels, and flooded depressions classified.
{
  const routing = engineFlowRouting(engine.views, engine.index, engine.poppedCount, engineZ)
  const CRX = 256
  const CRY = 128
  const precip = new Float32Array(CRX * CRY).fill(800)
  const temperature = new Float32Array(CRX * CRY).fill(15)
  const discharge = accumulateDischarge(routing, engineZ, precip, CRX, CRY)
  const lakes = computeLakes(routing, discharge, engineZ, temperature, precip, CRX, CRY)
  let landCells = 0
  let wetLand = 0
  let maxDischarge = 0
  for (let i = 0; i < n; i++) {
    if (engineZ[i] > 0) {
      landCells++
      if (discharge[i] > 0) wetLand++
      if (discharge[i] > maxDischarge) maxDischarge = discharge[i]
    }
  }
  let lakeCells = 0
  let saltCells = 0
  for (let i = 0; i < n; i++) {
    if (lakes.depth[i] > 0) lakeCells++
    if (lakes.saltFlat[i]) saltCells++
  }
  const ok = wetLand === landCells && maxDischarge > 800 * 50 && lakes.depth.length === n
  console.log(`${ok ? 'PASS' : 'FAIL'} — hydrology on engine routing: discharge on ${wetLand}/${landCells} land cells (max ${(maxDischarge / 800).toFixed(0)} cells eq.), ${lakeCells} lake + ${saltCells} salt cells`)
  if (!ok) process.exitCode = 1
}

// --- the pass adapter: the pipeline's contract, both execution paths ---------
{
  const single = await runErosionPassV2(z, RES_X, RES_Y, { uplift, erodibility }, { age: 8 })
  const pooled = await runErosionPassV2(z, RES_X, RES_Y, { uplift, erodibility }, {
    age: 8,
    pool: { createWorker: () => new NodeWorker(workerUrl) as never, stencilWorkers: 2, refreshWorkers: 1, pipelineDepth: 4 },
  })
  const contractOk = (r: typeof single): boolean =>
    r.elevations.length === n && r.preFillElevations.length === n &&
    r.routing.poppedCount > 0 && r.routing.flowTarget.length === n &&
    r.accumulation.length === n && r.elevations !== r.preFillElevations
  // Frozen ocean cells come back untouched, exactly as they went in.
  let frozenMoved = 0
  for (let i = 0; i < n; i++) if (engine.index.activeOf[i] < 0 && single.elevations[i] !== z[i]) frozenMoved++
  const ok = contractOk(single) && contractOk(pooled) && frozenMoved === 0
  console.log(`${ok ? 'PASS' : 'FAIL'} — runErosionPassV2 contract holds on both paths (popped ${single.routing.poppedCount} / ${pooled.routing.poppedCount}, ${frozenMoved} frozen cells moved)`)
  if (!ok) process.exitCode = 1
}

// THE INCUBATOR'S MODULE of the job worker (workerContract.ts): the
// incubator's history of a world from one origin, as a job
// (docs/decisions/incubator-history-engine.md, "The way there", step 4).
// Bundled by `make worker` into incubator.mjs beside pipeline.mjs, with the
// incubator's native build beside it (casas-incubator.node), and put into the
// incubator's release (.github/workflows/incubator-release.yml). The host
// (jobWorker.ts) runs it as it runs a pipeline module: its pipeline is the
// incubator's version (INCUBATOR_VERSION), the route of the history jobs' tasks
// (internal/modules/jobs, ScopeHistory).
//
// WHAT COMPUTES. The incubator's crate, native (casas-incubator-node): the
// cells, the flora, the fauna, the run, the H1 bytes — the same bits as
// its WASM build in the incubator (engine/scripts/incubatorSmoke.mjs). Its
// input is made by the incubator's own functions (historyInput.ts): the
// chart's node map from level 1 (the crate's chart), the cells' input,
// the rain. The engine's
// native build reads the save and level 1 (casas-generator.node beside it).
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { domainOfKind } from '../src/generator/core/domain'
import { openWorld } from '../src/world/query'
import { meshLevelStage, readMeshLevelArtifact } from '../src/world/meshArtifacts'
import { INCUBATOR_VERSION, historyKey, peoplingInput, readHistoryArtifact, writeHistoryArtifact } from '../src/world/historyArtifacts'
import { artifactKey } from '../src/storage/ArtifactStore'
import { cellInputOf, chartOf, CHART_HEIGHT, CHART_WIDTH, incubatorOf, rainOf, type ChartBuild, type HistoryChart, type HistoryIncubator, type IncubatorBuild } from '../src/screens/incubator/historyInput'
import { loadNativeEngine, type NativeEngine } from './engineNative'
import { laps } from './laps'
import { WORKER_CONTRACT, type PipelineIO, type PipelineTask, type PipelineVersion, type TaskOutcome } from './workerContract'

export const contract = WORKER_CONTRACT

export const version: PipelineVersion = { pipelineVersion: INCUBATOR_VERSION, tilePipelineVersions: {} }

// The incubator's native build (casas-incubator-node).
interface NativeIncubator extends HistoryIncubator {
  simulate(origin: number, seed: number, rainWidth: number, rainHeight: number, variability: Float32Array | undefined, enso: Float32Array | undefined, ensoStrength: number, reachKm: number, seaLowM: number): Uint8Array
}
interface NativeIncubatorBuild {
  version(): string
  Incubator: IncubatorBuild<NativeIncubator>
  Chart: ChartBuild<HistoryChart>
}

// The builds beside this module, loaded at the first task: --version
// loads the module without them.
let engines: { engine: NativeEngine; incubator: NativeIncubatorBuild } | null = null
function builds(): NonNullable<typeof engines> {
  if (!engines) {
    const incubator = createRequire(import.meta.url)(fileURLToPath(new URL('./casas-incubator.node', import.meta.url))) as NativeIncubatorBuild
    if (incubator.version() !== INCUBATOR_VERSION) throw new Error(`casas-incubator.node is ${incubator.version()}, this module ${INCUBATOR_VERSION}`)
    engines = { engine: loadNativeEngine(fileURLToPath(new URL('./casas-generator.node', import.meta.url))), incubator }
  }
  return engines
}

// One history, start to artifact (PipelineModule.runTask).
export async function runTask(task: PipelineTask, io: PipelineIO): Promise<TaskOutcome> {
  const clock = laps()
  const asked = task.history
  if (!asked) throw new Error('the incubator module runs histories only')
  const { engine, incubator: build } = builds()
  io.progress('read', 0)
  const read = await io.readWorld()
  if (!read || read === 'unchanged') throw new Error('cannot read the world')
  const world = await openWorld(read.archive, engine)
  if (!world) throw new Error('not a readable world archive')
  const worldId = await world.worldId()
  const store = io.store(world.recipe.worldUid)
  // Step 1's input: a control left out is its default, passed as given.
  const input = peoplingInput(asked.origin, { ...(asked.reach ? { reachKm: asked.reach } : {}), ...(asked.seaLow ? { seaLowM: asked.seaLow } : {}) })
  const key = historyKey(worldId, asked.level, input)
  const result = (nodes: number, durationMs: number): TaskOutcome['result'] => ({ worldId, pipelineVersion: key.pipelineVersion, stage: key.stage, width: world.width, height: world.height, nodes, durationMs })
  clock.lap('world')
  if (task.reuse && (await readHistoryArtifact(store, key))) return { result: result(0, 0), laps: clock.times }
  const started = Date.now()
  const levelRead = await readMeshLevelArtifact(store, artifactKey(worldId, asked.level, meshLevelStage(1)), engine)
  if (!levelRead) throw new Error(`no level 1 of ${worldId} under ${asked.level}`)
  const level = levelRead.artifact
  if (!level.land) throw new Error('level 1 has no land fields')
  clock.lap('level')
  io.progress('cells', 0)
  const kind = world.kind === 'SphereWorld' ? 'sphere' : 'torus'
  const chart = chartOf(build.Chart, kind, world.width, world.height, level)
  chart.pass(level.z, level.land.land, level.land.biome, CHART_WIDTH, CHART_HEIGHT)
  const nodes = chart.takeNodes()
  const refined = await world.refined()
  const rain = refined ? rainOf(domainOfKind(kind, world.width, world.height), refined) : null
  const seed = world.recipe.detailSeed
  const incubator = incubatorOf(build.Incubator, cellInputOf(kind, world.width, world.height, nodes, level, level.land))
  clock.lap('cells')
  io.progress('history', 0)
  incubator.growFlora(seed)
  incubator.populate(seed)
  const bytes = incubator.simulate(asked.origin, seed, rain?.width ?? 0, rain?.height ?? 0, rain?.variability, rain?.enso, rain?.ensoStrength ?? 0, input.reachKm, input.seaLowM)
  clock.lap('history')
  const durationMs = Date.now() - started
  io.progress('store', 0)
  const packed = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  if (!(await writeHistoryArtifact(store, key, asked.origin, packed, durationMs, world.recipe.seedText))) throw new Error('could not write the history')
  clock.lap('write')
  return { result: result(incubator.count(), durationMs), laps: clock.times }
}

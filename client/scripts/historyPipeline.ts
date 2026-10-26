// THE HISTORY'S MODULE of the job worker (workerContract.ts): the
// incubator's history of a world from one origin, as a job
// (docs/decisions/incubator-history-engine.md, "The way there", step 4).
// Bundled by `make worker` into history.mjs beside pipeline.mjs, with the
// history's native build beside it (casas-history.node), and put into the
// history's release (.github/workflows/history-release.yml). The host
// (jobWorker.ts) runs it as it runs a pipeline module: its pipeline is the
// history's version (HISTORY_VERSION), the route of the history's tasks
// (internal/modules/jobs, ScopeHistory).
//
// WHAT COMPUTES. The history's crate, native (casas-history-node): the
// cells, the flora, the fauna, the run, the H1 bytes — the same bits as
// its WASM build in the incubator (engine/scripts/historySmoke.mjs). Its
// input is made by the incubator's own functions (historyInput.ts): the
// chart's node map from level 1, the cells' input, the rain. The engine's
// native build reads the save and level 1 (casas-engine.node beside it).
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { domainOfKind } from '../src/generator/core/domain'
import { openWorld } from '../src/world/query'
import { meshLevelMesh, meshLevelStage, readMeshLevelArtifact } from '../src/world/meshArtifacts'
import { HISTORY_VERSION, historyKey, readHistoryArtifact, writeHistoryArtifact } from '../src/world/historyArtifacts'
import { artifactKey } from '../src/storage/ArtifactStore'
import { cellInputOf, chartPass, CHART_HEIGHT, CHART_WIDTH, incubatorOf, rainOf, type HistoryIncubator, type IncubatorBuild } from '../src/screens/incubator/historyInput'
import { loadNativeEngine, type NativeEngine } from './engineNative'
import { laps } from './laps'
import { WORKER_CONTRACT, type PipelineIO, type PipelineTask, type PipelineVersion, type TaskOutcome } from './workerContract'

export const contract = WORKER_CONTRACT

export const version: PipelineVersion = { pipelineVersion: HISTORY_VERSION, tilePipelineVersions: {} }

// The history's native build (casas-history-node).
interface NativeIncubator extends HistoryIncubator {
  simulate(origin: number, seed: number, rainWidth: number, rainHeight: number, variability: Float32Array | undefined, enso: Float32Array | undefined, ensoStrength: number): Uint8Array
}
interface NativeHistory {
  version(): string
  Incubator: IncubatorBuild<NativeIncubator>
}

// The builds beside this module, loaded at the first task: --version
// loads the module without them.
let engines: { engine: NativeEngine; history: NativeHistory } | null = null
function builds(): NonNullable<typeof engines> {
  if (!engines) {
    const history = createRequire(import.meta.url)(fileURLToPath(new URL('./casas-history.node', import.meta.url))) as NativeHistory
    if (history.version() !== HISTORY_VERSION) throw new Error(`casas-history.node is ${history.version()}, this module ${HISTORY_VERSION}`)
    engines = { engine: loadNativeEngine(fileURLToPath(new URL('./casas-engine.node', import.meta.url))), history }
  }
  return engines
}

// One history, start to artifact (PipelineModule.runTask).
export async function runTask(task: PipelineTask, io: PipelineIO): Promise<TaskOutcome> {
  const clock = laps()
  const asked = task.history
  if (!asked) throw new Error('the history module runs histories only')
  const { engine, history } = builds()
  io.progress('read', 0)
  const read = await io.readWorld()
  if (!read || read === 'unchanged') throw new Error('cannot read the world')
  const world = await openWorld(read.archive, engine)
  if (!world) throw new Error('not a readable world archive')
  const worldId = await world.worldId()
  const store = io.store(world.recipe.worldUid)
  const key = historyKey(worldId, asked.level, asked.origin)
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
  const mesh = meshLevelMesh(level, world.width, world.height, kind)
  const { nodes } = chartPass(mesh, level.z, level.land, CHART_WIDTH, CHART_HEIGHT)
  const refined = await world.refined()
  const rain = refined ? rainOf(domainOfKind(kind, world.width, world.height), refined) : null
  const seed = world.recipe.detailSeed
  const incubator = incubatorOf(history.Incubator, cellInputOf(kind, world.width, world.height, nodes, level, level.land))
  clock.lap('cells')
  io.progress('history', 0)
  incubator.growFlora(seed)
  incubator.populate(seed)
  const bytes = incubator.simulate(asked.origin, seed, rain?.width ?? 0, rain?.height ?? 0, rain?.variability, rain?.enso, rain?.ensoStrength ?? 0)
  clock.lap('history')
  const durationMs = Date.now() - started
  io.progress('store', 0)
  const packed = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  if (!(await writeHistoryArtifact(store, key, asked.origin, packed, durationMs, world.recipe.seedText))) throw new Error('could not write the history')
  clock.lap('write')
  return { result: result(incubator.count(), durationMs), laps: clock.times }
}

import incubatorVersion from 'casas-incubator-wasm/version.json'
import incubatorConstants from 'casas-incubator-wasm/constants.json'
import { artifactKey, writeArtifactFiles, type ArtifactKey, type ArtifactStore } from '../storage/ArtifactStore'

// THE HISTORY'S ARTIFACT, H1 (2026-10-26, DEC-0048): the incubator's simulated history of a world (casas-incubator),
// packed whole (historyPack.ts), so a world opened again with the same
// origin loads it instead of running it. On the server: the browser does
// not upload (DEC-0039), a job writes it (scripts/incubatorPipeline.ts) when
// the history shown is saved; until then the browser only shows it.
//
// Keyed by content, as every artifact: the terrain (worldId), the level it
// runs on and the history's own version (pipelineVersion: the pipeline of
// the level 1 read, `+`, INCUBATOR_VERSION), and step 1's input (the stage):
// the origin people set out from, `H1:<cell>`, and step 1's controls
// (2026-10-30, DES-0032), `:r<km>` and `:s<m>` after it, each only where
// it is not the default — a history at the defaults keeps its key. The incubator's version is its crate's
// (casas-incubator tuning.rs, `v<INCUBATOR_ALGO_VERSION>-<hash>`): derived from
// its tuning and catalog, as the pipeline's from the engine's constants;
// the number raised by hand on a change to the code that changes what a
// run gives or to the packed form.
export const INCUBATOR_VERSION: string = incubatorVersion.version
export const HISTORY_FILES = { history: 'history.bin', meta: 'meta.json' } as const

// STEP 1'S INPUT (casas-incubator peopling.rs): the origin's cell, the
// boats' reach over open sea at step 1's end, km, the sea's drop at the
// coldest, m. Step 2 runs from it, so it is the history's input too.
export interface PeoplingInput {
  origin: number
  reachKm: number
  seaLowM: number
}
// The controls' defaults: the crate's (peopling.rs REACH_END_KM,
// climate_history.rs SEA_DROP_M), read from its tuning.
export const PEOPLING_DEFAULTS = { reachKm: incubatorConstants.peopling.REACH_END_KM, seaLowM: incubatorConstants.climate.SEA_DROP_M } as const
export const peoplingInput = (origin: number, controls: Partial<Omit<PeoplingInput, 'origin'>> = {}): PeoplingInput => ({ origin, ...PEOPLING_DEFAULTS, ...controls })
export const samePeopling = (a: PeoplingInput, b: PeoplingInput): boolean => a.origin === b.origin && a.reachKm === b.reachKm && a.seaLowM === b.seaLowM

const HISTORY_STAGE = 'H1'
export const historyStage = (input: PeoplingInput): string =>
  `${HISTORY_STAGE}:${input.origin}${input.reachKm !== PEOPLING_DEFAULTS.reachKm ? `:r${input.reachKm}` : ''}${input.seaLowM !== PEOPLING_DEFAULTS.seaLowM ? `:s${input.seaLowM}` : ''}`
// The input of a history's stage; null for another stage.
export function parseHistoryStage(stage: string): PeoplingInput | null {
  const match = /^H1:(\d+)(?::r(\d+))?(?::s(\d+))?$/.exec(stage)
  if (!match) return null
  return peoplingInput(Number(match[1]), { ...(match[2] ? { reachKm: Number(match[2]) } : {}), ...(match[3] ? { seaLowM: Number(match[3]) } : {}) })
}
// `level`: the pipeline version of the level 1 the history runs on.
export const incubatorPipelineVersion = (level: string): string => `${level}+${INCUBATOR_VERSION}`
export const historyKey = (worldId: string, level: string, input: PeoplingInput): ArtifactKey => artifactKey(worldId, incubatorPipelineVersion(level), historyStage(input))
// Whether a stored artifact is a history this client reads, on any level.
export const isCurrentHistory = (artifact: { stage: string; pipelineVersion: string }): boolean => parseHistoryStage(artifact.stage) !== null && artifact.pipelineVersion.endsWith(`+${INCUBATOR_VERSION}`)

interface HistoryMeta {
  key: ArtifactKey
  origin: number
  bytes: number
  // The run's time, ms, as a bake's (the stores list it).
  bakeMs: number
  createdAt: number
  label: string
}

export async function writeHistoryArtifact(store: ArtifactStore, key: ArtifactKey, origin: number, bytes: ArrayBuffer, runMs: number, label = ''): Promise<boolean> {
  const handle = await store.resolve(key, true)
  if (!handle) return false
  const meta: HistoryMeta = { key, origin, bytes: bytes.byteLength, bakeMs: runMs, createdAt: Date.now(), label }
  return writeArtifactFiles(store, handle, [
    { name: HISTORY_FILES.history, bytes },
    { name: HISTORY_FILES.meta, bytes: new TextEncoder().encode(JSON.stringify(meta)) },
  ])
}

// The packed history; null where there is none or it is not whole.
export async function readHistoryArtifact(store: ArtifactStore, key: ArtifactKey): Promise<ArrayBuffer | null> {
  const handle = await store.resolve(key, false)
  if (!handle) return null
  const metaBytes = await store.read(handle, HISTORY_FILES.meta)
  if (!metaBytes) return null
  let meta: HistoryMeta
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes)) as HistoryMeta
  } catch {
    return null
  }
  const bytes = await store.read(handle, HISTORY_FILES.history)
  return bytes && bytes.byteLength === meta.bytes ? bytes : null
}

// The inputs (step 1's) of the histories of a terrain on the level 1 of
// `level` among a store's entries (a listing's), the one kept last first;
// the meta's time read from `store`. The incubator opens a world with the
// first.
export async function historyInputs(store: ArtifactStore, entries: readonly { worldId: string; pipelineVersion: string; stage: string }[], worldId: string, level: string): Promise<PeoplingInput[]> {
  const found: { input: PeoplingInput; at: number }[] = []
  for (const entry of entries) {
    if (entry.worldId !== worldId || entry.pipelineVersion !== incubatorPipelineVersion(level)) continue
    const input = parseHistoryStage(entry.stage)
    if (input === null) continue
    const handle = await store.resolve(historyKey(worldId, level, input), false)
    const metaBytes = handle ? await store.read(handle, HISTORY_FILES.meta) : null
    let at = 0
    try {
      at = metaBytes ? (JSON.parse(new TextDecoder().decode(metaBytes)) as HistoryMeta).createdAt : 0
    } catch {
      at = 0
    }
    found.push({ input, at })
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.input)
}

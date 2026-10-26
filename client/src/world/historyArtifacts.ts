import historyVersion from 'casas-history-wasm/version.json'
import { artifactKey, writeArtifactFiles, type ArtifactKey, type ArtifactStore } from '../storage/ArtifactStore'

// THE HISTORY'S ARTIFACT, H1 (2026-10-26, DES-0033 "Where the result
// lives"): the incubator's simulated history of a world (casas-history),
// packed whole (historyPack.ts), so a world opened again with the same
// origin loads it instead of running it. On the server: the browser does
// not upload (DEC-0039), a job writes it (scripts/historyPipeline.ts) when
// the history shown is saved; until then the browser only shows it.
//
// Keyed by content, as every artifact: the terrain (worldId), the level it
// runs on and the history's own version (pipelineVersion: the pipeline of
// the level 1 read, `+`, HISTORY_VERSION), and the origin people set out
// from (the stage, `H1:<cell>`). The history's version is its crate's (casas-history
// HISTORY_VERSION, raised by hand there: any change to what a run gives or
// to the packed form must raise it, or a world loads an old history as
// current, or fails to read it).
export const HISTORY_VERSION: string = historyVersion.version
export const HISTORY_FILES = { history: 'history.bin', meta: 'meta.json' } as const

const HISTORY_STAGE = 'H1'
export const historyStage = (origin: number): string => `${HISTORY_STAGE}:${origin}`
// The origin of a history's stage; null for another stage.
export function parseHistoryStage(stage: string): number | null {
  const match = /^H1:(\d+)$/.exec(stage)
  return match ? Number(match[1]) : null
}
// `level`: the pipeline version of the level 1 the history runs on.
export const historyPipelineVersion = (level: string): string => `${level}+${HISTORY_VERSION}`
export const historyKey = (worldId: string, level: string, origin: number): ArtifactKey => artifactKey(worldId, historyPipelineVersion(level), historyStage(origin))
// Whether a stored artifact is a history this client reads, on any level.
export const isCurrentHistory = (artifact: { stage: string; pipelineVersion: string }): boolean => parseHistoryStage(artifact.stage) !== null && artifact.pipelineVersion.endsWith(`+${HISTORY_VERSION}`)

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

// The origins of the histories of a terrain on the level 1 of `level`
// among a store's entries (a listing's), the one kept last first; the
// meta's time read from `store`. The incubator opens a world with the
// first.
export async function historyOrigins(store: ArtifactStore, entries: readonly { worldId: string; pipelineVersion: string; stage: string }[], worldId: string, level: string): Promise<number[]> {
  const found: { origin: number; at: number }[] = []
  for (const entry of entries) {
    if (entry.worldId !== worldId || entry.pipelineVersion !== historyPipelineVersion(level)) continue
    const origin = parseHistoryStage(entry.stage)
    if (origin === null) continue
    const handle = await store.resolve(historyKey(worldId, level, origin), false)
    const metaBytes = handle ? await store.read(handle, HISTORY_FILES.meta) : null
    let at = 0
    try {
      at = metaBytes ? (JSON.parse(new TextDecoder().decode(metaBytes)) as HistoryMeta).createdAt : 0
    } catch {
      at = 0
    }
    found.push({ origin, at })
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.origin)
}

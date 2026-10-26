import { artifactKey, writeArtifactFiles, type ArtifactKey, type ArtifactStore, type LocalArtifactStore } from '../storage/ArtifactStore'
import { meshPipelineVersion } from './meshArtifacts'

// THE HISTORY'S ARTIFACT, H1 (2026-10-26, DES-0033 "Where the result
// lives"): the incubator's simulated history of a world (screens/incubator/
// simulation.ts), packed whole (historyPack.ts), so a world opened again with
// the same origin loads it instead of running it. In the browser only for
// now — the browser does not upload (DEC-0039); a job will make it on the
// server once the history runs natively.
//
// Keyed by content, as every artifact: the terrain (worldId), the level it
// runs on and the history's own version (pipelineVersion: level 1's, `+`,
// HISTORY_VERSION), and the origin people set out from (the stage,
// `H1:<cell>`). The history's version is ours to raise by hand: any change
// to what a run gives — the simulation, the habitat's cells, the flora, the
// fauna — or to the packed form (historyPack.ts) must raise it, or a world
// loads an old history as current, or fails to read it.
export const HISTORY_VERSION = 'h1-2026-10-26b'
export const HISTORY_FILES = { history: 'history.bin', meta: 'meta.json' } as const

const HISTORY_STAGE = 'H1'
export const historyStage = (origin: number): string => `${HISTORY_STAGE}:${origin}`
// The origin of a history's stage; null for another stage.
export function parseHistoryStage(stage: string): number | null {
  const match = /^H1:(\d+)$/.exec(stage)
  return match ? Number(match[1]) : null
}
export const historyPipelineVersion = (): string => `${meshPipelineVersion(1)}+${HISTORY_VERSION}`
export const historyKey = (worldId: string, origin: number): ArtifactKey => artifactKey(worldId, historyPipelineVersion(), historyStage(origin))
// Whether a stored artifact is a history this client reads.
export const isCurrentHistory = (artifact: { stage: string; pipelineVersion: string }): boolean => parseHistoryStage(artifact.stage) !== null && artifact.pipelineVersion === historyPipelineVersion()

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

// The origin of the history of a terrain kept last in a local store, of
// those current; null for none. A world opens with it (the incubator).
export async function latestHistoryOrigin(store: LocalArtifactStore, worldId: string): Promise<number | null> {
  let best: { origin: number; at: number } | null = null
  for (const entry of await store.list()) {
    if (entry.worldId !== worldId || !isCurrentHistory(entry)) continue
    const origin = parseHistoryStage(entry.stage)!
    const handle = await store.resolve(historyKey(worldId, origin), false)
    const metaBytes = handle ? await store.read(handle, HISTORY_FILES.meta) : null
    let at = 0
    try {
      at = metaBytes ? (JSON.parse(new TextDecoder().decode(metaBytes)) as HistoryMeta).createdAt : 0
    } catch {
      at = 0
    }
    if (!best || at > best.at) best = { origin, at }
  }
  return best?.origin ?? null
}

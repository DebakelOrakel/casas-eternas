import { apiBase } from './worldClient'
import { authFetch } from './session'

// Inspecting and pruning the SERVER's artifact store.
//
// Separate from HttpArtifactStore on purpose. That one implements the
// resolve/read/write interface the bake goes through, and it deliberately
// does not answer "what is in there and how much room does it take" — the
// server answers that in one request, and emulating it over HTTP would be a
// slow, wrong second implementation.
//
// This is also the only place the client reaches across to DELETE something it
// did not have to compute. The storage panel keeps that visibly apart from
// clearing the local cache, because the two have different consequences: local
// bytes are recomputable by this machine, server bytes are what every other
// client is currently relying on.

// One entry of the server's listing (GET /v1/artifacts). Written out here
// rather than imported from storage/: the wire format is this module's
// contract, and server/ and storage/ are peers that must not import each
// other (the type import was the last edge of that cycle). It is kept
// field-for-field the shape the local store lists (storage/ArtifactStore
// StoredArtifact).
export interface ServerArtifact {
  artifactUid: string
  bytes: number
  worldId: string
  pipelineVersion: string
  stage: string
  label: string
  width: number
  height: number
  bakeMs: number
  // What the caller may do with the artifact, as the server states it:
  // `artifact.remove` or nothing (DEC-0039, fork 6; DEC-0040, fork 7).
  actions?: string[]
}

export interface ServerArtifacts {
  artifacts: ServerArtifact[]
  bytes: number
}

// Null when there is no server, rather than an empty list: "nothing there" and
// "nowhere to ask" are different states, and the panel shows them differently.
export async function listServerArtifacts(): Promise<ServerArtifacts | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/artifacts`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { artifacts?: ServerArtifact[] | null; bytes?: number }
    return { artifacts: body.artifacts ?? [], bytes: body.bytes ?? 0 }
  } catch {
    return null
  }
}

// One level of one terrain under one pipeline version, summed on the server
// (GET /v1/artifacts/levels): a whole level (count 1) or its tiles. What the
// artifact window shows as a row — a world refined to level 3 is ten
// thousand entries in the flat listing.
export interface ServerArtifactLevel {
  worldId: string
  pipelineVersion: string
  level: number
  tiles: boolean
  // The histories of the terrain (H1, world/historyArtifacts.ts) on level
  // 1 under the pipeline version: `count` origins.
  history?: boolean
  count: number
  bytes: number
  label: string
  bakeMs: number
  // As ServerArtifact's.
  actions?: string[]
}

// The pipeline builds of one pipeline version (docs/decisions/
// engine-releases.md): the files of its release the server keeps, for
// workers of that pipeline. The artifact window's group "Engines".
export interface ServerPipelineBuilds {
  pipelineVersion: string
  files: string[]
  bytes: number
  // As ServerArtifact's: `artifact.remove` for the operator only.
  actions?: string[]
}

export interface ServerArtifactLevels {
  levels: ServerArtifactLevel[]
  pipelines: ServerPipelineBuilds[]
  bytes: number
}

// Null when there is no server, as listServerArtifacts.
export async function listServerArtifactLevels(): Promise<ServerArtifactLevels | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/artifacts/levels`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { levels?: ServerArtifactLevel[] | null; pipelines?: ServerPipelineBuilds[] | null; bytes?: number }
    return { levels: body.levels ?? [], pipelines: body.pipelines ?? [], bytes: body.bytes ?? 0 }
  } catch {
    return null
  }
}

// Drops one level of a terrain — the whole level and every tile of it — of
// one pipeline version.
// Removes the pipeline builds of one version (the operator's).
export async function removeServerPipelineBuilds(pipelineVersion: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  const query = new URLSearchParams({ pipeline: pipelineVersion })
  try {
    const response = await authFetch(`${base}/artifacts?${query}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

// The histories of a terrain under a pipeline version (the levels
// summary's history row).
export async function removeServerHistories(worldId: string, pipelineVersion: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  const query = new URLSearchParams({ history: '1', worldId, pipeline: pipelineVersion })
  try {
    const response = await authFetch(`${base}/artifacts?${query}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

export async function removeServerLevel(level: number, worldId: string, pipelineVersion: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  const query = new URLSearchParams({ level: String(level), worldId, pipeline: pipelineVersion })
  try {
    const response = await authFetch(`${base}/artifacts?${query}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

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
  worldUid: string
  worldId: string
  pipelineVersion: string
  stage: string
  label: string
  width: number
  height: number
  bakeMs: number
  // The caller's level on the artifact's world ("viewer", "editor", "owner",
  // or "admin" for the operator): what the caller may do with it. Deleting
  // takes an editor.
  callerLevel?: string
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

// Drops everything one world has earned — every artifact whose meta names it.
export async function removeServerWorldArtifacts(worldUid: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await authFetch(`${base}/artifacts?world=${encodeURIComponent(worldUid)}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

// Drops one artifact by its uid — the reach for entries no world claims
// (unreadable meta, older layouts).
export async function removeServerArtifact(artifactUid: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await authFetch(`${base}/artifacts/${encodeURIComponent(artifactUid)}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

// One level of one terrain under one pipeline version, summed on the server
// (GET /v1/artifacts/levels): a whole level (count 1) or its tiles. What the
// artifact window shows as a row — a world refined to level 3 is ten
// thousand entries in the flat listing.
export interface ServerArtifactLevel {
  worldUid: string
  worldId: string
  pipelineVersion: string
  level: number
  tiles: boolean
  count: number
  bytes: number
  label: string
  bakeMs: number
  callerLevel?: string
}

export interface ServerArtifactLevels {
  levels: ServerArtifactLevel[]
  bytes: number
}

// Null when there is no server, as listServerArtifacts.
export async function listServerArtifactLevels(): Promise<ServerArtifactLevels | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/artifacts/levels`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = (await response.json()) as { levels?: ServerArtifactLevel[] | null; bytes?: number }
    return { levels: body.levels ?? [], bytes: body.bytes ?? 0 }
  } catch {
    return null
  }
}

// Drops one level of a world — the whole level and every tile of it — of
// one terrain and pipeline version.
export async function removeServerLevel(worldUid: string, level: number, worldId: string, pipelineVersion: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  const query = new URLSearchParams({ world: worldUid, level: String(level), worldId, pipeline: pipelineVersion })
  try {
    const response = await authFetch(`${base}/artifacts?${query}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

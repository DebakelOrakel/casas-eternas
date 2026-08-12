import { apiBase } from './worldClient'
import { authFetch } from './session'
import type { StoredArtifact } from '../storage/ArtifactStore'

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

export interface ServerArtifacts {
  // Flat, the same shape the local store lists — one grouping function serves
  // both tiers (artifactAdmin.groupArtifacts).
  artifacts: StoredArtifact[]
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
    const body = (await response.json()) as { artifacts?: StoredArtifact[] | null; bytes?: number }
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

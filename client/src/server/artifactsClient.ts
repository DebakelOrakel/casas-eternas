import { apiBase } from './worldClient'

// Inspecting and pruning the SERVER's artifact store.
//
// Separate from HttpArtifactStore on purpose. That one implements the
// bytes-at-a-path interface the bake reads and writes through, and it
// deliberately does not answer "what is in there and how much room does it
// take" — the server answers that in one request, and emulating it by walking
// directories over HTTP would be a slow, wrong second implementation.
//
// This is also the only place the client reaches across to DELETE something it
// did not have to compute. The storage panel keeps that visibly apart from
// clearing the local cache, because the two have different consequences: local
// bytes are recomputable by this machine, server bytes are what every other
// client is currently relying on.

export interface ServerArtifactStage {
  pipelineVersion: string
  stage: string
  bytes: number
  width: number
  height: number
  bakeMs: number
}

export interface ServerArtifactWorld {
  worldId: string
  bytes: number
  stages: ServerArtifactStage[]
}

export interface ServerArtifacts {
  worlds: ServerArtifactWorld[]
  bytes: number
}

// Null when there is no server, rather than an empty list: "nothing there" and
// "nowhere to ask" are different states, and the panel shows them differently.
export async function listServerArtifacts(): Promise<ServerArtifacts | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await fetch(`${base}/artifacts`, { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as ServerArtifacts
  } catch {
    return null
  }
}

export async function removeServerArtifacts(worldId: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await fetch(`${base}/artifacts/${encodeURIComponent(worldId)}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

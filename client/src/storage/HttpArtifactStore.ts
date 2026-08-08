import { apiBase } from '../server/worldClient'
import type { ArtifactStore, StorageUsage } from './ArtifactStore'

// The server's artifact store, behind the same bytes-at-a-path interface as
// the local one — the translation the interface was shaped for
// (docs/design/server-storage.md).
//
// The one wrinkle is that the two path grammars are not identical. Locally an
// entry lives at
//
//   worlds/{worldId}/amp/{pipelineVersion}/{stage}/elevation.u16
//
// while the server addresses it as
//
//   {apiBase}/artifacts/{worldId}/{pipelineVersion}/{stage}/elevation.u16
//
// Two deliberate differences: the root is `artifacts/` rather than `worlds/`,
// because on the server a *world* is a different thing addressed by a stable
// uid while `worldId` here is a content hash; and the local `amp/` grouping
// has no counterpart, because the server root already says what these are.
// Translating in one place beats making either side adopt the other's shape.

const LOCAL_PREFIX = 'worlds/'
const LOCAL_GROUP = 'amp'

interface RemotePath {
  worldId: string
  pipelineVersion: string
  stage: string
  name: string
}

// Exported for the sake of being testable without a server: this is the only
// piece of the class with a way to be subtly wrong.
export function toRemotePath(path: string): RemotePath | null {
  if (!path.startsWith(LOCAL_PREFIX)) return null
  const segments = path.slice(LOCAL_PREFIX.length).split('/').filter((s) => s.length > 0)
  // worldId / amp / pipelineVersion / stage / name…
  if (segments.length < 5 || segments[1] !== LOCAL_GROUP) return null
  const [worldId, , pipelineVersion, stage, ...rest] = segments
  return { worldId, pipelineVersion, stage, name: rest.join('/') }
}

const encodePath = (p: RemotePath): string =>
  [p.worldId, p.pipelineVersion, p.stage, ...p.name.split('/')].map(encodeURIComponent).join('/')

export function createHttpArtifactStore(): ArtifactStore {
  const url = async (path: string): Promise<string | null> => {
    const base = await apiBase()
    const remote = toRemotePath(path)
    if (!base || !remote) return null
    return `${base}/artifacts/${encodePath(remote)}`
  }

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      const target = await url(path)
      if (!target) return null
      try {
        const response = await fetch(target, { cache: 'no-store' })
        if (!response.ok) return null
        return await response.arrayBuffer()
      } catch {
        // Same contract as the local store: a miss and a network failure have
        // the same consequence, which is to compute it again.
        return null
      }
    },

    async write(path: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const target = await url(path)
      if (!target) return false
      try {
        // Passed through as-is, cast for the same reason OpfsArtifactStore
        // casts to BufferSource: the DOM types insist a view be backed by an
        // ArrayBuffer rather than an ArrayBufferLike, and a SharedArrayBuffer
        // cannot reach here — every raster in this pipeline comes from a
        // worker transfer or a plain allocation. Copying to satisfy the type
        // would cost a 17 MB duplicate on every upload.
        const response = await fetch(target, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes as BodyInit,
        })
        return response.ok
      } catch {
        return false
      }
    },

    async exists(path: string): Promise<boolean> {
      const target = await url(path)
      if (!target) return false
      try {
        // HEAD rather than GET: the point of asking is to avoid pulling
        // seventeen megabytes to learn a boolean.
        const response = await fetch(target, { method: 'HEAD', cache: 'no-store' })
        return response.ok
      } catch {
        return false
      }
    },

    async size(path: string): Promise<number | null> {
      const target = await url(path)
      if (!target) return null
      try {
        const response = await fetch(target, { method: 'HEAD', cache: 'no-store' })
        if (!response.ok) return null
        const length = Number(response.headers.get('Content-Length'))
        return Number.isFinite(length) ? length : null
      } catch {
        return null
      }
    },

    async remove(path: string): Promise<void> {
      const target = await url(path)
      if (!target) return
      try {
        await fetch(target, { method: 'DELETE' })
      } catch {
        // Nothing to recover: the caller is dropping recomputable bytes.
      }
    },

    // Deliberately unsupported rather than emulated. Both exist for the LOCAL
    // inventory — the storage panel walks directories to total up what this
    // machine is holding, and asks the browser for its quota. The server
    // answers both in one request through its own listing endpoint, so
    // pretending here would mean a slow, wrong second implementation of it.
    async listDirectory(): Promise<string[]> {
      return []
    },

    async usage(): Promise<StorageUsage | null> {
      return null
    },
  }
}

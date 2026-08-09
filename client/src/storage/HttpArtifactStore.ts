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

export interface HttpArtifactStoreOptions {
  // Where the API lives. Defaults to asking serverStatus, which resolves it
  // against the PAGE's origin — correct in a browser and meaningless in Node,
  // where the server-side baker runs and must be told outright.
  //
  // REQUIRED, deliberately. This used to default to importing `apiBase` from the
  // server module, which made a byte store — a thing that knows how to speak
  // HTTP — also know where this application's server lives. That is the
  // composition root's business, and `artifactStoreProvider` is where it now
  // happens. A store that has to be told its base can also be pointed at a test
  // server, or at none.
  resolveBase: () => Promise<string | null>
  // The fetch to use, defaulting to the global one.
  //
  // Injected for the same reason resolveBase is — a byte store has no business
  // knowing how this application authenticates — and as a FETCH rather than a
  // set of headers, because attaching credentials is only half of it. The other
  // half is noticing when they stop being accepted: the browser passes the
  // session's fetch, which ends the session on a 401 so the whole application
  // learns of it at once. Handing over headers alone made this store the one
  // place a dead session failed silently.
  //
  // A bake Job, whose token is fixed and scoped to the single artifact key it
  // may write, can pass a fetch that simply always adds it
  // (docs/decisions/distributed-bake.md).
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export function createHttpArtifactStore(options: HttpArtifactStoreOptions): ArtifactStore {
  const resolveBase = options.resolveBase
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))

  const url = async (path: string): Promise<string | null> => {
    const base = await resolveBase()
    const remote = toRemotePath(path)
    if (!base || !remote) return null
    return `${base}/artifacts/${encodePath(remote)}`
  }

  return {
    async read(path: string): Promise<ArrayBuffer | null> {
      const target = await url(path)
      if (!target) return null
      try {
        const response = await send(target, { cache: 'no-store' })
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
        const response = await send(target, {
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
        const response = await send(target, { method: 'HEAD', cache: 'no-store' })
        return response.ok
      } catch {
        return false
      }
    },

    async size(path: string): Promise<number | null> {
      const target = await url(path)
      if (!target) return null
      try {
        const response = await send(target, { method: 'HEAD', cache: 'no-store' })
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
        await send(target, { method: 'DELETE' })
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

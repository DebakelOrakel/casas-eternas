import type { ArtifactHandle, ArtifactKey, ArtifactStore } from './ArtifactStore'

// The server's artifact store, behind the same resolve/read/write interface
// as the local one. `resolve` is the server's own endpoint — the one request
// that speaks the logical key; everything after addresses the artifact uid
// the server minted. Its `files` answer doubles as the batch existence check
// (what used to be the separate `present` endpoint).

export interface HttpArtifactStoreOptions {
  // Where the API lives. Defaults nowhere on purpose: this used to import the
  // app's own apiBase, which made a byte store know where this application's
  // server lives. That is the composition root's business
  // (artifactStoreProvider), and a store that has to be told its base can
  // also be pointed at a test server, or at none.
  resolveBase: () => Promise<string | null>
  // The fetch to use, defaulting to the global one. Injected so the store
  // knows nothing about how this application authenticates: the browser
  // passes the session's fetch (which ends the session on a 401), a bake Job
  // passes one that adds its fixed token.
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export function createHttpArtifactStore(options: HttpArtifactStoreOptions): ArtifactStore {
  const resolveBase = options.resolveBase
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))

  const fileUrl = async (handle: ArtifactHandle, name: string): Promise<string | null> => {
    const base = await resolveBase()
    if (!base || !handle.remote) return null
    return `${base}/artifacts/${encodeURIComponent(handle.remote)}/${name.split('/').map(encodeURIComponent).join('/')}`
  }

  return {
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      const base = await resolveBase()
      if (!base) return null
      try {
        const response = await send(`${base}/artifacts/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...key, create }),
        })
        if (!response.ok) return null
        const body = (await response.json()) as { artifactUid?: string; files?: string[] }
        if (!body.artifactUid) return null
        return { key, remote: body.artifactUid, files: body.files ?? [] }
      } catch {
        return null
      }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      const target = await fileUrl(handle, name)
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

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const target = await fileUrl(handle, name)
      if (!target) return false
      try {
        // Passed through as-is, cast because the DOM types insist a view be
        // backed by an ArrayBuffer rather than an ArrayBufferLike; a
        // SharedArrayBuffer cannot reach here, and copying to satisfy the
        // type would cost a 17 MB duplicate on every upload.
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
  }
}

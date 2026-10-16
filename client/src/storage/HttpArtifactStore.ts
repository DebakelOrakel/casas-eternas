import { ArtifactStoreUnavailableError, type ArtifactHandle, type ArtifactKey, type ArtifactStore } from './ArtifactStore'

// The server's artifact store, behind the same resolve/read/write interface
// as the local one. `resolve` is the server's own endpoint — the one request
// that speaks the logical key; everything after addresses the artifact uid
// the server minted. Its `files` answer doubles as the batch existence check
// (what used to be the separate `present` endpoint).
//
// ABSENT IS 404, NOTHING ELSE (2026-10-16). The server says "not there" with
// a 404 only: resolve without create for an unknown key (or a world the
// caller may not see, which reads the same on purpose), a read of a file the
// artifact does not hold, a link whose object has gone. Everything else —
// no answer (network, TLS), a 5xx, an answer this store cannot read — throws
// ArtifactStoreUnavailableError. Until then every failure read as a miss,
// and a job worker whose server was briefly away computed a level again for
// hours, or failed a tile late with "not in the artifact store" for one that
// was. The browser's tiered store catches the error and goes on as on a miss
// (TieredArtifactStore.ts); the worker gives its task back (jobWorker.ts).
// A write that the server refuses (4xx: rights, size, an unminted uid) is
// false, as before; only a server that does not answer throws.

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

  // One request; a failure to get an answer at all is the store being
  // unavailable, whatever the cause (refused, reset, TLS, DNS).
  const request = async (what: string, input: string, init?: RequestInit): Promise<Response> => {
    try {
      return await send(input, init)
    } catch (error) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error)
      throw new ArtifactStoreUnavailableError(`artifact store: ${what}: no answer (${reason.trim()})`, undefined, { cause: error })
    }
  }
  const unavailable = (what: string, response: Response): ArtifactStoreUnavailableError =>
    new ArtifactStoreUnavailableError(`artifact store: ${what}: ${response.status} ${response.statusText}`.trimEnd(), response.status)

  return {
    async resolve(key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> {
      const base = await resolveBase()
      if (!base) return null
      const response = await request('resolve', `${base}/artifacts/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...key, create }),
      })
      if (response.status === 404) return null
      if (!response.ok) throw unavailable('resolve', response)
      let body: { artifactUid?: string; files?: string[] }
      try {
        body = (await response.json()) as { artifactUid?: string; files?: string[] }
      } catch (error) {
        throw new ArtifactStoreUnavailableError('artifact store: resolve: an answer that is not JSON', response.status, { cause: error })
      }
      if (!body.artifactUid) throw new ArtifactStoreUnavailableError('artifact store: resolve: an answer with no artifactUid', response.status)
      return { key, remote: body.artifactUid, files: body.files ?? [] }
    },

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      const target = await fileUrl(handle, name)
      if (!target) return null
      const response = await request(`read ${name}`, target, { cache: 'no-store' })
      if (response.status === 404) return null
      if (!response.ok) throw unavailable(`read ${name}`, response)
      try {
        return await response.arrayBuffer()
      } catch (error) {
        // The body broke off: the server went while it sent.
        throw new ArtifactStoreUnavailableError(`artifact store: read ${name}: the body broke off`, response.status, { cause: error })
      }
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      const target = await fileUrl(handle, name)
      if (!target) return false
      // Passed through as-is, cast because the DOM types insist a view be
      // backed by an ArrayBuffer rather than an ArrayBufferLike; a
      // SharedArrayBuffer cannot reach here, and copying to satisfy the
      // type would cost a 17 MB duplicate on every upload.
      const response = await request(`write ${name}`, target, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as BodyInit,
      })
      if (response.status >= 500) throw unavailable(`write ${name}`, response)
      return response.ok
    },
  }
}

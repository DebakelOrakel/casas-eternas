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
//
// WRITES BY LINK (2026-10-16, DEC-0038 fork 7), for the job worker: the
// bytes go straight to the bucket, not through the server. Per file the
// store asks for a write link with the file's length (`write-link`), PUTs
// the bytes to it without the caller's credentials (the link is the
// right), and with meta.json — the file every writer writes last — it
// commits the artifact's files (`commit`); the server checks each with a
// Head and only then lists them. Until the commit the artifact is not
// whole and a read of its files is a miss. THE RULE FOR EXPIRED LINKS:
// before an upload the store checks that LINK_MARGIN_MS is left of the
// link; if not, or if the upload is refused (403, 410), it asks for a
// fresh link once and uploads again. The browser keeps the server's own
// upload (`uploads: 'server'`): the bucket's CORS rule allows no PUT, and
// its tiered store writes in the background.

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
  // How a write reaches the bucket: through the server ('server', the
  // default) or by write link and commit ('links', the job worker).
  uploads?: 'server' | 'links'
  // The fetch for the upload to a link, defaulting to the global one. It
  // must NOT add the caller's credentials: a presigned PUT that carries an
  // Authorization header too is refused (two kinds of authorization), and
  // the job's token has no business at the provider.
  uploadFetch?: (input: string, init?: RequestInit) => Promise<Response>
}

// The time a write link must still have before an upload starts.
export const LINK_MARGIN_MS = 5 * 60_000

interface WriteLink {
  method: string
  url: string
  header: Record<string, string>
  expires: string
}

export function createHttpArtifactStore(options: HttpArtifactStoreOptions): ArtifactStore {
  const resolveBase = options.resolveBase
  const send = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const upload = options.uploadFetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  // The files uploaded by link per artifact, not yet committed.
  const uploaded = new Map<string, { name: string; size: number }[]>()

  const fileUrl = async (handle: ArtifactHandle, name: string): Promise<string | null> => {
    const base = await resolveBase()
    if (!base || !handle.remote) return null
    return `${base}/artifacts/${encodeURIComponent(handle.remote)}/${name.split('/').map(encodeURIComponent).join('/')}`
  }

  // One request; a failure to get an answer at all is the store being
  // unavailable, whatever the cause (refused, reset, TLS, DNS).
  const request = async (what: string, input: string, init?: RequestInit, using = send): Promise<Response> => {
    try {
      return await using(input, init)
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
      if (options.uploads === 'links') return writeByLink(handle.remote!, name, bytes)
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

  // A write link for one file of the length given; null when the server
  // refuses (4xx).
  async function writeLink(uid: string, name: string, size: number): Promise<WriteLink | null> {
    const base = await resolveBase()
    if (!base) return null
    const route = `${base}/artifacts/${encodeURIComponent(uid)}/write-link`
    const response = await request(`write-link ${name}`, route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, size }),
    })
    if (response.status >= 500) throw unavailable(`write-link ${name}`, response)
    if (!response.ok) return null
    let link: WriteLink
    try {
      link = (await response.json()) as WriteLink
    } catch (error) {
      throw new ArtifactStoreUnavailableError(`artifact store: write-link ${name}: an answer that is not JSON`, response.status, { cause: error })
    }
    // A dir link is a path on the server: relative to the route.
    return { ...link, url: new URL(link.url, route).href }
  }

  async function writeByLink(uid: string, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
    const size = bytes.byteLength
    let link = await writeLink(uid, name, size)
    if (!link) return false
    let refreshed = false
    const fresh = async (): Promise<boolean> => {
      refreshed = true
      link = await writeLink(uid, name, size)
      return link !== null
    }
    // Too little left of the link: a fresh one first (asked once; a server
    // whose links live shorter than the margin gets the upload anyway).
    if (Date.parse(link.expires) - Date.now() < LINK_MARGIN_MS && !(await fresh())) return false
    for (;;) {
      const response = await request(`upload ${name}`, link!.url, {
        method: link!.method,
        headers: link!.header,
        body: bytes as BodyInit,
      }, upload)
      // Read to the end, so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined)
      if (response.ok) break
      // Refused all the same (expired on the provider's clock, a slow
      // upload, a signature it does not take): once more with a fresh link.
      if ((response.status === 403 || response.status === 410) && !refreshed) {
        if (!(await fresh())) return false
        continue
      }
      if (response.status >= 500) throw unavailable(`upload ${name}`, response)
      return false
    }
    const files = uploaded.get(uid) ?? []
    uploaded.set(uid, [...files.filter((f) => f.name !== name), { name, size }])
    // meta.json is the last file of every writer: the artifact is whole.
    if (name !== 'meta.json') return true
    const committing = uploaded.get(uid)!
    uploaded.delete(uid)
    const base = await resolveBase()
    if (!base) return false
    const route = `${base}/artifacts/${encodeURIComponent(uid)}/commit`
    const response = await request('commit', route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: committing }),
    })
    if (response.status >= 500) throw unavailable('commit', response)
    return response.ok
  }
}

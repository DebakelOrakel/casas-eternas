import { ArtifactStoreRefusedError, ArtifactStoreUnavailableError, writeInTurn, type ArtifactFile, type ArtifactHandle, type ArtifactKey, type ArtifactStore } from './ArtifactStore'

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
// A REFUSAL IS FINAL (2026-10-16). A resolve or a read that the API answers
// with a 4xx other than 404 (400, 401, 403, …) throws
// ArtifactStoreRefusedError, not ArtifactStoreUnavailableError: asking
// again gets the same answer, so the worker fails the task at once instead
// of giving it back four times, 15 s apart. Two answers stay "unavailable",
// because a fresh request can succeed: a 410 (a read link that expired on
// the way) and a 403 from the link a read was redirected to (a link that
// does not verify, e.g. a key change-over), not from the API.
//
// WRITES BY LINK (2026-10-16, DEC-0038 fork 7), for the job worker: the
// bytes go straight to the bucket, not through the server. A write is a
// whole artifact (`writeFiles`): the store asks for a write link per file
// with its length, all in one request (`write-links`, since 2026-10-22),
// PUTs the bytes to the links all at once without the caller's credentials
// (the link is the right), and then commits the files (`commit`); the
// server checks each with a Head and only then lists them. Until the commit
// the artifact is not whole and a read of its files is a miss. Until
// 2026-10-22 it was a link per request and one file after the other: on S3
// thirteen round trips for a tile, a third of what a level-3 tile took.
// THE RULE FOR EXPIRED LINKS: before an upload the store checks that
// LINK_MARGIN_MS is left of the link; if not, or if the upload is refused
// (403, 410), it asks for a fresh link for that file once and uploads it
// again. The browser keeps the server's own upload (`uploads: 'server'`):
// the bucket's CORS rule allows no PUT, and its tiered store writes in the
// background.
//
// A RESERVATION THE SERVER FORGOT (2026-10-16). The server holds the uid
// that `resolve` with create minted in memory only, until the commit makes
// the artifact whole; after a restart it does not know the uid, and the
// write links, an upload or the commit answer 404. THE RULE: on a 404 the
// store resolves the key with create once more (a fresh uid) and writes the
// whole artifact again under it; every later call for the old uid goes to
// the new one. A second 404 under the fresh uid throws
// ArtifactStoreUnavailableError, and the worker gives its task back. The
// files under the old uid are not this store's business: the server's sweep
// takes them as junk (store.go, sweepLocked). A read's 404 stays "absent".
//
// ANOTHER WRITER WAS FIRST (2026-10-16). Two workers can compute the same
// artifact under the same uid; the first commit makes it whole, and the
// server then answers 409 with the code "committed" to write links for it
// (artifacts.go, WriteLinkCommitted). THE RULE: that answer is "already
// written" — the write is true, and there is no commit. The bytes the
// server holds are the other writer's; the key is the same, so they are the
// same artifact. On dir the module's link route refuses an upload into a
// whole artifact (403) first; the fresh link then answers the 409. Any
// other 409 of write-links (too many uncommitted files) is a refusal
// (false), and a 409 of the commit (a meta.json that names another key) is
// too.

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
  // default) or by write link and commit ('links', the job worker). Since
  // DEC-0039 a checking server takes a write from a job worker only.
  uploads?: 'server' | 'links'
  // The fetch for the upload to a link, defaulting to the global one. It
  // must NOT add the caller's credentials: a presigned PUT that carries an
  // Authorization header too is refused (two kinds of authorization), and
  // the job's token has no business at the provider.
  uploadFetch?: (input: string, init?: RequestInit) => Promise<Response>
  // The world uid this store works for, sent with every resolve — NOT part
  // of the key. A server in the local mode records the terrain for this
  // world from it; a checking server takes the world from the job's token
  // and ignores it. The job worker sets it; the browser does not.
  world?: string
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
  const uploadFetch = options.uploadFetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  // A uid the server forgot → the uid of the fresh reservation.
  const moved = new Map<string, string>()
  const current = (uid: string): string => moved.get(uid) ?? uid

  const fileUrl = async (handle: ArtifactHandle, name: string): Promise<string | null> => {
    const base = await resolveBase()
    if (!base || !handle.remote) return null
    return `${base}/artifacts/${encodeURIComponent(current(handle.remote))}/${name.split('/').map(encodeURIComponent).join('/')}`
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
  // A failed answer to a resolve or a read (see A REFUSAL IS FINAL above).
  const failed = (what: string, response: Response): Error => {
    const status = response.status
    const fromLink = response.redirected && status === 403
    if (status >= 400 && status < 500 && status !== 410 && !fromLink) {
      return new ArtifactStoreRefusedError(`artifact store: ${what}: ${status} ${response.statusText}`.trimEnd(), status)
    }
    return unavailable(what, response)
  }

  const resolveKey = async (key: ArtifactKey, create: boolean): Promise<ArtifactHandle | null> => {
    const base = await resolveBase()
    if (!base) return null
    const response = await request('resolve', `${base}/artifacts/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...key, create, ...(options.world ? { world: options.world } : {}) }),
    })
    if (response.status === 404) return null
    if (!response.ok) throw failed('resolve', response)
    let body: { artifactUid?: string; files?: string[] }
    try {
      body = (await response.json()) as { artifactUid?: string; files?: string[] }
    } catch (error) {
      throw new ArtifactStoreUnavailableError('artifact store: resolve: an answer that is not JSON', response.status, { cause: error })
    }
    if (!body.artifactUid) throw new ArtifactStoreUnavailableError('artifact store: resolve: an answer with no artifactUid', response.status)
    return { key, remote: body.artifactUid, files: body.files ?? [] }
  }

  const store: ArtifactStore = {
    resolve: resolveKey,

    async read(handle: ArtifactHandle, name: string): Promise<ArrayBuffer | null> {
      const target = await fileUrl(handle, name)
      if (!target) return null
      const response = await request(`read ${name}`, target, { cache: 'no-store' })
      if (response.status === 404) return null
      if (!response.ok) throw failed(`read ${name}`, response)
      try {
        return await response.arrayBuffer()
      } catch (error) {
        // The body broke off: the server went while it sent.
        throw new ArtifactStoreUnavailableError(`artifact store: read ${name}: the body broke off`, response.status, { cause: error })
      }
    },

    async write(handle: ArtifactHandle, name: string, bytes: ArrayBuffer | ArrayBufferView): Promise<boolean> {
      if (options.uploads === 'links') return writeByLinks(handle, [{ name, bytes }])
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

    async writeFiles(handle: ArtifactHandle, files: ArtifactFile[]): Promise<boolean> {
      if (options.uploads === 'links') return writeByLinks(handle, files)
      return writeInTurn(store, handle, files)
    },
  }
  return store

  // Write links for `files`, all in one request: null when the server
  // refuses (4xx), 'gone' when it does not know the artifact (404), 'whole'
  // when another writer committed it first (409 "committed").
  async function writeLinks(uid: string, files: { name: string; size: number }[]): Promise<Record<string, WriteLink> | null | 'gone' | 'whole'> {
    const base = await resolveBase()
    if (!base) return null
    const route = `${base}/artifacts/${encodeURIComponent(uid)}/write-links`
    const what = `write-links ${files.map((f) => f.name).join(',')}`
    const response = await request(what, route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    })
    if (response.status >= 500) throw unavailable(what, response)
    if (response.status === 404) return 'gone'
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null
      return body?.code === 'committed' ? 'whole' : null
    }
    if (!response.ok) return null
    let links: Record<string, WriteLink> | undefined
    try {
      links = ((await response.json()) as { links?: Record<string, WriteLink> }).links
    } catch (error) {
      throw new ArtifactStoreUnavailableError(`artifact store: ${what}: an answer that is not JSON`, response.status, { cause: error })
    }
    if (!links || files.some((f) => !links[f.name])) throw new ArtifactStoreUnavailableError(`artifact store: ${what}: an answer without a link for every file`, response.status)
    // A dir link is a path on the server: relative to the route.
    return Object.fromEntries(Object.entries(links).map(([name, link]) => [name, { ...link, url: new URL(link.url, route).href }]))
  }

  // One file to its link (the rule for expired links). 'gone' when the
  // server does not know the artifact (404), 'whole' when another writer
  // committed it first.
  async function upload(uid: string, file: ArtifactFile, given: WriteLink): Promise<boolean | 'gone' | 'whole'> {
    const size = file.bytes.byteLength
    let link = given
    let refreshed = false
    const fresh = async (): Promise<boolean | 'gone' | 'whole'> => {
      refreshed = true
      const got = await writeLinks(uid, [{ name: file.name, size }])
      if (got === null || got === 'gone' || got === 'whole') return got ?? false
      link = got[file.name]
      return true
    }
    // Too little left of the link: a fresh one first (asked once; a server
    // whose links live shorter than the margin gets the upload anyway).
    if (Date.parse(link.expires) - Date.now() < LINK_MARGIN_MS) {
      const got = await fresh()
      if (got !== true) return got
    }
    for (;;) {
      const response = await request(`upload ${file.name}`, link.url, {
        method: link.method,
        headers: link.header,
        body: file.bytes as BodyInit,
      }, uploadFetch)
      // Read to the end, so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined)
      if (response.ok) return true
      // Refused all the same (expired on the provider's clock, a slow
      // upload, a signature it does not take): once more with a fresh link.
      if ((response.status === 403 || response.status === 410) && !refreshed) {
        const got = await fresh()
        if (got !== true) return got
        continue
      }
      if (response.status >= 500) throw unavailable(`upload ${file.name}`, response)
      if (response.status === 404) return 'gone'
      return false
    }
  }

  // The artifact under `uid`: the links, the uploads at once, the commit.
  async function writeUnder(uid: string, files: ArtifactFile[]): Promise<boolean | 'gone'> {
    const links = await writeLinks(uid, files.map((f) => ({ name: f.name, size: f.bytes.byteLength })))
    if (links === null) return false
    if (links === 'whole') return true
    if (links === 'gone') return 'gone'
    const uploads = await Promise.all(files.map((f) => upload(uid, f, links[f.name])))
    if (uploads.includes('gone')) return 'gone'
    if (uploads.includes(false)) return false
    if (uploads.includes('whole')) return true
    const base = await resolveBase()
    if (!base) return false
    const response = await request('commit', `${base}/artifacts/${encodeURIComponent(uid)}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files.map((f) => ({ name: f.name, size: f.bytes.byteLength })) }),
    })
    if (response.status >= 500) throw unavailable('commit', response)
    if (response.status === 404) return 'gone'
    return response.ok
  }

  // A whole artifact by link (see A RESERVATION THE SERVER FORGOT above).
  async function writeByLinks(handle: ArtifactHandle, files: ArtifactFile[]): Promise<boolean> {
    if (!handle.remote || !(await resolveBase())) return false
    const uid = current(handle.remote)
    const wrote = await writeUnder(uid, files)
    if (wrote !== 'gone') return wrote
    const what = `write ${files.map((f) => f.name).join(',')}`
    const fresh = await resolveKey(handle.key, true)
    if (!fresh?.remote) throw new ArtifactStoreUnavailableError(`artifact store: ${what}: the artifact is unknown to the server, and resolve with create found none`, 404)
    moved.set(handle.remote, fresh.remote)
    if (uid !== handle.remote) moved.set(uid, fresh.remote)
    const again = await writeUnder(fresh.remote, files)
    if (again === 'gone') throw new ArtifactStoreUnavailableError(`artifact store: ${what}: the artifact is unknown to the server again after a fresh resolve`, 404)
    return again
  }
}

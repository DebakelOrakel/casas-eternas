import { getServerStatus } from './serverStatus'
import { authFetch } from './session'

// Talking to the server's world store.
//
// The one non-obvious part is revision bookkeeping. `status.revision` in a
// save's world.yaml counts LOCAL saves — it advances on a plain download too —
// while the server keeps its own counter and hands it back as an ETag. The two
// legitimately differ (five downloads then one upload is local 6, server 1), so
// the ETag has to be remembered separately, per world, and it cannot live in
// the yaml because the yaml is inside the archive being uploaded.
//
// It is kept in localStorage rather than in memory so a reload does not turn
// "update my world" into "create it", which the server would refuse with 409.

const REVISION_KEY_PREFIX = 'casas.serverRevision.'

export interface WorldSummary {
  uid: string
  name: string
  owner: string
  revision: number
  createdAt: string
  updatedAt: string
  size: number
  erosionRun: number
  hasPreview: boolean
  // Display data mirrored from the save at upload (empty for worlds not
  // re-uploaded since 2026-08-12): the recipe's seed, the build that wrote
  // it, and the current revision's content hash.
  seed: string
  generator: string
  contentHash: string
  // The save's kind (`FlatWorld`/`SphereWorld`) and its accepted progress
  // (a step id), mirrored the same way since 2026-10-11 — empty for worlds
  // not re-uploaded since, and absent from a server older than that. Kept
  // as plain strings: the world layer reads them, this module only carries
  // them.
  kind?: string
  progress?: string
  // Whether the world is a template — offered to every visitor of the
  // server, signed in or not, to copy (docs/decisions/template-worlds.md).
  // Absent from a server older than 2026-10-15.
  template?: boolean
  // The caller's level on the world, as the list states it: `viewer`,
  // `editor`, `owner` or `admin` (internal/access). Absent from a server
  // older than 2026-10-15, and from the answer of a copy or a mark.
  callerLevel?: string
}

// Why an upload failed, in terms a caller can act on rather than a status code.
export type UploadOutcome =
  | { ok: true; revision: number; created: boolean }
  // The server holds a revision we did not expect: someone else wrote, or this
  // browser forgot. NOT retried automatically — retrying is exactly the
  // last-writer-wins behaviour the lock exists to prevent, and the other side
  // is a world nobody can recompute.
  | { ok: false; reason: 'conflict'; serverRevision?: number; serverUpdatedAt?: string }
  | { ok: false; reason: 'rejected'; message: string }
  | { ok: false; reason: 'offline' }

function rememberedRevision(uid: string): number {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(REVISION_KEY_PREFIX + uid)
  } catch {
    // A private window or blocked site data throws on the READ as well as
    // on the write; the writes below already tolerate it, and a save must
    // not fail on the memory aid — it costs a redundant 409 at worst.
  }
  const value = raw === null ? 0 : Number(raw)
  return Number.isInteger(value) && value > 0 ? value : 0
}

function rememberRevision(uid: string, revision: number): void {
  try {
    localStorage.setItem(REVISION_KEY_PREFIX + uid, String(revision))
  } catch {
    // A full or disabled localStorage costs a redundant 409 on the next
    // upload, not correctness — never worth failing a completed upload over.
  }
}

export function forgetRevision(uid: string): void {
  try {
    localStorage.removeItem(REVISION_KEY_PREFIX + uid)
  } catch {
    // as above
  }
}

// Whether this world is known to live on the server — the "remembered
// destination" that lets a later save skip asking where to put it.
export function isStoredOnServer(uid: string): boolean {
  return rememberedRevision(uid) > 0
}

// The API root, or null when there is no server to talk to. Exported because
// the panels build preview URLs from it — a thumbnail is an <img src>, not a
// fetch, so it needs the address rather than a request helper.
export async function apiBase(): Promise<string | null> {
  const status = await getServerStatus()
  return status.state === 'local' || status.state === 'remote' ? status.apiBase : null
}

export async function listWorlds(): Promise<WorldSummary[] | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/worlds`, { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as WorldSummary[]
  } catch {
    return null
  }
}

// Deletes a world — every revision of it. The caller confirms; this only
// carries the request out and forgets the remembered revision, so a later
// save of the same world offers "create" rather than sending a stale
// If-Match at an entry that no longer exists.
export async function deleteWorld(uid: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}`, { method: 'DELETE' })
    if (response.ok) forgetRevision(uid)
    return response.ok
  } catch {
    return false
  }
}

// The worlds fetched, kept in the browser's cache storage by URL, each with
// the revision it holds — a world is tens of MB, and the incubator opens it
// on every visit (2026-10-03). Cache storage is absent in an insecure
// context; then every fetch is a full one, as before.
//
// THE REVISION COMES FROM THE META (2026-10-16). The zip is read by link:
// the server answers 302 to a presigned GET on its bucket (s3) or to its own
// signed link (dir), and fetch follows it. The revision is the ETag of the
// 302, which a browser's fetch does not show, and the ETag of the answer it
// does show is the bucket's (an MD5 on S3). So the meta is asked first: a
// cached copy of that revision is used without the zip, and a fetched zip
// is filed under that revision. The zip read after it holds that revision
// or a newer one (a save in between), never an older one; so the revision
// filed is never newer than the bytes: at worst the next save meets a 409
// or 412 and the next open fetches again, never an overwrite.
const WORLD_CACHE = 'casas-worlds'

export async function fetchWorld(uid: string): Promise<Blob | null> {
  const base = await apiBase()
  if (!base) return null
  const url = `${base}/worlds/${encodeURIComponent(uid)}`
  let cache: Cache | null = null
  let cached: Response | undefined
  try {
    cache = typeof caches !== 'undefined' ? await caches.open(WORLD_CACHE) : null
    cached = await cache?.match(url)
  } catch {
    cache = null
  }
  const revisionOf = (etag: string | null | undefined): number => {
    const value = etag ? Number(etag.replace(/"/g, '')) : 0
    return Number.isInteger(value) && value > 0 ? value : 0
  }
  try {
    const meta = await authFetch(`${url}/meta`, { cache: 'no-store' })
    if (!meta.ok) return null
    const { revision } = (await meta.json()) as { revision?: number }
    const current = typeof revision === 'number' && Number.isInteger(revision) && revision > 0 ? revision : 0
    if (cached && current > 0 && revisionOf(cached.headers.get('ETag')) === current) {
      rememberRevision(uid, current)
      return await cached.blob()
    }
    const response = await authFetch(url, { cache: 'no-store' })
    if (!response.ok) return null
    // The answer's own ETag only without a redirect (a server from before
    // the links): after one it is the bucket's.
    const read = (response.redirected ? 0 : revisionOf(response.headers.get('ETag'))) || current
    // Learning the revision here means a world opened from the server can
    // be saved straight back without a 409 detour.
    if (read > 0) rememberRevision(uid, read)
    const archive = await response.blob()
    if (cache && read > 0) {
      try {
        await cache.put(url, new Response(archive, { headers: { 'Content-Type': 'application/zip', ETag: `"${read}"` } }))
      } catch {
        // Full storage, or a private window: the world still opens.
      }
    }
    return archive
  } catch {
    return null
  }
}

/**
 * A world's preview image, as an object URL the caller must revoke.
 *
 * Fetched rather than handed to `<img src>`, which is how it was done until the
 * API needed authentication: an image request the browser makes on its own
 * carries no Authorization header, so every thumbnail 401'd and the rows showed
 * empty squares. Nothing said why — the image element's error event is silent by
 * design.
 *
 * The server answers the read with a 302 to a link (its bucket's presigned GET
 * on s3, its own signed link on dir, 2026-10-16), and fetch follows it: a
 * CORS-mode request, so the page's Cross-Origin-Embedder-Policy (require-corp)
 * does not stop it, as it would an `<img src>` on the bucket without CORP; the
 * image element gets a blob: URL of this document.
 *
 * Null when there is none, or when it could not be fetched; a missing thumbnail
 * must never cost the row, since the world is the point and the picture is a
 * convenience.
 */
export async function fetchWorldPreview(uid: string): Promise<string | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}/preview.png`, { cache: 'no-store' })
    if (!response.ok) return null
    return URL.createObjectURL(await response.blob())
  } catch {
    return null
  }
}

export async function uploadWorld(uid: string, archive: Blob): Promise<UploadOutcome> {
  const base = await apiBase()
  if (!base) return { ok: false, reason: 'offline' }
  return uploadWorldTo(base, uid, archive, authFetch)
}

// The upload against a given API root and fetch — uploadWorld without the
// app's server status and session, so that a test can point it at a server
// of its own (npm run test:http-store).
//
// A CREATION THAT WAS STORED (2026-10-16). A create can store the world and
// still fail: the answer is lost, or the server could not confirm its
// meta.json and answered 500 (DEC-0038, Status). The next save sends a
// create again and gets 409, although the world is this one. THE RULE: a
// 409 to a create asks the world's meta; when its content hash is the
// SHA-256 of this archive and the caller may write the world (editor or
// above), the world IS this save: its revision is remembered and the
// outcome is "stored". Else it is the conflict it was. Without
// crypto.subtle (an insecure context) nothing can be compared: a conflict.
export async function uploadWorldTo(
  base: string,
  uid: string,
  archive: Blob,
  send: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<UploadOutcome> {
  const expected = rememberedRevision(uid)
  const headers: Record<string, string> = { 'Content-Type': 'application/zip' }
  // Absent If-Match means "create, and fail if it already exists" — which is
  // the correct request the first time, and the reason a wrong guess surfaces
  // as a conflict instead of quietly overwriting something.
  if (expected > 0) headers['If-Match'] = `"${expected}"`

  const route = `${base}/worlds/${encodeURIComponent(uid)}`
  let response: Response
  try {
    response = await send(route, { method: 'PUT', headers, body: archive })
  } catch {
    return { ok: false, reason: 'offline' }
  }

  if (response.ok) {
    const meta = (await response.json()) as WorldSummary
    rememberRevision(uid, meta.revision)
    return { ok: true, revision: meta.revision, created: response.status === 201 }
  }

  // 409 (exists, we said create) and 412 (our revision is stale) are the same
  // situation from the user's side: the server holds something we did not
  // expect. Both are reported with what the server actually has, so the answer
  // is a decision rather than a guess — unless the world it holds is this
  // save (A CREATION THAT WAS STORED).
  if (response.status === 409 || response.status === 412) {
    let held: WorldSummary | undefined
    try {
      const meta = await send(`${route}/meta`, { cache: 'no-store' })
      if (meta.ok) held = (await meta.json()) as WorldSummary
    } catch {
      // No meta: the conflict is said without the server's revision.
    }
    if (held && response.status === 409 && expected === 0 && (await isThisArchive(held, archive))) {
      rememberRevision(uid, held.revision)
      return { ok: true, revision: held.revision, created: true }
    }
    if (held) rememberRevision(uid, held.revision)
    return { ok: false, reason: 'conflict', serverRevision: held?.revision, serverUpdatedAt: held?.updatedAt }
  }

  let message = `server refused the upload (${response.status})`
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) message = body.error
  } catch {
    // A non-JSON error body is not worth failing over; the status stands.
  }
  return { ok: false, reason: 'rejected', message }
}

// Whether the world the server holds is this archive, and the caller's to
// write: its content hash (the server's SHA-256 of the bytes, store.go) is
// this archive's, and the caller is an editor or above.
async function isThisArchive(held: WorldSummary, archive: Blob): Promise<boolean> {
  if (!held.contentHash || !['editor', 'owner', 'admin'].includes(held.callerLevel ?? '')) return false
  if (typeof crypto === 'undefined' || !crypto.subtle) return false
  try {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await archive.arrayBuffer()))
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === held.contentHash
  } catch {
    return false
  }
}

// Makes a copy of a world ON the server: a new world with a new uid, owned by
// the caller, the same content, and world.yaml naming the source
// (world/worldCopy.ts says what a copy is). Nothing travels through this
// browser. The copy's record, or null when the server refused or could not
// be reached. Its revision is remembered, so the next save of the copy is an
// update and not a 409.
export async function copyWorldOnServer(uid: string): Promise<WorldSummary | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}/copy`, { method: 'POST' })
    if (!response.ok) return null
    const meta = (await response.json()) as WorldSummary
    rememberRevision(meta.uid, meta.revision)
    return meta
  } catch {
    return null
  }
}

// Sets or removes a world's template mark — an admin's move; the server
// refuses everyone else. False when it was not done.
export async function setWorldTemplate(uid: string, on: boolean): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}/template`, { method: on ? 'PUT' : 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

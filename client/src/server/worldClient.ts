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
  const raw = localStorage.getItem(REVISION_KEY_PREFIX + uid)
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

export async function fetchWorld(uid: string): Promise<Blob | null> {
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}`, { cache: 'no-store' })
    if (!response.ok) return null
    // The ETag is the server's revision: learning it here means a world opened
    // from the server can be saved straight back without a 409 detour.
    const etag = response.headers.get('ETag')
    const revision = etag ? Number(etag.replace(/"/g, '')) : 0
    if (Number.isInteger(revision) && revision > 0) rememberRevision(uid, revision)
    return await response.blob()
  } catch {
    return null
  }
}

export async function uploadWorld(uid: string, archive: Blob): Promise<UploadOutcome> {
  const base = await apiBase()
  if (!base) return { ok: false, reason: 'offline' }

  const expected = rememberedRevision(uid)
  const headers: Record<string, string> = { 'Content-Type': 'application/zip' }
  // Absent If-Match means "create, and fail if it already exists" — which is
  // the correct request the first time, and the reason a wrong guess surfaces
  // as a conflict instead of quietly overwriting something.
  if (expected > 0) headers['If-Match'] = `"${expected}"`

  let response: Response
  try {
    response = await authFetch(`${base}/worlds/${encodeURIComponent(uid)}`, { method: 'PUT', headers, body: archive })
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
  // is a decision rather than a guess.
  if (response.status === 409 || response.status === 412) {
    const worlds = await listWorlds()
    const held = worlds?.find((world) => world.uid === uid)
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

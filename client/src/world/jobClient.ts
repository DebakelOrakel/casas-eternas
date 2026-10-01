import { apiBase } from '../server/worldClient'
import { getServerStatus } from '../server/serverStatus'
import { authFetch, hasSession } from '../server/session'

// Commissioning a bake on the server, and following it until it lands.
//
// This is the half of the artifact story the client did not have. It could
// READ what a server had already baked — that is what the tiered store is for
// — but nothing could ask for one, so an 8192² stage existed only if somebody
// ran `curl` by hand. The reason it matters is the same measurement the whole
// bake module rests on: 8k peaks near 2.6 GB, which is unremarkable for a
// process and fatal for a tab. A stage the browser must not bake is exactly
// the stage worth ordering from somewhere that can.
//
// Deliberately NOT automatic. The tempting version orders a bake whenever a
// showable stage is missing, and it is wrong twice over: it spends minutes of
// a shared machine on behalf of someone who only opened a map, and a bake that
// fails — or lands under a key this client does not look for, see below —
// would be re-ordered on every single load. An explicit act has neither
// failure mode.

export interface BakeResult {
  worldId: string
  // Which pipeline the SERVER ran. Checked against the client's own, because
  // this is the one mismatch that fails silently: a differing version writes a
  // perfectly good artifact under a key this client will never look for, so
  // the bake reports success and the map never changes. It has happened once
  // already, when the baker hashed different constants than the worldmap.
  pipelineVersion: string
  stage: string
  width: number
  height: number
  durationMs: number
}

export interface BakeJob {
  id: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  // Free text from the runner: pipeline phase locally, or the cluster runner's
  // pending/running distinction — a Job waiting for a node is not working yet,
  // and with hard anti-affinity that wait is routine rather than a fault.
  phase?: string
  percent: number
  error?: string
  result?: BakeResult
  // The order that produced the job, as the server records it. What lets a
  // screen recognise a job as being about ITS world and stage when somebody
  // else placed the order — see findActiveBake.
  request?: { worldUid: string; stage: number; scope?: { kind: string; x?: number; y?: number }; plan?: JobPlan }
  queuedAt?: string
  startedAt?: string
  // The caller's level on the job's world ("viewer", "editor", "owner", or
  // "admin" for the operator). Cancelling takes an editor.
  callerLevel?: string
}

// A job's plan (docs/decisions/detail-ladder.md, "Coordinator"): `refine` is
// level 1 of the world, then every tile of it that holds land at level 2.
export type JobPlan = 'refine'

// The jobs the caller may see (the server lists by the worlds' access), newest
// first; null when there is no server or no bake module to ask.
export async function listBakes(): Promise<BakeJob[] | null> {
  if (!(await canCommissionBakes())) return null
  const base = await apiBase()
  if (!base) return null
  try {
    const response = await authFetch(`${base}/jobs`, { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as BakeJob[]
  } catch {
    return null
  }
}

// Stops a job: a waiting one never starts, a running one is aborted. False
// when the server refused or could not be reached.
export async function cancelBake(id: string): Promise<boolean> {
  const base = await apiBase()
  if (!base) return false
  try {
    const response = await authFetch(`${base}/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return response.ok
  } catch {
    return false
  }
}

// Why an order failed, in terms the caller can act on rather than a status
// code. `unknownWorld` in particular is not an error state — it is the normal
// condition of a world that has never been uploaded, and the answer is to save
// it, not to retry.
export type CommissionOutcome =
  | { ok: true; job: BakeJob }
  | {
      ok: false
      reason: 'offline' | 'unsupported' | 'unknownWorld' | 'forbidden' | 'busy' | 'rejected'
      message?: string
    }

// How the follow ends. `mismatch` is a SUCCESS on the server's side: the bake
// ran and produced bytes, they are simply not addressed by the key this client
// searches. Reporting it as a failure would be a lie, and reporting it as
// success would leave someone staring at an unchanged map.
export type BakeOutcome =
  | { ok: true; result: BakeResult }
  | { ok: false; reason: 'failed' | 'lost'; message: string }
  // The two versions travel as VALUES rather than baked into a sentence here,
  // so the screen can put them through the catalog. A prebuilt English message
  // returned from a client module would be untranslatable by construction.
  | { ok: false; reason: 'mismatch'; serverVersion: string; clientVersion: string }

// Matched to the server's own poll of the runner. Asking faster cannot surface
// a state the server has not itself observed yet, so it would be pure traffic.
const POLL_MS = 2000

// The server reports progress WITHIN the current phase, so `erosion 84%` is
// followed by `hydrology 0%`; each phase owns a band of the whole so the bar
// runs one way. The phases are the mesh level bake's
// (pipeline/meshBakeStage). Set, not measured: the level bake has not been
// timed phase by phase yet (the raster bake's bands, measured, went with it
// on 2026-09-29).
const PHASE_BANDS: Record<string, [number, number]> = {
  refine: [0, 0.3],
  erosion: [0.3, 0.6],
  hydrology: [0.6, 1],
}
// A tile's (pipeline/meshTileBake, scripts/jobWorker's bakeTile): reading
// level 1, building the tile's mesh, eroding it. Set, not measured.
const TILE_PHASE_BANDS: Record<string, [number, number]> = {
  parent: [0, 0.15],
  mesh: [0.15, 0.3],
  erosion: [0.3, 1],
}

// Undefined for a phase with no band — the cluster runner's `pending` and
// `running`, where any bar would be invented rather than measured.
//
// A plan's fraction is that of its current part: level 1 by its phases, then
// `tiles`, whose percent the coordinator gives over all tiles. Not one bar
// over both, because the parts differ by two orders of magnitude (measured
// 2026-10-01: level 1 ~30 s, the tiles of one world ~2.5 h on two workers).
export function bakeFraction(job: BakeJob): number | undefined {
  if (job.phase === 'tiles') return Math.max(0, Math.min(1, job.percent / 100))
  const bands = job.request?.stage === 2 ? TILE_PHASE_BANDS : PHASE_BANDS
  const band = bands[job.phase ?? '']
  if (!band) return undefined
  return band[0] + (band[1] - band[0]) * Math.max(0, Math.min(1, job.percent / 100))
}

// Whether the job is still waiting rather than working. Queued here, or —
// in a cluster — a Job whose pod has no node yet, which with hard anti-affinity
// is routine rather than a fault and is worth saying out loud: nothing is
// wrong, and nothing is happening either.
export function bakeIsWaiting(job: BakeJob): boolean {
  return job.state === 'queued' || job.phase === 'pending'
}

// Consecutive poll failures tolerated before the job counts as lost. A bake
// runs for minutes, and a dropped request in the middle is not a dead bake —
// but a server that has gone for good should not be waited on forever.
const POLL_FAILURES_ALLOWED = 5

// Whether this server can be asked for bakes at all.
//
// The module list, not merely reachability: `start -t client,world` serves
// worlds and answers /v1/capabilities while running no baker, and offering the
// affordance there would produce a 404 at the click instead of an absent
// button.
export async function canCommissionBakes(): Promise<boolean> {
  const status = await getServerStatus()
  const reachable = status.state === 'local' || status.state === 'remote'
  // Signed out counts as CANNOT, deliberately. Ordering a bake without a session
  // would collect a 401 and report a failure, when the honest answer is that
  // this browser should do the work itself — which bakeFromArchive already does
  // when told no. Being signed out is the same kind of fact as having no server.
  const permitted = status.loginPath === '' || hasSession()
  return reachable && permitted && status.modules.includes('jobs')
}

// The artifact stage a job produces, as the server names it (the jobs
// module's StageName): `L1`, or `L2:x,y` for a tile; `L1+L2` for a refine
// plan, which produces both.
export function jobStageName(job: BakeJob): string {
  const request = job.request
  if (!request) return '?'
  if (request.plan === 'refine') return `L${request.stage}+L${request.stage + 1}`
  const scope = request.scope
  if (scope?.kind === 'tile') return `L${request.stage}:${scope.x ?? 0},${scope.y ?? 0}`
  return `L${request.stage}`
}

// `tile` orders one tile of the top level (stage 2); without it the whole
// world at `stage`. `plan` orders a plan of tasks instead of one (JobPlan).
export async function commissionBake(
  worldUid: string,
  stage: number,
  erosionRounds: number,
  order: { tile?: { x: number; y: number }; plan?: JobPlan } = {},
): Promise<CommissionOutcome> {
  const { tile, plan } = order
  const base = await apiBase()
  if (!base) return { ok: false, reason: 'offline' }

  let response: Response
  try {
    response = await authFetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // erosionRounds is sent EXPLICITLY rather than left to the server's
      // default. The client's artifact key is derived from its own constants
      // including this one, so a server whose default had drifted would bake a
      // real world under a key nobody asks for — the silent failure again, by
      // a different route.
      body: JSON.stringify({ worldUid, stage, erosionRounds, ...(tile ? { scope: { kind: 'tile', x: tile.x, y: tile.y } } : {}), ...(plan ? { plan } : {}) }),
    })
  } catch {
    return { ok: false, reason: 'offline' }
  }

  if (response.ok) return { ok: true, job: (await response.json()) as BakeJob }

  const message = await errorMessage(response)
  switch (response.status) {
    // The world is not on the server, or holds no stored revision. Its own
    // outcome because the remedy is specific and the user can do it.
    case 404:
      return { ok: false, reason: 'unknownWorld', message }
    case 403:
      return { ok: false, reason: 'forbidden', message }
    case 503:
      return { ok: false, reason: 'busy', message }
    default:
      return { ok: false, reason: 'rejected', message }
  }
}

// Follows the jobs' changes as the server sends them (GET /v1/jobs/events,
// server-sent events): `onJob` gets each changed job, in full. Read with
// fetch, not EventSource, which cannot send the session's Authorization
// header. The stream sends changes only, so a caller lists the jobs first.
//
// `onLost` is called once when the stream cannot be opened or ends without
// being stopped — an older server, a proxy that buffers, a restart. The caller
// then polls, as before the stream existed. The returned function stops it.
export function watchJobs(onJob: (job: BakeJob) => void, onLost: () => void): () => void {
  const abort = new AbortController()
  void (async () => {
    const base = await apiBase()
    if (!base || !(await canCommissionBakes())) throw new Error('no jobs')
    const response = await authFetch(`${base}/jobs/events`, { cache: 'no-store', signal: abort.signal })
    if (!response.ok || !response.body) throw new Error(`events ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let pending = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      pending += value
      // One event per blank-line-terminated block; only `data:` lines carry
      // a job (`:` lines are the server's keep-alive).
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, end)
        pending = pending.slice(end + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            onJob(JSON.parse(line.slice(5)) as BakeJob)
          } catch {
            // A line that does not parse is skipped; the next change of that
            // job carries it in full again.
          }
        }
      }
    }
  })().then(
    () => { if (!abort.signal.aborted) onLost() },
    () => { if (!abort.signal.aborted) onLost() },
  )
  return () => abort.abort()
}

// The most recent job for this world and stage that has not failed, or null.
//
// This is how a screen discovers work SOMEBODY ELSE started — the worldgen
// screen orders a bake, the user switches to the map, and without this the map
// would only see "artifact absent" and start the same computation again. The
// server does not deduplicate orders (two enqueues are two bakes), so noticing
// existing work is the caller's job, and this is the noticing.
//
// A 'done' job is deliberately included: the artifact may have landed seconds
// after the caller's read missed, and following a finished job simply returns
// its result at the first poll — the cheap retry, by the existing road. Only
// 'failed' is excluded, because attaching to it can produce nothing.
//
// Best-effort like every read in this file: offline, signed out, or a server
// without the bake module all answer null, and the caller does whatever it
// would have done without a server.
export async function findActiveBake(worldUid: string, stage: number): Promise<BakeJob | null> {
  if (worldUid === '' || !(await canCommissionBakes())) return null
  const base = await apiBase()
  if (!base) return null
  let jobs: BakeJob[]
  try {
    const response = await authFetch(`${base}/jobs`, { cache: 'no-store' })
    if (!response.ok) return null
    jobs = (await response.json()) as BakeJob[]
  } catch {
    return null
  }
  const matching = jobs.filter((job) =>
    job.state !== 'failed' && job.state !== 'cancelled' && job.request?.worldUid === worldUid && job.request?.stage === stage)
  if (matching.length === 0) return null
  // Newest first: orders are not deduplicated, so an old finished job and a
  // fresh running one can coexist — the fresh one is the one to follow.
  matching.sort((a, b) => (b.queuedAt ?? '').localeCompare(a.queuedAt ?? ''))
  return matching[0]
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // A non-JSON body is not worth failing over; the status stands.
  }
  return `server refused the bake (${response.status})`
}

// Follow a job to its end, reporting progress along the way.
//
// `expectedPipelineVersion` is what the CALLER will look for in the artifact
// store. Comparing it here rather than at the call site keeps the check
// impossible to forget, and it is the only place that can tell the difference
// between a bake that did nothing and a bake whose output is simply addressed
// elsewhere.
export async function followBake(
  jobId: string,
  expectedPipelineVersion: string,
  onProgress: (job: BakeJob) => void,
  signal?: AbortSignal,
): Promise<BakeOutcome> {
  const base = await apiBase()
  if (!base) return { ok: false, reason: 'lost', message: 'no server to ask' }
  let failures = 0

  for (;;) {
    await sleep(POLL_MS)
    if (signal?.aborted) return { ok: false, reason: 'lost', message: 'stopped watching' }

    let response: Response
    try {
      response = await authFetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal })
    } catch {
      // Still out there working, most likely. Only a run of failures ends it.
      if (++failures > POLL_FAILURES_ALLOWED) {
        return { ok: false, reason: 'lost', message: 'lost contact with the server' }
      }
      continue
    }

    // A 404 is different from a dropped request and must not be retried: the
    // server restarted and the job went with it. Finished jobs are evicted
    // eventually too, but never while in flight, so this cannot be a race with
    // a job that is merely old.
    if (response.status === 404) {
      return { ok: false, reason: 'lost', message: 'the server forgot this job — it may have restarted' }
    }
    if (!response.ok) {
      if (++failures > POLL_FAILURES_ALLOWED) {
        return { ok: false, reason: 'lost', message: await errorMessage(response) }
      }
      continue
    }

    failures = 0
    const job = (await response.json()) as BakeJob
    onProgress(job)

    if (job.state === 'failed') {
      return { ok: false, reason: 'failed', message: job.error || 'the bake failed' }
    }
    if (job.state !== 'done') continue

    if (!job.result) {
      return { ok: false, reason: 'failed', message: 'the bake finished without saying what it produced' }
    }
    if (job.result.pipelineVersion !== expectedPipelineVersion) {
      return {
        ok: false,
        reason: 'mismatch',
        serverVersion: job.result.pipelineVersion,
        clientVersion: expectedPipelineVersion,
      }
    }
    return { ok: true, result: job.result }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

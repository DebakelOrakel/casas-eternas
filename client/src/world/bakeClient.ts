import { apiBase } from '../server/worldClient'
import { getServerStatus } from '../server/serverStatus'
import { amplifyPhaseFraction } from '../worldgen/surface/bakeInBrowser'

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
  state: 'queued' | 'running' | 'done' | 'failed'
  // Free text from the runner: pipeline phase locally, or the cluster runner's
  // pending/running distinction — a Job waiting for a node is not working yet,
  // and with hard anti-affinity that wait is routine rather than a fault.
  phase?: string
  percent: number
  error?: string
  result?: BakeResult
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
// followed by `hydrology 0%`. The band table that makes that monotonic lives in
// worldgen/surface/bakeInBrowser, shared with the generator's own bake — two
// copies would drift, and a progress bar that runs backwards in one place and
// not the other is exactly the kind of difference nobody notices until it is
// confusing.
export function bakeFraction(job: BakeJob): number | undefined {
  return amplifyPhaseFraction(job.phase ?? '', job.percent / 100)
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
  return reachable && status.modules.includes('bake')
}

export async function commissionBake(
  worldUid: string,
  stage: number,
  erosionRounds: number,
): Promise<CommissionOutcome> {
  const base = await apiBase()
  if (!base) return { ok: false, reason: 'offline' }

  let response: Response
  try {
    response = await fetch(`${base}/worlds/${encodeURIComponent(worldUid)}/bake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // erosionRounds is sent EXPLICITLY rather than left to the server's
      // default. The client's artifact key is derived from its own constants
      // including this one, so a server whose default had drifted would bake a
      // real world under a key nobody asks for — the silent failure again, by
      // a different route.
      body: JSON.stringify({ stage, erosionRounds }),
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
      response = await fetch(`${base}/bakes/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal })
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

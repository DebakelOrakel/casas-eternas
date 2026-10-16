// The job worker's read of its world (jobWorker.ts), on its own so that it
// can be tested without the worker (npm run test:http-store).
import { readFile } from 'node:fs/promises'

// Where the world is: a path or a URL, exactly one of the two.
export interface WorldSource {
  worldZip?: string
  worldUrl?: string
}

// A world server that did not answer, or answered with something other
// than the world or a 404: not the task's fault, and not "no such world".
// The serve loop gives the task back to the relay (nak), as for an
// artifact store that did not answer (HttpArtifactStore.ts).
export class WorldUnavailableError extends Error {}

// `held` is the revision (the server's ETag) of a copy this worker keeps:
// the server answers 304 when it is still the current one, and the
// archive — tens of MB — is not sent again (`unchanged`).
//
// Null only when the world is absent: no file at the path, or a 404 for the
// URL. Until 2026-10-16 any failure was null, so a server that was away for
// a moment failed the task with "cannot read the world" and ended it.
export async function readWorld(job: WorldSource, send: (input: string, init?: RequestInit) => Promise<Response>, held?: string): Promise<{ archive: Uint8Array; etag: string | null } | 'unchanged' | null> {
  if (job.worldZip) {
    const archive = await readFile(job.worldZip).catch(() => null)
    return archive ? { archive, etag: null } : null
  }
  if (!job.worldUrl) return null
  let response: Response
  try {
    response = await send(job.worldUrl, held ? { headers: { 'If-None-Match': held } } : {})
  } catch (error) {
    throw new WorldUnavailableError(`world: no answer (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  if (response.status === 304 && held) return 'unchanged'
  if (response.status === 404) return null
  if (!response.ok) throw new WorldUnavailableError(`world: ${response.status} ${response.statusText}`.trimEnd())
  try {
    return { archive: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('ETag') }
  } catch (error) {
    throw new WorldUnavailableError('world: the body broke off', { cause: error })
  }
}

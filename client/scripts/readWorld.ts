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
// THE LINK (DEC-0038, 2026-10-16). Otherwise the server answers 302 to a
// link: a presigned GET on the bucket (s3) or its own signed link (dir).
// The revision is the ETag of the 302, not of the link's answer (on S3
// that is the bucket's MD5), so the redirect is followed here and not by
// fetch: `send` asks with `redirect: 'manual'`, and `follow` reads the link
// with no header of the task at all — no job token for the bucket (S3
// refuses a presigned GET that also carries an Authorization header, 400),
// no If-None-Match. An answer without a redirect (a server before the
// links) is read as it comes, with its own ETag.
//
// Null only when the world is absent: no file at the path, or a 404 for the
// URL. Until 2026-10-16 any failure was null, so a server that was away for
// a moment failed the task with "cannot read the world" and ended it. A
// link that fails (its object went, it expired on the way) is unavailable
// too: the world was there a moment ago, and the next delivery asks again.
export async function readWorld(
  job: WorldSource,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  held?: string,
  follow: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<{ archive: Uint8Array; etag: string | null } | 'unchanged' | null> {
  if (job.worldZip) {
    const archive = await readFile(job.worldZip).catch(() => null)
    return archive ? { archive, etag: null } : null
  }
  if (!job.worldUrl) return null
  let response: Response
  try {
    response = await send(job.worldUrl, { redirect: 'manual', headers: held ? { 'If-None-Match': held } : {} })
  } catch (error) {
    throw new WorldUnavailableError(`world: no answer (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  if (response.status === 304 && held) return 'unchanged'
  if (response.status === 404) return null
  const etag = response.headers.get('ETag')
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location')
    await response.body?.cancel()
    if (!location) throw new WorldUnavailableError(`world: ${response.status} without a Location`)
    try {
      response = await follow(new URL(location, job.worldUrl).href)
    } catch (error) {
      throw new WorldUnavailableError(`world: the link did not answer (${error instanceof Error ? error.message : String(error)})`, { cause: error })
    }
    if (!response.ok) throw new WorldUnavailableError(`world: the link answered ${response.status} ${response.statusText}`.trimEnd())
  } else if (!response.ok) {
    throw new WorldUnavailableError(`world: ${response.status} ${response.statusText}`.trimEnd())
  }
  try {
    return { archive: new Uint8Array(await response.arrayBuffer()), etag }
  } catch (error) {
    throw new WorldUnavailableError('world: the body broke off', { cause: error })
  }
}

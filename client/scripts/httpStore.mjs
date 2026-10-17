// The HTTP artifact store's failure contract (2026-10-16, DEC-0038 Status):
//
//   npm run test:http-store
//
// Only a 404 is "absent"; a server that does not answer — refused, a TLS
// handshake that fails, a 5xx — throws ArtifactStoreUnavailableError, which
// the job worker turns into "give the task back" (jobWorker.ts, serve). The
// browser's tiered store catches the same error and goes on as on a miss,
// as it did before. Both halves are checked here against a real HTTP
// server on loopback, in about a second; no Vite, no world.
//
// Also (DEC-0038, fork 7): the job worker's writes by link — a write link
// per file, the upload without the job's credentials, the commit with
// meta.json — and the rule for expired links: a link with less than the
// margin left is asked for again before the upload, a refused upload (403,
// 410) once after it. And the worker's read of the world: only a 404 is
// "no such world", other failures give the task back. And a reservation
// the server forgot at a restart: a 404 on a write by link resolves again
// once and uploads the artifact again from its first file; a second 404
// throws. And the world read by link (2026-10-16): the 302's ETag is the
// revision, the link is read without the job token, the 304 still comes.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { resolve } from './tsResolve.mjs'

registerHooks({ resolve })
const { createHttpArtifactStore } = await import('../src/storage/HttpArtifactStore.ts')
const { createTieredArtifactStore } = await import('../src/storage/TieredArtifactStore.ts')
const { createMemoryArtifactStore } = await import('../src/storage/MemoryArtifactStore.ts')
const { ArtifactStoreUnavailableError, ArtifactStoreRefusedError, artifactKey } = await import('../src/storage/ArtifactStore.ts')
const { readWorld, WorldUnavailableError, WorldRefusedError } = await import('./readWorld.ts')
const { uploadWorldTo } = await import('../src/server/worldClient.ts')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok    ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`) }
}
// What a call did: its value, or the error it threw.
const outcome = async (call) => {
  try {
    return { value: await call() }
  } catch (error) {
    return { error }
  }
}
const unavailable = (o) => o.error instanceof ArtifactStoreUnavailableError
// A final refusal (4xx other than 404): the task fails at once, no nak.
const refusedFinally = (o) => o.error instanceof ArtifactStoreRefusedError && !(o.error instanceof ArtifactStoreUnavailableError)

// The server's answer per route, set by each case.
const answers = { resolve: 200, file: 200, put: 204 }
// The writes by link: what the server answers, and what it was sent.
const links = { linkStatus: [], linkTtlMs: [], upload: [], commit: 204, relative: false, asked: 0, uploads: [], commits: [] }
const resetLinks = (change = {}) => Object.assign(links, { linkStatus: [], linkTtlMs: [], upload: [], commit: 204, relative: false, asked: 0, uploads: [], commits: [] }, change)
const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const body = Buffer.concat(chunks)
    const write = url.pathname.match(/^\/v1\/artifacts\/u1\/write-link$/)
    if (write && req.method === 'POST') {
      const n = ++links.asked
      const answer = links.linkStatus.shift() ?? 200
      const [status, error] = typeof answer === 'number' ? [answer, '{"error":"x"}'] : [answer.status, answer.body]
      if (status !== 200) return res.writeHead(status, { 'Content-Type': 'application/json' }).end(error)
      const { name, size } = JSON.parse(body.toString())
      const ttl = links.linkTtlMs.shift() ?? 3_600_000
      const path = `/bucket/u1/${name}?len=${size}&n=${n}`
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        method: 'PUT',
        url: links.relative ? path : `http://127.0.0.1:${port}${path}`,
        header: { 'X-Signed': `link-${n}` },
        expires: new Date(Date.now() + ttl).toISOString(),
      }))
    }
    if (url.pathname.startsWith('/bucket/') && req.method === 'PUT') {
      links.uploads.push({ path: url.pathname, n: url.searchParams.get('n'), signed: req.headers['x-signed'], authorization: req.headers.authorization, length: body.length })
      const status = links.upload.shift() ?? 200
      return res.writeHead(status).end()
    }
    if (url.pathname === '/v1/artifacts/u1/commit' && req.method === 'POST') {
      links.commits.push({ body: JSON.parse(body.toString()), authorization: req.headers.authorization })
      return res.writeHead(links.commit).end()
    }
    if (url.pathname === '/v1/artifacts/resolve') {
      if (answers.resolve !== 200) return res.writeHead(answers.resolve).end('{"error":"x"}')
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ artifactUid: 'u1', files: ['meta.json'] }))
    }
    if (url.pathname === '/v1/artifacts/blob/u1/forbidden') {
      // A link that does not verify: the link's 403, not the API's.
      return res.writeHead(403).end()
    }
    if (url.pathname === '/v1/artifacts/blob/u1/meta.json') {
      // The link a read is redirected to (the dir backend's own links).
      if (answers.file === 'gone') return res.writeHead(404).end()
      return res.writeHead(200).end('{"ok":true}')
    }
    if (url.pathname.startsWith('/v1/artifacts/u1/')) {
      if (req.method === 'PUT') return res.writeHead(answers.put).end()
      if (answers.file === 'redirect' || answers.file === 'gone') return res.writeHead(302, { Location: '/v1/artifacts/blob/u1/meta.json' }).end()
      if (answers.file === 'linkForbidden') return res.writeHead(302, { Location: '/v1/artifacts/blob/u1/forbidden' }).end()
      if (answers.file !== 200) return res.writeHead(answers.file).end()
      return res.writeHead(200).end('{"ok":true}')
    }
    res.writeHead(404).end()
  })
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const plain = `http://127.0.0.1:${port}/v1`
// TLS against a server that speaks plain HTTP: the handshake fails.
const tls = `https://127.0.0.1:${port}/v1`
// Nobody listens there: the connection is refused.
const refused = `http://127.0.0.1:1/v1`

const key = artifactKey('world', 'v1', '1')
const handle = { key, remote: 'u1', files: ['meta.json'] }
const store = (base) => createHttpArtifactStore({ resolveBase: async () => base })
const bytes = new Uint8Array([1, 2, 3])

console.log('\n— the HTTP store: only 404 is absent —')
{
  const s = store(plain)
  Object.assign(answers, { resolve: 200, file: 200, put: 204 })
  const found = await outcome(() => s.resolve(key, false))
  check('resolve 200 → a handle', found.value?.remote === 'u1', JSON.stringify(found))
  answers.resolve = 404
  const absent = await outcome(() => s.resolve(key, false))
  check('resolve 404 → null', absent.value === null, String(absent.error))
  answers.resolve = 500
  check('resolve 500 → unavailable', unavailable(await outcome(() => s.resolve(key, false))))
  answers.resolve = 503
  check('resolve 503 → unavailable', unavailable(await outcome(() => s.resolve(key, true))))
  for (const status of [400, 401, 403]) {
    answers.resolve = status
    const o = await outcome(() => s.resolve(key, false))
    check(`resolve ${status} → refused (final), not unavailable, not absent`, refusedFinally(o) && o.error.status === status, String(o.error ?? JSON.stringify(o.value)))
  }
  answers.resolve = 200

  const read = await outcome(() => s.read(handle, 'meta.json'))
  check('read 200 → bytes', read.value && new TextDecoder().decode(read.value) === '{"ok":true}', String(read.error))
  answers.file = 'redirect'
  const linked = await outcome(() => s.read(handle, 'meta.json'))
  check('read 302 → link 200 → bytes', linked.value?.byteLength === 11, String(linked.error))
  answers.file = 'gone'
  const gone = await outcome(() => s.read(handle, 'meta.json'))
  check('read 302 → link 404 → null', gone.value === null, String(gone.error))
  answers.file = 404
  const missing = await outcome(() => s.read(handle, 'meta.json'))
  check('read 404 → null', missing.value === null, String(missing.error))
  answers.file = 500
  const broken = await outcome(() => s.read(handle, 'meta.json'))
  check('read 500 → unavailable', unavailable(broken) && broken.error.status === 500, String(broken.error))
  answers.file = 410
  check('read 410 (an expired link) → unavailable', unavailable(await outcome(() => s.read(handle, 'meta.json'))))
  answers.file = 'linkForbidden'
  check('read 302 → link 403 (a link that does not verify) → unavailable', unavailable(await outcome(() => s.read(handle, 'meta.json'))))
  for (const status of [400, 401, 403]) {
    answers.file = status
    const o = await outcome(() => s.read(handle, 'meta.json'))
    check(`read ${status} from the API → refused (final)`, refusedFinally(o) && o.error.status === status, String(o.error ?? JSON.stringify(o.value)))
  }
  answers.file = 200

  const wrote = await outcome(() => s.write(handle, 'meta.json', bytes))
  check('write 204 → true', wrote.value === true, String(wrote.error))
  answers.put = 403
  const refusedWrite = await outcome(() => s.write(handle, 'meta.json', bytes))
  check('write 403 → false (a refusal, as before)', refusedWrite.value === false, String(refusedWrite.error))
  answers.put = 500
  check('write 500 → unavailable', unavailable(await outcome(() => s.write(handle, 'meta.json', bytes))))
}

console.log('\n— the HTTP store: writes by link (the job worker) —')
{
  // The worker's store: its fetch adds the job's token, the upload's does not.
  const s = createHttpArtifactStore({
    resolveBase: async () => plain,
    fetch: (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, Authorization: 'Bearer job-token' } }),
    uploads: 'links',
  })
  const data = new Uint8Array(1000)
  const meta = new TextEncoder().encode('{"key":{}}')

  resetLinks()
  const a = await outcome(() => s.write(handle, 'a.f32', data))
  check('a file → a link with its length, an upload to it, no commit yet', a.value === true && links.asked === 1 && links.uploads.length === 1 && links.uploads[0].length === 1000 && links.commits.length === 0, JSON.stringify({ a, links }))
  check('the upload carries the link\'s headers', links.uploads[0].signed === 'link-1', JSON.stringify(links.uploads[0]))
  check('the upload carries no Authorization (the link is the right)', links.uploads[0].authorization === undefined, String(links.uploads[0].authorization))
  const m = await outcome(() => s.write(handle, 'meta.json', meta))
  const committed = links.commits[0]?.body.files ?? []
  check('meta.json → uploaded, then one commit of both files with their sizes', m.value === true && links.commits.length === 1 && JSON.stringify(committed) === JSON.stringify([{ name: 'a.f32', size: 1000 }, { name: 'meta.json', size: meta.byteLength }]), JSON.stringify({ m, commits: links.commits }))
  check('the commit carries the job\'s token', links.commits[0]?.authorization === 'Bearer job-token', String(links.commits[0]?.authorization))

  resetLinks({ relative: true })
  const relative = await outcome(() => s.write(handle, 'b.f32', data))
  check('a dir link (a path) is resolved against the server', relative.value === true && links.uploads.length === 1, JSON.stringify(relative))

  // The rule for expired links.
  resetLinks({ linkTtlMs: [60_000] })
  const expiring = await outcome(() => s.write(handle, 'c.f32', data))
  check('a link with less than the margin left → a fresh one first, one upload with it', expiring.value === true && links.asked === 2 && links.uploads.length === 1 && links.uploads[0].n === '2', JSON.stringify({ expiring, asked: links.asked, uploads: links.uploads }))
  for (const status of [403, 410]) {
    resetLinks({ upload: [status] })
    const refused = await outcome(() => s.write(handle, 'd.f32', data))
    check(`an upload refused with ${status} → a fresh link, uploaded again`, refused.value === true && links.asked === 2 && links.uploads.length === 2 && links.uploads[1].n === '2', JSON.stringify({ refused, asked: links.asked, uploads: links.uploads }))
  }
  resetLinks({ upload: [403, 403] })
  const twice = await outcome(() => s.write(handle, 'e.f32', data))
  check('refused again with the fresh link → false, no third try', twice.value === false && links.uploads.length === 2, JSON.stringify({ twice, uploads: links.uploads.length }))
  resetLinks({ linkTtlMs: [60_000], upload: [403] })
  const both = await outcome(() => s.write(handle, 'f.f32', data))
  check('fresh after the margin check, then refused → false (asked once only)', both.value === false && links.asked === 2 && links.uploads.length === 1, JSON.stringify({ both, asked: links.asked }))

  // Failures: a refusal is false, a server that does not answer throws.
  resetLinks({ upload: [500] })
  check('an upload answered 500 → unavailable', unavailable(await outcome(() => s.write(handle, 'g.f32', data))))
  resetLinks({ linkStatus: [403] })
  check('write-link refused (403) → false', (await outcome(() => s.write(handle, 'h.f32', data))).value === false)
  resetLinks({ linkStatus: [500] })
  check('write-link 500 → unavailable', unavailable(await outcome(() => s.write(handle, 'h.f32', data))))
  resetLinks({ commit: 409 })
  check('commit refused (409) → false', (await outcome(() => s.write(handle, 'meta.json', meta))).value === false)
  resetLinks({ linkStatus: [507] })
  check('write-link 507 (the store is full) → unavailable', unavailable(await outcome(() => s.write(handle, 'h.f32', data))))

  // A whole artifact: another writer committed it first (409, code
  // "committed"). Already written: true, the rest of its files skipped,
  // no commit.
  const committedFirst = { status: 409, body: '{"error":"the artifact is whole","code":"committed"}' }
  resetLinks({ linkStatus: [committedFirst] })
  const first = await outcome(() => s.write(handle, 'a.f32', data))
  check('write-link 409 "committed" → true, nothing uploaded', first.value === true && links.asked === 1 && links.uploads.length === 0, JSON.stringify({ first, links }))
  const rest = await outcome(() => s.write(handle, 'b.f32', data))
  const last = await outcome(() => s.write(handle, 'meta.json', meta))
  check('the rest of that artifact → true, no link asked, no commit', rest.value === true && last.value === true && links.asked === 1 && links.uploads.length === 0 && links.commits.length === 0, JSON.stringify({ rest, last, links }))
  resetLinks()
  const next = await outcome(() => s.write(handle, 'a.f32', data))
  check('after its meta.json the uid is written as usual again', next.value === true && links.asked === 1 && links.uploads.length === 1, JSON.stringify({ next, links }))
  resetLinks()
  await s.write(handle, 'a.f32', data)
  links.linkStatus.push(committedFirst)
  const midway = await outcome(() => s.write(handle, 'b.f32', data))
  const midMeta = await outcome(() => s.write(handle, 'meta.json', meta))
  check('committed by another writer half-way → true, no commit of our files', midway.value === true && midMeta.value === true && links.commits.length === 0, JSON.stringify({ midway, midMeta, links }))
  // On dir the module's link route refuses a link of a whole artifact (403);
  // the fresh link then answers 409 "committed".
  resetLinks({ upload: [403], linkStatus: [200, committedFirst] })
  const refusedThenWhole = await outcome(() => s.write(handle, 'c.f32', data))
  check('upload 403, then write-link 409 "committed" → true', refusedThenWhole.value === true && links.asked === 2 && links.uploads.length === 1, JSON.stringify({ refusedThenWhole, links }))
  await s.write(handle, 'meta.json', meta)
  resetLinks({ linkStatus: [409] })
  check('write-link 409 without the code (too many files) → false', (await outcome(() => s.write(handle, 'h.f32', data))).value === false)
  resetLinks({ commit: 503 })
  check('commit 503 → unavailable', unavailable(await outcome(() => s.write(handle, 'meta.json', meta))))
}

console.log('\n— the HTTP store: a reservation the server forgot (a restart) —')
{
  // A server that keeps its reservations in memory, as the artifact store
  // does, and forgets them when it "restarts". Its bucket survives.
  const fake = { minted: 0, byKey: new Map(), known: new Set(), bucket: new Map(), resolves: 0, resolveBodies: [], commits: [], uploads: [], putGone: false, restartOn: null }
  const restart = () => { fake.byKey.clear(); fake.known.clear() }
  const reset = () => Object.assign(fake, { minted: 0, byKey: new Map(), known: new Set(), bucket: new Map(), resolves: 0, resolveBodies: [], commits: [], uploads: [], putGone: false, restartOn: null })
  // restartOn: a predicate over the request ('link', 'upload', 'commit' and
  // the file); true restarts the server before it answers.
  const maybeRestart = (what, name) => {
    if (fake.restartOn && fake.restartOn(what, name)) restart()
  }
  const restartable = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const body = Buffer.concat(chunks)
      if (url.pathname === '/v1/artifacts/resolve') {
        fake.resolves++
        const k = JSON.parse(body.toString())
        fake.resolveBodies.push(k)
        const id = `${k.worldId}/${k.pipelineVersion}/${k.stage}`
        let uid = fake.byKey.get(id)
        if (!uid && !k.create) return res.writeHead(404).end()
        if (!uid) {
          uid = `r${++fake.minted}`
          fake.byKey.set(id, uid)
          fake.known.add(uid)
        }
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ artifactUid: uid, files: [] }))
      }
      let m = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/write-link$/)
      if (m && req.method === 'POST') {
        const { name, size } = JSON.parse(body.toString())
        maybeRestart('link', name)
        if (!fake.known.has(m[1])) return res.writeHead(404).end('{"error":"no such artifact"}')
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          method: 'PUT', url: `/bucket/${m[1]}/${name}?len=${size}`, header: {}, expires: new Date(Date.now() + 3_600_000).toISOString(),
        }))
      }
      m = url.pathname.match(/^\/bucket\/([^/]+)\/(.+)$/)
      if (m && req.method === 'PUT') {
        maybeRestart('upload', m[2])
        fake.uploads.push(`${m[1]}/${m[2]}`)
        // A provider stores what a valid link sends, known uid or not; the
        // fake can also answer 404 (putGone).
        if (fake.putGone && !fake.known.has(m[1])) return res.writeHead(404).end()
        fake.bucket.set(`${m[1]}/${m[2]}`, body)
        return res.writeHead(200).end()
      }
      m = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/commit$/)
      if (m && req.method === 'POST') {
        maybeRestart('commit', '')
        if (!fake.known.has(m[1])) return res.writeHead(404).end('{"error":"no such artifact"}')
        fake.commits.push({ uid: m[1], files: JSON.parse(body.toString()).files })
        return res.writeHead(204).end()
      }
      m = url.pathname.match(/^\/v1\/artifacts\/([^/]+)\/(.+)$/)
      if (m && req.method === 'GET') {
        const committed = fake.commits.some((c) => c.uid === m[1] && c.files.some((f) => f.name === m[2]))
        if (!committed) return res.writeHead(404).end()
        return res.writeHead(200).end(fake.bucket.get(`${m[1]}/${m[2]}`))
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((done) => restartable.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${restartable.address().port}/v1`
  // A store per case: the fake's uids start again at r1 with each reset.
  const linked = () => createHttpArtifactStore({ resolveBase: async () => base, uploads: 'links' })
  let s = linked()
  const a = new Uint8Array(100).fill(1)
  const b = new Uint8Array(200).fill(2)
  const meta = new TextEncoder().encode('{"key":{}}')
  const names = (commit) => (commit?.files ?? []).map((f) => `${f.name}:${f.size}`).join(',')
  const whole = `a.f32:100,b.f32:200,meta.json:${meta.byteLength}`
  // The worker's write of one artifact: resolve with create, files, meta last.
  const writeAll = async (store, k) => {
    const h = await store.resolve(k, true)
    const done = []
    for (const [name, bytes] of [['a.f32', a], ['b.f32', b], ['meta.json', meta]]) done.push(await store.write(h, name, bytes))
    return { h, done }
  }

  reset()
  {
    // The key is the content only (DEC-0039); the world the store works
    // for goes with the resolve beside it, for a server in the local mode.
    const forWorld = createHttpArtifactStore({ resolveBase: async () => base, uploads: 'links', world: 'world-uid' })
    await forWorld.resolve(artifactKey('w0', 'v1', '1'), true)
    await s.resolve(artifactKey('w0', 'v1', '1'), false)
    const [withWorld, without] = fake.resolveBodies
    check('a resolve sends the key and the store\'s world, no world uid in the key',
      withWorld?.world === 'world-uid' && withWorld.worldId === 'w0' && !('worldUid' in withWorld) && without && !('world' in without),
      JSON.stringify(fake.resolveBodies))
  }

  reset()
  fake.restartOn = (what, name) => what === 'link' && name === 'b.f32' && fake.minted === 1
  const k1 = artifactKey('w1', 'v1', '1')
  const lost = await outcome(() => writeAll(s, k1))
  check('a restart between two files → resolved again, the artifact again from its first file, committed whole under the fresh uid',
    lost.value?.done.every(Boolean) && fake.resolves === 2 && fake.commits.length === 1 && fake.commits[0].uid === 'r2' && names(fake.commits[0]) === whole,
    JSON.stringify({ lost, resolves: fake.resolves, commits: fake.commits }))
  check('the upload again starts at the first file', JSON.stringify(fake.uploads) === JSON.stringify(['r1/a.f32', 'r2/a.f32', 'r2/b.f32', 'r2/meta.json']), JSON.stringify(fake.uploads))
  const back = await outcome(() => s.read(lost.value.h, 'meta.json'))
  check('a read with the old handle goes to the fresh uid', back.value?.byteLength === meta.byteLength, String(back.error ?? back.value))

  reset()
  s = linked()
  fake.restartOn = (what) => what === 'commit' && fake.minted === 1
  const atCommit = await outcome(() => writeAll(s, artifactKey('w2', 'v1', '1')))
  check('a restart before the commit → the commit answers 404 → every file again, then the commit',
    atCommit.value?.done.every(Boolean) && fake.commits.length === 1 && fake.commits[0].uid === 'r2' && names(fake.commits[0]) === whole && fake.uploads.filter((u) => u.startsWith('r2/')).length === 3,
    JSON.stringify({ atCommit, commits: fake.commits, uploads: fake.uploads }))

  reset()
  s = linked()
  fake.putGone = true
  fake.restartOn = (what, name) => what === 'upload' && name === 'b.f32' && fake.minted === 1
  const atUpload = await outcome(() => writeAll(s, artifactKey('w3', 'v1', '1')))
  check('an upload answered 404 → the same, under a fresh uid',
    atUpload.value?.done.every(Boolean) && fake.commits.length === 1 && fake.commits[0].uid === 'r2' && names(fake.commits[0]) === whole,
    JSON.stringify({ atUpload, commits: fake.commits, uploads: fake.uploads }))

  reset()
  s = linked()
  // Restarts again while the artifact is uploaded again.
  fake.restartOn = (what, name) => what === 'link' && name === 'b.f32'
  const twice = await outcome(() => writeAll(s, artifactKey('w4', 'v1', '1')))
  check('a 404 again under the fresh uid → unavailable (the task is given back)', unavailable(twice) && twice.error.status === 404 && fake.resolves === 2, String(twice.error ?? JSON.stringify(twice.value)))
  fake.restartOn = null
  fake.commits = []
  const after = await outcome(() => writeAll(s, artifactKey('w5', 'v1', '1')))
  check('the next artifact commits its own files only (the broken-off upload is let go)',
    after.value?.done.every(Boolean) && fake.commits.length === 1 && names(fake.commits[0]) === whole,
    JSON.stringify({ after, commits: fake.commits }))

  reset()
  s = linked()
  const resolvesBefore = fake.resolves
  const read = await outcome(() => s.read({ key: k1, remote: 'r9', files: [] }, 'meta.json'))
  check('a read\'s 404 stays absent: null, no resolve again', read.value === null && fake.resolves === resolvesBefore, String(read.error ?? read.value))

  restartable.close()
}

console.log('\n— the HTTP store: no answer at all —')
for (const [name, base] of [['a TLS handshake that fails', tls], ['a refused connection', refused]]) {
  const s = store(base)
  const r = await outcome(() => s.resolve(key, false))
  check(`resolve, ${name} → unavailable`, unavailable(r), String(r.error ?? JSON.stringify(r.value)))
  const d = await outcome(() => s.read(handle, 'meta.json'))
  check(`read, ${name} → unavailable`, unavailable(d), String(d.error ?? d.value))
  const w = await outcome(() => s.write(handle, 'meta.json', bytes))
  check(`write, ${name} → unavailable`, unavailable(w), String(w.error ?? w.value))
}
{
  const s = createHttpArtifactStore({ resolveBase: async () => null })
  check('no server configured → null, not an error', (await outcome(() => s.resolve(key, false))).value === null)
}

console.log('\n— the tiered store (the browser): unavailable is a miss —')
{
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on('unhandledRejection', onRejection)
  const warn = console.warn
  const warnings = []
  console.warn = (...args) => {
    warnings.push(args)
  }
  try {
    for (const [name, base] of [['500', plain], ['TLS', tls], ['refused', refused]]) {
      Object.assign(answers, { resolve: 500, file: 500, put: 500 })
      const local = createMemoryArtifactStore()
      const tiered = createTieredArtifactStore(local, store(base), { remoteAvailable: async () => true })
      const none = await outcome(() => tiered.resolve(key, false))
      check(`${name}: resolve with nothing local → null`, none.value === null && !none.error, String(none.error))
      const made = await outcome(() => tiered.resolve(key, true))
      check(`${name}: resolve with create → the local handle`, Boolean(made.value?.local) && !made.value?.remote, String(made.error))
      const h = made.value
      const stored = await outcome(() => tiered.write(h, 'meta.json', bytes))
      check(`${name}: write → stored locally`, stored.value === true, String(stored.error))
      const back = await outcome(() => tiered.read(h, 'meta.json'))
      check(`${name}: read → the local bytes`, back.value?.byteLength === 3, String(back.error))
      const remoteOnly = await outcome(() => tiered.read({ key, remote: 'u1', files: [] }, 'meta.json'))
      check(`${name}: read of a remote-only handle → null`, remoteOnly.value === null && !remoteOnly.error, String(remoteOnly.error))
      // The browser does not upload (DEC-0039): a write to a handle the
      // server knows stays local, and asks the server nothing.
      const before = warnings.length
      const kept = await outcome(() => tiered.write({ ...h, remote: 'u1' }, 'meta.json', bytes))
      check(`${name}: a write with a remote handle → local only`, kept.value === true && warnings.length === before, String(kept.error))
    }
  } finally {
    console.warn = warn
    process.off('unhandledRejection', onRejection)
  }
  check('no unhandled rejection', rejections.length === 0, String(rejections[0]))
  // Per store: the resolve (said once, though called twice), the read of
  // the remote-only handle.
  const said = warnings.map((args) => String(args[0]).match(/server's (\w+) failed/)?.[1]).join(',')
  check('each failure is said on the console, once per call kind and store', said === Array(3).fill('resolve,read').join(','), said)
}

console.log('\n— the job worker reads its world: only 404 is absent —')
{
  const world = (base) => ({ worldUrl: `${base}/artifacts/u1/world.zip` })
  const plainFetch = (input, init) => fetch(input, init)
  answers.file = 200
  const read = await outcome(() => readWorld(world(plain), plainFetch))
  check('200 → the archive', read.value?.archive?.byteLength === 11, String(read.error))
  answers.file = 404
  const absent = await outcome(() => readWorld(world(plain), plainFetch))
  check('404 → null (no such world: the task fails)', absent.value === null, String(absent.error))
  const worldUnavailable = (o) => o.error instanceof WorldUnavailableError
  for (const status of [500, 503]) {
    answers.file = status
    const o = await outcome(() => readWorld(world(plain), plainFetch))
    check(`${status} → unavailable (the task is given back)`, worldUnavailable(o), String(o.error ?? JSON.stringify(o.value)))
  }
  for (const status of [400, 401, 403]) {
    answers.file = status
    const o = await outcome(() => readWorld(world(plain), plainFetch))
    check(`${status} → refused (the task fails at once)`, o.error instanceof WorldRefusedError && !worldUnavailable(o), String(o.error ?? JSON.stringify(o.value)))
  }
  for (const [name, base] of [['a TLS handshake that fails', tls], ['a refused connection', refused]]) {
    const o = await outcome(() => readWorld(world(base), plainFetch))
    check(`${name} → unavailable`, worldUnavailable(o), String(o.error ?? JSON.stringify(o.value)))
  }
  check('a missing file → null', (await outcome(() => readWorld({ worldZip: '/nonexistent/world.zip' }, plainFetch))).value === null)
}

console.log('\n— the job worker reads its world by link: the 302, its ETag, the 304 —')
{
  // A world server (the API) and a bucket on another origin. The API answers
  // 304 for the held revision, else 302 to the link with the revision as
  // the ETag of the 302 (internal/modules/world, handleGet); the bucket
  // answers the bytes with an ETag of its own, as S3 does (an MD5).
  const seen = { api: [], bucket: [] }
  const world = { revision: 2, link: 200, absolute: true }
  const bucket = createServer((req, res) => {
    seen.bucket.push({ path: req.url, authorization: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] })
    if (world.link !== 200) return res.writeHead(world.link).end()
    res.writeHead(200, { ETag: '"0cc175b9c0f1b6a831c399e269772661"' }).end('zip-bytes')
  })
  await new Promise((done) => bucket.listen(0, '127.0.0.1', done))
  const bucketBase = `http://127.0.0.1:${bucket.address().port}`
  const api = createServer((req, res) => {
    seen.api.push({ path: req.url, authorization: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] })
    const etag = `"${world.revision}"`
    if (req.url === '/v1/worlds/w1') {
      if (req.headers['if-none-match'] === etag) return res.writeHead(304, { ETag: etag }).end()
      const link = `/link/w1/rev/${world.revision}/world.zip?sig=s`
      return res.writeHead(302, { ETag: etag, Location: world.absolute ? bucketBase + link : link, 'Cache-Control': 'no-store' }).end()
    }
    if (req.url.startsWith('/link/')) {
      // The dir backend's own link, on the API's origin.
      seen.bucket.push({ path: req.url, authorization: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] })
      return res.writeHead(world.link, {}).end(world.link === 200 ? 'zip-bytes' : '')
    }
    res.writeHead(404).end()
  })
  await new Promise((done) => api.listen(0, '127.0.0.1', done))
  const job = { worldUrl: `http://127.0.0.1:${api.address().port}/v1/worlds/w1`, authToken: 'job-token' }
  // As jobWorker.ts's authorizedFetch: the job token on every request it sends.
  const authorized = (input, init = {}) => fetch(input, { ...init, headers: { ...init.headers, Authorization: `Bearer ${job.authToken}` } })
  const reset = () => { seen.api.length = 0; seen.bucket.length = 0 }

  for (const absolute of [true, false]) {
    const where = absolute ? 's3 (another origin)' : 'dir (the same origin)'
    Object.assign(world, { revision: 2, link: 200, absolute })
    reset()
    const first = await outcome(() => readWorld(job, authorized))
    check(`${where}: 302 → the link → the archive`, first.value?.archive && new TextDecoder().decode(first.value.archive) === 'zip-bytes', String(first.error ?? JSON.stringify(first.value)))
    check(`${where}: the etag is the 302's revision, not the bucket's`, first.value?.etag === '"2"', String(first.value?.etag))
    check(`${where}: the link is read without the job token and without If-None-Match`, seen.bucket.length === 1 && !seen.bucket[0].authorization && !seen.bucket[0].ifNoneMatch, JSON.stringify(seen.bucket))
    check(`${where}: the API got the job token`, seen.api[0]?.authorization === 'Bearer job-token', JSON.stringify(seen.api))
    reset()
    const again = await outcome(() => readWorld(job, authorized, first.value?.etag))
    check(`${where}: the held revision → 304 → unchanged, no link read`, again.value === 'unchanged' && seen.bucket.length === 0, JSON.stringify({ again, seen }))
    world.revision = 3
    reset()
    const newer = await outcome(() => readWorld(job, authorized, '"2"'))
    check(`${where}: a newer revision → 302 → the archive with its etag`, newer.value?.etag === '"3"' && seen.bucket.length === 1, String(newer.error ?? JSON.stringify(newer.value)))
    for (const status of [404, 403, 410, 500]) {
      world.link = status
      const failed = await outcome(() => readWorld(job, authorized))
      check(`${where}: the link answers ${status} → unavailable (the task is given back)`, failed.error instanceof WorldUnavailableError, String(failed.error ?? JSON.stringify(failed.value)))
    }
  }
  api.close()
  bucket.close()
}

console.log('\n— the browser creates a world: a 409 for a world that is this save —')
{
  // A world server whose creation may have stored the world without the
  // client knowing (a lost answer, a 500 for a meta it could not confirm):
  // the next create answers 409. Its meta says what it holds.
  const bytesOfSave = 'zip-bytes of this save'
  const archive = new Blob([new TextEncoder().encode(bytesOfSave)])
  const ours = createHash('sha256').update(bytesOfSave).digest('hex')
  const fake = { putStatus: [], put: [], held: null, level: 'owner' }
  const worlds = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const m = req.url.match(/^\/v1\/worlds\/([^/]+)(\/meta)?$/)
      if (m && !m[2] && req.method === 'PUT') {
        fake.put.push(req.headers['if-match'] ?? null)
        return res.writeHead(fake.putStatus.shift() ?? 409, { 'Content-Type': 'application/json' }).end('{"error":"x"}')
      }
      if (m && m[2] && fake.held) {
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...fake.held, uid: m[1], actions: fake.level === 'viewer' ? ['world.read'] : ['world.read', 'world.write'] }))
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((done) => worlds.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${worlds.address().port}/v1`
  const send = (input, init) => fetch(input, init)
  // The browser's localStorage, where the revision is remembered.
  const remembered = new Map()
  globalThis.localStorage = { getItem: (k) => remembered.get(k) ?? null, setItem: (k, v) => remembered.set(k, String(v)), removeItem: (k) => remembered.delete(k) }
  const held = (contentHash) => ({ revision: 3, updatedAt: '2026-10-16T12:00:00Z', contentHash })

  Object.assign(fake, { putStatus: [500, 409], put: [], held: held(ours), level: 'owner' })
  const first = await outcome(() => uploadWorldTo(base, 'w1', archive, send))
  check('a create answered 500 → rejected, as before', first.value?.ok === false && first.value.reason === 'rejected', JSON.stringify(first))
  const again = await outcome(() => uploadWorldTo(base, 'w1', archive, send))
  check('the retry (a create) answered 409, the meta holds this archive → stored, with its revision', again.value?.ok === true && again.value.revision === 3 && fake.put.length === 2 && fake.put.every((h) => h === null), JSON.stringify({ again, put: fake.put }))
  check('and the revision is remembered: the next save is an update', remembered.get('casas.serverRevision.w1') === '3', JSON.stringify([...remembered]))
  const cases = [['another content', { held: held('0'.repeat(64)) }], ['a viewer only', { level: 'viewer' }], ['no content hash', { held: held('') }], ['no meta', { held: null }]]
  for (const [i, [name, change]] of cases.entries()) {
    Object.assign(fake, { putStatus: [409], put: [], held: held(ours), level: 'owner' }, change)
    const o = await outcome(() => uploadWorldTo(base, `c${i}`, archive, send))
    const revision = fake.held ? 3 : undefined
    check(`409, ${name} → the conflict, as before`, o.value?.ok === false && o.value.reason === 'conflict' && o.value.serverRevision === revision, JSON.stringify(o))
  }
  // A stale update (412) stays a conflict, even for the same bytes: the
  // server dedupes an identical update itself.
  Object.assign(fake, { putStatus: [412], put: [], held: held(ours), level: 'owner' })
  const stale = await outcome(() => uploadWorldTo(base, 'w1', archive, send))
  check('412 on an update → the conflict, not "stored"', stale.value?.ok === false && stale.value.reason === 'conflict' && fake.put[0] === '"3"', JSON.stringify({ stale, put: fake.put }))
  delete globalThis.localStorage
  worlds.close()
}

server.close()
console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)

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
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import { resolve } from './tsResolve.mjs'

registerHooks({ resolve })
const { createHttpArtifactStore } = await import('../src/storage/HttpArtifactStore.ts')
const { createTieredArtifactStore } = await import('../src/storage/TieredArtifactStore.ts')
const { createMemoryArtifactStore } = await import('../src/storage/MemoryArtifactStore.ts')
const { ArtifactStoreUnavailableError, artifactKey } = await import('../src/storage/ArtifactStore.ts')

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

// The server's answer per route, set by each case.
const answers = { resolve: 200, file: 200, put: 204 }
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/v1/artifacts/resolve') {
      if (answers.resolve !== 200) return res.writeHead(answers.resolve).end('{"error":"x"}')
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ artifactUid: 'u1', files: ['meta.json'] }))
    }
    if (url.pathname === '/v1/artifacts/blob/u1/meta.json') {
      // The link a read is redirected to (the dir backend's own links).
      if (answers.file === 'gone') return res.writeHead(404).end()
      return res.writeHead(200).end('{"ok":true}')
    }
    if (url.pathname.startsWith('/v1/artifacts/u1/')) {
      if (req.method === 'PUT') return res.writeHead(answers.put).end()
      if (answers.file === 'redirect' || answers.file === 'gone') return res.writeHead(302, { Location: '/v1/artifacts/blob/u1/meta.json' }).end()
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

const key = artifactKey('uid', 'world', 'v1', '1')
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
  answers.resolve = 401
  check('resolve 401 → unavailable, not absent', unavailable(await outcome(() => s.resolve(key, false))))

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

  const wrote = await outcome(() => s.write(handle, 'meta.json', bytes))
  check('write 204 → true', wrote.value === true, String(wrote.error))
  answers.put = 403
  const refusedWrite = await outcome(() => s.write(handle, 'meta.json', bytes))
  check('write 403 → false (a refusal, as before)', refusedWrite.value === false, String(refusedWrite.error))
  answers.put = 500
  check('write 500 → unavailable', unavailable(await outcome(() => s.write(handle, 'meta.json', bytes))))
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
  console.warn = (...args) => warnings.push(args)
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
      // The remote write is not awaited; give it its moment to fail.
      await tiered.write({ ...h, remote: 'u1' }, 'meta.json', bytes)
      await new Promise((done) => setTimeout(done, 200))
    }
  } finally {
    console.warn = warn
    process.off('unhandledRejection', onRejection)
  }
  check('no unhandled rejection from the background upload', rejections.length === 0, String(rejections[0]))
  check('each failure is said on the console, once per call kind and store', warnings.length > 0 && warnings.length <= 9, `${warnings.length} warnings`)
}

server.close()
console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)

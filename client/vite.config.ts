import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Where the Go server lives during development. Overridable so a dev client can
// point at a real deployment without touching this file; the default matches
// `casas-eternas start`'s own default listen address.
const API = process.env.CASAS_API ?? 'http://localhost:8080'

// The build's provenance (see src/app/buildVersion.ts): the commit this build
// was made from, with -dirty when the tree had local changes. Resolved here at
// config load so a production bundle carries a real value; anything loading
// the modules without vite's define step (the Node harnesses) falls back to
// the declared 'dev'.
const BUILD = (() => {
  try {
    return execSync('git describe --always --dirty', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
})()

// WebKit loses a response's Cross-Origin-Embedder-Policy when it answers from
// its own cache: the check runs against the 304, which carries no such header,
// so the module is refused with "Refused to load ... because of
// Cross-Origin-Embedder-Policy" (WebKit bug 245346). The generator dies with
// it — its workers load their modules exactly that way — and the map stays
// white. It is a RELOAD failure: the first load is a 200 and works, the next
// one revalidates and does not, which is why restarting the dev server (fresh
// ETags) looked like a cure.
//
// Dropping the validators from the REQUEST makes the dev server answer 200
// every time, so there is no cache hit to lose the header on. It costs a few
// hundred kilobytes per reload and nothing else. The built app does not need
// this: its worker modules are fingerprinted files under /assets/, served
// immutable, which a browser reads from cache without revalidating at all.
const alwaysFullResponses = (): Plugin => ({
  name: 'casas-always-full-responses',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      delete req.headers['if-none-match']
      delete req.headers['if-modified-since']
      next()
    })
  },
})

// THE GENERATOR'S CODE as a hash (`virtual:generator-code`, read by
// src/app/generatorCode.ts): every source file under src/generator plus the
// mapping from recorded values to run parameters (src/world/runParams.ts),
// paths and contents. A world's history records it per run, and a replay of
// the history (docs/decisions/detail-ladder.md, fork 2) runs only where it
// matches — the build string above is provenance and may not be compared.
// Computed when the module is asked for and again after a change under
// those paths, so a dev session's edits are in it; `git describe` is fixed
// when the server starts.
const GENERATOR_CODE_ROOTS = ['src/generator', 'src/world/runParams.ts']
const generatorCodeHash = (root: string): string => {
  const files: string[] = []
  const walk = (path: string): void => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      files.push(path)
      return
    }
    for (const entry of entries) walk(join(path, entry.name))
  }
  for (const entry of GENERATOR_CODE_ROOTS) walk(join(root, entry))
  const hash = createHash('sha256')
  for (const file of files.filter((f) => /\.(ts|json)$/.test(f)).sort()) {
    hash.update(relative(root, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
const generatorCode = (): Plugin => {
  const id = 'virtual:generator-code'
  const resolved = `\0${id}`
  let root = process.cwd()
  return {
    name: 'casas-generator-code',
    configResolved(config) {
      root = config.root
    },
    resolveId(source) {
      return source === id ? resolved : null
    },
    load(source) {
      return source === resolved ? `export default ${JSON.stringify(generatorCodeHash(root))}` : null
    },
    configureServer(server) {
      server.watcher.on('change', (file) => {
        if (!GENERATOR_CODE_ROOTS.some((entry) => file.startsWith(join(root, entry)))) return
        const module = server.moduleGraph.getModuleById(resolved)
        if (module) server.moduleGraph.invalidateModule(module)
      })
    },
  }
}

// The dev server's port is PINNED, and that is not cosmetic: browser storage
// (OPFS, IndexedDB, caches) is scoped to the ORIGIN, port included. Vite's
// default behaviour is to take 5173 and silently increment when it is busy —
// and a different port is a different origin, so the artifact cache
// (docs/design/server-storage.md) would come up empty with no error, on a
// machine where it demonstrably worked yesterday. strictPort turns that
// silent drift into a loud "port already in use", which is the failure mode
// one can actually debug.
export default defineConfig({
  plugins: [alwaysFullResponses(), generatorCode()],
  define: {
    __CASAS_BUILD__: JSON.stringify(BUILD),
  },
  server: {
    port: 5173,
    strictPort: true,
    // Cross-origin isolation, so the page may use SharedArrayBuffer (the
    // erosion engine's worker pool). The Go client module sets the same pair
    // on the built app — change the two together. Everything the client
    // fetches goes through the same-origin proxy below, so require-corp
    // forbids nothing this app actually does.
    //
    // CORP says the same thing about our own responses: nothing here is meant
    // for another origin. It is not what made the generator's workers load in
    // WebKit — see the plugin above for that.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
    // Development runs the SAME code path as production rather than a special
    // case: the client always asks its own origin for /config.json and /v1,
    // and here vite forwards both to the Go server. Nothing in the app knows
    // whether it is being developed or deployed, and CORS never enters the
    // picture in either.
    //
    // With no server running these simply fail, which is a first-class state —
    // worldgen work must not require a backend, so the client falls back to
    // browser-local storage exactly as it did before any of this existed.
    proxy: {
      '/config.json': { target: API, changeOrigin: true },
      '/v1': { target: API, changeOrigin: true },
      '/docs': { target: API, changeOrigin: true },
    },
  },
})

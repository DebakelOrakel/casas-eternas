import { defineConfig } from 'vite'
import { execSync } from 'node:child_process'

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

// The dev server's port is PINNED, and that is not cosmetic: browser storage
// (OPFS, IndexedDB, caches) is scoped to the ORIGIN, port included. Vite's
// default behaviour is to take 5173 and silently increment when it is busy —
// and a different port is a different origin, so the artifact cache
// (docs/design/server-storage.md) would come up empty with no error, on a
// machine where it demonstrably worked yesterday. strictPort turns that
// silent drift into a loud "port already in use", which is the failure mode
// one can actually debug.
export default defineConfig({
  define: {
    __CASAS_BUILD__: JSON.stringify(BUILD),
  },
  server: {
    port: 5173,
    strictPort: true,
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
    },
  },
})

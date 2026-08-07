import { defineConfig } from 'vite'

// The dev server's port is PINNED, and that is not cosmetic: browser storage
// (OPFS, IndexedDB, caches) is scoped to the ORIGIN, port included. Vite's
// default behaviour is to take 5173 and silently increment when it is busy —
// and a different port is a different origin, so the artifact cache
// (docs/design/server-storage.md) would come up empty with no error, on a
// machine where it demonstrably worked yesterday. strictPort turns that
// silent drift into a loud "port already in use", which is the failure mode
// one can actually debug.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
})

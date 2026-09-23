// A worker_threads host for the erosion engine's pool worker under plain
// node — the mesh harness's pooled-parity gate spawns it. The engine's
// modules use extensionless imports node will not resolve, so the host
// registers tsResolve.mjs and then imports the TypeScript worker entry
// directly (node strips the types itself). The pool's init message waits
// in the port until the entry has attached its listener; the entry
// answers 'ready' exactly as it does in the browser or under tsx.
//
// Not Vite: a Vite server inside a worker thread loads the entry too, but
// the thread then never terminates (native handles the server holds keep
// `worker.terminate()` from resolving — measured 2026-09-23), and the
// pool's close() waits on exactly that.
import { registerHooks } from 'node:module'
import { resolve } from './tsResolve.mjs'

registerHooks({ resolve })
await import('../src/generator/surface/erosionEngineWorker.ts')

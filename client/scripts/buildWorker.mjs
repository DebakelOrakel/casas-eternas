import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The job worker's bundle (`npm run build:worker`, `make worker`):
// scripts/jobWorker.ts for Node, beside the server binary. A script, so the
// esbuild call is one place for `npm run build:worker` and `make worker`.
//
//   node scripts/buildWorker.mjs [outfile]   default ../job-worker.mjs, beside
//                                            the server; another path leaves a
//                                            running server's bundle alone
const client = join(fileURLToPath(import.meta.url), '..', '..')
const outfile = process.argv[2] ?? '../job-worker.mjs'
const result = spawnSync('npx', [
  'esbuild', 'scripts/jobWorker.ts',
  '--bundle', '--platform=node', '--format=esm', '--target=node20',
  `--outfile=${outfile}`, '--log-level=warning',
  // Bundled CommonJS dependencies call require(); an ESM bundle has none.
  "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
], { cwd: client, stdio: 'inherit' })
process.exit(result.status ?? 1)

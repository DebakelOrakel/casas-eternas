import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The job worker's bundles (`npm run build:worker`, `make worker`), for
// Node, beside the server binary. A script, so the esbuild calls are one
// place for `npm run build:worker` and `make worker`.
//
//   node scripts/buildWorker.mjs [outfile]   default ../job-worker.mjs, beside
//                                            the server; another path leaves a
//                                            running server's bundle alone
//
// Three bundles (scripts/workerContract.ts): the host, scripts/jobWorker.ts →
// <outfile>, and the pipeline module, scripts/workerPipeline.ts →
// pipeline.mjs beside it, which the host loads. The engine's native build
// goes beside them as casas-engine.node, where the pipeline module loads
// it: engine/dist's, which `make engine` writes. The incubator's module,
// scripts/incubatorPipeline.ts → incubator.mjs, the route of the incubator's
// histories, with the incubator's native build beside it as
// casas-incubator.node.
const client = join(fileURLToPath(import.meta.url), '..', '..')
const outfile = process.argv[2] ?? '../job-worker.mjs'
const outdir = dirname(resolve(client, outfile))
const bundle = (entry, out, extra = []) => {
  const result = spawnSync('npx', [
    'esbuild', entry,
    '--bundle', '--platform=node', '--format=esm', '--target=node20',
    `--outfile=${out}`, '--log-level=warning',
    // Bundled CommonJS dependencies call require(); an ESM bundle has none.
    "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    ...extra,
  ], { cwd: client, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
bundle('scripts/jobWorker.ts', outfile)
// The engine's constants for the pipeline versions
// (generator/pipeline/engineConstants.ts).
bundle('scripts/workerPipeline.ts', join(outdir, 'pipeline.mjs'), ['--alias:casas-engine-constants=../engine/dist/constants.json'])
bundle('scripts/incubatorPipeline.ts', join(outdir, 'incubator.mjs'), ['--alias:casas-engine-constants=../engine/dist/constants.json', '--alias:casas-incubator-wasm=../engine/dist/incubator'])
for (const name of ['casas-engine.node', 'casas-incubator.node']) {
  const build = join(client, '..', 'engine', 'dist', name)
  if (!existsSync(build)) {
    console.error(`${build} is not there: run \`make engine\` first`)
    process.exit(1)
  }
  copyFileSync(build, join(outdir, name))
}

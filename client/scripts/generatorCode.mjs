import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// THE GENERATOR'S CODE as a hash: every source file under src/generator
// plus the mapping from recorded values to run parameters
// (src/world/runParams.ts), paths and contents. A world's history records
// it per run, and a replay of the history (docs/decisions/detail-ladder.md,
// fork 2) runs only where it matches — the build string is provenance and
// may not be compared.
//
// One function for its two readers: vite.config.ts (`virtual:generator-code`,
// the app) and scripts/buildWorker.mjs (the job worker's bundle). Two copies
// would let the app and the worker disagree about the same code, and the
// worker would then refuse every world.
//
//   node scripts/generatorCode.mjs   prints the hash of this checkout

export const GENERATOR_CODE_ROOTS = ['src/generator', 'src/world/runParams.ts']

// `root` is the client directory.
export function generatorCodeHash(root) {
  const files = []
  const walk = (path) => {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(generatorCodeHash(join(fileURLToPath(import.meta.url), '..', '..')))
}

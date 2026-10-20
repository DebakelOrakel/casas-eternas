// Loads both builds from engine/dist/ and checks that they answer the same.
// Run by `make test` after `make engine`.
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const native = createRequire(import.meta.url)(new URL('casas-engine.node', dist).pathname)
const { instance } = await WebAssembly.instantiate(await readFile(new URL('casas-engine.wasm', dist)))
const wasm = instance.exports
const wasmVersion = new TextDecoder().decode(
  new Uint8Array(wasm.memory.buffer, wasm.version_ptr(), wasm.version_len()),
)

if (native.version() !== wasmVersion) {
  console.error(`engine: native ${native.version()} and wasm ${wasmVersion} differ`)
  process.exit(1)
}
console.log(`engine: native and wasm ${wasmVersion}`)

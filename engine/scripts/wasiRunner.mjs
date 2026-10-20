// Runs a wasm32-wasip1 program under Node's WASI: the cargo runner of the
// engine's WASM tests (docs/decisions/rust-engine.md, fork 4).
//
//   node engine/scripts/wasiRunner.mjs <program.wasm> [args…]
//
// The tests read their fixtures from the binary (include_str!), so the
// program needs no file system.

import { readFile } from 'node:fs/promises'
import { WASI } from 'node:wasi'

const [program, ...args] = process.argv.slice(2)
const wasi = new WASI({ version: 'preview1', args: [program, ...args], env: process.env, returnOnExit: true })
const module = await WebAssembly.compile(await readFile(program))
const instance = await WebAssembly.instantiate(module, wasi.getImportObject())
process.exitCode = wasi.start(instance)

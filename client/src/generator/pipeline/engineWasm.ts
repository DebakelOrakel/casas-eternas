// The Rust engine's WASM build in the browser (docs/decisions/rust-engine.md,
// fork 3: level 0 runs here), loaded once per worker. The build is not in
// the repository: `make engine` writes it to engine/dist/wasm, and the
// client's build needs it from the switch on, when the runtime imports this.
import init, { version, forcingOfSnapshot, levelFiles, tileFiles, riverGraphParts, levelOfFiles, tileOfFiles, World, Replay, Preview } from 'casas-engine-wasm/casas-engine.js'
import wasmUrl from 'casas-engine-wasm/casas-engine_bg.wasm?url'
import type { Engine } from './engine'

let loading: Promise<Engine> | null = null

export function loadWasmEngine(): Promise<Engine> {
  loading ??= init({ module_or_path: wasmUrl }).then(() => ({ version, forcingOfSnapshot, levelFiles, tileFiles, riverGraphParts, levelOfFiles, tileOfFiles, World, Replay, Preview }))
  return loading
}

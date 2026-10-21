// Modules vite.config.ts makes or names.
declare module 'virtual:handbook' {
  const handbook: import('../ui/handbook/handbookTypes').Handbook
  export default handbook
}

// The Rust engine's WASM build (`make engine` writes it to engine/dist/wasm;
// vite.config.ts's alias `casas-engine-wasm` names that directory), with the
// classes the adapter types (generator/pipeline/engine.ts).
declare module 'casas-engine-wasm/casas-engine.js' {
  const init: (options: { module_or_path: string }) => Promise<unknown>
  export default init
  export const version: import('../generator/pipeline/engine').Engine['version']
  export const World: import('../generator/pipeline/engine').EngineWorlds
  export const Replay: import('../generator/pipeline/engine').Engine['Replay']
  export const Preview: import('../generator/pipeline/engine').Engine['Preview']
}

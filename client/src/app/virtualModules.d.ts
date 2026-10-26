// Modules vite.config.ts makes or names.
declare module 'virtual:handbook' {
  const handbook: import('../ui/handbook/handbookTypes').Handbook
  export default handbook
}

// The engine's constants for the pipeline versions (`make engine` writes
// engine/dist/constants.json; world/engineConstants.ts).
declare module 'casas-engine-constants' {
  const constants: {
    // The history's tuning by group, nested as the objects are.
    tuning: Record<string, unknown>
    amplify: Record<string, number>
    bake: Record<string, number>
    // Each tile level's cube and tile constants, by level.
    tiles: Record<string, Record<string, number>>
    levelBudget: Record<string, number>
  }
  export default constants
}

// The Rust engine's WASM build (`make engine` writes it to engine/dist/wasm;
// vite.config.ts's alias `casas-engine-wasm` names that directory), with the
// classes the adapter types (generator/pipeline/engine.ts).
declare module 'casas-engine-wasm/casas-engine.js' {
  const init: (options: { module_or_path: string }) => Promise<unknown>
  export default init
  export const version: import('../generator/pipeline/engine').Engine['version']
  export const forcingOfSnapshot: import('../generator/pipeline/engine').Engine['forcingOfSnapshot']
  export const levelFiles: import('../generator/pipeline/engine').Engine['levelFiles']
  export const tileFiles: import('../generator/pipeline/engine').Engine['tileFiles']
  export const riverGraphParts: import('../generator/pipeline/engine').Engine['riverGraphParts']
  export const levelOfFiles: import('../generator/pipeline/engine').Engine['levelOfFiles']
  export const tileOfFiles: import('../generator/pipeline/engine').Engine['tileOfFiles']
  export const World: import('../generator/pipeline/engine').EngineWorlds
  export const Replay: import('../generator/pipeline/engine').Engine['Replay']
  export const Preview: import('../generator/pipeline/engine').Engine['Preview']
}

// The incubator's catalogs, data shared with the history's crate
// (engine/crates/casas-history/data; vite.config.ts's alias
// `casas-history-data`).
declare module 'casas-history-data/catalog.json' {
  const catalog: {
    plants: readonly import('../screens/incubator/plants').PlantSpec[]
    trees: readonly import('../screens/incubator/trees').TreeSpec[]
    animals: readonly import('../screens/incubator/animals').AnimalSpec[]
    // The herbivores' share of a biome's production, by the biome's name.
    edibleShare: Record<string, number>
  }
  export default catalog
}

// The history's version (`make engine` writes engine/dist/history/
// version.json from the crate's HISTORY_VERSION).
declare module 'casas-history-wasm/version.json' {
  const version: { version: string }
  export default version
}

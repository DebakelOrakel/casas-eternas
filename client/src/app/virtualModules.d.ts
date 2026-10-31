// Modules vite.config.ts makes or names.
declare module 'virtual:handbook' {
  const handbook: import('../ui/handbook/handbookTypes').Handbook
  export default handbook
}

// The engine's constants for the pipeline versions (`make engine` writes
// engine/dist/constants.json; generator/pipeline/engineConstants.ts).
declare module 'casas-generator-constants' {
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
// vite.config.ts's alias `casas-generator-wasm` names that directory), with the
// classes the adapter types (generator/pipeline/engine.ts).
declare module 'casas-generator-wasm/casas-generator.js' {
  const init: (options: { module_or_path: string }) => Promise<unknown>
  export default init
  export const version: import('../generator/pipeline/engine').Engine['version']
  export const forcingOfSnapshot: import('../generator/pipeline/engine').Engine['forcingOfSnapshot']
  export const volcanoesOfSnapshot: import('../generator/pipeline/engine').Engine['volcanoesOfSnapshot']
  export const seaLevelTemperatureBand: import('../generator/pipeline/engine').Engine['seaLevelTemperatureBand']
  export const levelFiles: import('../generator/pipeline/engine').Engine['levelFiles']
  export const tileFiles: import('../generator/pipeline/engine').Engine['tileFiles']
  export const riverGraphParts: import('../generator/pipeline/engine').Engine['riverGraphParts']
  export const levelOfFiles: import('../generator/pipeline/engine').Engine['levelOfFiles']
  export const tileOfFiles: import('../generator/pipeline/engine').Engine['tileOfFiles']
  export const World: import('../generator/pipeline/engine').EngineWorlds
  export const Replay: import('../generator/pipeline/engine').Engine['Replay']
  export const Preview: import('../generator/pipeline/engine').Engine['Preview']
}

// The incubator's catalogs, data shared with the incubator's crate
// (engine/crates/casas-incubator/data; vite.config.ts's alias
// `casas-incubator-data`).
declare module 'casas-incubator-data/catalog.json' {
  const catalog: {
    plants: readonly import('../screens/incubator/plants').PlantSpec[]
    trees: readonly import('../screens/incubator/trees').TreeSpec[]
    animals: readonly import('../screens/incubator/animals').AnimalSpec[]
    // The herbivores' share of a biome's production, by the biome's name.
    edibleShare: Record<string, number>
    // The big game and how vulnerable each is (the catalog's megafauna); the
    // herd animals the herders keep (incubatorWorker.ts).
    megafauna: Record<string, number>
    herdAnimals: readonly string[]
  }
  export default catalog
}

// The incubator's version (`make engine` writes engine/dist/incubator/
// version.json from the crate's INCUBATOR_VERSION).
declare module 'casas-incubator-wasm/version.json' {
  const version: { version: string }
  export default version
}

// The incubator's tuning by module (casas-incubator tuning.rs `constants`;
// `make engine` writes it beside version.json). Typed for what the client
// reads: step 1's controls' defaults.
declare module 'casas-incubator-wasm/constants.json' {
  const constants: { peopling: { REACH_END_KM: number }; climate: { SEA_DROP_M: number } }
  export default constants
}

// The incubator's WASM build (`make engine` writes it to
// engine/dist/incubator; vite.config.ts's alias `casas-incubator-wasm` names that
// directory), as wasm-bindgen types it (its casas-incubator.d.ts).
declare module 'casas-incubator-wasm/casas-incubator.js' {
  const init: (options: { module_or_path: string | BufferSource }) => Promise<unknown>
  export default init
  export function version(): string
  export function coldCurve(seed: number): Float32Array
  export function iceReachKm(): number
  export function seaDropM(): number
  // A debug view of a seed's proto-language, as JSON (language/mod.rs `sample`).
  export function languageSample(seed: number): string
  // THE LANGUAGES' view of a history's packed tree, as JSON (languages.rs
  // `Languages::view`; screens/incubator/languageView.ts LanguagesMade).
  export function languageView(peopleLanguage: Int32Array, parent: Int32Array, level: Uint8Array, people: Int32Array, from: Float32Array, at: Float32Array, until: Float32Array, seed: Int32Array, style: Uint8Array, changeStart: Int32Array, changeYear: Uint16Array, change: Uint8Array, changeChoice: Uint8Array, wordStart: Int32Array, wordYear: Uint16Array, wordMeaning: Uint8Array): string
  // The languages' tree of peoples given as arrays, as JSON: the packed
  // arrays and the log's events (languages.rs `tree_json`). For the
  // languages harness.
  export function languagesOfPeoples(parent: Int32Array, group: Int32Array, born: Float64Array, ended: Float64Array, mergedInto: Int32Array, big: Uint8Array, share: Float64Array, replaced: Uint8Array, heart: Int32Array, heartApart: Int32Array, seed: number, start: number, end: number): string
  // THE NAMES of places over a tree of peoples given as arrays, then by
  // place its kind, namer and year, as JSON (place_names.rs
  // `names_of_places_json`). For the languages harness.
  export function namesOfPlaces(parent: Int32Array, group: Int32Array, born: Float64Array, ended: Float64Array, mergedInto: Int32Array, big: Uint8Array, share: Float64Array, replaced: Uint8Array, heart: Int32Array, heartApart: Int32Array, seed: number, start: number, end: number, kinds: Uint8Array, people: Int32Array, years: Float64Array): string
  // THE NAMES of a history (place_names.rs `NameBook`): the packed tree's
  // arrays (as languageView's), then the packed names' (historyPack.ts
  // PlaceNamesPacked); `at`: the names in a year, JSON, "" for one not
  // given by then; `forms`: by name [year, form, …] over time, JSON.
  export class PlaceNames {
    constructor(peopleLanguage: Int32Array, parent: Int32Array, level: Uint8Array, people: Int32Array, from: Float32Array, at: Float32Array, until: Float32Array, seed: Int32Array, style: Uint8Array, changeStart: Int32Array, changeYear: Uint16Array, change: Uint8Array, changeChoice: Uint8Array, wordStart: Int32Array, wordYear: Uint16Array, wordMeaning: Uint8Array, kind: Uint8Array, place: Int32Array, cell: Int32Array, namer: Uint16Array, year: Float32Array, pattern: Uint8Array, meaning: Uint8Array, ownLength: Uint8Array, own: Uint8Array)
    count(): number
    at(year: number, from: number, count: number): string
    forms(from: number, count: number): string
    free(): void
  }
  export class Incubator {
    constructor(sphere: boolean, spacingKm: number, width: number, height: number, nodes: Int32Array, nodeW: number, nodeH: number, land: Uint8Array, biome: Uint8Array, koppen: Uint8Array, z: Float32Array, lakeDepth: Float32Array, ecology: Uint8Array, ecologyPresent: number, riverPoints?: Float32Array, riverLengths?: Uint32Array, riverRegimes?: Uint8Array, shelfCarrying?: Uint8Array, volcanoes?: Float64Array)
    free(): void
    count(): number
    owners(): Int32Array
    scalars(): Float64Array
    floats(name: string): Float32Array
    bytes(name: string): Uint8Array
    ints(name: string): Int32Array
    landmassKm2(): Float64Array
    iceKm(): Float32Array
    originOf(seed: number, reachKm?: number, seaLowM?: number): number
    floodedRuns(seed: number, seaLowM?: number): Int32Array
    growFlora(seed: number): void
    populate(seed: number): void
    floraCodes(): Uint8Array
    floraShares(): Float64Array
    faunaCodes(): Uint8Array
    faunaShares(): Float64Array
    simulate(origin: number, seed: number, rainWidth: number, rainHeight: number, variability: Float32Array | undefined, enso: Float32Array | undefined, ensoStrength: number, progress: ((share: number) => void) | undefined, reachKm?: number, seaLowM?: number): Uint8Array
    settleHistory(arrival: Float32Array, farmAt: Float32Array, herdAt: Float32Array, villages: Int32Array, villageFrom: Float32Array, villageTo: Float32Array, villageTown: Float32Array, end: number): Uint8Array
    people(origins: Int32Array, seed: number, reachKm?: number, seaLowM?: number): number
    peoplingFloats(name: string): Float32Array
    peoplingInts(name: string): Int32Array
    peoplingAfloat(): Uint8Array
    peoplingLandings(): Float64Array
  }
  export class Chart {
    constructor(sphere: boolean, width: number, height: number, count: number, nodes: Float32Array, connectivity: Uint8Array)
    free(): void
    raster(z: Float32Array, w: number, h: number): Float32Array
    pass(z: Float32Array, land: Uint8Array, biome: Uint8Array, w: number, h: number): void
    takeElevation(): Float32Array
    takeBiome(): Uint8Array
    takeNodes(): Int32Array
  }
}

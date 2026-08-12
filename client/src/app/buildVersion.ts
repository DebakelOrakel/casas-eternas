// The build's provenance string — `git describe` at build/dev time, injected
// by vite.config.ts through `define`. PROVENANCE, never a key: it says which
// build wrote a save (status.generator in world.yaml), and nothing may ever
// address, hash or compare content by it. A semantic "algorithm version" was
// considered for the save and rejected (2026-08-11): no generator-wide
// version number exists, and a hand-bumped one has exactly the
// forgotten-bump failure mode world/identity.ts documents — the content hash
// is the identity that needs no discipline.
declare const __CASAS_BUILD__: string | undefined
export const BUILD_VERSION: string = typeof __CASAS_BUILD__ === 'undefined' ? 'dev' : __CASAS_BUILD__

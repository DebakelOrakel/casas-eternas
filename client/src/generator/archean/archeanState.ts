import { hashSeedString } from '../core/rng'

// The world's coastline-warp seed, the one salted derivation every reader
// of the fine-detail field family shares (the generator's warp, the
// amplification bake's roughness seed, the queryable save's detail seed —
// world/query.ts). Changing the salt changes baked terrain for an unchanged
// world under an unchanged key, so it is one function, not one string in
// three files.
export const coastalWarpSeed = (seedString: string): number => hashSeedString(`${seedString}:coastalWarp`)

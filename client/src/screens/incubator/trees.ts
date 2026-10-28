import catalog from 'casas-incubator-data/catalog.json'
import type { NicheSpec } from './plants'

// THE INCUBATOR'S TREES (2026-10-25, a trial): the wood people cut just
// before the bronze age, by what they cut it for: to build (houses,
// palisades, long straight trunks), to burn (fire, pottery, the charcoal
// that smelts copper), to work (bows, spears, handles, bark), for boats
// (a dugout from a big trunk, a bark canoe, a raft), for resin (birch pitch
// to haft a point, tar to seal a boat, incense). Archetypes,
// a niche over the habitat as the plants' (plants.ts), grown with them
// (flora.ts); their names are `wood.<id>`. A tree serves one use or
// more. Not hard and soft wood: that split is the botanist's (a broadleaf
// against a conifer), and says little of what the wood is good for.
//
// The weights are first guesses from the real trees' ranges: 1 the main
// classes, about 0.5 the edge. The catalog is data (plants.ts).

import type { WoodUse } from '../../map/overlayGroups'

export interface TreeSpec extends NicheSpec {
  woods: readonly WoodUse[]
}

export const TREES: readonly TreeSpec[] = catalog.trees as readonly TreeSpec[]

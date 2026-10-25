import { ALL_C, ALL_D, UP_TO, type NicheSpec } from './plants'

// THE INCUBATOR'S TREES (2026-10-25, a trial): the wood people cut just
// before the bronze age, by what they cut it for: to build (houses,
// palisades, long straight trunks), to burn (fire, pottery, the charcoal
// that smelts copper), to work (bows, spears, handles, bark), for boats
// (a dugout from a big trunk, a bark canoe, a raft), for resin (birch pitch
// to haft a point, tar to seal a boat, incense). Archetypes,
// a niche over the habitat as the plants' (plants.ts), grown with them
// (plantWorker.ts); their names are `wood.<id>`. A tree serves one use or
// more. Not hard and soft wood: that split is the botanist's (a broadleaf
// against a conifer), and says little of what the wood is good for.
//
// The weights are first guesses from the real trees' ranges: 1 the main
// classes, about 0.5 the edge.

export type WoodUse = 'build' | 'fuel' | 'tool' | 'boat' | 'resin'

export interface TreeSpec extends NicheSpec {
  woods: readonly WoodUse[]
}

export const TREES: readonly TreeSpec[] = [
  {
    id: 'oak', woods: ['build', 'fuel', 'boat'],
    climates: { Cfb: 1, Cfa: 1, Dfb: 0.8, Dfa: 0.8, Csb: 0.6, Csa: 0.5 }, cover: 'forest',
  },
  {
    id: 'conifer', woods: ['build', 'fuel', 'boat', 'resin'],
    climates: { Dfc: 1, Dfb: 1, Dwc: 1, Dwb: 0.8, Dfd: 0.8, Dwd: 0.8, Dsc: 0.8, Cfc: 0.8, Cfb: 0.5, Csb: 0.4, ET: 0.2 }, height: UP_TO(3800, 4500), cover: 'forest',
  },
  {
    id: 'birch', woods: ['fuel', 'tool', 'boat', 'resin'],
    climates: { Dfc: 1, Dfb: 1, Dwc: 0.8, Dwb: 0.8, Dfd: 0.7, Cfc: 0.7, Cfb: 0.5, ET: 0.4 },
  },
  {
    id: 'cedar', woods: ['build', 'boat', 'resin'],
    climates: { Csa: 1, Csb: 1, BSk: 0.7, Dsa: 0.6, Dsb: 0.6, Cwb: 0.4 }, height: UP_TO(3200, 4000),
  },
  {
    id: 'yew', woods: ['tool'],
    climates: { Cfb: 1, Dfb: 0.7, Cfa: 0.6, Csb: 0.5, Dfa: 0.5 }, cover: 'forest',
  },
  {
    id: 'willow', woods: ['fuel', 'tool', 'boat'],
    climates: { ...ALL_C, ...ALL_D, BSk: 0.5 }, wet: 0.9,
  },
  {
    id: 'eucalyptus', woods: ['build', 'fuel', 'boat', 'resin'],
    climates: { Csa: 1, Cfa: 0.8, Csb: 0.8, BSh: 0.8, Cwa: 0.6, Aw: 0.5 },
  },
  {
    id: 'teak', woods: ['build', 'tool', 'boat'],
    climates: { Aw: 1, Am: 1, Af: 0.6 }, cover: 'forest',
  },
  {
    id: 'bamboo', woods: ['build', 'tool', 'boat'],
    climates: { Cwa: 1, Am: 1, Af: 0.8, Cfa: 0.8, Cwb: 0.7, Aw: 0.6 },
  },
  {
    id: 'acacia', woods: ['fuel', 'tool', 'resin'],
    climates: { BSh: 1, Aw: 1, As: 0.8, BWh: 0.6, BSk: 0.5 }, cover: 'open',
  },
  {
    id: 'mangrove', woods: ['build', 'fuel'],
    climates: { Af: 1, Am: 1, Aw: 1, As: 0.7, BWh: 0.4 }, height: UP_TO(20, 60), coast: 1, salt: true,
  },
  {
    id: 'frankincense', woods: ['resin'],
    climates: { BSh: 1, BWh: 0.7, BSk: 0.4 }, height: UP_TO(1800, 2400), cover: 'open',
  },
]

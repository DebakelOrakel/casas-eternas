// What the settlement (settle.ts) and the screen share, out
// of the worker for the reason peopleShared.ts gives: the lifeways' shares
// and the density of a cell at a time, from its times (SettleTimes). The worker
// places the villages by them, the screen draws them as the time plays.

export const LIFEWAY = { none: 0, foragers: 1, fishers: 2, herders: 3, farmers: 4 } as const
export const GOODS = ['toolStone', 'salt', 'copper'] as const

// People a km² at the carrying capacity's CARRYING_FULL, by lifeway (the
// earth's: foragers some 0.01 to 0.2, herders 0.5 to 3, farmers 10 to 100);
// the land's own carrying capacity scales it, to twice.
export const DENSITY: Record<number, number> = { 1: 0.1, 2: 1, 3: 1.5, 4: 15 }
export const CARRYING_FULL = 0.8
// The fishers settle this long after people came; the herders keep their
// herds from the herding's wave on (settle.ts); a lifeway's density
// grows to its own with the time constant DENSITY_TAU.
export const SETTLE_AFTER = 3000
export const DENSITY_TAU = 3000

// A cell's times and what it allows, the worker's (settle.ts).
export interface SettleTimes {
  // When people came (people.ts), Infinity for never.
  arrival: Float32Array
  // When the farmers came, Infinity for never.
  farmAt: Float32Array
  // When the herders came, Infinity for never; 1 where the fish allow the
  // settled fishers.
  herdAt: Float32Array
  fishOk: Uint8Array
  // How well the land suits the fields, the herds and the fishers, 0 … 1
  // (the ecology's arable land, pasture and fish).
  farmSuit: Float32Array
  herdSuit: Float32Array
  fishSuit: Float32Array
  // The carrying capacity over CARRYING_FULL, to 2.
  carrying: Float32Array
}

// THE LIFEWAYS' SHARES (2026-10-26): a cell holds several lifeways at a
// time — the farmers and the herders of one valley, the hunters left
// between them. Each lifeway the cell has by then weighs its suit (the
// arable land, the pasture, the fish) by SHARE_GAIN, grown with the time
// since it came as the density grows (DENSITY_TAU); the foragers weigh
// FORAGER_WEIGHT always. So the foragers give way as the others grow,
// the fields weigh most, and a cell of fields and pasture holds both.
const SHARE_GAIN: Record<number, number> = { 2: 1, 3: 2, 4: 4 }
const FORAGER_WEIGHT = 0.2

const grownSince = (t: number, since: number): number => Math.max(0, 1 - Math.exp(-(t - since) / DENSITY_TAU))

// When a lifeway came to a cell; Infinity for never.
export function lifewaySince(s: SettleTimes, i: number, way: number): number {
  if (way === LIFEWAY.farmers) return s.farmAt[i]
  if (way === LIFEWAY.herders) return s.herdAt[i]
  if (way === LIFEWAY.fishers) return s.fishOk[i] ? s.arrival[i] + SETTLE_AFTER : Infinity
  return s.arrival[i]
}

// The lifeways' shares of a cell at `t` years after the departure, into
// `shares` (by LIFEWAY, summing to 1, all 0 before people came); the
// largest's lifeway returned, LIFEWAY.none before people came.
export function sharesAt(s: SettleTimes, i: number, t: number, shares: Float32Array): number {
  shares.fill(0)
  if (!(s.arrival[i] <= t)) return LIFEWAY.none
  shares[LIFEWAY.foragers] = FORAGER_WEIGHT
  let sum = FORAGER_WEIGHT
  const suits = [0, 0, s.fishSuit[i], s.herdSuit[i], s.farmSuit[i]]
  for (const way of [LIFEWAY.fishers, LIFEWAY.herders, LIFEWAY.farmers]) {
    const since = lifewaySince(s, i, way)
    if (!(since <= t)) continue
    const w = SHARE_GAIN[way] * suits[way] * grownSince(t, since)
    shares[way] = w
    sum += w
  }
  let top: number = LIFEWAY.foragers
  for (let w = 1; w < shares.length; w++) {
    shares[w] /= sum
    if (shares[w] > shares[top]) top = w
  }
  return top
}

// People a km² of a lifeway in a cell at `t`, were it alone there: grown
// since it came from the foragers' to its own.
function wayDensity(s: SettleTimes, i: number, t: number, way: number): number {
  const floor = DENSITY[LIFEWAY.foragers] * s.carrying[i]
  const full = DENSITY[way] * s.carrying[i]
  return floor + (full - floor) * grownSince(t, lifewaySince(s, i, way))
}

// People a km² in a cell at `t`: each lifeway's share of its own density.
export function densityAt(s: SettleTimes, i: number, t: number, shares: Float32Array): number {
  let d = 0
  for (let way = 1; way < shares.length; way++) if (shares[way] > 0) d += shares[way] * wayDensity(s, i, t, way)
  return d
}

// THE CLEARING (2026-10-26): the share of a cell's forest people cleared by
// `t`, only as much as they need — CLEAR_HA hectares a person for the
// fields, the fallow and the village (the farmers), or for the grazing that
// keeps the wood from growing back (the herders); at the farmers' full
// density of 15 a km², some 15 % of the land. Never more than CLEAR_MOST.
const CLEAR_HA: Record<number, number> = { 3: 0.3, 4: 1 }
const CLEAR_MOST = 0.5

export function clearedAt(s: SettleTimes, i: number, t: number, shares: Float32Array): number {
  let ha = 0
  for (const way of [LIFEWAY.herders, LIFEWAY.farmers]) if (shares[way] > 0) ha += shares[way] * wayDensity(s, i, t, way) * CLEAR_HA[way]
  // A hectare is a hundredth of a km².
  return Math.min(CLEAR_MOST, ha / 100)
}

// THE PEOPLE'S PRESSURE ON AN ANIMAL in a cell, a factor on its numbers
// (2026-10-26): the animals people hunt (game, fur) thin out with the
// people's density, 1 / (1 + density / HUNT_HALF); the wild herbivores
// give way to the herds and the fields (HERDERS_LEAVE, FARMERS_LEAVE), the
// predators are hunted down there (PREDATORS_LEAVE), each by its lifeway's
// share of the cell. The animals of the water are left as they are.
export const HUNT_HALF = 3
export const HERDERS_LEAVE = 0.6
export const FARMERS_LEAVE = 0.4
export const PREDATORS_LEAVE = 0.3

export function pressure(role: string, hunted: boolean, shares: Float32Array, density: number): number {
  let f = hunted ? 1 / (1 + density / HUNT_HALF) : 1
  if (role === 'herbivore') f *= 1 - shares[LIFEWAY.herders] * (1 - HERDERS_LEAVE) - shares[LIFEWAY.farmers] * (1 - FARMERS_LEAVE)
  if (role === 'predator') f *= 1 - (shares[LIFEWAY.herders] + shares[LIFEWAY.farmers]) * (1 - PREDATORS_LEAVE)
  return f
}

// THE BIG GAME'S LOSS, cell by cell (2026-10-26): where a species dies out
// on a landmass (settle.ts), it goes from a cell EXTINCT_AFTER to
// EXTINCT_AFTER + EXTINCT_SPREAD years after people came there, the cell's
// own share of that drawn from its index; Infinity where they never came.
export const EXTINCT_AFTER = 1000
export const EXTINCT_SPREAD = 1000

export function extinctAt(arrival: number, cell: number): number {
  let x = Math.imul(cell ^ 0x9e3779b9, 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return arrival + EXTINCT_AFTER + EXTINCT_SPREAD * ((x >>> 0) / 4294967296)
}

// A plant's or a tree's code from which its niche suits a cell (niche.ts:
// SUITABLE 0.3, the niche coded 2 … 255).
export const PLANT_SUITS_CODE = 2 + Math.round(253 * 0.3)

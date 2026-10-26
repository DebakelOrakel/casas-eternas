// What the settlement (settle.ts) and the screen share, out
// of the worker for the reason peopleShared.ts gives: the lifeways and the
// density of a cell at a time, from its times (SettleTimes). The worker
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
  // The carrying capacity over CARRYING_FULL, to 2.
  carrying: Float32Array
}

// The lifeway of a cell at `t` years after the departure.
export function lifewayAt(s: SettleTimes, i: number, t: number): number {
  const came = s.arrival[i]
  if (!(came <= t)) return LIFEWAY.none
  if (s.farmAt[i] <= t) return LIFEWAY.farmers
  if (s.herdAt[i] <= t) return LIFEWAY.herders
  if (s.fishOk[i] && t >= came + SETTLE_AFTER) return LIFEWAY.fishers
  return LIFEWAY.foragers
}

// When a cell's lifeway at `t` began.
export function lifewaySince(s: SettleTimes, i: number, way: number): number {
  if (way === LIFEWAY.farmers) return s.farmAt[i]
  if (way === LIFEWAY.herders) return s.herdAt[i]
  if (way === LIFEWAY.fishers) return s.arrival[i] + SETTLE_AFTER
  return s.arrival[i]
}

// People a km² in a cell at `t`: grown since its lifeway began from the
// foragers' to its own.
export function densityAt(s: SettleTimes, i: number, t: number): number {
  const way = lifewayAt(s, i, t)
  if (way === LIFEWAY.none) return 0
  const floor = DENSITY[LIFEWAY.foragers] * s.carrying[i]
  const full = DENSITY[way] * s.carrying[i]
  const grown = 1 - Math.exp(-(t - lifewaySince(s, i, way)) / DENSITY_TAU)
  return floor + (full - floor) * Math.max(0, grown)
}

// THE PEOPLE'S PRESSURE ON AN ANIMAL in a cell, a factor on its numbers
// (2026-10-26): the animals people hunt (game, fur) thin out with the
// people's density, 1 / (1 + density / HUNT_HALF); the wild herbivores
// give way to the herds and the fields (HERDERS_LEAVE, FARMERS_LEAVE), the
// predators are hunted down there (PREDATORS_LEAVE). The animals of the
// water are left as they are.
export const HUNT_HALF = 3
export const HERDERS_LEAVE = 0.6
export const FARMERS_LEAVE = 0.4
export const PREDATORS_LEAVE = 0.3

export function pressure(role: string, hunted: boolean, way: number, density: number): number {
  let f = 1
  if (hunted) f /= 1 + density / HUNT_HALF
  if (role === 'herbivore') f *= way === LIFEWAY.herders ? HERDERS_LEAVE : way === LIFEWAY.farmers ? FARMERS_LEAVE : 1
  if (role === 'predator' && (way === LIFEWAY.herders || way === LIFEWAY.farmers)) f *= PREDATORS_LEAVE
  return f
}

// A plant's or a tree's code from which its niche suits a cell (niche.ts:
// SUITABLE 0.3, the niche coded 2 … 255).
export const PLANT_SUITS_CODE = 2 + Math.round(253 * 0.3)

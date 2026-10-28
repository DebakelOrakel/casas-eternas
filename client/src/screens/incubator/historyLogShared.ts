// THE HISTORY'S LOG (2026-10-26, DES-0032 "One chronicle"): every event
// of the people's past — step 1's, derived from its graph (casas-incubator
// peopling.rs), then the history's, written when it happens
// (simulation.rs); the settlement adds the first trade (settle.rs). The
// chronicle (IncubatorScreen sayChronicle) reads it alone
// and picks what it tells; it is the event log in game time DES-0023
// proposes. Out of the worker for the reason peopleShared.ts gives.
//
// `at` is years after the departure; `cell` the incubator's cell
// (casas-incubator habitat.rs) it happened at.
export type LogEvent =
  | { kind: 'departure'; at: number; cell: number }
  // A crossing made; `first` when it was the first arrival on its landmass
  // by any way, `km` its longest stretch of open water.
  | { kind: 'crossing'; at: number; cell: number; landmass: number; km: number; first: boolean }
  // A centre of the farming or the herding (settleShared.ts LIFEWAY).
  | { kind: 'centre'; at: number; cell: number; lifeway: number }
  | { kind: 'domesticated'; at: number; cell: number; id: string; plant: boolean }
  | { kind: 'extinct'; at: number; cell: number; landmass: number; id: string }
  // A famine: when it began and ended, its square's people when it began,
  // the people it cost (dead), those who left it, the villages given up.
  | { kind: 'famine'; at: number; to: number; cell: number; landmass: number; before: number; lost: number; left: number; villages: number }
  // A village founded or given up; `village` its index in the settlement's
  // villages, by when it was founded.
  | { kind: 'village'; at: number; cell: number; village: number; lifeway: number }
  | { kind: 'villageLeft'; at: number; cell: number; village: number }
  // A camp of the foragers or the herders made or left (simulation.ts):
  // in the settlement's villages too, `village` its index there.
  | { kind: 'camp'; at: number; cell: number; village: number; lifeway: number }
  | { kind: 'campLeft'; at: number; cell: number; village: number }
  // The first link that carried goods (settle.ts), between two villages.
  | { kind: 'trade'; at: number; cell: number; a: number; b: number }
  // The people over a mark, and the villages and the centres then.
  | { kind: 'population'; at: number; cell: number; count: number; villages: number; centres: number }
  // The copper found and hammered, or smelted, where it was not passed on.
  | { kind: 'copper'; at: number; cell: number; smelted: boolean }
  // The first city, the history's end: the people of its town.
  | { kind: 'city'; at: number; cell: number; people: number }
  // The sea took `km2` of a landmass's shelf in 500 years (simulation.rs
  // THE RISING SEA), `people` moved away from it; at its cell of the most
  // people.
  | { kind: 'drowned'; at: number; cell: number; landmass: number; km2: number; people: number }
  // A cold spell begins (climate_history.rs THE COLD SPELLS), `years` long.
  | { kind: 'coldSpell'; at: number; years: number }

// The people's marks the log notes.
export const POPULATION_MARKS = [100_000, 1_000_000, 10_000_000]

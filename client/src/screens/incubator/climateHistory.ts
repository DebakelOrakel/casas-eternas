import { KOPPEN_CODES } from '../../generator/climate/koppen'
import { mulberry32 } from './habitat'

// THE WORLD'S CLIMATE HISTORY (2026-10-26, DES-0033 "Progression"): a
// glacial cycle over the people's span, drawn once from the world's seed —
// how cold it gets, when the cold is deepest, how fast it ends — and what
// follows from it for the simulation (simulation.ts): the sea level and so
// the land bridges, the ice's edge, what the land carries in the cold.
// Instead of the rules' dates (the bridges until 10 000 years before the
// game, the farming from 11 000), one cause.
//
// THE CURVE, `cold` 0 … 1 (1: the earth's last glacial maximum): from a
// middling cold at the departure it deepens, with stadials (STADIALS
// swings), to its maximum at `maxAt` of the span; it ends over
// `deglaciation` years, and the rest is warm and calm. THE WORLD'S
// TIMELINE (2026-10-26, asked for): the departure in year 0, the large
// landmasses reached by some 40 000, the cold deepest at 40 … 55 % of the
// span, a stable warmth from some 60 000, the first fields by 65 000 …
// 70 000, some 30 000 years of farming before the game. The first form
// put the maximum at 76 … 86 %, after the earth (some 20 000 years before
// a bronze-age game), and so no farming before year 85 000.
//
// WHAT FOLLOWS:
// - the sea stands SEA_DROP_M lower at cold 1 (the earth's −120 m), in
//   proportion: the shelf to that depth is land;
// - the ice grows out of today's glaciers over the cold climates (Köppen D
//   and E), ICE_REACH_KM far at cold 1, in proportion (iceDistance): the
//   ice sheets grew from their cores. 800 km at first; Morvane, half
//   under ice today, was then shut for most of the cold. A first form closed the whole tundra
//   from cold 0.5 and the subarctic from 0.8; on Morvane, cold and half
//   under ice, that shut most of the world for most of the span, while the
//   earth's glacial tundra was the mammoth steppe, lived in;
// - the cold lowers what the land carries, the cold climates most
//   (COLD_LOSS by the class's main group), the dry ones by the cold's
//   dryness;
// - the climate is stable when it has stayed under STABLE_COLD for
//   STABLE_YEARS: a condition of the farming and the herding.

export interface ClimateHistory {
  // The cold at `t` years after the departure, 0 … 1.
  cold(t: number): number
  // The sea's drop below today's at `t`, metres (≥ 0).
  seaDropM(t: number): number
  // Whether the climate has been warm and calm for STABLE_YEARS by `t`.
  stable(t: number): boolean
  // The draw, for a readout: when the cold was deepest, its depth, the
  // melt's years.
  maxAt: number
  depth: number
  deglaciation: number
}

const SEA_DROP_M = 120
const STADIALS = 4
const STABLE_COLD = 0.15
const STABLE_YEARS = 2000

export function climateHistoryOf(seed: number, span: number): ClimateHistory {
  const random = mulberry32(seed ^ 0xc11a7e)
  const maxAt = span * (0.4 + 0.15 * random())
  const depth = 0.75 + 0.25 * random()
  const deglaciation = 6000 + 6000 * random()
  const start = 0.3 + 0.2 * random()
  const swings = Array.from({ length: STADIALS }, () => ({ period: 6000 + 10_000 * random(), phase: 2 * Math.PI * random(), amplitude: 0.06 + 0.08 * random() }))
  const cold = (t: number): number => {
    if (t <= maxAt) {
      const f = Math.max(0, t / maxAt)
      let c = start + (depth - start) * f ** 1.5
      // The stadials fade out toward the maximum, where the cold holds.
      for (const s of swings) c += s.amplitude * (1 - f) * Math.sin((2 * Math.PI * t) / s.period + s.phase)
      return Math.max(0, Math.min(1, c))
    }
    if (t >= maxAt + deglaciation) return 0
    // The melt: a smooth fall from the maximum to the warmth.
    return depth * 0.5 * (1 + Math.cos((Math.PI * (t - maxAt)) / deglaciation))
  }
  return {
    cold,
    seaDropM: (t) => SEA_DROP_M * cold(t),
    stable: (t) => cold(t) < STABLE_COLD && cold(t - STABLE_YEARS) < STABLE_COLD,
    maxAt,
    depth,
    deglaciation,
  }
}

// What the cold takes of what the land carries, at cold 1, by the class's
// main group (A tropical … E polar).
const COLD_LOSS: Record<string, number> = { A: 0.1, B: 0.3, C: 0.25, D: 0.4, E: 0.5 }
export const ICE_REACH_KM = 400

// Whether the ice may grow over a Köppen class (the cold ones, D and E).
export const iceMayCover = (koppen: number): boolean => {
  const group = (KOPPEN_CODES[koppen] ?? '').charAt(0)
  return group === 'D' || group === 'E'
}

// What a cell carries at a cold, as a share of today's: 0 under the ice
// (`iceKm`: its distance from today's glaciers over the cold climates,
// Infinity where the ice cannot come).
export function coldShare(koppen: number, iceKm: number, cold: number): number {
  if (iceKm <= ICE_REACH_KM * cold) return 0
  return 1 - (COLD_LOSS[(KOPPEN_CODES[koppen] ?? '').charAt(0)] ?? 0.2) * cold
}

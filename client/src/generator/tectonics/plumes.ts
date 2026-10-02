import { toroidalDistanceSq } from '../core/toroidal'
import { sampleNearestWorld } from '../core/field'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'
import { detHypot, sq } from '../core/detMath'

// Mantle plumes, derived from the mantle field rather than scattered at random.
//
// **A plume is a persistent upwelling.** That is the same definition the Archean
// already uses to decide where crust nucleates (crustNucleation's upwellingStreak),
// which is the point: one rule on both sides of the hand-off instead of two.
//
// They used to be five uniformly random points, created once at the hand-off and
// never moved again — "fixed for the world's life". Two things were wrong with that:
//
//  - **Real plumes drift**, just slowly. The Hawaiian plume moved roughly 15° south
//    between ~80 and ~50 Ma, which is part of why the Hawaiian-Emperor chain has a
//    bend in it. Inter-hotspot drift runs 1-2 cm/yr against plate speeds of 5-10.
//  - **The world already had them moving, on the other side of the hand-off.** In the
//    Archean the plume role is played by the mantle field's upwellings, and that
//    pattern reorganises completely across the phase (correlation against its start
//    falls to 0.21). So the same physical thing flipped from mobile to frozen at the
//    hand-off — and in the wrong direction, since the Archean mantle was the hotter,
//    more vigorous one.
//
// Deriving them from the field rather than giving the fixed points a random walk is
// deliberate, and it is the same move that fixed plate motion (see
// docs/decisions/evolving-euler-poles.md, which sets out to model the CAUSE instead of
// scripting the effect). A random walk would be motion without a reason, untethered
// from the field that drives everything else here.
//
// Three properties fall out for free rather than needing to be tuned:
//
//  - **Speed.** The field's pattern changes at ~0.996 correlation per epoch, while
//    plates are re-fitted to its flow every epoch and move fast. Plumes are therefore
//    automatically much slower than the plates riding over them — the real
//    relationship, with no ratio to calibrate.
//  - **Bent chains.** A plume that creeps while the plate above it races produces
//    exactly the geometry the Hawaiian-Emperor bend records.
//  - **Clustering.** Real plumes cluster (at the margins of the deep mantle's two
//    large provinces) rather than being uniformly spread. Field-derived plumes
//    inherit the field's own spatial organisation; uniformly random points cannot.

// Mantle value a cell must reach to host a plume. Above the Archean's nucleation
// threshold (0.70): a plume should mark a genuinely strong upwelling, not merely one
// hot enough to make crust.
const PLUME_THRESHOLD = 0.85
// Below this a plume has outlived its upwelling and is retired. Hysteresis against
// PLUME_THRESHOLD, so one that sits near the line does not flicker in and out.
const PLUME_RETIRE_THRESHOLD = 0.55
// Upper bound only. The count is otherwise emergent from how many strong upwellings
// the mantle actually organises itself into — the same way the plate count comes from
// the convection cells. Capped because vigorous convection can offer a great many.
const PLUME_MAX_COUNT = 8
// Two plumes closer than this are one upwelling found twice.
const PLUME_MIN_SEPARATION_FRAC = 0.14
// Hard ceiling on how far a plume may travel in one epoch, in world pixels.
//
// The field is slow enough that this rarely binds — it is insurance. A plume that
// jumps would silently break its chain into unrelated dots, and that is the kind of
// fault that is noticed only long after it is introduced.
const PLUME_MAX_STEP_PX = 3

function mantleAt(mantle: Float32Array, x: number, y: number, width: number, height: number): number {
  return sampleNearestWorld(mantle, MANTLE_RES_X, MANTLE_RES_Y, x, y, width, height)
}

// The strongest upwellings, strongest first, thinned so each is a distinct one.
// Kin to finalizeArchean's convectionCellSeeds, which does the same sweep for plate
// seeds — but that one wants extrema of BOTH signs at a different prominence, so they
// are deliberately separate rather than one function with flags.
export interface Plume {
  x: number
  y: number
  // Identity, so a plume is more than its position in an array — retiring one splices
  // the list, and without an id "the same plume" would silently become "whichever is
  // now at that index". The chain a plume builds is the reason it exists, so losing
  // track of which is which loses the feature.
  id: number
  birthEpoch: number
}

// Ids continue from whatever is already there, so no counter has to be carried in the
// simulation state (and none has to be serialised).
export function findPlumeSites(mantle: Float32Array, width: number, height: number, epoch = 0, exclude: Plume[] = []): Plume[] {
  let nextId = exclude.reduce((m, p) => Math.max(m, p.id), -1) + 1
  const candidates: { x: number; y: number; strength: number }[] = []
  for (let gy = 0; gy < MANTLE_RES_Y; gy++) {
    for (let gx = 0; gx < MANTLE_RES_X; gx++) {
      const v = mantle[gy * MANTLE_RES_X + gx]
      if (v < PLUME_THRESHOLD) continue
      let isMax = true
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = (((gx + dx) % MANTLE_RES_X) + MANTLE_RES_X) % MANTLE_RES_X
          const ny = (((gy + dy) % MANTLE_RES_Y) + MANTLE_RES_Y) % MANTLE_RES_Y
          if (mantle[ny * MANTLE_RES_X + nx] > v) { isMax = false; break }
        }
      }
      if (!isMax) continue
      candidates.push({ x: ((gx + 0.5) / MANTLE_RES_X) * width, y: ((gy + 0.5) / MANTLE_RES_Y) * height, strength: v })
    }
  }
  candidates.sort((a, b) => b.strength - a.strength)
  const minSepSq = sq(PLUME_MIN_SEPARATION_FRAC * Math.min(width, height))
  const chosen: { x: number; y: number }[] = exclude.map((p) => ({ x: p.x, y: p.y }))
  const fresh: Plume[] = []
  for (const c of candidates) {
    if (chosen.length >= PLUME_MAX_COUNT) break
    if (chosen.some((s) => toroidalDistanceSq(s.x, s.y, c.x, c.y, width, height) < minSepSq)) continue
    chosen.push({ x: c.x, y: c.y })
    fresh.push({ x: c.x, y: c.y, id: nextId++, birthEpoch: epoch })
  }
  return fresh
}

// One epoch of plume motion: each keeps its identity and CREEPS toward the upwelling
// it sits on, rather than being re-found from scratch. Re-finding every epoch would
// let a plume blink out and reappear elsewhere, and its volcano chain would come apart
// into unrelated dots — the chain is the whole reason the plume is visible at all.
//
// Retired when its upwelling dies; new ones appear where a strong upwelling has none.
// The count therefore breathes with the convection instead of being a constant.
export function advancePlumes(plumes: Plume[], mantle: Float32Array, width: number, height: number, epoch: number): void {
  const cellW = width / MANTLE_RES_X
  const cellH = height / MANTLE_RES_Y
  for (const plume of plumes) {
    // Uphill by one step: sample the four neighbours a cell away and move toward the
    // steepest rise. Hill-climbing rather than gradient descent on a smooth function
    // because the field is coarse (128x64) and its cells are what the plume follows.
    const here = mantleAt(mantle, plume.x, plume.y, width, height)
    let bestX = 0
    let bestY = 0
    let best = here
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const v = mantleAt(mantle, plume.x + dx * cellW, plume.y + dy * cellH, width, height)
      if (v > best) { best = v; bestX = dx; bestY = dy }
    }
    if (bestX === 0 && bestY === 0) continue
    const len = detHypot(bestX * cellW, bestY * cellH) || 1
    const step = Math.min(PLUME_MAX_STEP_PX, len)
    plume.x = (((plume.x + (bestX * cellW / len) * step) % width) + width) % width
    plume.y = (((plume.y + (bestY * cellH / len) * step) % height) + height) % height
  }
  for (let i = plumes.length - 1; i >= 0; i--) {
    if (mantleAt(mantle, plumes[i].x, plumes[i].y, width, height) < PLUME_RETIRE_THRESHOLD) plumes.splice(i, 1)
  }
  plumes.push(...findPlumeSites(mantle, width, height, epoch, plumes))
}

import type { Raft, RaftBlob } from '../crust/raftTypes'
import { raftField } from '../crust/raftField'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../tectonics/mantleField'
import { toroidalDistanceSq } from '../core/toroidal'
import { SHORELINE_FIELD } from '../elevation/elevationScale'

// Where new continental crust appears in the Archean.
//
// **The one decision that determines whether this produces cratons or porridge.**
//
// evolveMantleField heats the mantle UNDER continents and cools it under ocean:
//
//     if (membership > 0.5) field[i] += INSULATION_RATE
//     else                  field[i] -= OCEAN_COOL_RATE
//
// So continents create upwellings beneath themselves. A rule of "crust nucleates
// over upwellings" is therefore a positive feedback — crust grows where crust
// already is — and collapses into two or three blobs that consume everything.
//
// Reality runs the other way round: Archean crust formed over OCEANIC plateaus, by
// plume-driven partial melting of hydrated basalt (the TTG suites). Only once a
// craton exists does its insulation build the dome that eventually rifts it. So
// the rule is: hot, persistent, AND currently ocean.
//
// The persistence requirement is the second half. Without it, a cell that crosses
// the threshold for a single epoch seeds crust, and the map speckles; requiring a
// streak means only upwellings that actually stand still long enough to build a
// plateau produce anything.

export interface NucleationParams {
  // Mantle field value above which a cell counts as an upwelling. The field is
  // zero-mean and clamped to ±2.5.
  upwellingThreshold: number
  // Consecutive epochs above that threshold before crust forms.
  persistenceEpochs: number
  // Raft field value above which a cell already counts as crust and is skipped.
  //
  // This is SHORELINE_FIELD — the level at which land begins — and not a number of its
  // own. It used to be 0.15, chosen to be "as generous as the crust's actual reach",
  // which turned out to mean something quite different from what it sounds like:
  // measured against the rendered coastline, it treated 1.5 to 2 times the land area
  // as occupied. Every island sat inside a belt of open water where nothing could
  // nucleate, so new crust could never appear against an existing shore and fuse with
  // it — it had to land far enough out to become its own island. Hence a world of many
  // small masses that stopped growing.
  occupiedFieldLevel: number
  // Radius of a newly nucleated crust blob, in world pixels.
  blobRadius: number
  // At most this many new blobs per epoch, so a broadly hot mantle produces a
  // steady trickle of nuclei rather than carpeting the ocean in one step.
  maxPerEpoch: number
}

export const DEFAULT_NUCLEATION_PARAMS: NucleationParams = {
  upwellingThreshold: 0.70,
  persistenceEpochs: 5,
  occupiedFieldLevel: SHORELINE_FIELD,
  blobRadius: 70,
  maxPerEpoch: 4,
}

// Advances the per-cell upwelling streaks and returns the world positions where
// crust should nucleate this epoch. Mutates `streak` in place.
export function findNucleationSites(
  mantle: Float32Array,
  streak: Int16Array,
  rafts: Raft[],
  params: NucleationParams,
  random: () => number,
  width: number,
  height: number,
): { x: number; y: number }[] {
  const candidates: { x: number; y: number; streak: number }[] = []

  for (let gy = 0; gy < MANTLE_RES_Y; gy++) {
    const wy = ((gy + 0.5) / MANTLE_RES_Y) * height
    for (let gx = 0; gx < MANTLE_RES_X; gx++) {
      const i = gy * MANTLE_RES_X + gx
      if (mantle[i] < params.upwellingThreshold) {
        streak[i] = 0
        continue
      }
      streak[i] += 1
      if (streak[i] < params.persistenceEpochs) continue

      // The ocean condition. Without it this whole function is a feedback loop.
      const wx = ((gx + 0.5) / MANTLE_RES_X) * width
      if (raftField(wx, wy, rafts, width, height) > params.occupiedFieldLevel) continue

      candidates.push({ x: wx, y: wy, streak: streak[i] })
    }
  }

  // Longest-standing upwellings first — the ones that have had the most time to
  // build a plateau — then cut to the per-epoch budget.
  candidates.sort((a, b) => b.streak - a.streak)
  const chosen = candidates.slice(0, params.maxPerEpoch)

  // Reset the streak where crust was actually placed, so the same cell doesn't
  // immediately re-fire next epoch; the new crust will suppress it via the ocean
  // test anyway, but this keeps the streak field honest.
  for (const c of chosen) {
    const gx = Math.min(MANTLE_RES_X - 1, Math.floor((c.x / width) * MANTLE_RES_X))
    const gy = Math.min(MANTLE_RES_Y - 1, Math.floor((c.y / height) * MANTLE_RES_Y))
    streak[gy * MANTLE_RES_X + gx] = 0
  }

  // Jitter within the cell so nuclei don't sit on a visible 128×64 grid.
  const cellW = width / MANTLE_RES_X
  const cellH = height / MANTLE_RES_Y
  return chosen.map((c) => ({
    x: c.x + (random() - 0.5) * cellW,
    y: c.y + (random() - 0.5) * cellH,
  }))
}

// Places a nucleated blob: welded onto a nearby raft if one is within reach,
// otherwise it starts a new continent. That second case is the whole difference
// from accreteToNearestRaft, which only ever grows an existing raft — in the
// Archean the first crust has nothing to attach to.
export function nucleateCrust(
  rafts: Raft[],
  site: { x: number; y: number },
  epoch: number,
  blobRadius: number,
  attachDistSq: number,
  width: number,
  height: number,
): void {
  const blob: RaftBlob = { x: site.x, y: site.y, radius: blobRadius, birthEpoch: epoch }
  let nearest = -1
  let nearestDistSq = Infinity
  for (let i = 0; i < rafts.length; i++) {
    for (const b of rafts[i].blobs) {
      const d = toroidalDistanceSq(site.x, site.y, b.x, b.y, width, height)
      if (d < nearestDistSq) { nearestDistSq = d; nearest = i }
    }
  }
  if (nearest >= 0 && nearestDistSq <= attachDistSq) {
    rafts[nearest].blobs.push(blob)
    return
  }
  rafts.push({ id: rafts.reduce((max, r) => Math.max(max, r.id), -1) + 1, name: null, blobs: [blob] })
}

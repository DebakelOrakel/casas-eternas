import type { ArcheanSimulation } from './archeanState'
import type { Raft } from '../crust/raftTypes'
import { mulberry32 } from '../core/rng'
import { MANTLE_RES_X, MANTLE_RES_Y } from '../mantle/mantleField'

// Saving a world that is still in the Archean.
//
// The phase is explicitly a PAUSE rather than an ending — you stop it, look, and carry
// on — so a world should be savable there. It was not: `handleSerializeWorld` returns
// early unless a PlateSimulation exists, and during the Archean none does yet, so the
// save button posted its message and nothing came back. No file, no error.
//
// Replaying from the recipe would be tidier still, since the phase is deterministic in
// (seed, mantle diffusion, water, epochs) — but an Archean epoch costs enough that a
// few hundred of them is far too slow to sit through on load. So it is a snapshot.
//
// The two rasters travel outside the JSON, like the tectonic snapshot's own: JSON
// numbers would roughly triple their size and cost precision for nothing.
export interface ArcheanSnapshot {
  width: number
  height: number
  epoch: number
  warpSeed: number
  seaLevelOffset: number
  rafts: Raft[]
  rngState: number
}

export function serializeArchean(archean: ArcheanSimulation): ArcheanSnapshot {
  return {
    width: archean.width,
    height: archean.height,
    epoch: archean.epoch,
    warpSeed: archean.warpSeed,
    seaLevelOffset: archean.seaLevelOffset,
    rafts: archean.rafts,
    rngState: archean.random.state(),
  }
}

export function deserializeArchean(snap: ArcheanSnapshot, mantle: Float32Array, streak: Int16Array): ArcheanSimulation {
  return {
    width: snap.width,
    height: snap.height,
    epoch: snap.epoch,
    warpSeed: snap.warpSeed,
    seaLevelOffset: snap.seaLevelOffset ?? 0,
    rafts: snap.rafts,
    random: mulberry32(snap.rngState),
    // Sized from the current resolution rather than trusted from the file: a save from
    // a different mantle grid restores its rafts and starts the streaks over, instead
    // of writing past the end of the array.
    mantle: mantle.length === MANTLE_RES_X * MANTLE_RES_Y ? mantle : new Float32Array(MANTLE_RES_X * MANTLE_RES_Y),
    upwellingStreak: streak.length === MANTLE_RES_X * MANTLE_RES_Y ? streak : new Int16Array(MANTLE_RES_X * MANTLE_RES_Y),
    // Per-epoch readouts, not state — they are recomputed on the next step.
    lastRecycled: 0,
    lastSplits: 0,
  }
}

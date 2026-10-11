import type { ArcheanSimulation } from './archeanState'
import type { Raft } from '../crust/raftTypes'
import { mulberry32 } from '../core/rng'
import { domainOfKind, type Domain } from '../core/domain'
import { createMantleField, mantleMesh, restoreMantleField } from '../mantle/mantleField'
import type { SavedField } from '../fields/fieldMesh'

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
// The mantle and its streaks travel outside the JSON, like the tectonic snapshot's: JSON
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

// `shape`: the world's, from its save's kind — the snapshot does not carry it.
// `mantle`: the field as the save holds it, the mesh's own values
// (restoreMantleField refuses another mesh's). `streak` is per mesh cell;
// one of another length starts the streaks over.
export function deserializeArchean(snap: ArcheanSnapshot, mantle: SavedField | undefined, streak: Int16Array, shape: Domain['kind'] = 'torus'): ArcheanSimulation {
  const domain = domainOfKind(shape, snap.width, snap.height)
  const cells = mantleMesh(domain).mesh.count
  return {
    width: snap.width,
    height: snap.height,
    domain,
    epoch: snap.epoch,
    warpSeed: snap.warpSeed,
    seaLevelOffset: snap.seaLevelOffset ?? 0,
    rafts: snap.rafts,
    random: mulberry32(snap.rngState),
    // Sized from the current mesh rather than trusted from the file: a save from
    // a different mantle grid restores its rafts and starts the streaks over, instead
    // of writing past the end of the array. A save with no field at all gets a
    // fresh one from an RNG of its own, so `random` is not disturbed.
    mantle: restoreMantleField(domain, mantle) ?? createMantleField(mulberry32((snap.warpSeed ^ 0x5bd1e995) >>> 0), domain),
    upwellingStreak: streak.length === cells ? streak : new Int16Array(cells),
    // Per-epoch readouts, not state — they are recomputed on the next step.
    lastRecycled: 0,
    lastSplits: 0,
  }
}

import type { Raft } from '../crust/raftTypes'

// Saving a world that is still in the Archean.
//
// The phase is explicitly a PAUSE rather than an ending — you stop it, look, and carry
// on — so a world should be savable there. It was not: `handleSerializeWorld` returns
// early unless a PlateSimulation exists, and during the Archean none does yet, so the
// save button posted its message and nothing came back. No file, no error.
//
// Replaying from the recipe would be tidier still, since the phase is deterministic in
// (seed, mantle diffusion, land share, epochs) — but an Archean epoch costs enough that a
// few hundred of them is far too slow to sit through on load. So it is a snapshot.
//
// The mantle and its streaks travel outside the JSON, like the tectonic snapshot's: JSON
// numbers would roughly triple their size and cost precision for nothing.
export interface ArcheanSnapshot {
  width: number
  height: number
  epoch: number
  warpSeed: number
  // The land share controller's credit (ArcheanSimulation.nucleationCredit).
  nucleationCredit: number
  rafts: Raft[]
  rngState: number
}

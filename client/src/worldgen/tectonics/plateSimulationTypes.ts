import type { PlateSeed } from './plateSeeds'
import type { PlateMotion } from './plateMotion'
import type { PlateType } from './plateTypes'
import type { TerrainFeature } from './terrainFeatures'
import type { LatticePoint } from './boundaryLattice'
import type { Raft, Suture } from '../crust/raftTypes'
import type { SeededRandom } from '../core/rng'

// The simulation's data shapes and its event vocabulary, held apart from the code
// that operates on them. This is what lets the per-epoch phases live in epoch/
// without a cycle: a phase needs to know what a PlateSimulation IS, while
// plateSimulation.ts needs to CALL the phases. With the types in the middle both
// point inward and nothing points back.
//
// plateSimulation.ts re-exports all of this, so nothing outside tectonics/ had to
// change its imports.

export interface PlateSimulation {
  width: number
  height: number
  // Plate count as configured at creation — the target the plate-count
  // homeostasis (PLATE_COUNT_PRESSURE_STRENGTH) steers back toward as
  // rift/merge events change seeds.length over time.
  initialPlateCount: number
  seeds: PlateSeed[]
  // Continental crust as persistent metaball rafts, decoupled from the
  // plates (see rafts.ts / docs/decisions/continental-crust-rafts.md). Rafts
  // are the source of truth for land now; `types` below is a compatibility
  // shim derived from them so the existing classification/event/rift-merge
  // code keeps working.
  rafts: Raft[]
  // Derived from rafts each epoch (a plate is continental if a raft covers
  // its seed) — a bridge for the crust-type-consuming code, not an
  // independent state, and slated to be removed once those consumers read
  // rafts directly.
  types: PlateType[]
  motions: PlateMotion[]
  ages: number[]
  features: TerrainFeature[]
  epoch: number
  // Epochs the Archean phase ran before this simulation was handed over, so the
  // world-age readout stays continuous across the two phases (they run on
  // different Ma-per-epoch scales — see core/worldTime). 0 for worlds built the
  // old way, straight from createPlateSimulation.
  archeanEpochs: number
  random: SeededRandom
  // Seeds the coastline/contour domain-warp noise (domainWarp.ts) —
  // derived from the same world seed string but kept independent of
  // `random` above, since that generator's output sequence is order-
  // sensitive (every plate-generation call consumes from it) and warp
  // noise needs to be a pure, repeatable function of position alone, not
  // dependent on how many other random values happened to be drawn first.
  warpSeed: number
  // Fixed lattice + persistent per-point state, all keyed by lattice
  // index (stable across epochs — see boundaryLattice.ts). Used only to
  // trigger rift/merge, never rendered directly — mirrors the sphere
  // version's separate detection-grid store vs. its rendered
  // terrainFeatures, kept apart here for the same reason: the rift/merge
  // trigger needs a *signed* accumulator (extension goes negative), while
  // rendered thickness (terrainFeatures.ts) never should.
  lattice: LatticePoint[]
  latticeAccumulated: Float32Array
  latticeLockedEpochs: Int16Array
  latticeLastClassCode: Int8Array
  // Coarse ocean-floor age field (oceanAge.ts) driving age-depth in the
  // baseline — advected with plate motion each epoch, reset to 0 at divergent
  // boundaries. Continental (raft-covered) points ignore it.
  oceanAge: Float32Array
  // Hysteresis latch for the supercontinent_formed event: true once all
  // rafts have assembled into one, cleared again only after breakup pushes
  // the count back up, so the milestone fires once per assembly, not every
  // epoch the single raft persists. Seeded from the initial raft count so a
  // single-craton start doesn't spuriously fire at epoch 0.
  supercontinentActive: boolean
  // Epoch until which no continental rift may fire — set after each one to
  // space breakups out (see CONT_RIFT_COOLDOWN_EPOCHS). 0 = ready.
  continentalRiftCooldownUntil: number
  // Coarse evolving mantle buoyancy field the plates ride on (mantleField.ts) —
  // continents insulate it (→ upwelling → breakup), ocean cools it (→ downwelling
  // → assembly). Plate motions are re-fit to its surface flow each epoch.
  mantle: Float32Array
  // Fixed mantle-plume points (world coords), stationary in the deep-mantle frame
  // while plates drift OVER them — each punches a volcano onto the overlying plate
  // every epoch, so the plate carries a chain away (a hotspot trail, Hawaii-style;
  // Phase M3). Fixed for the world's life.
  hotspots: { x: number; y: number }[]
  // Accumulated collision-belt history: every raft suture ever formed, kept for
  // the world's life (unlike terrain features, which get pruned). The Ecology
  // layer reads these as the provenance for tin / lode gold / metamorphic gems —
  // deep-time orogens that the pruned mountain features no longer record. See
  // rafts.ts Suture and docs/decisions/ecology.md P1.
  sutures: Suture[]
}

// A JSON-serializable snapshot of a running simulation — everything needed to
// reconstruct it and CONTINUE from exactly where it was (see the save/load
// world feature). Deliberately excludes: `types` (derived from rafts), the
// detection lattice (regenerated + its accumulators reset on restore — a rift
// or merge just needs to re-lock over a few epochs, cheap), and `oceanAge`
// (carried separately as a binary float raster). The RNG's internal state is
// stored so continuation is bit-identical.
export interface PlateSimulationSnapshot {
  // Absent in saves written before the Archean phase existed; treated as 0.
  archeanEpochs?: number
  width: number
  height: number
  initialPlateCount: number
  seeds: PlateSeed[]
  motions: PlateMotion[]
  ages: number[]
  rafts: Raft[]
  features: TerrainFeature[]
  epoch: number
  warpSeed: number
  supercontinentActive: boolean
  continentalRiftCooldownUntil: number
  hotspots: { x: number; y: number }[]
  sutures: Suture[]
  rngState: number
}

// Two tiers, matching how they're surfaced (see the overlay/notification
// design): the `continent_*` events are the rare, narratively significant
// ones (the supercontinent cycle) — they get a notification AND a geologic
// map marker. The `oceanic_*` events are routine crust churn (a rift opening
// seafloor, a slab subducting) — frequent, so they feed the events *overlay*
// only, never a toast. `eventCategory` below classifies which is which.
export type SimEventType =
  | 'continent_collided'
  | 'continent_broke_up'
  | 'supercontinent_formed'
  | 'oceanic_created'
  | 'oceanic_subducted'

export function eventCategory(type: SimEventType): 'continent' | 'routine' {
  return type === 'oceanic_created' || type === 'oceanic_subducted' ? 'routine' : 'continent'
}

export interface SimEvent {
  type: SimEventType
  // Continent names involved (collision: the two continents; breakup: the
  // parent in `name`). Either may be absent for an unnamed raft.
  name?: string
  nameA?: string
  nameB?: string
  // Event location (seam point for a collision, rift point for a breakup,
  // boundary point for a routine crust event).
  x?: number
  y?: number
  // Marker line direction (unit): the suture tangent for a collision or the
  // rift axis for a breakup — the geologic line the map marker draws along.
  dirX?: number
  dirY?: number
  // Routine crust events still carry the plate indices the interim
  // worker-baked highlight uses; continent events use x/y + dir instead.
  plateIndex?: number
  // Set on oceanic_created when it came from a rift — the specific
  // flanking plate this new plate split away from, so a highlight can
  // trace just that one shared edge instead of the new plate's entire
  // boundary (which may end up touching other neighbors too).
  otherPlateIndex?: number
}

export interface RiftEvent {
  x: number
  y: number
  plateA: number
  plateB: number
}

// Which plate is actually removed (consumed) vs. which one survives and
// absorbs its territory — no longer always min/max by index, since a
// subducting oceanic plate must be the one removed regardless of which
// index it happens to hold (see stepEpoch's merge-resolution branch).
export interface MergeEvent {
  x: number
  y: number
  keepIndex: number
  removeIndex: number
}

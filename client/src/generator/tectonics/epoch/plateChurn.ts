import { pickUnusedRaftName } from '../../crust/raftNames'
import type { Raft, RaftBlob } from '../../crust/raftTypes'
import { generatePlateMotions } from '../plateMotion'
import type { PlateSeed } from '../plateSeeds'
import type { MergeEvent, PlateSimulation, RiftEvent, SimEvent } from '../plateSimulationTypes'
import type { BoundaryPassResult } from './boundaryPass'
import type { RaftEventResult } from './raftEvents'
import { detHypot } from '../../core/detMath'



// New crust at a rift starts as its own (oceanic) plate — a rifting
// continent doesn't split into two continental copies; it pulls apart
// and new (oceanic) crust forms in the widening gap, same as the real
// Atlantic opening between separating continents. The two original
// flanking plates keep their own type and simply keep moving apart under
// their existing motions; the new plate's Voronoi territory grows into
// that gap on its own as later epochs render it, no separate bookkeeping
// needed.
function applyRift(sim: PlateSimulation, event: RiftEvent): void {
  const newSeed: PlateSeed = { x: event.x, y: event.y }
  const newMotion = generatePlateMotions([newSeed], sim.width, sim.height, sim.random)[0]
  sim.seeds.push(newSeed)
  sim.types.push('oceanic')
  sim.motions.push(newMotion)
  sim.ages.push(0)
}

// Merging drops one of the two plates and reassigns anything attached to
// it to the survivor — the merged/overriding landmass's Voronoi
// territory then naturally absorbs the removed plate's former area on
// the next render, no explicit territory bookkeeping needed. keepIndex
// and removeIndex can come in either order now (a subducting oceanic
// plate might hold either a lower or higher index than the continental
// plate it's going under), so the index shift from splice(removeIndex)
// has to be resolved relative to keepIndex too, not just assumed to
// already be the smaller one.
function applyMerge(sim: PlateSimulation, event: MergeEvent): void {
  const { keepIndex, removeIndex } = event
  const newKeepIndex = keepIndex > removeIndex ? keepIndex - 1 : keepIndex
  const remapIndex = (index: number): number => (index === removeIndex ? newKeepIndex : index > removeIndex ? index - 1 : index)
  for (const feature of sim.features) {
    feature.plateA = remapIndex(feature.plateA)
    feature.plateB = remapIndex(feature.plateB)
    if (feature.movesWithPlate !== 'both') feature.movesWithPlate = remapIndex(feature.movesWithPlate)
  }
  sim.seeds.splice(removeIndex, 1)
  sim.types.splice(removeIndex, 1)
  sim.motions.splice(removeIndex, 1)
  sim.ages.splice(removeIndex, 1)
}

// A single point to anchor the supercontinent_formed marker/label on — the
// biggest blob's center, a cheap stand-in for the continent's visual middle
// (a proper toroidal centroid comes with per-raft labels in the overlay work).
function supercontinentAnchor(rafts: Raft[]): { x: number; y: number } | null {
  let best: RaftBlob | null = null
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      if (!best || blob.radius > best.radius) best = blob
    }
  }
  return best ? { x: best.x, y: best.y } : null
}

// Phase 5. Turn this epoch's continent-scale changes into events, then apply the
// routine plate churn (at most one rift and one merge). Order matters: the events
// are pushed BEFORE applyRift/applyMerge mutate the plate arrays the event
// payloads index into.
export function collectEventsAndApplyPlateChurn(sim: PlateSimulation, pass: BoundaryPassResult, rafts: RaftEventResult): SimEvent[] {
  const { riftEvent, mergeEvent } = pass
  const { raftMerges, raftSplit } = rafts
  const events: SimEvent[] = []

  // --- Continent-scale events (the supercontinent cycle) ---
  // These come from the raft lifecycle (sutures/rifts already applied
  // above), NOT the plate rift/merge below — a continent is a raft across
  // plates, so plate-count changes and continent events are decoupled.
  for (const m of raftMerges) {
    const len = detHypot(m.tangentX, m.tangentY) || 1
    events.push({ type: 'continent_collided', nameA: m.nameA ?? undefined, nameB: m.nameB ?? undefined, x: m.x, y: m.y, dirX: m.tangentX / len, dirY: m.tangentY / len })
  }
  if (raftSplit) {
    const len = detHypot(raftSplit.axisX, raftSplit.axisY) || 1
    events.push({ type: 'continent_broke_up', name: raftSplit.parentName ?? undefined, x: raftSplit.x, y: raftSplit.y, dirX: raftSplit.axisX / len, dirY: raftSplit.axisY / len })
  }
  // Supercontinent milestone, latched by supercontinentActive so it fires
  // once per assembly rather than every epoch the single raft persists.
  if (sim.rafts.length <= 1 && !sim.supercontinentActive) {
    sim.supercontinentActive = true
    // A newly-assembled supercontinent is a new entity — give it a fresh name (Pangaea,
    // Rodinia, …) rather than inheriting whichever surviving raft's name, so each
    // assembly reads as its own supercontinent.
    if (sim.rafts[0]) sim.rafts[0].name = pickUnusedRaftName(sim.rafts, sim.random)
    const anchor = supercontinentAnchor(sim.rafts)
    if (anchor) events.push({ type: 'supercontinent_formed', name: sim.rafts[0]?.name ?? undefined, x: anchor.x, y: anchor.y })
  } else if (sim.rafts.length >= 2) {
    sim.supercontinentActive = false
  }

  // --- Routine crust churn (events overlay only, never a notification) ---
  // At most one plate rift and one plate merge per epoch — both are rare
  // (locking takes LOCK_EPOCHS_REQUIRED epochs to even become eligible) and
  // this sidesteps the bookkeeping multiple simultaneous plate-count changes
  // in a single epoch would need.
  if (riftEvent) {
    // Which flank the new oceanic plate split away from — the continental
    // side if this rift was under a continent, else either flank (plateA).
    const continentalSide = sim.types[riftEvent.plateA] === 'continental' ? riftEvent.plateA : sim.types[riftEvent.plateB] === 'continental' ? riftEvent.plateB : riftEvent.plateA
    events.push({ type: 'oceanic_created', plateIndex: sim.seeds.length, otherPlateIndex: continentalSide, x: riftEvent.x, y: riftEvent.y })
    applyRift(sim, riftEvent)
  }

  if (mergeEvent) {
    if (sim.types[mergeEvent.removeIndex] === 'oceanic') {
      events.push({ type: 'oceanic_subducted', plateIndex: mergeEvent.keepIndex, x: mergeEvent.x, y: mergeEvent.y })
    }
    applyMerge(sim, mergeEvent)
  }
  return events
}

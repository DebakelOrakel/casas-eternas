import { toroidalDistanceSq, wrappedDelta } from '../../core/toroidal'
import { mergeOverlappingRafts, splitDisconnectedRafts, splitRaftAtRift } from '../../crust/raftLifecycle'
import { deservesContinentName, pickUnusedRaftName } from '../../crust/raftNames'
import type { RaftMergeEvent, RaftSplitEvent } from '../../crust/raftTypes'
import { coolMantleAt } from '../../mantle/mantleField'
import { resetOceanAgeAround } from '../oceanAge'
import { getVelocityAt } from '../plateMotion'
import type { PlateMotion } from '../plateMotion'
import { TECTONICS_TUNING } from '../tectonicsTuneParams'
import { MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR } from '../../crust/crustTuneParams'
import { findOrCreateFeatureIndex } from '../terrainFeatures'
import type { PlateSimulation } from '../plateSimulationTypes'
import type { BoundaryPassResult } from './boundaryPass'



// A continental breakup opens a real ocean basin: birth a young oceanic plate —
// a mid-ocean ridge — in the gap between the two separating halves (dynamic-
// boundaries / rift lifecycle, Option C; see docs/decisions/evolving-euler-poles.md).
// This is what retires the CONT_RIFT_COOLDOWN band-aid: once the rifted spot is
// its own oceanic plate (not the two continental seeds still adjacent+divergent),
// its raftMembership drops and it can no longer re-qualify as a continental rift,
// so it stops strobing on its own — no global timer needed. The new plate takes
// the MEAN velocity of the two flanks AT the rift point (pure drift, spin 0), so
// it sits centred between them and the basin opens symmetrically, Atlantic-style;
// the mantle coupling refines the motion next epoch. Ocean-floor age at the point
// is already reset to 0 by the divergent-boundary reset in the boundary loop, and
// advection then ages the new seafloor outward from the ridge.
function birthRidgePlate(sim: PlateSimulation, x: number, y: number, flankA: number, flankB: number): void {
  const vA = getVelocityAt({ x, y }, sim.motions[flankA], sim.width, sim.height)
  const vB = getVelocityAt({ x, y }, sim.motions[flankB], sim.width, sim.height)
  const motion: PlateMotion = {
    driftX: (vA.vx + vB.vx) / 2,
    driftY: (vA.vy + vB.vy) / 2,
    spin: 0,
    centroidX: x,
    centroidY: y,
  }
  sim.seeds.push({ x, y })
  sim.types.push('oceanic')
  sim.motions.push(motion)
  sim.ages.push(0)
}

export interface RaftEventResult {
  raftMerges: RaftMergeEvent[]
  raftSplit: RaftSplitEvent | null
}

// Phase 4. The raft (continent) lifecycle: collisions suture, a sustained
// continental rift tears a continent in two and opens an ocean basin in the gap,
// and any raft left as spatially separate clusters is decomposed.
export function applyRaftEvents(sim: PlateSimulation, pass: BoundaryPassResult): RaftEventResult {
  const { width, height } = sim
  const { boundaries, continentalRift } = pass
  // Continents that have drifted (or grown by accretion) into contact this
  // epoch suture into one (Phase 2c). Each suture is a continent-collision
  // event (name + seam geometry) for the notification/overlay layer.
  const raftMerges = mergeOverlappingRafts(sim.rafts, MERGE_OVERLAP_FACTOR, sim.epoch, width, height)
  // Persist each collision belt for the world's life — terrain features get
  // pruned, so this is the only durable record of deep-time orogens (Ecology
  // provenance for tin / lode gold / gems). Stamped with the current epoch
  // (pre-increment). Merges are rare/gated, so this list grows slowly.
  for (const m of raftMerges) {
    sim.sutures.push({ x: m.x, y: m.y, tangentX: m.tangentX, tangentY: m.tangentY, epoch: sim.epoch })
  }

  // Continental breakup: a sustained divergent point under a continent tears it
  // into two halves that the rift gap shoves apart (Phase 2d). Independent of
  // the plate rift below, which fires at oceanic ridges.
  let raftSplit: RaftSplitEvent | null = null
  if (continentalRift) {
    const cSeedA = sim.seeds[continentalRift.plateA]
    const cSeedB = sim.seeds[continentalRift.plateB]
    const cnx = wrappedDelta(cSeedA.x, cSeedB.x, width)
    const cny = wrappedDelta(cSeedA.y, cSeedB.y, height)
    const cnl = Math.sqrt(cnx * cnx + cny * cny) || 1
    const newRaftId = sim.rafts.reduce((max, raft) => Math.max(max, raft.id), -1) + 1
    raftSplit = splitRaftAtRift(sim.rafts, continentalRift.x, continentalRift.y, cnx / cnl, cny / cnl, newRaftId, TECTONICS_TUNING.splitMaxDistSq, TECTONICS_TUNING.splitGap, sim.epoch, TECTONICS_TUNING.splitMergeImmunityEpochs, width, height)
    // Reset that point's divergence accumulator so it doesn't immediately
    // re-split the fresh halves next epoch.
    if (raftSplit) {
      // Relieve the accumulated strain across the whole rifted ZONE, not just the
      // one fired point: the rupture reset the region's stress state, so every
      // boundary point near the rift must re-establish sustained divergence (re-lock
      // over TECTONICS_TUNING.contRiftLockEpochs) before it can rift again. This is the local,
      // physical replacement for the old global cooldown timer — together with the
      // mantle release below (which removes the FORCING that would re-lock them), it
      // stops the broad hot dome under a supercontinent from strobing a breakup every
      // epoch. See the TECTONICS_TUNING.riftResetRadius const.
      const rr2 = TECTONICS_TUNING.riftResetRadius * TECTONICS_TUNING.riftResetRadius
      for (const b of boundaries) {
        if (toroidalDistanceSq(b.x, b.y, continentalRift.x, continentalRift.y, width, height) <= rr2) {
          // Negative lock = a passive-margin recovery delay: needs
          // TECTONICS_TUNING.riftMarginRecoveryEpochs + TECTONICS_TUNING.contRiftLockEpochs of sustained
          // divergence to rift again. Local, so a separate supercontinent is unaffected.
          sim.latticeLockedEpochs[b.latticeIndex] = -TECTONICS_TUNING.riftMarginRecoveryEpochs
          sim.latticeAccumulated[b.latticeIndex] = 0
        }
      }
      // Global breakup-staging interval (halved to 20; the zone reset + mantle release
      // above cut the local strobing, but a coherent supercontinent still needs a global
      // rate-limit — see TECTONICS_TUNING.contRiftCooldownEpochs).
      sim.continentalRiftCooldownUntil = sim.epoch + TECTONICS_TUNING.contRiftCooldownEpochs
      // The far half is a brand-new continent — give it its own name (the near half
      // keeps the parent's), so split-born continents aren't left unnamed on the map.
      // Unless it is a splinter: the same size rule the hand-off applies, or a rift
      // that shears off one blob would put a continent's name on an island.
      const newRaft = sim.rafts.find((raft) => raft.id === newRaftId)
      if (newRaft) {
        const areas = sim.rafts.map((raft) => raft.blobs.reduce((sum, b) => sum + b.radius * b.radius, 0))
        const total = areas.reduce((a, b) => a + b, 0)
        const own = newRaft.blobs.reduce((sum, b) => sum + b.radius * b.radius, 0)
        if (deservesContinentName(own, total)) newRaft.name = pickUnusedRaftName(sim.rafts, sim.random)
      }
      // Flood-basalt province at the breakup: one big volcanic deposit along the
      // rift line (tangent ⟂ the seed-to-seed normal), riding one half. See M3.
      const fbTangentX = -cny / cnl
      const fbTangentY = cnx / cnl
      const fbIdx = findOrCreateFeatureIndex(sim.features, continentalRift.x, continentalRift.y, continentalRift.plateA, -2, continentalRift.plateA, fbTangentX, fbTangentY, 'range', false, width, height)
      sim.features[fbIdx].thickness += TECTONICS_TUNING.floodBasaltDeposit
      sim.features[fbIdx].epochsSinceDeposit = 0
      // Open a real ocean basin in the gap: a young oceanic plate (mid-ocean
      // ridge) is born between the two halves (Option C, the rift lifecycle).
      birthRidgePlate(sim, continentalRift.x, continentalRift.y, continentalRift.plateA, continentalRift.plateB)
      // The whole gap the split just opened is brand-new seafloor, so it starts at
      // age 0 — a young, shallow basin. The per-boundary-point reset above is far
      // too narrow to cover a breakup's gap on its own, and without this the new
      // basin inherits the age that kept ticking under the continent and renders at
      // full abyssal depth: a newborn Atlantic as deep as the oldest Pacific.
      resetOceanAgeAround(sim.oceanAge, continentalRift.x, continentalRift.y, TECTONICS_TUNING.breakupFreshCrustRadius, width, height)
      // Release the thermal doming that drove the breakup — this is what actually
      // retires the global cooldown: it collapses the broad divergent forcing under
      // the (former) supercontinent so neighbouring points stop re-qualifying.
      coolMantleAt(sim.mantle, continentalRift.x, continentalRift.y, width, height, TECTONICS_TUNING.riftCoolRadius, TECTONICS_TUNING.riftCoolAmount)
    }
  }

  // Rendering/identity cleanup: a raft whose blobs have drifted into spatially
  // separate clusters (renders as several landmasses under one name) is
  // decomposed into one named continent per cluster. No events — this isn't a
  // tectonic breakup, just keeping "one raft = one visible landmass".
  splitDisconnectedRafts(sim.rafts, RAFT_CONNECT_FACTOR, sim.random, width, height)
  return { raftMerges, raftSplit }
}

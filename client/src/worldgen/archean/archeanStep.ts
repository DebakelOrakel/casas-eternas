import type { ArcheanSimulation } from './archeanState'
import type { NucleationParams } from './crustNucleation'
import { DEFAULT_NUCLEATION_PARAMS, findNucleationSites, nucleateCrust } from './crustNucleation'
import { computeMembershipField } from '../crust/raftField'
import { advanceRaftsOnFlow, mergeOverlappingRafts, recycleUnstabilisedCrust, splitDisconnectedRafts } from '../crust/raftLifecycle'
import { evolveMantleField, computeMantleFlow, sustainMantleVigour, MANTLE_RES_X, MANTLE_RES_Y } from '../tectonics/mantleField'
import { MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR } from '../tectonics/tectonicsParams'

export interface ArcheanParams {
  nucleation: NucleationParams
  // Target RMS amplitude the mantle is held at each epoch. Without it the field
  // decays to nothing on a crustless planet — see sustainMantleVigour.
  mantleRms: number
  // How far a new nucleus may be from existing crust and still weld onto it rather
  // than starting its own continent. Beyond this it is a separate proto-continent.
  attachDistSq: number
  // Recycling gates — deliberately NOT the tectonic phase's STABILISATION_EPOCHS
  // and RECYCLE_DOWNWELLING_THRESHOLD.
  //
  // Reusing those was the first attempt and it produced crust with an age spread of
  // three epochs: everything was destroyed about as fast as it formed. The reason is
  // that the two phases run the mantle at different amplitudes. In the tectonic phase
  // the field is whatever the insulation feedback sustains; here it is renormalised
  // to mantleRms, so a threshold of -0.05 selects nearly half the surface — and since
  // the flow carries crust from its birth upwelling toward a downwelling, essentially
  // every blob transits into the kill zone before it can stabilise.
  //
  // The Archean therefore needs its own pair: a stricter downwelling test (only
  // genuinely cold mantle recycles) and a shorter road to immunity (crust must be
  // able to survive the transit).
  stabilisationEpochs: number
  recycleThreshold: number
}

export const DEFAULT_ARCHEAN_PARAMS: ArcheanParams = {
  nucleation: DEFAULT_NUCLEATION_PARAMS,
  mantleRms: 0.4,
  attachDistSq: 190 * 190,
  stabilisationEpochs: 25,
  recycleThreshold: -0.45,
}

// One Archean epoch.
//
// Deliberately short, because almost everything it needs already exists: the
// mantle evolution and flow solve are the same ones that drive the plates, and
// merging, fragmenting and recycling are the same raft-lifecycle operations the
// tectonic phase uses. What is genuinely new is only nucleation (crustNucleation)
// and flow advection (advanceRaftsOnFlow).
//
// Order matters and is not arbitrary:
//
//  1. **Mantle first**, so everything downstream sees this epoch's convection.
//  2. **Drift before nucleation**, so a nucleus is placed against where the crust
//     IS, not where it was.
//  3. **Nucleation before recycling**, so brand-new crust is exposed to
//     destruction immediately rather than getting a free epoch — otherwise the
//     equilibrium sits higher than the parameters say it should.
//  4. **Merge and fragment last**, on the settled geometry.
export function archeanStep(sim: ArcheanSimulation, params: ArcheanParams = DEFAULT_ARCHEAN_PARAMS): void {
  const { width, height } = sim

  // 1. Convection. Crust insulates the mantle beneath it exactly as it does in the
  // tectonic phase — which is what eventually turns a craton into the dome that
  // rifts it, and also why nucleation must exclude cells that already hold crust.
  const membership = computeMembershipField(sim.rafts, MANTLE_RES_X, MANTLE_RES_Y, width, height)
  sim.mantle = evolveMantleField(sim.mantle, membership, MANTLE_RES_X, MANTLE_RES_Y, width, height)
  // Internal heating keeps convection running; without it the field decays to
  // nothing on a planet that has no crust yet. See sustainMantleVigour.
  sim.mantle = sustainMantleVigour(sim.mantle, params.mantleRms)
  const flow = computeMantleFlow(sim.mantle)

  // 2. Crust rides the convection directly. No plates exist yet.
  advanceRaftsOnFlow(sim.rafts, flow, MANTLE_RES_X, MANTLE_RES_Y, width, height)

  // 3. New crust over persistent upwellings that are still ocean.
  const sites = findNucleationSites(sim.mantle, sim.upwellingStreak, sim.rafts, params.nucleation, sim.random, width, height)
  for (const site of sites) {
    nucleateCrust(sim.rafts, site, sim.epoch, params.nucleation.blobRadius, params.attachDistSq, width, height)
  }

  // 4. Recycling — the same sink the tectonic phase uses, and the reason crust
  // production settles at an equilibrium instead of carpeting the planet.
  sim.lastRecycled = recycleUnstabilisedCrust(
    sim.rafts, sim.mantle, MANTLE_RES_X, MANTLE_RES_Y, sim.epoch,
    params.stabilisationEpochs, params.recycleThreshold, width, height,
  )

  // 5. Collisions weld, and crust pulled across two convection cells falls apart
  // into separate continents. The merge events are discarded here: sutures are a
  // tectonic-phase concept, and stamping them with Archean epochs would put them on
  // a different clock from the ones the Ecology layer already consumes.
  mergeOverlappingRafts(sim.rafts, MERGE_OVERLAP_FACTOR, sim.epoch, width, height)
  splitDisconnectedRafts(sim.rafts, RAFT_CONNECT_FACTOR, sim.random, width, height)

  sim.epoch += 1
}

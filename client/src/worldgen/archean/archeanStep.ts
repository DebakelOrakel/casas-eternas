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
  // **The mantle-vigour knob.** How much the mantle stirs each epoch, in blur passes
  // (fractional allowed). More stirring smooths the buoyancy field into fewer, broader
  // convection cells, so crust collects into fewer and larger continents.
  //
  // This is the knob because it is REAPPLIED every epoch. The slider used to set the
  // field's initial smoothing instead, and that washed out — this very diffusion
  // erased it, leaving a control that measurably did nothing by the time anyone
  // stopped the phase (see DEFAULT_INITIAL_SMOOTHING).
  //
  // Measured at 250 epochs over two seeds — plates, then the largest landmass as a
  // share of all land:
  //
  //     0.0 -> 26/24 plates,  8-10% in the biggest mass   (busy archipelago world)
  //     1.0 -> 12/ 8 plates,  10-11%
  //     2.0 ->  7/ 4 plates,  16-24%
  //     3.0 ->  7/ 6 plates,  13-26%                      (saturating)
  //
  // Land fraction does NOT follow it monotonically, which is the point: how much land
  // there is stays the water slider's job. Saturates past ~3, so that is the range's
  // top end.
  diffusion: number
  // How rigidly a craton moves: 1 = a rigid plate carried by the mean flow under it,
  // 0 = every blob advected by its own local flow. See advanceRaftsOnFlow for what
  // this fixes and why it deliberately stops short of 1 (differential motion is the
  // Archean's only break-up mechanism — there are no plates to rift yet).
  raftRigidity: number
}

export const DEFAULT_ARCHEAN_PARAMS: ArcheanParams = {
  nucleation: DEFAULT_NUCLEATION_PARAMS,
  mantleRms: 0.4,
  // Matches the tectonic phase's DIFFUSION_PASSES, so the default Archean stirs the
  // mantle exactly as hard as the tectonic phase does.
  diffusion: 1,
  // Swept over two seeds at 250 epochs. Largest contiguous landmass as a share of all
  // land, number of separate masses, and break-ups per 100 epochs:
  //
  //     rigidity   biggest mass    masses    break-ups
  //       0.00      10-11%          48/46     555/518     <- the old behaviour
  //       0.50      18-27%          29/30     272/295
  //       0.80      23-25%          28/23     200/177
  //       0.90      27-41%          12/18     129/123
  //       0.95      43-70%          12/12      95/ 98
  //       1.00      65-85%           7/ 7      64/ 69
  //
  // The worry that a rigid craton could never break up again turned out to be
  // unfounded: recycleUnstabilisedCrust eats blobs out of a raft's middle and
  // disconnects it that way, so break-ups survive even at 1.0. There is no trade-off
  // to balance here — the old value was simply shredding the crust.
  //
  // 0.95 rather than 1.0 all the same, because at exactly 1.0 the differential term is
  // zero and the only remaining way to break a continent is to have its middle
  // recycled away. Being pulled apart across two convection cells — the mechanism
  // archeanStep describes as THE Archean break-up — needs a non-zero differential, and
  // the measurement shows it still contributes at 0.95 (95 break-ups against 64).
  raftRigidity: 0.95,
  attachDistSq: 190 * 190,
  stabilisationEpochs: 25,
  // -0.60, from -0.45 (2026-08-06): only genuinely cold downwellings recycle.
  // At -0.45 the continents assembled far too late — measured over two seeds
  // (largest CONNECTED landmass as a share of land, at the realistic ~300-epoch
  // Archean length): 17-35% connected on 3-22% land, with true assembly
  // (73-97% connected) only arriving at epochs 500-600 — twice the real
  // Archean's duration, and after the stabilised gauge had long read "late".
  // At -0.60: 78-84% connected on 32-52% land at epoch 300, while the
  // stabilised clock stays closest to its calibrated banner thresholds (the
  // stabilisationEpochs 25->15 alternative assembled equally fast but pushed
  // the gauge to 75-86% by epoch 200, collapsing the advertised archipelago
  // window). Side effect: more land overall — that is the water knob's job.
  recycleThreshold: -0.6,
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
  sim.mantle = evolveMantleField(sim.mantle, membership, MANTLE_RES_X, MANTLE_RES_Y, width, height, params.diffusion)
  // Internal heating keeps convection running; without it the field decays to
  // nothing on a planet that has no crust yet. See sustainMantleVigour.
  sim.mantle = sustainMantleVigour(sim.mantle, params.mantleRms)
  const flow = computeMantleFlow(sim.mantle)

  // 2. Crust rides the convection directly. No plates exist yet.
  advanceRaftsOnFlow(sim.rafts, flow, MANTLE_RES_X, MANTLE_RES_Y, width, height, params.raftRigidity)

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
  sim.lastSplits = splitDisconnectedRafts(sim.rafts, RAFT_CONNECT_FACTOR, sim.random, width, height, false)

  sim.epoch += 1
}

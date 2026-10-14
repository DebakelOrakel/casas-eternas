import type { ArcheanSimulation } from './archeanState'
import type { NucleationParams } from './crustNucleation'
import { DEFAULT_NUCLEATION_PARAMS, findNucleationSites, nucleateCrust } from './crustNucleation'
import { archeanLandAim, archeanLandShare, nucleationBudget, type LandShareParams } from './archeanLand'
import { advanceRaftsOnFlow, compactRafts, consolidateRaftBlobs, mergeOverlappingRafts, recycleUnstabilisedCrust, splitDisconnectedRafts } from '../crust/raftLifecycle'
import { evolveMantleField, computeMantleFlow, sustainMantleVigour, mantleAt, mantleFlowAt } from '../mantle/mantleField'
import { MERGE_OVERLAP_FACTOR, RAFT_CONNECT_FACTOR } from '../crust/crustTuneParams'
import { sq } from '../core/detMath'

export interface ArcheanParams {
  nucleation: NucleationParams
  // THE LAND SHARE LEVER (DEC-0036 phase 8b-1): the land the Archean steers
  // its nucleation toward, a fraction of the world's area — the
  // genesis.landShare control's (world/runParams.landShareFromControl), a
  // run parameter as `diffusion` is. See archeanLand.ts.
  landShare: number
  land: LandShareParams
  // Target RMS amplitude the mantle is held at each epoch. Without it the field
  // decays to nothing on a crustless planet — see sustainMantleVigour.
  mantleRms: number
  // How far a new nucleus may be from existing crust and still weld onto it rather
  // than starting its own continent. Beyond this it is a separate proto-continent.
  // Metres (DEC-0036 phase 8a; squared in units at the use).
  attachDistM: number
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
  // there is is the land share's job. Saturates past ~3, so that is the range's
  // top end.
  diffusion: number
  // How rigidly a craton moves: 1 = a rigid plate carried by the mean flow under it,
  // 0 = every blob advected by its own local flow. See advanceRaftsOnFlow for what
  // this fixes and why it deliberately stops short of 1 (differential motion is the
  // Archean's only break-up mechanism — there are no plates to rift yet).
  raftRigidity: number
  // Fraction of a blob's excess distance beyond its raft's equivalent-disc
  // radius pulled back toward the centroid each epoch — the rounding force
  // that keeps continents from staying the strings the linear downwelling
  // zones aggregate them into. See compactRafts. 0 disables.
  compaction: number
  // Blob consolidation (see consolidateRaftBlobs): near-concentric pairs of
  // STABILISED blobs merge when within this fraction of the smaller radius,
  // up to consolidateMaxRadiusM (metres, DEC-0036 phase 8a). 0 disables.
  consolidateProximity: number
  consolidateMaxRadiusM: number
}

export const DEFAULT_ARCHEAN_PARAMS: ArcheanParams = {
  nucleation: DEFAULT_NUCLEATION_PARAMS,
  // The control's default, 30 %.
  landShare: 0.3,
  land: {
    // 800 Ma: 160 epochs of ARCHEAN_MA_PER_EPOCH. Not the 1000 Ma a
    // player stops at: the plates recycle crust younger than their
    // stabilisation age (150 Ma, TECTONICS_TUNING.stabilisationEpochs) over
    // a downwelling, and a climb that ended at 1000 Ma handed them its
    // youngest crust — 40 epochs into the history the land of a world
    // stopped at 1000 Ma stood 4–5 points below one stopped at 1500 Ma
    // (torus, 12 seeds). Ending at 800 Ma, the two agree within 1.5 points.
    reachEpoch: 160,
    // A tenth of the deficit a step once there: the land held within about
    // ±2 points from 1000 to 2500 Ma (measured below).
    holdEpochs: 10,
    // The land a nucleus adds NET: 0.03 Mkm², a twentieth of a lone
    // nucleus's land (546 km blob, 0.73 % of the torus's 127.6 Mkm² as a
    // disc, 0.16 % above the sea): most nuclei weld onto crust that is
    // already land, and young crust over a downwelling is recycled. Swept
    // 2026-10-12 at 2048 × 1024, the target 30 % and the climb to 1000 Ma,
    // three or four seeds per shape, land at 500 / 1000 Ma:
    //
    //     nucleusLandM2   torus           sphere
    //     30 000 km²      15–20 / 25–30   13–19 / 28–30   <- chosen
    //     60 000 km²      10–11 / 26–28   8–11 / 22–29
    //     120 000 km²     3–6 / 25–27     6–8 / 20–24
    //
    // Larger values under-ask early and catch up at the cap just before the
    // reach epoch; 30 000 makes the climb close to the straight ramp.
    nucleusLandM2: 30_000e6,
    // The history's toll, measured 2026-10-12 (12 seeds per shape, 2048 ×
    // 1024, the hand-over at 1000 Ma, then 40 epochs of the plates alone —
    // the coupled history's land agreed with it within 0.5 points): the
    // land after 40 epochs against the land the Archean handed over —
    //
    //     handed over    torus    sphere
    //     15 %           15.4     14.4
    //     30 %           27.7     25.8
    //     35 %           32.3     30.2
    //     40 %           38.1     31.7
    //     46 %           36.0     37.3
    //
    // Nothing at 15 %, about a quarter of the excess above it: an aim of
    // T + 0.27 (T − 15 %) lands both shapes within ±3 points of T. The
    // sphere loses more than the torus — perhaps its plates, which move in
    // domain units and so 25 % further in metres (DEC-0036 phase 8a; not
    // measured) —; one aim for both, between them. `npm run calibrate`
    // with the aim, the land after 40 coupled epochs, median (p10–p90):
    //
    //     target  stopped at   torus              sphere
    //     15 %    1000 Ma      15.8 (12.8–19.0)   13.8 (12.2–17.8)
    //             1500 Ma      17.7 (14.3–20.0)   14.8 (12.1–17.5)
    //     30 %    1000 Ma      31.0 (26.5–35.4)   28.0 (24.1–31.7)
    //             1500 Ma      31.5 (26.7–34.0)   30.1 (28.3–33.8)
    //     40 %    1000 Ma      37.4 (33.3–47.0)   37.3 (33.7–41.5)
    //             1500 Ma      41.8 (38.3–45.2)   37.7 (32.3–40.4)
    historyFrom: 0.15,
    historySlope: 0.27,
    // Phase 8g (2026-10-14, npm run calibrate, 3 seeds per shape; the
    // table in docs/decisions/fields-on-meshes.md): the history's 40
    // epochs take 5–9 points of a 40 % world on the torus and 8–10 on the
    // sphere, 0–5 of a 30 % one, so the toll rises faster than the line
    // above above 30 %. With the steeper aim and the ceiling below, the
    // Archean hands over 45–49 % (42–46 before) and a 40 % world ends at
    // 39.0 / 37.1 % (median of 3, torus / sphere; 36.4 / 34.6 before).
    // Nothing changes at or below 30 %.
    historySteepFrom: 0.3,
    historySteepSlope: 0.25,
    // 1.3 × the 30 % aim's ramp (9.05 nuclei an epoch) is 11.8, under the
    // nucleation's 12: the 30 % and 15 % worlds keep their ceiling.
    ceilingOverRamp: 1.3,
  },
  mantleRms: 0.4,
  // Matches the tectonic phase's MANTLE_TUNING.diffusionPasses, so the default Archean stirs the
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
  // Swept over two seeds at epoch 300, isoperimetric Q of the largest
  // landmass (grid disc ≈ 1.6; the "wie beim Bleigießen" strings measured
  // 24-35 without compaction):
  //
  //     rate    largest-mass Q    land
  //     0.00      23.9 / 34.7     32 / 52%
  //     0.03      14.1 / 25.0     20 / 32%
  //     0.06      11.6 / 11.0     22 / 26%    <- massif with bays
  //     0.10      15.9 / 13.8     24 / 23%    (over-pulling churns it back up)
  //
  // 0.06 also pulls total land back toward Earth-like — rounder masses carry
  // less margin-band area than sprawling strings do.
  compaction: 0.06,
  // Swept over two seeds (Q = largest-mass isoperimetric quotient, blob
  // count = the raftField query cost everything from rendering to membership
  // sweeps scales with):
  //
  //                        e300 Q      e300 blobs    e500 blobs
  //     off                11.6/11.0    332/534       634/920
  //     prox 0.4 cap 150    8.4/12.1    157/188       296/286   <- chosen
  //     prox 0.6 cap 150   10.0/13.6    146/190       264/246
  //     prox 0.6 cap 110   15.2/13.3    265/281       459/482   (cap too low)
  //
  // Shape: better early, neutral late (accretion outpaces it either way).
  // The real win is the ~2-3x blob reduction at equal land. Note the
  // count-based stabilised gauge deflated under consolidation — which is why
  // stabilisedFraction is area-weighted now (see its own comment).
  consolidateProximity: 0.4,
  // The crust's lengths are metres since DEC-0036 phase 8a — the torus's
  // 150 and 190 cells of 7.8 km (with the nucleus's radius, crustNucleation):
  // in cells the sphere's crust was 25 % larger in metres on a globe of 64 %
  // of the torus's units², and its land fraction the larger for it.
  consolidateMaxRadiusM: 1_170_000,
  attachDistM: 1_482_000,
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
  // window). Side effect: more land overall — the land share controls that now.
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
  const { domain } = sim

  // 1. Convection. Crust insulates the mantle beneath it exactly as it does in the
  // tectonic phase — which is what eventually turns a craton into the dome that
  // rifts it, and also why nucleation must exclude cells that already hold crust.
  sim.mantle = evolveMantleField(sim.mantle, sim.rafts, domain, params.diffusion)
  // Internal heating keeps convection running; without it the field decays to
  // nothing on a planet that has no crust yet. See sustainMantleVigour.
  sim.mantle = sustainMantleVigour(sim.mantle, params.mantleRms, domain)
  const flow = computeMantleFlow(sim.mantle, domain)

  // 2. Crust rides the convection directly. No plates exist yet. Compaction
  // runs with the motion step: drift stretches rafts along the convergence
  // lines, compaction trades that length back into width — see compactRafts.
  advanceRaftsOnFlow(sim.rafts, (x, y, out) => mantleFlowAt(flow, domain, x, y, out), domain, params.raftRigidity)
  compactRafts(sim.rafts, params.compaction, domain)

  // 3. New crust over persistent upwellings that are still ocean, as many as
  // the land share controller grants from the land as it stands after the
  // drift (archeanLand.ts).
  const budget = nucleationBudget(sim, archeanLandShare(sim), archeanLandAim(params.landShare, params.land), params.land, params.nucleation.maxPerEpoch)
  const sites = findNucleationSites(sim.mantle, sim.upwellingStreak, sim.rafts, params.nucleation, sim.random, domain, budget)
  sim.nucleationCredit -= sites.length
  sim.lastNucleated = sites.length
  for (const site of sites) {
    nucleateCrust(sim.rafts, site, sim.epoch, params.nucleation.blobRadiusM / domain.metresPerUnit, sq(params.attachDistM / domain.metresPerUnit), domain)
  }

  // 4. Recycling — the same sink the tectonic phase uses, and the reason crust
  // production settles at an equilibrium instead of carpeting the planet.
  sim.lastRecycled = recycleUnstabilisedCrust(
    sim.rafts, (x, y) => mantleAt(sim.mantle, domain, x, y), (birth) => sim.epoch - birth,
    params.stabilisationEpochs, params.recycleThreshold,
  )

  // 5. Collisions weld, and crust pulled across two convection cells falls apart
  // into separate continents. The merge events are discarded here: sutures are a
  // tectonic-phase concept, and stamping them with Archean epochs would put them on
  // a different clock from the ones the Ecology layer already consumes.
  mergeOverlappingRafts(sim.rafts, MERGE_OVERLAP_FACTOR, sim.epoch, domain)
  sim.lastSplits = splitDisconnectedRafts(sim.rafts, RAFT_CONNECT_FACTOR, sim.random, domain, false)

  // 6. Consolidation, on the settled geometry: heavily-overlapped stabilised
  // blobs collapse into fewer larger ones — see consolidateRaftBlobs.
  if (params.consolidateProximity > 0) {
    consolidateRaftBlobs(sim.rafts, sim.epoch, params.stabilisationEpochs, params.consolidateProximity, params.consolidateMaxRadiusM / domain.metresPerUnit, domain)
  }

  sim.epoch += 1
}

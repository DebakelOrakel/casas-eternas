// Every tuning constant the plate simulation runs on, in one place.
//
// They used to be spread down the first 400 lines of plateSimulation.ts,
// interleaved with the type definitions, which had two costs. Tuning meant
// hunting: "how fast do continents grow" (accretionEpochInterval) sat 200 lines
// from "how fast do mountains decay" (thicknessDecayPerEpoch) with interfaces
// in between. And it kept the epoch phases welded into that one file — a phase
// cannot move into its own module while the twenty constants it reads are locals
// of the file it is leaving.
//
// The comments come along, because they are the actually valuable part: most of
// these values were arrived at empirically and the reasoning behind them is not
// recoverable from the number. Order is preserved from the original file, so
// constants that share a comment block still sit together.
//
// ONE OBJECT rather than 45 loose exports, which is what changed in 2026-08-09's
// part B: `derivePipelineVersion` (storage/artifactKey.ts) hashes a
// `Record<string, number>`, so a module whose constants are an object can get an
// automatic "my tuning changed" signal and one whose constants are scattered
// never can. Read it directly as `TECTONICS_TUNING.x` — no local aliases, so each
// value has exactly one name and adding one is a single edit.

// Private, because two entries below are defined from it and an object literal
// cannot reference its own siblings. The original file preserved its ordering
// specifically so `breakupFreshCrustRadius` could follow the gap it comes from;
// this keeps that link explicit instead of restating 80 twice.
const splitGap = 80

export const TECTONICS_TUNING = {
  // A fixed grid independent of the 2048x1024 display raster — see
  // boundaryLattice.ts for why its resolution doesn't need to match either
  // the display or the plate count.
  detectionLatticeResolutionX: 256,
  detectionLatticeResolutionY: 128,

  // Angle (radians) each plate rotates about its own center every epoch.
  // plateMotion.ts calibrates angularSpeed so that a *full* unit of it
  // produces the target 30-90px speed at the seed (see LINEAR_SPEED_MIN/MAX_PX) —
  // stepping
  // by only 0.01 of that unit per epoch (the original value here) meant
  // actual on-screen displacement was ~0.3-0.9px/epoch, confirmed
  // empirically (10.41px measured over 18 epochs) — technically moving, far
  // too little to ever perceive. This is a more moderate increase (~3-4px
  // average per epoch) — a 15x jump (0.15) was tried first and made plates
  // sweep through complex enough configurations that the still-unbounded
  // elevation query (see elevationField.ts's feature bucketing) hung the
  // main thread for 10+ seconds within a single run.
  epochAngleStep: 0.05,
  // Separate scale for how much convergence gets deposited as uplift per
  // epoch — deliberately decoupled from epochAngleStep above (which only
  // governs how far plates physically move) so bumping up visible plate
  // motion doesn't also blow through the mountain-building pacing that was
  // already tuned against the old, smaller step.
  upliftEpochScale: 0.01,

  // A boundary point needs to stay classified the same way for this many
  // consecutive epochs before it can trigger a rift or merge — stops a
  // single noisy epoch from flipping a plate's fate. Original value (8) let
  // almost any sustained divergence cross the rift threshold the moment it
  // became *eligible* to (see the thresholds below) — rifting should be a
  // rare, dramatic event, not routine plate-count churn every few epochs.
  lockEpochsRequired: 40,
  // Lattice accumulator thresholds (signed: positive from sustained
  // convergence, negative from sustained divergence) that trigger a merge
  // or rift once also held for lockEpochsRequired. Tuning details per the
  // decision doc, not a design fork — easy to retune from here. Original
  // values (-6 / 10) were only barely past what typical convergence/
  // divergence already accumulates in exactly lockEpochsRequired epochs,
  // so crossing the lock duration and crossing the threshold were nearly
  // the same event instead of two independent conditions — confirmed
  // empirically: plate count went 25 -> 34 in 20 seconds of real time.
  riftAccumulatorThreshold: -40,
  mergeAccumulatorThreshold: 60,
  // Rift and merge aren't naturally symmetric: merge has three eligible
  // boundary characters (foldMountains, subductionArc, islandArc) against
  // rift's effectively one (any sustained divergent boundary), and
  // convergent rates (FOLD_MOUNTAIN_RATE/SUBDUCTION_RATE/ISLAND_ARC_RATE,
  // averaging ~0.8) run roughly double the divergent ones
  // (RIFT_VALLEY_RATE/MID_OCEAN_RIDGE_RATE, averaging ~0.4) — see
  // boundaryClassification.ts. Confirmed empirically: total plate count
  // drifted from 25 down to as few as 2 over an 800-epoch run, with no
  // sign of leveling off, because merges kept outpacing rifts on average.
  // Rather than hand-tune the thresholds/rates to cancel this out (fragile
  // — the right constants would depend on exactly how many plates and
  // which types exist, and could still drift over a long enough run),
  // this scales both thresholds each epoch by how far the CURRENT plate
  // count sits from where the simulation started: rifting gets easier and
  // merging gets harder as plates grow scarce, and the reverse as they
  // grow plentiful — a self-correcting negative-feedback loop targeting
  // the simulation's own starting plate count as its equilibrium, rather
  // than a second hardcoded target that could drift out of sync with
  // whatever PLATE_COUNT the UI is actually configured to.
  plateCountPressureStrength: 0.03,
  plateCountPressureClamp: 0.6,
  // A hard floor the soft pressure above cannot provide, because it only ever
  // makes merging HARDER, never impossible — a boundary whose accumulator
  // happens to sail past even the maximally-widened threshold still merges.
  // Re-verified 2026-08-06 (headless, 5 seeds x 800 epochs, current code): the
  // pressure alone does not stop a slow merge-dominated seed from reaching 1
  // plate (one seed went 13 -> 1 and stayed there for the rest of the run).
  // That specific outcome is a trap, not just an extreme: detectBoundaries has
  // nothing to detect with a single Voronoi seed, so a boundary-triggered rift
  // can never fire again, and the continental-rift path (runBoundaryPass's
  // other rift source) ALSO reads convergence off a detected boundary — so at
  // 1 plate the simulation is kinematically frozen for the rest of the run,
  // permanently, not just until the pressure term catches up. Below this floor
  // a merge is refused outright regardless of its accumulator, independent of
  // plateCountPressure*. 3 (not 2) leaves at least two boundaries standing
  // so a stalled one has a second chance elsewhere, rather than the single
  // boundary two plates would leave.
  minPlateCount: 3,
  // Thickness decays a little every epoch even without erosion actually
  // being built yet (explicitly out of scope for this feature per the
  // decision doc) — a real forcing/response model still needs *some*
  // relaxation term or thickness only ever grows, without bound, for as
  // long as a boundary stays active. This is a placeholder stand-in for
  // that, not the real fluvial erosion pass; without it, long-lived
  // boundaries reliably saturated the elevation clamp into solid white
  // disks within well under a minute of running.
  thicknessDecayPerEpoch: 0.99,
  // Extra per-epoch decay applied to an *oceanic* feature (see
  // TerrainFeature.subsides) once it goes idle — age-depth subsidence: oceanic
  // crust cools and sinks as it drifts off the ridge/arc that formed it, so a
  // drifted mid-ocean-ridge/island-arc/trench feature should fade rather than
  // linger as ocean clutter. Multiplies on top of thicknessDecayPerEpoch, so
  // an idle oceanic feature decays at ~0.99*0.85/epoch and is invisible (and
  // then pruned by the existing thickness rule) within ~15-20 idle epochs,
  // while continental fold-mountain / subduction-arc ranges keep their slow
  // 0.99 decay and persist. Confirmed via the headless render harness to clear
  // the drift "corduroy" without touching the ridges themselves.
  oceanicSubsidenceDecayPerEpoch: 0.85,
  // Bounds how long a terrain feature can accumulate in sim.features once
  // its boundary has gone inactive — without this, every feature ever
  // created (even ones long abandoned, decaying toward negligible
  // thickness under thicknessDecayPerEpoch but never actually removed)
  // stays in the array forever. Confirmed empirically as the direct cause
  // of the simulation slowing down over a long run: feature count grew
  // from 237 to 7625 over 550 epochs, with per-render time growing
  // proportionally (561ms to 8.8s) since every pixel's elevation query
  // scans nearby features (elevationField.ts). A feature is only ever
  // pruned once BOTH conditions hold — never while it's still recently
  // active, regardless of how thin it currently is (a fresh deposit starts
  // at 0 thickness and needs epochs to grow; pruning by thickness alone
  // would delete brand-new features on the same epoch they're created).
  //
  // featurePruneInactivityEpochs matches lockEpochsRequired (both are "enough
  // epochs to trust this isn't just one noisy epoch"); the max matches the
  // same order as ageMultiplierHalfLifeEpochs. A more
  // lenient first pass (60 / 500) still let equilibrium feature count
  // settle around 5000 over an 800-epoch run (6+ second renders); these
  // tighter values settle around 2000 instead (~2s renders) — confirmed
  // empirically, not guessed. Render time still doesn't return to the
  // sub-100-feature-count speeds (there's real fixed per-render cost
  // elsewhere — the raft-membership baseline pass alone measured ~140ms
  // independent of feature count) — pruning bounds the *growth*, it doesn't make the
  // renderer itself fast.
  featurePruneThickness: 0.05,
  featurePruneInactivityEpochs: 40,
  // Hard cutoff regardless of remaining thickness — without this, a large,
  // long-abandoned mountain range (thickness decays slowly in proportion
  // to how large it already was) could still take hundreds of epochs to
  // cross featurePruneThickness on decay alone, limiting how much the
  // thickness-based rule above actually bounds worst-case growth.
  featurePruneMaxInactivityEpochs: 150,
  // A boundary's own uplift-rate multiplier decays with how long it's been
  // continuously active (latticeLockedEpochs — already tracked for the
  // rift/merge lock, reused here rather than adding new state): a
  // brand-new collision builds at 1.5x, decaying toward a 0.5x floor with
  // a ~150-epoch half-life, matching "younger collisions build faster" —
  // mountain character should read as a record of *when* a boundary formed,
  // not just a flat rate applied forever.
  ageMultiplierFloor: 0.5,
  ageMultiplierRange: 1.0,
  ageMultiplierHalfLifeEpochs: 150,

  // A subduction/island arc deposits, besides its uplift on the overriding
  // side, a paired *trench* on the subducting (oceanic) side — the deep,
  // narrow depression that makes a real subduction margin read as
  // asymmetric (trench + arc) rather than a symmetric bump. The trench sits
  // offset from the boundary toward the subducting plate (well past
  // terrainFeatures' MERGE_RADIUS so it never fuses with the arc's own
  // range feature) and carries a fraction of the arc's per-epoch uplift as
  // negative thickness. Fold-mountain (continent-continent) and divergent
  // boundaries get no trench — only convergence with a downgoing oceanic
  // slab does.
  trenchOffset: 60,
  trenchDepthFraction: 0.6,

  // Continental accretion (Phase 2): at a subduction arc, new continental crust
  // welds onto the overriding plate's continent, growing it toward the trench —
  // the process that makes land grow over the run, balancing the crust lost to
  // rifting so land/ocean is truly emergent. Each active subduction-arc boundary
  // point adds a small margin blob just inside the continental side, guarded
  // (see accreteToNearestRaft) so the margin advances without exploding the blob
  // count. Rates/sizes are visual-tuning constants.
  accretionBlobRadius: 70,
  accretionInset: 30,
  accretionMinGapSq: 85 * 85,
  accretionMaxAttachSq: 150 * 150,
  // Only accrete every Nth epoch — the direct lever on how fast continents grow
  // (and how many margin blobs pile up, which the raft membership query scans).
  // Raising it slows growth and keeps blob counts lower.
  accretionEpochInterval: 3,

  // Crust recycling — the counterweight accretion never had.
  //
  // Without it the model only ever gains continental crust: measured over 5 seeds,
  // land coverage went 0.26-0.32 at epoch 0 to 0.64-0.79 by epoch 300, every raft
  // collapsed into a single supercontinent, and on 3 of 5 seeds the plate count
  // collapsed too (no boundaries left, so the simulation stops evolving). The
  // comment on accretionBlobRadius above claims accretion "balanc[es] the crust
  // lost to rifting" — it does not; rifting moves crust, it does not destroy any.
  //
  // The physical sink is well documented and specific: most Archean crust was
  // destroyed by delamination and drips, and what survived was crust that had
  // stabilised into a thick, depleted, buoyant cratonic keel. So the rule is an age
  // gate, not a rate: young crust sitting over a downwelling is recycled, and once
  // crust is older than stabilisationEpochs nothing can destroy it. That is what
  // makes a craton a craton, and it is what turns a runaway into an equilibrium —
  // production keeps going, but the pool of destructible crust is bounded.
  //
  // The downwelling test reads the mantle field (negative = cold = downwelling), the
  // same field that already drives plate motion, so crust is destroyed exactly where
  // the mantle is pulling it under.
  stabilisationEpochs: 150,
  recycleDownwellingThreshold: -0.05,

  // MERGE_OVERLAP_FACTOR and RAFT_CONNECT_FACTOR live in
  // crust/crustTuneParams.ts. Both eras hand them to the same crust functions, so
  // filing them under the tectonic phase made the Archean import across a
  // boundary for a rule neither phase owns.
  //
  // Raft split (Phase 2d): a rift only tears a continent if it actually runs
  // through one — a raft blob must be within this distance of the rift point,
  // else the rift is oceanic and nothing splits.
  splitMaxDistSq: 160 * 160,
  // How far (each side) a rift shoves the two continent halves apart — just
  // enough to open a visible gap. It no longer has to be large enough to stop
  // an immediate re-merge (the merge-immunity window below handles that); a big
  // push over-scattered the halves' blobs and made splitDisconnectedRafts
  // shatter them into many pieces.
  splitGap,
  // Epochs a freshly-split pair is immune from re-merging (Raft.noMergeUntilEpoch).
  // RETIRED 2026-07-25 (set to 0): this was a band-aid over fixed Euler poles that
  // pulled the halves straight back. Now that the mantle field (mantle/mantleField.ts)
  // evolves the plate motions, the upwelling under a fresh rift genuinely drives
  // the halves apart, so no artificial immunity window is needed — verified
  // equivalent to the old 30 (breakups, raft range, no re-welding all unchanged
  // across seeds/300 epochs). Left as a named constant (not deleted) so it can be
  // dialled back up if a future seed ever shows an instant re-weld.
  splitMergeImmunityEpochs: 0,
  // Continental breakup is more lenient than a plate rift — a shorter lock and a gentler
  // divergence threshold — so a supercontinent rifts apart from within on the divergence
  // concentrated under it (still gated on raftMembership > 0.5). KEPT LENIENT 2026-07-25.
  // This is LOAD-BEARING, not just for a livelier cycle: its continental rifts birth ocean
  // plates (birthRidgePlate) that counter merges and keep the plate count healthy. Going
  // strict (40 / 1.0) to try to retire the global cooldown was tested and REJECTED — it
  // starves that plate source and the world terminally COLLAPSES to a single plate on some
  // seeds (plate count → 1 by ~epoch 200 and stuck, since 1 plate has no boundaries to
  // rift back from); a middle setting (0.75 / 30) still collapsed on some seeds. So the
  // lenient trigger + a short cooldown is the stable regime. The two are coupled knobs
  // (both tame strobing, both feed liveliness/candidate-abundance) — see the decision doc.
  contRiftLockEpochs: 20,
  contRiftThresholdFactor: 0.55,
  // GLOBAL breakup-staging interval: no further continental rift for this many epochs
  // after one fires. Reframed + HALVED (was 40) 2026-07-25 with the Option-C rift
  // lifecycle (birthRidgePlate + coolMantleAt + passive-margin recovery). It is NOT a pure
  // band-aid: a single assembled supercontinent domes across the whole torus, so without a
  // GLOBAL rate-limit it rifts all over that dome every epoch (strobing: breakups 7→114 at
  // 0, even with the mantle field + the local Option-C machinery — which acts locally while
  // the dome is global). Fully retiring it needs the trigger to go strict, which collapses
  // the plate count (see contRiftLockEpochs above) — rejected. So it stays, but the
  // Option-C machinery let it HALVE to 20 while staying strobe-free (max 1 breakup / 20-epoch
  // window) and running LIVELIER than the old 40 (13-14 vs 7 breakups / 300ep) — physically
  // the interval between successive rift stages of a supercontinent (Pangaea rifted in
  // pulses). Its one real defect (global → also gates a 2nd separate supercontinent) is
  // mitigated by being short + rarely biting (one dominant landmass). Full retirement is
  // deferred; it needs a deeper change (break the dome's coherence at breakup).
  contRiftCooldownEpochs: 20,

  // Ocean-floor age (Phase 3, see oceanAge.ts): the field starts at a moderate
  // uniform age so the ocean isn't uniformly shallow at epoch 0, then evolves as
  // ridges reset it to 0 and advection ages crust away from them.
  oceanAgeInit: 40,
  // World radius around a divergent boundary point whose seafloor counts as newly
  // formed (resetOceanAgeAround). Two very different situations, two radii:
  //
  // An ordinary spreading ridge makes a narrow strip of new crust per epoch, so
  // this stays close to one age cell (world/OCEAN_AGE_RES_X = 8 px) — just wide
  // enough that a ridge line reads as continuous rather than dotted. It has to be
  // small: this fires for EVERY divergent boundary point every epoch, and an
  // earlier value of 80 (which conflated it with the breakup case below) zeroed
  // ~300 age cells per point, which flattened the whole age field — measured median
  // ocean age 0, i.e. half the ocean floor sitting at ridge-crest depth instead of
  // subsided. That is the age-depth law being erased from the other direction.
  ridgeFreshCrustRadius: 12,
  // A continental breakup is the other case: splitRaftAtRift shoves the two halves
  // splitGap apart in a single step, and everything that gap exposes genuinely IS
  // crust the new ridge just made. Fires once per breakup, not per boundary point.
  breakupFreshCrustRadius: splitGap,

  // How fast a plate's motion relaxes toward the mantle-flow-fitted target each
  // epoch (inertia) — low enough that motion changes smoothly, high enough that the
  // evolving field actually reorganizes the plates over a run.
  mantleCouplingRate: 0.15,

  hotspotDepositPerEpoch: 4,
  // Only erupt every few epochs — spaces the chain into distinct volcanoes (like a
  // real island chain, not a continuous ridge) and keeps the feature count in check.
  hotspotEpochInterval: 2,

  // Flood basalt / large igneous province: when a supercontinent rifts apart (the
  // doming upwelling breaching the crust), one big volcanic province erupts at the
  // rift, along it — a Deccan/CAMP-scale plateau. A single large deposit, persistent
  // (continental) so it stays as a lasting mark of the breakup. plateB = -2 is its
  // own marker (like hotspots' -1) so it never merges with boundary/hotspot features.
  floodBasaltDeposit: 50,

  // At a continental breakup, release the mantle doming that drove it (see
  // coolMantleAt): subtract this much buoyancy over a disc of this world-radius
  // around the rift, so the divergent forcing under the (former) supercontinent
  // collapses regionally and the strobing that made contRiftCooldownEpochs necessary
  // stops on its own (Option C). Radius covers a good part of a supercontinent-scale
  // dome; amount pushes the peak (~1.1) past zero into cooling-ocean territory.
  // Tuned by harness so cooldown can go to 0 without runaway breakups.
  riftCoolRadius: 380,
  riftCoolAmount: 1.8,
  // After a breakup, reset the rift/lock accumulators for every boundary point within
  // this world-radius of the rift — the rifted zone's stress state is relieved.
  riftResetRadius: 400,
  // A just-rifted margin is tectonically quiet while it cools into a passive margin:
  // the zone's boundary points get their lock counter set NEGATIVE, so they need this
  // many epochs of sustained divergence (on top of contRiftLockEpochs) before they
  // could rift again. This is the LOCAL margin-recovery state that replaces the old
  // GLOBAL cooldown timer — local means a second, separate supercontinent elsewhere can
  // still rift freely (the global timer wrongly blocked that). Paired with the mantle
  // release, which removes the forcing so the recovery isn't fighting a live dome.
  riftMarginRecoveryEpochs: 45,
  // Depth cap (most-negative thickness) for a continental rift-valley trough, so its
  // floor stays just above sea level and it reads as a deep LAKE basin, not an ocean
  // incursion. Without the cap the trough sinks to the −1 elevation clamp (ocean).
  // The lake is transient: at actual breakup birthRidgePlate drops the baseline to
  // oceanic and it floods to sea. See the rift-lake work in docs/decisions.
  //
  // Re-derived for the metre-anchored scale. The continental baseline this sits on
  // dropped from 0.35 to elevationScale's LAND_BASE (0.040 ≈ 360 m), so the old −8
  // would now put the floor at 0.040 + (−8 · 0.035) = −0.24, i.e. 2160 m BELOW sea
  // level — the exact ocean incursion the cap exists to prevent, and the flood fill
  // would seed it from the ocean and drown the basin instead of ponding a lake in
  // it. −0.9 puts the floor at 0.040 + (−0.9 · 0.035) = 0.0085 ≈ 76 m: still above
  // sea level, still ~280 m below the plateau enclosing it, so computeLakes ponds a
  // real rift lake there.
  //
  // The trade this makes explicit: a rift lake can now be at most LAND_BASE deep
  // (~360 m), where the old scale nominally allowed far more. That is not a loss of
  // realism but the arrival of it — the real Baikal and Tanganyika have floors well
  // BELOW sea level, and representing those needs the hydrology to tell an enclosed
  // sub-sea-level basin (Caspian, Dead Sea) apart from connected ocean, which
  // fillDepressionsAndRouteFlow currently cannot: it seeds from every cell at or
  // below SEA_LEVEL. That is the real blocker, and it was hidden before behind a
  // baseline on which "above sea level" stretched 3 km up.
  riftBasinFloorThickness: -0.9,
} as const

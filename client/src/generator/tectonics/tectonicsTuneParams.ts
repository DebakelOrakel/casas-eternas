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
// part B: `derivePipelineVersion` (world/identity.ts) hashes a
// `Record<string, number>`, so a module whose constants are an object can get an
// automatic "my tuning changed" signal and one whose constants are scattered
// never can. Read it directly as `TECTONICS_TUNING.x` — no local aliases, so each
// value has exactly one name and adding one is a single edit.

// Private, because two entries below are defined from it and an object literal
// cannot reference its own siblings. The original file preserved its ordering
// specifically so `breakupFreshCrustRadiusM` could follow the gap it comes from;
// this keeps that link explicit instead of restating it twice. Metres since
// DEC-0036 phase 8f (the torus's 80 cells of 7.8 km).
const splitGapM = 624_000

export const TECTONICS_TUNING = {
  // A fixed grid independent of the 2048x1024 display raster — see
  // boundaryLattice.ts for why its resolution doesn't need to match either
  // the display or the plate count.
  detectionLatticeResolutionX: 256,
  detectionLatticeResolutionY: 128,

  // THE PLATES' SPEED (DEC-0036 phase 8f). A plate's motion is relaxed
  // toward the rigid fit of the mantle's surface flow (mantleCoupling),
  // and the flow is the gradient of the Poisson potential of the mantle's
  // buoyancy, per mantle cell (mantle/mantleField.computeMantleFlow). This
  // is the plates' speed, km/Myr (= mm/yr), per unit of that gradient: the
  // one constant that says how fast the mantle drags a plate. Read through
  // domain.metresPerUnit, so the sphere's plates move as far in metres as
  // the torus's.
  //
  // Until 8f the motion was in domain units per "unit of spin angle", an
  // epoch 0.05 of it (epochAngleStep), with the flow at the Archean's
  // scale (MANTLE_TUNING.flowSpeedScale 110): 110 × 0.05 × 7.8 km = 42.9
  // km/Myr per unit on the torus, 53.7 on the sphere. That scale was set
  // when the flow's Poisson solve stopped short of the broadest modes and
  // the land was a twelfth of the surface; with the converged solve
  // (DEC-0036 phase 1) and 30 % land (phase 8b-1) the plates ran at
  // 70–220 km/Myr, area-weighted, after the first 10–20 epochs
  // (Earth: about 50; 10–30 the continental plates, up to 100 the
  // Pacific-type ones). At 16 (npm run calibrate, 12 worlds per shape,
  // 40 epochs; the mean over epochs 10–40): 58 / 52 km/Myr torus /
  // sphere, the fastest plate 104 / 79; over 600 plain epochs (3 seeds)
  // 33–43 / 22–26. At 19 the 40 epochs ran at 67 / 60. See
  // docs/decisions/fields-on-meshes.md, phase 8f.
  mantleFlowSpeedKmPerMyr: 16,
  // The crust a convergent boundary thickens per km it closes: a feature's
  // deposit and the boundary's rift/merge accumulator are the convergence
  // over the epoch, km, times this (boundaryPass). The torus's old rate,
  // 0.01 per unit of convergence velocity at an epoch of 0.05 of its time
  // unit: 0.01 / (0.05 × 7.8 km).
  upliftPerKm: 0.01 / (0.05 * 7.8),
  // THE HISTORY'S UPLIFT RATE (DEC-0036 phase 8g): the crust a boundary
  // thickens is its shortening times the crust's thickness, spread over
  // the range's cross-section — mass conserved in the section, ḣ = v Hc / W
  // (elevation/upliftField.ts). v is a feature's shortening rate
  // (TerrainFeature.shorteningKmPerMyr), W the capsule's integral across,
  // ELEVATION_TUNING.rangePerpRadiusM (234 km). Hc is the thickness of the
  // crust that the shortening thickens, m: the continental crust is 35–45
  // km thick (Christensen & Mooney 1995, J. Geophys. Res. 100: 39 km on
  // the mean): 40 km, the mean crust (the character's rate takes out the
  // part of a margin's convergence that is the slab's). 8g took 30 km,
  // when every plate boundary through a continent thickened it: at 35 km
  // the land above 2000 m was 7.7 / 18.7 % (torus / sphere, 3 seeds).
  // Since 8g-2 only the margins and a share of the intraplate push build
  // (boundaryPass): at 30 km the land's mean height was 594 / 535 m and
  // above 4500 m 0.12 / 0.07 %, at 40 km 639 / 584 m and 0.30 / 0.23 %
  // (2026-10-14, npm run calibrate, 6 seeds per shape, without the
  // intraplate share). See docs/decisions/fields-on-meshes.md, phases 8g
  // and 8g-2.
  orogenCrustM: 40_000,
  // The half-life of a feature's shortening rate as a moving mean, Ma: a
  // boundary point deposits on one of the overlapping features of its
  // stretch, and which one changes from epoch to epoch; the mean smooths
  // that, and a boundary that stops converging stops thickening the crust
  // within a few Ma.
  shorteningHalfLifeMa: 2,
  // WHERE THE CRUST DEFORMS (DEC-0036 phase 8g-2, boundaryPass): how far
  // into each plate a boundary point reads the plate that carries the
  // crust (a raft rides its host plate, crust/raftLifecycle.carrierPlateAt),
  // m: 156 km, beyond the boundary's own zone and inside the range's
  // cross-section (234 km); 20 cells on the torus.
  crustSideM: 156_000,
  // INTRAPLATE DEFORMATION (boundaryPass): the share of the plates'
  // convergence a boundary deposits where the same plate carries the crust
  // on both sides — a boundary through one rigid raft. The raft model has
  // no strain inside a raft, but a continent's interior takes up some of
  // the push at its margins (the Tian Shan, the Laramide ranges, slow and
  // far from the collision that drives them). Shortening only: the stress
  // in continental interiors is mostly compressive (Zoback 1992, J.
  // Geophys. Res. 97, the World Stress Map), and a continent breaks at the
  // breakup event (splitRaftAtRift), not by a slow stretch at every
  // divergent plate boundary under it (a rift's thinning at the plates'
  // rate lowered the land: at a share of 0.2 for both signs the land's
  // mean height fell from 594 to 508 m, torus, 6 seeds). Measured
  // 2026-10-14 (npm run calibrate, 6 seeds per shape, orogenCrustM 40 km,
  // collapseHeightM 4000 m; torus / sphere): at 0 the land's mean height
  // 639 / 584 m, above 2000 m 3.5 / 4.3 %; at 0.2 714 / 594 m, 4.7 /
  // 4.0 %; at 0.4 772 / 634 m, 6.5 / 4.8 %. 0.3 between.
  intraplateShortening: 0.3,
  // How far from a carriers' margin (boundaryPass depositCarrierMargins)
  // the coast is searched on either side, m. The margin lies where a raft's
  // reach ends (1.5 blob radii, the blobs 546 km): a lone blob's coast
  // stands about 0.54 of its radius from its centre, so 1.5 − 0.54 radii,
  // 524 km, and more where blobs overlap; 120 cells on the torus.
  coastSearchM: 936_000,

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
  // terrainFeatures' MERGE_RADIUS_M so it never fuses with the arc's own
  // range feature) and carries a fraction of the arc's per-epoch uplift as
  // negative thickness. Fold-mountain (continent-continent) and divergent
  // boundaries get no trench — only convergence with a downgoing oceanic
  // slab does. Metres since DEC-0036 phase 8f (the torus's 60 cells).
  trenchOffsetM: 468_000,
  trenchDepthFraction: 0.6,
  // The history's trench (tectonics/trench.ts, DEC-0036 phase 8e): its
  // half-width across the plate boundary — Earth's trenches are 50–100 km
  // wide — and its relief below the floor beside it as a multiple of that
  // floor's thermal subsidence (2.3, 3.7 and 4.8 km on 15, 45 and 150 Ma
  // floor; Earth's Middle America, Peru–Chile and Mariana trenches).
  trenchHalfWidthM: 50_000,
  trenchReliefPerSubsidence: 1.6,

  // Continental accretion (Phase 2): at a subduction arc, new continental crust
  // welds onto the overriding plate's continent, growing it toward the trench —
  // the process that makes land grow over the run, balancing the crust lost to
  // rifting so land/ocean is truly emergent. Each active subduction-arc boundary
  // point adds a small margin blob just inside the continental side, guarded
  // (see accreteToNearestRaft) so the margin advances without exploding the blob
  // count. Rates/sizes are visual-tuning constants. Metres since DEC-0036
  // phase 8a (the torus's 70, 30, 85 and 150 cells of 7.8 km — on the
  // sphere they were 25 % longer): the blob's radius, how far inside the
  // overriding side it is welded, the gap below which it is not placed and
  // the reach within which it joins a raft (accreteToNearestRaft's squared
  // distances, in units² at the use).
  accretionBlobRadiusM: 546_000,
  accretionInsetM: 234_000,
  accretionMinGapM: 663_000,
  accretionMaxAttachM: 1_170_000,
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
  // comment on accretionBlobRadiusM above claims accretion "balanc[es] the crust
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
  // else the rift is oceanic and nothing splits. Metres since DEC-0036
  // phase 8f (the torus's 160 cells; it was a square in units²).
  splitMaxDistM: 1_248_000,
  // How far (each side) a rift shoves the two continent halves apart — just
  // enough to open a visible gap. It no longer has to be large enough to stop
  // an immediate re-merge (the merge-immunity window below handles that); a big
  // push over-scattered the halves' blobs and made splitDisconnectedRafts
  // shatter them into many pieces.
  splitGapM,
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
  // The seafloor a continental breakup exposes (resetOceanAgeAround):
  // splitRaftAtRift shoves the two halves splitGapM apart in a single step,
  // and everything that gap exposes genuinely IS crust the new ridge just
  // made. Fires once per breakup. An ordinary ridge's new crust is the ocean
  // age's own since DEC-0036 phase 8e — the strip the plates open, found in
  // its transport (oceanAge.advectOceanAge); the disc of ridgeFreshCrustRadiusM
  // (93.6 km) it replaced, reset around every divergent boundary point every
  // epoch, made 2–3 × the young floor the plates' motion opens (measured:
  // 13–39 % of the ocean under 2 Ma after 40 epochs, 13–24 % without it).
  breakupFreshCrustRadiusM: splitGapM,

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
  // Metres since DEC-0036 phase 8a (the torus's 380 cells).
  riftCoolRadiusM: 2_964_000,
  riftCoolAmount: 1.8,
  // After a breakup, reset the rift/lock accumulators for every boundary point within
  // this world-radius of the rift — the rifted zone's stress state is relieved.
  // Metres since DEC-0036 phase 8a (the torus's 400 cells).
  riftResetRadiusM: 3_120_000,
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
  // sub-sea-level basin (Caspian, Dead Sea) apart from connected ocean. The
  // routing could not until adaptive-mesh phase 0: it seeded from every cell
  // at or below SEA_LEVEL; since then it seeds the ocean from the largest
  // water component alone (flowRouting.largestWaterComponent), and a
  // sub-sea basin fills as a lake. The value stayed where it was.
  riftBasinFloorThickness: -0.9,

  // FLEXURAL ISOSTASY (tectonics/flexure.ts, ADAPTIVE_MESH_PLAN.md phase
  // 5.3, decision 5 of docs/decisions/adaptive-mesh.md). The elastic
  // thickness Te is a FIELD: on a raft between the young-orogen and the
  // craton value by the craton oldness (crust/raftField), in the ocean
  // from the lithosphere's age like its depth (GDH1's isotherm depth,
  // ~√age). Densities and the plate's elastic constants as on Earth; the
  // plate equation (since DEC-0036 phase 6) makes of them the flexural
  // parameter α = (4D / (ρm g))^¼: 18–99 km at sea, 50 km (Te 20) to
  // 127 km (Te 70) on land. Deflection scale flexureDeflectionScale is the
  // one calibration knob: 1 is full compensation of the load, ρc / ρm.
  flexureTeYoungKm: 20,
  flexureTeCratonKm: 70,
  flexureTeOceanFloorKm: 5,
  flexureTeOceanAgeKm: 3,
  flexureTeOceanMaxKm: 50,
  flexureCrustDensity: 2700,
  flexureMantleDensity: 3300,
  flexureYoungsModulusGPa: 70,
  flexurePoisson: 0.25,
  flexureDeflectionScale: 1,

  // THE PLATEAU'S FORCE BALANCE (DEC-0036 phase 8b-3, the history's
  // uplift; pipeline/coupledEpoch.ts collapseFactor). A convergent
  // boundary thickens the crust only while its push exceeds what the
  // raised crust exerts back by its weight: the spreading force of a
  // plateau grows with its MEAN height, and where the two balance the
  // crust spreads instead of thickening (Molnar & Lyon-Caen 1988, Geol.
  // Soc. Am. Spec. Pap. 218: Tibet at 5 km, the Altiplano at 4). To first
  // order in the mean height h̄ the thickening rate falls as 1 − h̄ / H.
  // h̄ is a REGIONAL mean — the land's height (the sea at 0) on the
  // flexure's mesh, smoothed by a Gaussian of σ = collapseSmoothingM — so
  // a plateau stops rising while a narrow range in lowland goes on; a peak
  // stands above it by the relief the rivers and the ice cut and by the
  // plate's rebound under that cut. The flexure (above) is linear and so
  // cannot bound a plateau by itself: the load of a wide uplift sinks by
  // ρc / ρm whatever its height (measured 2026-10-13: at five times the
  // uplift the widest plateau stood at 7 km, its peak at 12.6 km).
  // H is calibrated, not Tibet's 5 km: h̄ takes in a plateau's valleys and
  // its lower margin, so it reads below the plateau's own level. Measured
  // 2026-10-13 (npm run calibrate, 3 seeds per shape, upliftScale 4): at
  // H 5000 m the land above 6000 m was 0.074 % (torus median), 0.10 %
  // (sphere), the largest patch above 4500 m up to 425 000 km²; at 4000 m
  // 0.010 % and 0.071 %, the largest patch 190 000 km², the peaks still
  // 6.0–9.2 km. A σ of 100 km instead of 150 moved less (0.010 / 0.076 %,
  // the largest patch 509 000 km²).
  // 4000 → 3000 m with the physical uplift rate (DEC-0036 phase 8g,
  // 2026-10-14; 3 seeds per shape, with the range's balance below): every
  // slow boundary through a continent now thickens it as fast as it closes,
  // and broad 2–3 km highlands formed (above 2000 m 6.2 / 16.8 % of the
  // land, torus / sphere, at 4000 m; 5.4 / 15.2 % at 3000 m, and above
  // 4500 m 0.10 / 0.04 % against 0.12 / 0.07 %).
  // 3000 → 4000 m again in phase 8g-2 (2026-10-14), when the plate
  // boundaries through a continent stopped thickening it at the plates'
  // rate (boundaryPass): the broad highlands it held went with them. At
  // 3000 m the land above 4500 m was 0.062 / 0.033 % (torus / sphere, 6
  // seeds), at 4000 m 0.12 / 0.07 %; above 2000 m 2.4 / 2.6 % and 2.6 /
  // 2.8 %.
  collapseHeightM: 4000,
  collapseSmoothingM: 150_000,
  // THE COLUMN'S FORCE BALANCE (DEC-0036 phase 8g, coupledEpoch
  // wedgeFactor): the thickening falls as 1 − h̄ / H with h̄ the mean height
  // within wedgeRadiusM of a node — at 10 km, on the land's 8–31 km nodes,
  // the node's own column: the local crust's thickness, in Airy terms its
  // height. The same balance as the plateau's (the crust's weight against
  // the push), read where a narrow range stands: a range is a wedge, and
  // once it stands at its critical height more shortening widens it
  // instead of raising it (Davis, Suppe & Dahlen 1983, J. Geophys. Res. 88).
  // The plateau's balance reads a mean over σ 150 km and does not see a
  // range 20–50 km wide in lowland. Not a cap: a peak stands above H by
  // the plate's rebound under the cut around it. Measured 2026-10-14
  // (3 seeds per shape, collapseHeightM 3000, the history's highest peak
  // sampled every tenth epoch): radius 20 km, H 7000 m 12.0 km (torus
  // alpha), 8000 m 12.4 km, 6500 m 11.3 km; radius 10 km, H 7000 m 9.5 km;
  // without it 15–31 km.
  // 7000 → 9500 m in phase 8g-2 (2026-10-14), when coupledEpoch began to
  // integrate the balance over the epoch (columnFactor) instead of taking
  // its factor at the epoch's start: the explicit step let a node at the
  // fast margins pass H within one epoch (to 12.5 km, torus alpha, epoch
  // 38), and the exact integral holds the summits further below H, as
  // the erosion works on them. Measured (npm run calibrate, 6 seeds per
  // shape; torus / sphere): at H 7000 m the highest node of torus alpha
  // and sphere zulu stood at 5.9 / 6.5 km over 60 epochs (sampled every
  // second epoch), at 10 000 m 9.1 / 9.3 km; at 9000 m the land above
  // 4500 m 0.43 / 0.29 %, above 6000 m 0.003 / 0 %, at 11 000 m (torus)
  // 0.68 % and 0.053 %.
  wedgeRadiusM: 10_000,
  wedgeHeightM: 9500,

  // FOLDS (tectonics/folds.ts, phase 5.7): the buckling wavelength across
  // a convergent margin and the modulation of the uplift over it (±
  // amplitude around the range's mean). Both to be measured: the
  // wavelength against the mesh's spacing in an orogen (a train the mesh
  // cannot resolve is noise), the amplitude against the ridge-and-valley
  // relief a young range shows before its rivers cut.
  foldWavelengthKm: 15,
  foldAmplitude: 0.5,
} as const

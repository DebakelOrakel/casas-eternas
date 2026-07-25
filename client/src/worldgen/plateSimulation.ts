import { classifyBoundary } from './boundaryClassification'
import { detectBoundaries } from './boundaryDetection'
import type { LatticePoint } from './boundaryLattice'
import { generateDetectionLattice } from './boundaryLattice'
import { generatePlateMotions, advancePointByMotion } from './plateMotion'
import type { PlateMotion } from './plateMotion'
import { createMantleField, evolveMantleField, computeMantleFlow, fitMotionsToFlow } from './mantleField'
import { classifyBoundaryMotion } from './plateVelocityDecomposition'
import { generatePlateSeeds } from './plateSeeds'
import type { PlateSeed } from './plateSeeds'
import { hashSeedString, mulberry32 } from './rng'
import type { SeededRandom } from './rng'
import type { PlateType } from './plateTypes'
import { generateInitialRafts, advanceRafts, derivePlateTypes, accreteToNearestRaft, mergeOverlappingRafts, splitRaftAtRift, splitDisconnectedRafts, raftMembership, pickUnusedRaftName } from './rafts'
import type { Raft, RaftBlob, RaftSplitEvent } from './rafts'
import { createOceanAgeField, advectOceanAge, resetOceanAgeAt } from './oceanAge'
import { advanceTerrainFeatures, findOrCreateFeatureIndex } from './terrainFeatures'
import type { TerrainFeature } from './terrainFeatures'
import { wrappedDelta } from './toroidal'

// A fixed grid independent of the 2048x1024 display raster — see
// boundaryLattice.ts for why its resolution doesn't need to match either
// the display or the plate count.
const DETECTION_LATTICE_RESOLUTION_X = 256
const DETECTION_LATTICE_RESOLUTION_Y = 128

// Angle (radians) each plate rotates about its own center every epoch.
// plateMotion.ts calibrates angularSpeed so that a *full* unit of it
// produces the target 30-90px "arrow length" speed at the seed — stepping
// by only 0.01 of that unit per epoch (the original value here) meant
// actual on-screen displacement was ~0.3-0.9px/epoch, confirmed
// empirically (10.41px measured over 18 epochs) — technically moving, far
// too little to ever perceive. This is a more moderate increase (~3-4px
// average per epoch) — a 15x jump (0.15) was tried first and made plates
// sweep through complex enough configurations that the still-unbounded
// elevation query (see elevationField.ts's feature bucketing) hung the
// main thread for 10+ seconds within a single run.
const EPOCH_ANGLE_STEP = 0.05
// Separate scale for how much convergence gets deposited as uplift per
// epoch — deliberately decoupled from EPOCH_ANGLE_STEP above (which only
// governs how far plates physically move) so bumping up visible plate
// motion doesn't also blow through the mountain-building pacing that was
// already tuned against the old, smaller step.
const UPLIFT_EPOCH_SCALE = 0.01

// A boundary point needs to stay classified the same way for this many
// consecutive epochs before it can trigger a rift or merge — stops a
// single noisy epoch from flipping a plate's fate. Original value (8) let
// almost any sustained divergence cross the rift threshold the moment it
// became *eligible* to (see the thresholds below) — rifting should be a
// rare, dramatic event, not routine plate-count churn every few epochs.
const LOCK_EPOCHS_REQUIRED = 40
// Lattice accumulator thresholds (signed: positive from sustained
// convergence, negative from sustained divergence) that trigger a merge
// or rift once also held for LOCK_EPOCHS_REQUIRED. Tuning details per the
// decision doc, not a design fork — easy to retune from here. Original
// values (-6 / 10) were only barely past what typical convergence/
// divergence already accumulates in exactly LOCK_EPOCHS_REQUIRED epochs,
// so crossing the lock duration and crossing the threshold were nearly
// the same event instead of two independent conditions — confirmed
// empirically: plate count went 25 -> 34 in 20 seconds of real time.
const RIFT_ACCUMULATOR_THRESHOLD = -40
const MERGE_ACCUMULATOR_THRESHOLD = 60
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
const PLATE_COUNT_PRESSURE_STRENGTH = 0.03
const PLATE_COUNT_PRESSURE_CLAMP = 0.6
// Thickness decays a little every epoch even without erosion actually
// being built yet (explicitly out of scope for this feature per the
// decision doc) — a real forcing/response model still needs *some*
// relaxation term or thickness only ever grows, without bound, for as
// long as a boundary stays active. This is a placeholder stand-in for
// that, not the real fluvial erosion pass; without it, long-lived
// boundaries reliably saturated the elevation clamp into solid white
// disks within well under a minute of running.
const THICKNESS_DECAY_PER_EPOCH = 0.99
// Extra per-epoch decay applied to an *oceanic* feature (see
// TerrainFeature.subsides) once it goes idle — age-depth subsidence: oceanic
// crust cools and sinks as it drifts off the ridge/arc that formed it, so a
// drifted mid-ocean-ridge/island-arc/trench feature should fade rather than
// linger as ocean clutter. Multiplies on top of THICKNESS_DECAY_PER_EPOCH, so
// an idle oceanic feature decays at ~0.99*0.85/epoch and is invisible (and
// then pruned by the existing thickness rule) within ~15-20 idle epochs,
// while continental fold-mountain / subduction-arc ranges keep their slow
// 0.99 decay and persist. Confirmed via the headless render harness to clear
// the drift "corduroy" without touching the ridges themselves.
const OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH = 0.85
// Bounds how long a terrain feature can accumulate in sim.features once
// its boundary has gone inactive — without this, every feature ever
// created (even ones long abandoned, decaying toward negligible
// thickness under THICKNESS_DECAY_PER_EPOCH but never actually removed)
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
// INACTIVITY_EPOCHS matches LOCK_EPOCHS_REQUIRED (both are "enough
// epochs to trust this isn't just one noisy epoch"); MAX_INACTIVITY
// matches the same order as AGE_MULTIPLIER_HALF_LIFE_EPOCHS. A more
// lenient first pass (60 / 500) still let equilibrium feature count
// settle around 5000 over an 800-epoch run (6+ second renders); these
// tighter values settle around 2000 instead (~2s renders) — confirmed
// empirically, not guessed. Render time still doesn't return to the
// sub-100-feature-count speeds (there's real fixed per-render cost
// elsewhere — the raft-membership baseline pass alone measured ~140ms
// independent of feature count) — pruning bounds the *growth*, it doesn't make the
// renderer itself fast.
const FEATURE_PRUNE_THICKNESS = 0.05
const FEATURE_PRUNE_INACTIVITY_EPOCHS = 40
// Hard cutoff regardless of remaining thickness — without this, a large,
// long-abandoned mountain range (thickness decays slowly in proportion
// to how large it already was) could still take hundreds of epochs to
// cross FEATURE_PRUNE_THICKNESS on decay alone, limiting how much the
// thickness-based rule above actually bounds worst-case growth.
const FEATURE_PRUNE_MAX_INACTIVITY_EPOCHS = 150
// A boundary's own uplift-rate multiplier decays with how long it's been
// continuously active (latticeLockedEpochs — already tracked for the
// rift/merge lock, reused here rather than adding new state): a
// brand-new collision builds at 1.5x, decaying toward a 0.5x floor with
// a ~150-epoch half-life, matching "younger collisions build faster" —
// mountain character should read as a record of *when* a boundary formed,
// not just a flat rate applied forever.
const AGE_MULTIPLIER_FLOOR = 0.5
const AGE_MULTIPLIER_RANGE = 1.0
const AGE_MULTIPLIER_HALF_LIFE_EPOCHS = 150

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
const TRENCH_OFFSET = 60
const TRENCH_DEPTH_FRACTION = 0.6

// Continental accretion (Phase 2): at a subduction arc, new continental crust
// welds onto the overriding plate's continent, growing it toward the trench —
// the process that makes land grow over the run, balancing the crust lost to
// rifting so land/ocean is truly emergent. Each active subduction-arc boundary
// point adds a small margin blob just inside the continental side, guarded
// (see accreteToNearestRaft) so the margin advances without exploding the blob
// count. Rates/sizes are visual-tuning constants.
const ACCRETION_BLOB_RADIUS = 70
const ACCRETION_INSET = 30
const ACCRETION_MIN_GAP_SQ = 85 * 85
const ACCRETION_MAX_ATTACH_SQ = 150 * 150
// Only accrete every Nth epoch — the direct lever on how fast continents grow
// (and how many margin blobs pile up, which the raft membership query scans).
// Raising it slows growth and keeps blob counts lower.
const ACCRETION_EPOCH_INTERVAL = 3

// Raft merge (Phase 2c): two continents whose crust overlaps suture into one.
// The factor scales the sum of two blobs' radii into the center-distance that
// counts as overlapping — ~0.5 ≈ their coastlines meet (see mergeOverlappingRafts).
const MERGE_OVERLAP_FACTOR = 0.5
// Raft split (Phase 2d): a rift only tears a continent if it actually runs
// through one — a raft blob must be within this distance of the rift point,
// else the rift is oceanic and nothing splits.
const SPLIT_MAX_DIST_SQ = 160 * 160
// How far (each side) a rift shoves the two continent halves apart — just
// enough to open a visible gap. It no longer has to be large enough to stop
// an immediate re-merge (the merge-immunity window below handles that); a big
// push over-scattered the halves' blobs and made splitDisconnectedRafts
// shatter them into many pieces.
const SPLIT_GAP = 80
// Epochs a freshly-split pair is immune from re-merging (Raft.noMergeUntilEpoch),
// so a breakup stays visible while the halves drift instead of re-welding at
// once. A band-aid over fixed Euler poles pulling the halves straight back.
const SPLIT_MERGE_IMMUNITY_EPOCHS = 30
// Blobs count as connected (same landmass) if their centers are within
// (ra+rb)*this. Deliberately generous: two blobs render as one landmass at
// ~0.7·(ra+rb), but the coastline is the SUMMED field, so a thin neck bridged
// by several nearby blobs reads as connected even when no single pair is close.
// A tight factor mistook those bridges for gaps and shattered rendered-
// connected rafts into many pieces; this only decomposes clusters with a
// clear, wide gap between them (the "obviously separate landmasses" case).
const RAFT_CONNECT_FACTOR = 1.5
// Continental breakup is more lenient than a plate rift — a shorter lock and a
// gentler divergence threshold — so a supercontinent can rift apart from within
// on the limited divergence available under it (plate motions are fixed, so
// boundaries under an assembled continent are mostly convergent). Still gated
// enough that continents don't churn apart constantly.
const CONT_RIFT_LOCK_EPOCHS = 20
const CONT_RIFT_THRESHOLD_FACTOR = 0.55
// Global cooldown after a continental rift fires: no further continental rift
// for this many epochs. Without it, an assembled supercontinent oscillates
// every single epoch — the rift point stays divergent+locked+under-continent
// (its lock never clears since the plate motions that made it divergent are
// fixed), so it re-qualifies immediately, and the just-split halves drift back
// together and re-merge on the very next epoch: a strobing split/merge limit
// cycle (confirmed ~1 collision + 1 breakup per epoch past ~epoch 220). The
// cooldown turns that into an occasional, dramatic breakup event instead —
// which is the honest ceiling until evolving Euler poles let breakup actually
// succeed (see the raft decision doc's "breakup is limited by fixed motions").
const CONT_RIFT_COOLDOWN_EPOCHS = 40

// Ocean-floor age (Phase 3, see oceanAge.ts): the field starts at a moderate
// uniform age so the ocean isn't uniformly shallow at epoch 0, then evolves as
// ridges reset it to 0 and advection ages crust away from them.
const OCEAN_AGE_INIT = 40

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
}

// How fast a plate's motion relaxes toward the mantle-flow-fitted target each
// epoch (inertia) — low enough that motion changes smoothly, high enough that the
// evolving field actually reorganizes the plates over a run.
const MANTLE_COUPLING_RATE = 0.15

export function createPlateSimulation(seedString: string, plateCount: number, landFraction: number, clustering: number, cratonCount: number, width: number, height: number): PlateSimulation {
  const random = mulberry32(hashSeedString(seedString))
  // A distinctly-salted hash of the same seed string, not hashSeedString(seedString)
  // itself — keeps this fully deterministic per world seed without reusing
  // the exact numeric seed `random` was already built from for a
  // different purpose.
  const warpSeed = hashSeedString(`${seedString}:coastalWarp`)
  const seeds = generatePlateSeeds(plateCount, width, height, random)
  // Rafts are generated first — they're the source of truth for crust type;
  // plate `types` are then derived from raft coverage (see rafts.ts).
  const rafts = generateInitialRafts(random, landFraction, clustering, cratonCount, width, height)
  const types = derivePlateTypes(seeds, rafts, width, height)
  const motions = generatePlateMotions(seeds, width, height, random)
  const lattice = generateDetectionLattice(width, height, DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y)

  return {
    width,
    height,
    initialPlateCount: plateCount,
    seeds,
    rafts,
    types,
    motions,
    ages: seeds.map(() => 0),
    features: [],
    epoch: 0,
    random,
    warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    oceanAge: createOceanAgeField(OCEAN_AGE_INIT),
    supercontinentActive: rafts.length <= 1,
    continentalRiftCooldownUntil: 0,
    mantle: createMantleField(random),
  }
}

// A JSON-serializable snapshot of a running simulation — everything needed to
// reconstruct it and CONTINUE from exactly where it was (see the save/load
// world feature). Deliberately excludes: `types` (derived from rafts), the
// detection lattice (regenerated + its accumulators reset on restore — a rift
// or merge just needs to re-lock over a few epochs, cheap), and `oceanAge`
// (carried separately as a binary float raster). The RNG's internal state is
// stored so continuation is bit-identical.
export interface PlateSimulationSnapshot {
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
  rngState: number
}

export function serializePlateSimulation(sim: PlateSimulation): PlateSimulationSnapshot {
  return {
    width: sim.width,
    height: sim.height,
    initialPlateCount: sim.initialPlateCount,
    seeds: sim.seeds,
    motions: sim.motions,
    ages: sim.ages,
    rafts: sim.rafts,
    features: sim.features,
    epoch: sim.epoch,
    warpSeed: sim.warpSeed,
    supercontinentActive: sim.supercontinentActive,
    continentalRiftCooldownUntil: sim.continentalRiftCooldownUntil,
    rngState: sim.random.state(),
  }
}

export function deserializePlateSimulation(snap: PlateSimulationSnapshot, oceanAge: Float32Array): PlateSimulation {
  const lattice = generateDetectionLattice(snap.width, snap.height, DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y)
  return {
    width: snap.width,
    height: snap.height,
    initialPlateCount: snap.initialPlateCount,
    seeds: snap.seeds,
    rafts: snap.rafts,
    types: derivePlateTypes(snap.seeds, snap.rafts, snap.width, snap.height),
    motions: snap.motions,
    ages: snap.ages,
    features: snap.features,
    epoch: snap.epoch,
    random: mulberry32(snap.rngState),
    warpSeed: snap.warpSeed,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
    oceanAge,
    supercontinentActive: snap.supercontinentActive,
    continentalRiftCooldownUntil: snap.continentalRiftCooldownUntil,
    // Regenerated fresh on restore (not serialized) — like the detection lattice,
    // it re-evolves toward the current crust config over a few epochs. Uses an
    // independent RNG so it doesn't disturb the bit-identical continuation RNG.
    mantle: createMantleField(mulberry32((snap.warpSeed ^ 0x5bd1e995) >>> 0)),
  }
}

function motionClassCode(motionClass: 'convergent' | 'divergent' | 'transform'): number {
  return motionClass === 'convergent' ? 0 : motionClass === 'divergent' ? 1 : 2
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

export function getInitialPlateEvents(_sim: PlateSimulation): SimEvent[] {
  // Phase 1: initial continent notifications dropped (user's call). In the
  // raft model a continent is a raft spanning several plates, so the old
  // per-continental-plate "created" event no longer maps; real continent
  // events (raft birth/split/merge) arrive with the raft lifecycle in a
  // later phase.
  return []
}

interface RiftEvent {
  x: number
  y: number
  plateA: number
  plateB: number
}

// Which plate is actually removed (consumed) vs. which one survives and
// absorbs its territory — no longer always min/max by index, since a
// subducting oceanic plate must be the one removed regardless of which
// index it happens to hold (see stepEpoch's merge-resolution branch).
interface MergeEvent {
  x: number
  y: number
  keepIndex: number
  removeIndex: number
}

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

export function stepEpoch(sim: PlateSimulation): SimEvent[] {
  const { width, height } = sim

  // 0. The mantle drives the plates. Evolve the field under the current crust
  // (continents insulate → upwelling; ocean cools → downwelling), derive its
  // surface flow, and relax each plate's motion toward the flow-fitted rigid
  // motion (inertia). This is what makes assembly AND breakup emerge — plates
  // drift to downwellings and assemble, an assembled continent then insulates an
  // upwelling beneath it that pushes its plates apart. See mantleField.ts.
  sim.mantle = evolveMantleField(sim.mantle, sim.rafts, width, height)
  const flow = computeMantleFlow(sim.mantle)
  const fitted = fitMotionsToFlow(sim.seeds, flow, width, height)
  for (let i = 0; i < sim.motions.length; i++) {
    const m = sim.motions[i]
    const f = fitted[i]
    m.driftX += (f.driftX - m.driftX) * MANTLE_COUPLING_RATE
    m.driftY += (f.driftY - m.driftY) * MANTLE_COUPLING_RATE
    m.spin += (f.spin - m.spin) * MANTLE_COUPLING_RATE
    m.centroidX = f.centroidX
    m.centroidY = f.centroidY
  }

  // 1. Advance every plate (and whatever terrain is attached to it)
  // along its own rotation.
  for (let i = 0; i < sim.seeds.length; i++) {
    const motion = sim.motions[i]
    const rotated = advancePointByMotion(sim.seeds[i].x, sim.seeds[i].y, motion, EPOCH_ANGLE_STEP, width, height)
    sim.seeds[i].x = rotated.x
    sim.seeds[i].y = rotated.y
    sim.ages[i] += 1
  }
  // Rafts (continents) ride their host plates, and plate types are re-derived
  // from the new raft positions so boundary classification below sees the
  // current crust layout. Phase 1: rafts only drift; split/merge/accretion
  // come later.
  advanceRafts(sim.rafts, sim.seeds, sim.motions, EPOCH_ANGLE_STEP, width, height)
  sim.types = derivePlateTypes(sim.seeds, sim.rafts, width, height)
  // Advect the ocean-age field along with the plates that just moved (Phase 3).
  sim.oceanAge = advectOceanAge(sim.oceanAge, sim.seeds, sim.motions, EPOCH_ANGLE_STEP, width, height)
  advanceTerrainFeatures(sim.features, sim.motions, EPOCH_ANGLE_STEP, width, height)
  for (const feature of sim.features) {
    feature.thickness *= THICKNESS_DECAY_PER_EPOCH
    // Age-depth subsidence for oceanic features once idle (no longer fed by
    // their boundary, i.e. drifting off-ridge). Gated on epochsSinceDeposit
    // > 0 so a still-active ridge/arc (refreshed every epoch) keeps full
    // height — see OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH.
    if (feature.subsides && feature.epochsSinceDeposit > 0) {
      feature.thickness *= OCEANIC_SUBSIDENCE_DECAY_PER_EPOCH
    }
    feature.epochsSinceDeposit += 1
  }

  // 2. Detect this epoch's boundaries against the fixed lattice.
  const boundaries = detectBoundaries(sim.lattice, sim.seeds, width, height)

  // Scales the rift/merge thresholds toward whichever makes the currently-
  // scarce event easier — see PLATE_COUNT_PRESSURE_STRENGTH's own comment.
  // Positive pressure means too few plates (rifting should get easier,
  // merging harder); negative means too many (the reverse).
  const plateCountPressure = Math.max(
    -PLATE_COUNT_PRESSURE_CLAMP,
    Math.min(PLATE_COUNT_PRESSURE_CLAMP, (sim.initialPlateCount - sim.seeds.length) * PLATE_COUNT_PRESSURE_STRENGTH),
  )
  const effectiveRiftThreshold = RIFT_ACCUMULATOR_THRESHOLD * (1 - plateCountPressure)
  const effectiveMergeThreshold = MERGE_ACCUMULATOR_THRESHOLD * (1 + plateCountPressure)

  let riftEvent: RiftEvent | null = null
  let mergeEvent: MergeEvent | null = null
  // A sustained-divergent boundary point sitting UNDER a continent — the seed
  // of continental breakup, tracked separately from the plate rift above
  // (which fires at oceanic ridges, away from continents). At most one per
  // epoch tears a continent apart (Phase 2d).
  let continentalRift: { x: number; y: number; plateA: number; plateB: number; index: number } | null = null

  // Many adjacent lattice points along the same physical boundary
  // stretch resolve to the same terrain feature (see
  // findOrCreateFeatureIndex) — contributions are summed here and
  // averaged once per feature after the loop, rather than applied
  // immediately per lattice point, so a densely-sampled boundary doesn't
  // deposit many times more uplift per epoch than a sparsely-sampled one
  // would for the same actual convergence.
  const featureDeposits = new Map<number, { sum: number; count: number }>()
  const addDeposit = (featureIndex: number, amount: number): void => {
    const existing = featureDeposits.get(featureIndex)
    if (existing) {
      existing.sum += amount
      existing.count += 1
    } else {
      featureDeposits.set(featureIndex, { sum: amount, count: 1 })
    }
  }

  // 3. Classify each boundary point, deposit uplift/subsidence onto the
  // relevant plate's terrain features (any motion class whose
  // classification.elevationSign is nonzero — see boundaryClassification
  // for why transform currently deposits nothing), and track how long
  // each lattice point has stayed on the same side of the same threshold
  // for rift/merge purposes.
  for (const boundary of boundaries) {
    const seedA = sim.seeds[boundary.plateA]
    const seedB = sim.seeds[boundary.plateB]
    const convergence = classifyBoundaryMotion(
      { x: boundary.x, y: boundary.y },
      seedA,
      sim.motions[boundary.plateA],
      seedB,
      sim.motions[boundary.plateB],
      width,
      height,
    )
    const classification = classifyBoundary(sim.types[boundary.plateA], sim.ages[boundary.plateA], sim.types[boundary.plateB], sim.ages[boundary.plateB], convergence.motionClass)

    // Fresh oceanic crust forms at a divergent boundary (a mid-ocean ridge or
    // opening rift) — reset its floor age to 0 so age-depth reads it as young
    // and shallow (Phase 3).
    if (convergence.motionClass === 'divergent') {
      resetOceanAgeAt(sim.oceanAge, boundary.x, boundary.y, width, height)
    }

    const classCode = motionClassCode(convergence.motionClass)
    const index = boundary.latticeIndex
    if (sim.latticeLastClassCode[index] === classCode) {
      sim.latticeLockedEpochs[index] += 1
    } else {
      sim.latticeLockedEpochs[index] = 0
      sim.latticeLastClassCode[index] = classCode
    }
    // getVelocityAt (inside classifyBoundaryMotion) returns velocity
    // scaled by the plate's full angularSpeed, i.e. "per unit of the
    // abstract time getVelocityAt's own unit represents" — deposited
    // as-is, this would accumulate uplift ~1/UPLIFT_EPOCH_SCALE times
    // faster than intended (this is what originally blew straight through
    // the elevation clamp). Uses its own scale rather than
    // EPOCH_ANGLE_STEP specifically so plate movement speed and
    // mountain-building pace can be tuned independently.
    const epochConvergence = convergence.normal * UPLIFT_EPOCH_SCALE
    sim.latticeAccumulated[index] += epochConvergence * classification.rate

    if (classification.elevationSign !== 0) {
      const ageMultiplier = AGE_MULTIPLIER_FLOOR + AGE_MULTIPLIER_RANGE * Math.pow(2, -sim.latticeLockedEpochs[index] / AGE_MULTIPLIER_HALF_LIFE_EPOCHS)
      const amount = Math.abs(epochConvergence) * classification.rate * ageMultiplier * classification.elevationSign
      // Boundary tangent (the ridge's own long axis): perpendicular to the
      // seed-to-seed normal, so a feature can be laid down as an oriented
      // ridge segment rather than an isotropic blob (see
      // TerrainFeature.tangentX / computeElevation's anisotropic falloff).
      const ndx = wrappedDelta(seedA.x, seedB.x, width)
      const ndy = wrappedDelta(seedA.y, seedB.y, height)
      const nlen = Math.sqrt(ndx * ndx + ndy * ndy) || 1
      const tangentX = -ndy / nlen
      const tangentY = ndx / nlen
      // 'both' deposits onto a single shared feature (see
      // findOrCreateFeatureIndex/advanceTerrainFeatures) rather than one
      // per side — a real collision range is one ridge straddling the
      // boundary, not two independent ones.
      const movesWithPlate = classification.upliftSide === 'both' ? 'both' : classification.upliftSide === 'a' ? boundary.plateA : boundary.plateB
      // Oceanic-crust ranges (island arcs, mid-ocean ridges) subside as they
      // drift off their boundary; continental ones (fold mountains, subduction
      // arcs) persist — see TerrainFeature.subsides.
      const featureSubsides = classification.character === 'islandArc' || classification.character === 'midOceanRidge'
      addDeposit(findOrCreateFeatureIndex(sim.features, boundary.x, boundary.y, boundary.plateA, boundary.plateB, movesWithPlate, tangentX, tangentY, 'range', featureSubsides, width, height), amount)

      // Paired trench on the subducting side of a subduction/island arc —
      // the side that is NOT the uplift side (continental crust never
      // subducts; the older oceanic plate goes under at an island arc).
      if (classification.character === 'subductionArc' || classification.character === 'islandArc') {
        const subductingPlate = classification.upliftSide === 'a' ? boundary.plateB : boundary.plateA
        const subductingSeed = sim.seeds[subductingPlate]
        let offsetX = wrappedDelta(subductingSeed.x, boundary.x, width)
        let offsetY = wrappedDelta(subductingSeed.y, boundary.y, height)
        const offsetLen = Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 1
        offsetX /= offsetLen
        offsetY /= offsetLen
        const trenchX = (((boundary.x + offsetX * TRENCH_OFFSET) % width) + width) % width
        const trenchY = (((boundary.y + offsetY * TRENCH_OFFSET) % height) + height) % height
        addDeposit(
          // Trenches are always oceanic (the subducting slab), so they subside.
          findOrCreateFeatureIndex(sim.features, trenchX, trenchY, boundary.plateA, boundary.plateB, subductingPlate, tangentX, tangentY, 'trench', true, width, height),
          -Math.abs(amount) * TRENCH_DEPTH_FRACTION,
        )
      }

      // Continental accretion at a subduction arc: weld a margin blob just
      // inside the overriding (continental) side, growing that continent
      // toward the trench (see the ACCRETION_* constants / accreteToNearestRaft).
      // Throttled to every Nth epoch so continents grow at a measured pace.
      if (classification.character === 'subductionArc' && sim.epoch % ACCRETION_EPOCH_INTERVAL === 0) {
        const continentalSeed = classification.upliftSide === 'a' ? seedA : seedB
        const inX = wrappedDelta(continentalSeed.x, boundary.x, width)
        const inY = wrappedDelta(continentalSeed.y, boundary.y, height)
        const inLen = Math.sqrt(inX * inX + inY * inY) || 1
        const accreteX = (((boundary.x + (inX / inLen) * ACCRETION_INSET) % width) + width) % width
        const accreteY = (((boundary.y + (inY / inLen) * ACCRETION_INSET) % height) + height) % height
        accreteToNearestRaft(sim.rafts, accreteX, accreteY, ACCRETION_BLOB_RADIUS, ACCRETION_MIN_GAP_SQ, ACCRETION_MAX_ATTACH_SQ, width, height)
      }
    }

    // Continental breakup: a divergent point under a continent, on a more
    // lenient lock/threshold than the plate rift below, so a supercontinent
    // can rift apart from within even when the plate rift lands in the ocean.
    // Checked before the plate-rift lock gate since it uses its own lock.
    if (
      !continentalRift &&
      sim.epoch >= sim.continentalRiftCooldownUntil &&
      convergence.motionClass === 'divergent' &&
      sim.latticeLockedEpochs[index] >= CONT_RIFT_LOCK_EPOCHS &&
      sim.latticeAccumulated[index] <= effectiveRiftThreshold * CONT_RIFT_THRESHOLD_FACTOR &&
      raftMembership(boundary.x, boundary.y, sim.rafts, width, height) > 0.5
    ) {
      continentalRift = { x: boundary.x, y: boundary.y, plateA: boundary.plateA, plateB: boundary.plateB, index }
    }

    if (sim.latticeLockedEpochs[index] < LOCK_EPOCHS_REQUIRED) continue
    if (!riftEvent && convergence.motionClass === 'divergent' && sim.latticeAccumulated[index] <= effectiveRiftThreshold) {
      riftEvent = { x: boundary.x, y: boundary.y, plateA: boundary.plateA, plateB: boundary.plateB }
    } else if (!mergeEvent && sim.latticeAccumulated[index] >= effectiveMergeThreshold) {
      // Continent-continent collision (foldMountains) merges the two
      // into one — doesn't matter which index survives, both are
      // continental. Subduction (subductionArc, islandArc) instead
      // consumes specifically the downgoing side — continental crust is
      // too buoyant to ever subduct, so a subductionArc always removes
      // the oceanic plate; islandArc's own upliftSide already identifies
      // the younger, surviving side (see classifyBoundary's age
      // tiebreak), so the OTHER side is the older, denser one going
      // under. Without this, oceanic plates had no way to ever actually
      // disappear — only continent-continent collisions could remove a
      // plate, even though real subduction is the main way a plate
      // vanishes entirely.
      if (classification.character === 'foldMountains') {
        mergeEvent = { x: boundary.x, y: boundary.y, keepIndex: Math.min(boundary.plateA, boundary.plateB), removeIndex: Math.max(boundary.plateA, boundary.plateB) }
      } else if (classification.character === 'subductionArc') {
        const plateAIsOceanic = sim.types[boundary.plateA] === 'oceanic'
        mergeEvent = { x: boundary.x, y: boundary.y, keepIndex: plateAIsOceanic ? boundary.plateB : boundary.plateA, removeIndex: plateAIsOceanic ? boundary.plateA : boundary.plateB }
      } else if (classification.character === 'islandArc') {
        mergeEvent = { x: boundary.x, y: boundary.y, keepIndex: classification.upliftSide === 'a' ? boundary.plateA : boundary.plateB, removeIndex: classification.upliftSide === 'a' ? boundary.plateB : boundary.plateA }
      }
    }
  }

  // Apply this epoch's deposits once per feature, averaged rather than
  // summed — see featureDeposits' own comment above. No floor at zero:
  // thickness is signed now (rift valleys deposit negative amounts to
  // sink, not just mountains depositing positive ones to rise) — see
  // boundaryClassification's elevationSign. THICKNESS_DECAY_PER_EPOCH
  // above already relaxes either sign back toward zero on its own.
  for (const [featureIndex, { sum, count }] of featureDeposits) {
    const feature = sim.features[featureIndex]
    feature.thickness += sum / count
    feature.epochsSinceDeposit = 0
  }

  // Continents that have drifted (or grown by accretion) into contact this
  // epoch suture into one (Phase 2c). Each suture is a continent-collision
  // event (name + seam geometry) for the notification/overlay layer.
  const raftMerges = mergeOverlappingRafts(sim.rafts, MERGE_OVERLAP_FACTOR, sim.epoch, width, height)

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
    raftSplit = splitRaftAtRift(sim.rafts, continentalRift.x, continentalRift.y, cnx / cnl, cny / cnl, newRaftId, SPLIT_MAX_DIST_SQ, SPLIT_GAP, sim.epoch, SPLIT_MERGE_IMMUNITY_EPOCHS, width, height)
    // Reset that point's divergence accumulator so it doesn't immediately
    // re-split the fresh halves next epoch.
    if (raftSplit) {
      sim.latticeAccumulated[continentalRift.index] = 0
      // Space the next breakup out, so a supercontinent under fixed convergent
      // motions doesn't strobe split/merge every epoch (see the cooldown const).
      sim.continentalRiftCooldownUntil = sim.epoch + CONT_RIFT_COOLDOWN_EPOCHS
      // The far half is a brand-new continent — give it its own name (the
      // near half keeps the parent's), so split-born continents aren't
      // left unnamed on the map.
      const newRaft = sim.rafts.find((raft) => raft.id === newRaftId)
      if (newRaft) newRaft.name = pickUnusedRaftName(sim.rafts, sim.random)
    }
  }

  // Rendering/identity cleanup: a raft whose blobs have drifted into spatially
  // separate clusters (renders as several landmasses under one name) is
  // decomposed into one named continent per cluster. No events — this isn't a
  // tectonic breakup, just keeping "one raft = one visible landmass".
  splitDisconnectedRafts(sim.rafts, RAFT_CONNECT_FACTOR, sim.random, width, height)

  const events: SimEvent[] = []

  // --- Continent-scale events (the supercontinent cycle) ---
  // These come from the raft lifecycle (sutures/rifts already applied
  // above), NOT the plate rift/merge below — a continent is a raft across
  // plates, so plate-count changes and continent events are decoupled.
  for (const m of raftMerges) {
    const len = Math.hypot(m.tangentX, m.tangentY) || 1
    events.push({ type: 'continent_collided', nameA: m.nameA ?? undefined, nameB: m.nameB ?? undefined, x: m.x, y: m.y, dirX: m.tangentX / len, dirY: m.tangentY / len })
  }
  if (raftSplit) {
    const len = Math.hypot(raftSplit.axisX, raftSplit.axisY) || 1
    events.push({ type: 'continent_broke_up', name: raftSplit.parentName ?? undefined, x: raftSplit.x, y: raftSplit.y, dirX: raftSplit.axisX / len, dirY: raftSplit.axisY / len })
  }
  // Supercontinent milestone, latched by supercontinentActive so it fires
  // once per assembly rather than every epoch the single raft persists.
  if (sim.rafts.length <= 1 && !sim.supercontinentActive) {
    sim.supercontinentActive = true
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

  // Drop features that have been both inactive for a while AND decayed
  // to a negligible thickness, plus anything inactive long enough to hit
  // the hard cap regardless of thickness — see FEATURE_PRUNE_THICKNESS's
  // own comment for why this is the actual fix for the simulation
  // slowing down over a long run.
  sim.features = sim.features.filter((feature) => {
    if (feature.epochsSinceDeposit <= FEATURE_PRUNE_INACTIVITY_EPOCHS) return true
    if (feature.epochsSinceDeposit > FEATURE_PRUNE_MAX_INACTIVITY_EPOCHS) return false
    return Math.abs(feature.thickness) >= FEATURE_PRUNE_THICKNESS
  })

  sim.epoch += 1

  return events
}

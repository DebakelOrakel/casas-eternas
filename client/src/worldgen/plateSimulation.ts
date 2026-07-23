import { generateBaseElevations } from './plateBaseline'
import { classifyBoundary } from './boundaryClassification'
import { detectBoundaries } from './boundaryDetection'
import type { LatticePoint } from './boundaryLattice'
import { generateDetectionLattice } from './boundaryLattice'
import { generatePlateMotions } from './plateMotion'
import type { PlateMotion } from './plateMotion'
import { classifyBoundaryMotion } from './plateVelocityDecomposition'
import { generatePlateSeeds } from './plateSeeds'
import type { PlateSeed } from './plateSeeds'
import { hashSeedString, mulberry32 } from './rng'
import { assignPlateTypes } from './plateTypes'
import type { PlateType } from './plateTypes'
import { assignContinentNames } from './continentNames'
import { advanceTerrainFeatures, findOrCreateFeatureIndex } from './terrainFeatures'
import type { TerrainFeature } from './terrainFeatures'
import { rotateAroundCenter } from './toroidal'

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
// elsewhere — computeBlendedBaselines alone measured ~140ms independent
// of feature count) — pruning bounds the *growth*, it doesn't make the
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

export interface PlateSimulation {
  width: number
  height: number
  // Plate count as configured at creation — the target the plate-count
  // homeostasis (PLATE_COUNT_PRESSURE_STRENGTH) steers back toward as
  // rift/merge events change seeds.length over time.
  initialPlateCount: number
  seeds: PlateSeed[]
  types: PlateType[]
  motions: PlateMotion[]
  ages: number[]
  baseElevations: number[]
  // One name per plate, `null` for oceanic ones — see continentNames.ts.
  // Kept as a plain parallel array indexed the same way as types/motions/
  // etc. so applyMerge's existing splice-based removal keeps it aligned
  // for free.
  continentNames: (string | null)[]
  features: TerrainFeature[]
  epoch: number
  random: () => number
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
}

export function createPlateSimulation(seedString: string, plateCount: number, continentalCount: number, width: number, height: number): PlateSimulation {
  const random = mulberry32(hashSeedString(seedString))
  const seeds = generatePlateSeeds(plateCount, width, height, random)
  const types = assignPlateTypes(plateCount, continentalCount, random)
  const motions = generatePlateMotions(seeds, width, height, random)
  const baseElevations = generateBaseElevations(types, random)
  const continentNames = assignContinentNames(types, random)
  const lattice = generateDetectionLattice(width, height, DETECTION_LATTICE_RESOLUTION_X, DETECTION_LATTICE_RESOLUTION_Y)

  return {
    width,
    height,
    initialPlateCount: plateCount,
    seeds,
    types,
    motions,
    ages: seeds.map(() => 0),
    baseElevations,
    continentNames,
    features: [],
    epoch: 0,
    random,
    lattice,
    latticeAccumulated: new Float32Array(lattice.length),
    latticeLockedEpochs: new Int16Array(lattice.length),
    latticeLastClassCode: new Int8Array(lattice.length).fill(-1),
  }
}

function motionClassCode(motionClass: 'convergent' | 'divergent' | 'transform'): number {
  return motionClass === 'convergent' ? 0 : motionClass === 'divergent' ? 1 : 2
}

interface RiftEvent {
  x: number
  y: number
}

// Which plate is actually removed (consumed) vs. which one survives and
// absorbs its territory — no longer always min/max by index, since a
// subducting oceanic plate must be the one removed regardless of which
// index it happens to hold (see stepEpoch's merge-resolution branch).
interface MergeEvent {
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
  const newBaseElevation = generateBaseElevations(['oceanic'], sim.random)[0]
  sim.seeds.push(newSeed)
  sim.types.push('oceanic')
  sim.motions.push(newMotion)
  sim.ages.push(0)
  sim.baseElevations.push(newBaseElevation)
  sim.continentNames.push(null)
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
  sim.baseElevations.splice(removeIndex, 1)
  sim.continentNames.splice(removeIndex, 1)
}

export function stepEpoch(sim: PlateSimulation): void {
  const { width, height } = sim

  // 1. Advance every plate (and whatever terrain is attached to it)
  // along its own rotation.
  for (let i = 0; i < sim.seeds.length; i++) {
    const motion = sim.motions[i]
    const rotated = rotateAroundCenter(sim.seeds[i].x, sim.seeds[i].y, motion.centerX, motion.centerY, motion.angularSpeed * EPOCH_ANGLE_STEP, width, height)
    sim.seeds[i].x = rotated.x
    sim.seeds[i].y = rotated.y
    sim.ages[i] += 1
  }
  advanceTerrainFeatures(sim.features, sim.motions, EPOCH_ANGLE_STEP, width, height)
  for (const feature of sim.features) {
    feature.thickness *= THICKNESS_DECAY_PER_EPOCH
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
      // 'both' deposits onto a single shared feature (see
      // findOrCreateFeatureIndex/advanceTerrainFeatures) rather than one
      // per side — a real collision range is one ridge straddling the
      // boundary, not two independent ones.
      const movesWithPlate = classification.upliftSide === 'both' ? 'both' : classification.upliftSide === 'a' ? boundary.plateA : boundary.plateB
      addDeposit(findOrCreateFeatureIndex(sim.features, boundary.x, boundary.y, boundary.plateA, boundary.plateB, movesWithPlate, width, height), amount)
    }

    if (sim.latticeLockedEpochs[index] < LOCK_EPOCHS_REQUIRED) continue
    if (!riftEvent && convergence.motionClass === 'divergent' && sim.latticeAccumulated[index] <= effectiveRiftThreshold) {
      riftEvent = { x: boundary.x, y: boundary.y }
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
        mergeEvent = { keepIndex: Math.min(boundary.plateA, boundary.plateB), removeIndex: Math.max(boundary.plateA, boundary.plateB) }
      } else if (classification.character === 'subductionArc') {
        const plateAIsOceanic = sim.types[boundary.plateA] === 'oceanic'
        mergeEvent = plateAIsOceanic ? { keepIndex: boundary.plateB, removeIndex: boundary.plateA } : { keepIndex: boundary.plateA, removeIndex: boundary.plateB }
      } else if (classification.character === 'islandArc') {
        mergeEvent = classification.upliftSide === 'a' ? { keepIndex: boundary.plateA, removeIndex: boundary.plateB } : { keepIndex: boundary.plateB, removeIndex: boundary.plateA }
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

  // At most one rift and one merge per epoch — both are rare (locking
  // takes LOCK_EPOCHS_REQUIRED epochs to even become eligible) and this
  // sidesteps the bookkeeping multiple simultaneous plate-count changes
  // in a single epoch would need.
  if (riftEvent) applyRift(sim, riftEvent)
  if (mergeEvent) applyMerge(sim, mergeEvent)

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
}

import { classifyBoundary } from '../boundaryClassification'
import { detectBoundaries } from '../boundaryDetection'
import { wrapValue } from '../../core/field'
import { wrappedDelta } from '../../core/toroidal'
import { raftMembership } from '../../crust/raftField'
import { accreteToNearestRaft } from '../../crust/raftLifecycle'
import { resetOceanAgeAround } from '../oceanAge'
import { classifyBoundaryMotion } from '../plateVelocityDecomposition'
import { ACCRETION_BLOB_RADIUS, ACCRETION_EPOCH_INTERVAL, ACCRETION_INSET, ACCRETION_MAX_ATTACH_SQ, ACCRETION_MIN_GAP_SQ, AGE_MULTIPLIER_FLOOR, AGE_MULTIPLIER_HALF_LIFE_EPOCHS, AGE_MULTIPLIER_RANGE, CONT_RIFT_LOCK_EPOCHS, CONT_RIFT_THRESHOLD_FACTOR, LOCK_EPOCHS_REQUIRED, MERGE_ACCUMULATOR_THRESHOLD, PLATE_COUNT_PRESSURE_CLAMP, PLATE_COUNT_PRESSURE_STRENGTH, RIDGE_FRESH_CRUST_RADIUS, RIFT_ACCUMULATOR_THRESHOLD, RIFT_BASIN_FLOOR_THICKNESS, TRENCH_DEPTH_FRACTION, TRENCH_OFFSET, UPLIFT_EPOCH_SCALE } from '../tectonicsParams'
import { findOrCreateFeatureIndex } from '../terrainFeatures'
import type { MergeEvent, PlateSimulation, RiftEvent } from '../plateSimulationTypes'



function motionClassCode(motionClass: 'convergent' | 'divergent' | 'transform'): number {
  return motionClass === 'convergent' ? 0 : motionClass === 'divergent' ? 1 : 2
}

// What one epoch's phases hand to each other. stepEpoch used to carry all of this
// as locals across 440 lines, which is exactly what made the data flow between
// its four numbered comment headings impossible to see: `membership` is computed
// in phase 0 and read in phase 1, `boundaries` in phase 2 and re-read during the
// breakup in phase 4, and the three pending events are decided in phase 3 but not
// applied until phase 5. Making each phase take what it needs and return what it
// produces turns those couplings into signatures.
export interface BoundaryPassResult {
  boundaries: ReturnType<typeof detectBoundaries>
  riftEvent: RiftEvent | null
  mergeEvent: MergeEvent | null
  continentalRift: { x: number; y: number; plateA: number; plateB: number; index: number } | null
}

// Phases 2 and 3. Detect this epoch's boundaries, classify each point, deposit
// uplift/subsidence onto the relevant terrain features, and decide which (at most
// one each) plate rift, plate merge and continental rift this epoch has earned.
// Applying those is phases 4 and 5 — this phase only decides.
export function runBoundaryPass(sim: PlateSimulation): BoundaryPassResult {
  const { width, height } = sim
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
      resetOceanAgeAround(sim.oceanAge, boundary.x, boundary.y, RIDGE_FRESH_CRUST_RADIUS, width, height)
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
      const rangeIdx = findOrCreateFeatureIndex(sim.features, boundary.x, boundary.y, boundary.plateA, boundary.plateB, movesWithPlate, tangentX, tangentY, 'range', featureSubsides, width, height)
      // Subduction/island arcs are volcanic (a chain of volcanoes); flag them so the
      // screen can mark them (see TerrainFeature.volcanic). Only ever set true — a
      // shared feature reused across epochs stays flagged once it's been an arc.
      if (classification.character === 'subductionArc' || classification.character === 'islandArc') sim.features[rangeIdx].volcanic = true
      addDeposit(rangeIdx, amount)

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
        const trenchX = wrapValue((boundary.x + offsetX * TRENCH_OFFSET), width)
        const trenchY = wrapValue((boundary.y + offsetY * TRENCH_OFFSET), height)
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
        accreteToNearestRaft(sim.rafts, accreteX, accreteY, ACCRETION_BLOB_RADIUS, sim.epoch, ACCRETION_MIN_GAP_SQ, ACCRETION_MAX_ATTACH_SQ, width, height)
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
    // Rift-lake floor: a continental rift trough (the only negative-thickness range —
    // trenches are 'trench' kind) is capped so its floor stays just ABOVE sea level
    // instead of running away to the elevation clamp (thickness → ~−50 → elevation −1 →
    // ocean). At the cap the graben floor is ~0.35 + (−8)·0.035 ≈ 0.07, a deep but
    // dry-land enclosed basin that the hydrology's computeLakes fills into a deep rift
    // lake (Baikal/Tanganyika-scale). It stays a LAKE, not an ocean, until the rift
    // actually breaks up — then birthRidgePlate drops the whole area to the oceanic
    // baseline and the lake floods to sea (transient, Red-Sea-style). See the tectonic-
    // rift-lakes work in docs/decisions and RIFT_BASIN_FLOOR_THICKNESS.
    if (feature.kind === 'range' && feature.thickness < RIFT_BASIN_FLOOR_THICKNESS) feature.thickness = RIFT_BASIN_FLOOR_THICKNESS
  }
  return { boundaries, riftEvent, mergeEvent, continentalRift }
}

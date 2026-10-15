import { classifyBoundary, type BoundaryClassification } from '../boundaryClassification'
import { detectBoundaries } from '../boundaryDetection'
import { buildBlobIndex, nearestRaftIndexed, raftFieldIndexed, raftMembership, type BlobIndex } from '../../crust/raftField'
import type { PlateType } from '../plateTypes'
import { accreteToNearestRaft, carrierPlateAt, RAFT_CARRY_REACH, raftHostPlates } from '../../crust/raftLifecycle'
import { TECTONIC_MA_PER_EPOCH, worldEpoch } from '../../core/worldTime'
import { kmPerMyr } from '../plateMotion'
import { classifyBoundaryMotion } from '../plateVelocityDecomposition'
import { TECTONICS_TUNING } from '../tectonicsTuneParams'
import { findOrCreateFeatureIndex } from '../terrainFeatures'
import type { MergeEvent, PlateSimulation, RiftEvent } from '../plateSimulationTypes'
import { detPow } from '../../core/detMath'

// The offset `domain.delta` writes into: one per module, so no call
// allocates. Read it at once, before the next delta.
const offset = { x: 0, y: 0 }
// A point beside a boundary point (its crust's carrier), the same way.
const sidePoint = { x: 0, y: 0 }



// The crust either side of a boundary point (runBoundaryPass's crustBeside):
// A's side along the normal, B's against it.
interface CrustBeside {
  crustA: PlateType
  crustB: PlateType
  carrierA: number
  carrierB: number
}

// Points of an edge of the detection lattice, the same way as `offset`.
const edgeFar = { x: 0, y: 0 }
const edgeMid = { x: 0, y: 0 }
const coastPoint = { x: 0, y: 0 }

// The carriers' margins (runBoundaryPass, DEC-0036 phase 8g-2): every edge
// of the detection lattice, one step east and one south of each point,
// across which the plate that carries the crust changes and on which a raft
// lies (within RAFT_CARRY_REACH of either end), lays down its relief — the
// carriers' relative motion at the edge's midpoint, the boundary's
// character from the crust either side. The far end's carrier is A.
//
// The edge lies where the raft's reach ends, out at sea: the ocean floor
// next to a continent rides with it (the terrain's nodes as the rafts,
// RAFT_CARRY_REACH), so the plates meet beyond the coast, as a trench lies
// off its margin. The range stands at the margin itself: each side is
// searched along the normal for the coast (a raft's field above one half)
// within coastSearchM, a side with a coast is continental, and the range is
// laid at the overriding side's coast — at the edge's midpoint when both
// sides are continental (a collision). An edge with no coast beside it is
// the ocean's, which the Voronoi boundary lays down; one that parts a raft
// from the ocean opens new sea floor (the ocean age's), not a rift, and
// lays down nothing.
function depositCarrierMargins(
  sim: PlateSimulation,
  layRelief: (x: number, y: number, plateA: number, plateB: number, relief: BoundaryClassification, amount: number, nx: number, ny: number, trenchDirX: number, trenchDirY: number) => void,
  epochMa: number,
  blobs: BlobIndex,
  hosts: number[],
): void {
  const { domain } = sim
  // One lattice step, domain units: the lattice's column spacing at the
  // equator (a row narrows on the sphere; the step stays a length).
  const step = domain.width / TECTONICS_TUNING.detectionLatticeResolutionX
  // The coast's search, in half steps.
  const searchSteps = Math.ceil(TECTONICS_TUNING.coastSearchM / domain.metresPerUnit / (step / 2))
  // The distance to the coast from (x, y) along (dx, dy), domain units, or
  // −1 within the search.
  const coastAlong = (x: number, y: number, dx: number, dy: number): number => {
    for (let k = 0; k <= searchSteps; k++) {
      const d = k * (step / 2)
      domain.advance(x, y, dx * d, dy * d, coastPoint)
      if (raftFieldIndexed(coastPoint.x, coastPoint.y, blobs) > 0.5) return d
    }
    return -1
  }
  for (const point of sim.lattice) {
    // Whether a raft is in reach comes first: it is the cheap test, and
    // most edges fail it.
    const nearOnRaft = nearestRaftIndexed(point.x, point.y, blobs, RAFT_CARRY_REACH) >= 0
    let near = -1
    for (let d = 0; d < 2; d++) {
      const dx = d === 0 ? step : 0
      const dy = d === 0 ? 0 : step
      domain.advance(point.x, point.y, dx, dy, edgeFar)
      if (!nearOnRaft && nearestRaftIndexed(edgeFar.x, edgeFar.y, blobs, RAFT_CARRY_REACH) < 0) continue
      if (near < 0) near = carrierPlateAt(point.x, point.y, blobs, hosts, sim.seeds, domain)
      const far = carrierPlateAt(edgeFar.x, edgeFar.y, blobs, hosts, sim.seeds, domain)
      if (far === near) continue
      domain.advance(point.x, point.y, dx / 2, dy / 2, edgeMid)
      const mid = { x: edgeMid.x, y: edgeMid.y }
      const farEnd = { x: edgeFar.x, y: edgeFar.y }
      // The unit normal into the far side, in the midpoint's frame.
      domain.delta(farEnd.x, farEnd.y, mid.x, mid.y, offset)
      const len = Math.sqrt(offset.x * offset.x + offset.y * offset.y) || 1
      const nx = offset.x / len
      const ny = offset.y / len
      const coastA = coastAlong(mid.x, mid.y, nx, ny)
      const coastB = coastAlong(mid.x, mid.y, -nx, -ny)
      if (coastA < 0 && coastB < 0) continue
      const crustA: PlateType = coastA >= 0 ? 'continental' : 'oceanic'
      const crustB: PlateType = coastB >= 0 ? 'continental' : 'oceanic'
      const convergence = classifyBoundaryMotion(mid, farEnd, sim.motions[far], point, sim.motions[near], domain)
      if (convergence.motionClass === 'transform') continue
      if (convergence.motionClass === 'divergent' && (crustA === 'oceanic' || crustB === 'oceanic')) continue
      const relief = classifyBoundary(crustA, sim.ages[far], crustB, sim.ages[near], convergence.motionClass)
      if (relief.elevationSign === 0) continue
      const amount = Math.abs(kmPerMyr(convergence.normal, domain) * epochMa * TECTONICS_TUNING.upliftPerKm) * relief.rate * relief.elevationSign
      // The range at the overriding side's coast; the trench lies on the
      // subducting side.
      let x = mid.x
      let y = mid.y
      if (relief.upliftSide !== 'both') {
        const toA = relief.upliftSide === 'a'
        const along = toA ? coastA : coastB
        domain.advance(mid.x, mid.y, (toA ? nx : -nx) * along, (toA ? ny : -ny) * along, coastPoint)
        x = coastPoint.x
        y = coastPoint.y
      }
      const towards = relief.upliftSide === 'a' ? -1 : 1
      layRelief(x, y, far, near, relief, amount, nx, ny, towards * nx, towards * ny)
    }
  }
}

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
  const { domain } = sim
  // 2. Detect this epoch's boundaries against the fixed lattice.
  const boundaries = detectBoundaries(sim.lattice, sim.seeds, domain)

  // Scales the rift/merge thresholds toward whichever makes the currently-
  // scarce event easier — see TECTONICS_TUNING.plateCountPressureStrength's own comment.
  // Positive pressure means too few plates (rifting should get easier,
  // merging harder); negative means too many (the reverse).
  const plateCountPressure = Math.max(
    -TECTONICS_TUNING.plateCountPressureClamp,
    Math.min(TECTONICS_TUNING.plateCountPressureClamp, (sim.initialPlateCount - sim.seeds.length) * TECTONICS_TUNING.plateCountPressureStrength),
  )
  const effectiveRiftThreshold = TECTONICS_TUNING.riftAccumulatorThreshold * (1 - plateCountPressure)
  const effectiveMergeThreshold = TECTONICS_TUNING.mergeAccumulatorThreshold * (1 + plateCountPressure)

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
  // The crust beside each boundary point and the plate that carries it
  // (DEC-0036 phase 8g-2), by the terrain's own rule (a raft rides its host
  // plate), crustSideM into each plate.
  const carrierBlobs = buildBlobIndex(sim.rafts, domain, RAFT_CARRY_REACH)
  const raftHosts = raftHostPlates(sim.rafts, sim.seeds, domain)
  const crustSide = TECTONICS_TUNING.crustSideM / domain.metresPerUnit
  // The crust beside a point on each side of a boundary through it, the
  // unit normal (nx, ny) pointing into A's side: crustSideM into each, the
  // crust's type (a raft's field above one half) and the plate that
  // carries it.
  const crustBeside = (x: number, y: number, nx: number, ny: number): CrustBeside => {
    domain.advance(x, y, nx * crustSide, ny * crustSide, sidePoint)
    const crustA: PlateType = raftFieldIndexed(sidePoint.x, sidePoint.y, carrierBlobs) > 0.5 ? 'continental' : 'oceanic'
    const carrierA = carrierPlateAt(sidePoint.x, sidePoint.y, carrierBlobs, raftHosts, sim.seeds, domain)
    domain.advance(x, y, -nx * crustSide, -ny * crustSide, sidePoint)
    const crustB: PlateType = raftFieldIndexed(sidePoint.x, sidePoint.y, carrierBlobs) > 0.5 ? 'continental' : 'oceanic'
    const carrierB = carrierPlateAt(sidePoint.x, sidePoint.y, carrierBlobs, raftHosts, sim.seeds, domain)
    return { crustA, crustB, carrierA, carrierB }
  }
  // Lays down a boundary's relief at (x, y) between plates A and B: the
  // range feature (an arc's flagged volcanic) and, at an arc, the paired
  // trench towards the subducting side (trenchDirX/Y, a unit vector).
  // (nx, ny) is the unit normal into A's side; the feature's tangent, the
  // ridge's own long axis, is perpendicular to it, so a feature can be laid
  // down as an oriented ridge segment rather than an isotropic blob (see
  // TerrainFeature.tangentX / computeElevation's anisotropic falloff).
  const layRelief = (x: number, y: number, plateA: number, plateB: number, relief: BoundaryClassification, amount: number, nx: number, ny: number, trenchDirX: number, trenchDirY: number): void => {
    const tangentX = -ny
    const tangentY = nx
    // 'both' deposits onto a single shared feature (see
    // findOrCreateFeatureIndex/advanceTerrainFeatures) rather than one
    // per side — a real collision range is one ridge straddling the
    // boundary, not two independent ones.
    const movesWithPlate = relief.upliftSide === 'both' ? 'both' : relief.upliftSide === 'a' ? plateA : plateB
    // Oceanic-crust ranges (island arcs, mid-ocean ridges) subside as they
    // drift off their boundary; continental ones (fold mountains, subduction
    // arcs) persist — see TerrainFeature.subsides.
    const featureSubsides = relief.character === 'islandArc' || relief.character === 'midOceanRidge'
    const rangeIdx = findOrCreateFeatureIndex(sim.features, x, y, plateA, plateB, movesWithPlate, tangentX, tangentY, 'range', featureSubsides, domain)
    // Subduction/island arcs are volcanic (a chain of volcanoes); flag them so the
    // screen can mark them (see TerrainFeature.volcanic). Only ever set true — a
    // shared feature reused across epochs stays flagged once it's been an arc.
    if (relief.character === 'subductionArc' || relief.character === 'islandArc') sim.features[rangeIdx].volcanic = true
    addDeposit(rangeIdx, amount)
    // Paired trench on the subducting side of a subduction/island arc —
    // the side that is NOT the uplift side (continental crust never
    // subducts; the older oceanic plate goes under at an island arc).
    if (relief.character === 'subductionArc' || relief.character === 'islandArc') {
      const subductingPlate = relief.upliftSide === 'a' ? plateB : plateA
      // The offset in domain units (the tuning's metres).
      const trenchOffset = TECTONICS_TUNING.trenchOffsetM / domain.metresPerUnit
      // Moved as a point (across a pole on the sphere): advance, which on
      // the torus is the wrapped sum this always was.
      domain.advance(x, y, trenchDirX * trenchOffset, trenchDirY * trenchOffset, offset)
      addDeposit(
        // Trenches are always oceanic (the subducting slab), so they subside.
        findOrCreateFeatureIndex(sim.features, offset.x, offset.y, plateA, plateB, subductingPlate, tangentX, tangentY, 'trench', true, domain),
        -Math.abs(amount) * TECTONICS_TUNING.trenchDepthFraction,
      )
    }
  }
  const epochMa = sim.epochMa || TECTONIC_MA_PER_EPOCH
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
      domain,
    )
    const classification = classifyBoundary(sim.types[boundary.plateA], sim.ages[boundary.plateA], sim.types[boundary.plateB], sim.ages[boundary.plateB], convergence.motionClass)

    // Fresh oceanic crust at a divergent boundary is the ocean age's own
    // (tectonics/oceanAge.advectOceanAge, DEC-0036 phase 8e): the strip the
    // two plates open in the epoch, not a disc around each boundary point.

    const classCode = motionClassCode(convergence.motionClass)
    const index = boundary.latticeIndex
    if (sim.latticeLastClassCode[index] === classCode) {
      sim.latticeLockedEpochs[index] += 1
    } else {
      sim.latticeLockedEpochs[index] = 0
      sim.latticeLastClassCode[index] = classCode
    }
    // The convergence over the epoch, km (the velocity is in domain units
    // per Ma, plateMotion), as the crust it thickens: upliftPerKm.
    const epochConvergence = kmPerMyr(convergence.normal, domain) * epochMa * TECTONICS_TUNING.upliftPerKm
    sim.latticeAccumulated[index] += epochConvergence * classification.rate

    if (classification.elevationSign !== 0) {
      // The seed-to-seed normal, found at B's seed and carried to the
      // boundary point (on the torus the same two numbers): it points from
      // B's seed towards A's (Domain.delta), so A's side is +n.
      domain.delta(seedA.x, seedA.y, seedB.x, seedB.y, offset)
      domain.transport(offset.x, offset.y, seedB.x, seedB.y, boundary.x, boundary.y, offset)
      const nlen = Math.sqrt(offset.x * offset.x + offset.y * offset.y) || 1
      const nx = offset.x / nlen
      const ny = offset.y / nlen
      const side = crustBeside(boundary.x, boundary.y, nx, ny)
      // A boundary with continental crust beside it builds relief only
      // where the same plate carries both sides, and only where it
      // converges — at intraplateShortening of the plates' rate; where two
      // plates carry them, the carriers' margin is the boundary and
      // depositCarrierMargins below lays it down. In the ocean the plates
      // are the carriers.
      const continental = side.crustA === 'continental' || side.crustB === 'continental'
      const intraplate = convergence.motionClass === 'convergent' ? TECTONICS_TUNING.intraplateShortening : 0
      const deformation = side.carrierA === side.carrierB ? (continental ? intraplate : 0) : continental ? 0 : 1
      if (deformation > 0) {
        const relief = classifyBoundary(side.crustA, sim.ages[boundary.plateA], side.crustB, sim.ages[boundary.plateB], convergence.motionClass)
        const ageMultiplier = TECTONICS_TUNING.ageMultiplierFloor + TECTONICS_TUNING.ageMultiplierRange * detPow(2, -sim.latticeLockedEpochs[index] / TECTONICS_TUNING.ageMultiplierHalfLifeEpochs)
        const amount = Math.abs(epochConvergence) * relief.rate * ageMultiplier * relief.elevationSign * deformation
        // The trench lies towards the subducting plate's seed.
        const subductingSeed = relief.upliftSide === 'a' ? seedB : seedA
        domain.delta(subductingSeed.x, subductingSeed.y, boundary.x, boundary.y, offset)
        const tlen = Math.sqrt(offset.x * offset.x + offset.y * offset.y) || 1
        layRelief(boundary.x, boundary.y, boundary.plateA, boundary.plateB, relief, amount, nx, ny, offset.x / tlen, offset.y / tlen)
      }

      // Continental accretion at a subduction arc: weld a margin blob just
      // inside the overriding (continental) side, growing that continent
      // toward the trench (see the ACCRETION_* constants / accreteToNearestRaft).
      // Throttled to every Nth epoch so continents grow at a measured pace.
      if (classification.character === 'subductionArc' && sim.epoch % TECTONICS_TUNING.accretionEpochInterval === 0) {
        const continentalSeed = classification.upliftSide === 'a' ? seedA : seedB
        domain.delta(continentalSeed.x, continentalSeed.y, boundary.x, boundary.y, offset)
        const inX = offset.x
        const inY = offset.y
        const inLen = Math.sqrt(inX * inX + inY * inY) || 1
        // The accretion's lengths in domain units (the tuning's metres).
        const unitM = domain.metresPerUnit
        const inset = TECTONICS_TUNING.accretionInsetM / unitM
        const minGap = TECTONICS_TUNING.accretionMinGapM / unitM
        const maxAttach = TECTONICS_TUNING.accretionMaxAttachM / unitM
        domain.advance(boundary.x, boundary.y, (inX / inLen) * inset, (inY / inLen) * inset, offset)
        const accreteX = offset.x
        const accreteY = offset.y
        accreteToNearestRaft(sim.rafts, accreteX, accreteY, TECTONICS_TUNING.accretionBlobRadiusM / unitM, worldEpoch(sim.archeanEpochs, sim.epoch), minGap * minGap, maxAttach * maxAttach, domain)
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
      sim.latticeLockedEpochs[index] >= TECTONICS_TUNING.contRiftLockEpochs &&
      sim.latticeAccumulated[index] <= effectiveRiftThreshold * TECTONICS_TUNING.contRiftThresholdFactor &&
      raftMembership(boundary.x, boundary.y, sim.rafts, domain) > 0.5
    ) {
      continentalRift = { x: boundary.x, y: boundary.y, plateA: boundary.plateA, plateB: boundary.plateB, index }
    }

    if (sim.latticeLockedEpochs[index] < TECTONICS_TUNING.lockEpochsRequired) continue
    if (!riftEvent && convergence.motionClass === 'divergent' && sim.latticeAccumulated[index] <= effectiveRiftThreshold) {
      riftEvent = { x: boundary.x, y: boundary.y, plateA: boundary.plateA, plateB: boundary.plateB }
    } else if (!mergeEvent && sim.seeds.length > TECTONICS_TUNING.minPlateCount && sim.latticeAccumulated[index] >= effectiveMergeThreshold) {
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

  // THE CARRIERS' MARGINS (DEC-0036 phase 8g-2): where the plate that
  // carries the crust changes next to a raft. A raft rides its host plate
  // as a whole, so its margins are where the host meets another plate's
  // crust — at the raft's own edge wherever the raft reaches into another
  // plate's cell, not on the Voronoi boundary of the seeds. Measured
  // 2026-10-14 (calibration seed, epochs 10 and 20): 72–84 % of the
  // converging edges of the carriers next to a raft lay on no Voronoi
  // boundary point. Each lattice point is compared with the point one
  // lattice step east and one south of it; an edge between two carriers
  // that touches a raft lays down its relief at its midpoint, from the
  // carriers' own motions and the crust crustSideM to either side. The
  // Voronoi boundary's lock state does not follow these edges, so their
  // age multiplier is 1.
  depositCarrierMargins(sim, layRelief, epochMa, carrierBlobs, raftHosts)

  // Apply this epoch's deposits once per feature, averaged rather than
  // summed — see featureDeposits' own comment above. No floor at zero:
  // thickness is signed now (rift valleys deposit negative amounts to
  // sink, not just mountains depositing positive ones to rise) — see
  // boundaryClassification's elevationSign. TECTONICS_TUNING.thicknessDecayPerEpoch
  // above already relaxes either sign back toward zero on its own.
  for (const [featureIndex, { sum, count }] of featureDeposits) {
    const feature = sim.features[featureIndex]
    feature.thickness += sum / count
    feature.epochsSinceDeposit = 0
    // The shortening rate's moving mean gets the epoch's share (plateDrift
    // decayed the old mean): the deposit back in km of shortening per Ma.
    const shorteningKeep = detPow(2, -epochMa / TECTONICS_TUNING.shorteningHalfLifeMa)
    feature.shorteningKmPerMyr = (feature.shorteningKmPerMyr ?? 0) + (1 - shorteningKeep) * (sum / count) / (TECTONICS_TUNING.upliftPerKm * epochMa)
    // Rift-lake floor: a continental rift trough (the only negative-thickness range —
    // trenches are 'trench' kind) is capped so its floor stays just ABOVE sea level
    // instead of running away to the elevation clamp (thickness → ~−50 → elevation −1 →
    // ocean). At the cap the graben floor is ~0.35 + (−8)·0.035 ≈ 0.07, a deep but
    // dry-land enclosed basin that the hydrology's computeLakes fills into a deep rift
    // lake (Baikal/Tanganyika-scale). It stays a LAKE, not an ocean, until the rift
    // actually breaks up — then birthRidgePlate drops the whole area to the oceanic
    // baseline and the lake floods to sea (transient, Red-Sea-style). See the tectonic-
    // rift-lakes work in docs/decisions and TECTONICS_TUNING.riftBasinFloorThickness.
    if (feature.kind === 'range' && feature.thickness < TECTONICS_TUNING.riftBasinFloorThickness) {
      feature.thickness = TECTONICS_TUNING.riftBasinFloorThickness
      // At its floor the rift thins the crust no further, so it no longer
      // lowers the land in the history (DEC-0036 phase 8g): with the rate
      // kept, a divergent plate boundary under a continent (the rafts
      // ride decoupled from the plates) lowered 15–23 % of the land by
      // 0.4–1.4 mm/yr and drowned 3–4 points of it in 12 epochs (measured
      // 2026-10-14, calibration seed, both shapes).
      if ((feature.shorteningKmPerMyr ?? 0) < 0) feature.shorteningKmPerMyr = 0
    }
  }
  return { boundaries, riftEvent, mergeEvent, continentalRift }
}

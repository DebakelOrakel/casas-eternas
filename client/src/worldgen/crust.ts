import { Vector3 } from '@babylonjs/core'
import { buildCoastlineNoiseField, type CoastlineNoiseField } from './coastlineNoise'
import { hashSeedString, mulberry32 } from './rng'
import {
  addPlate,
  createPlateColor,
  nearestTwoPlateIndices,
  randomEulerKinematics,
  removePlate,
  type PlateType,
  type PlateWorld,
} from './plates'
import { angularDistance, fibonacciSpherePoints, randomUnitVector, rotateAroundAxis } from './sphere'

// Two separate roles used to live on one fixed lattice, which is why
// mountains didn't travel with their plate (see TerrainFeature below):
//
// - The detection grid (`points` + `thickness`/`lockedEpochs`/`hasRifted`)
//   is fixed in space, per docs/decisions/plate-tectonics-simulation.md's
//   "state along boundary curves" (A3). It only ever answers "is there an
//   active boundary here right now" and drives rift/merge — it does not
//   carry the rendered elevation record.
// - TerrainFeature (below) is what actually gets rendered — mountains,
//   trenches, arcs, rift valleys, and mid-ocean ridges alike. Each one is
//   born wherever the detection grid finds sustained convergence *or*
//   divergence, then moves every epoch by rotating with whichever plate
//   absorbed it (attachedPlateId) — a real plate, not a fixed point in
//   space. That's what makes terrain travel with its plate instead of
//   being left behind as the plate drifts out from under a fixed sample
//   point. (Divergent deposits always use subductingPlateId -1 — there's
//   no subducting side while pulling apart — and attach to plate `a`,
//   arbitrary but consistent, same as continental-continental collision.)
//
// Remaining simplification versus the full model: there's no explicit
// "time since this boundary started converging" — mountain character
// uses plate age as a proxy instead (ageUpliftMultiplier), which reads
// right for the common case (a fresh collision involves young plates)
// but isn't identical to the real thing.
//
// Rift/merge are threshold crossings on the detection grid's
// thickness/lock state, per the sim doc — not a separate system. Both
// are capped at one event per epoch, globally: a divergent boundary
// crosses threshold at several neighboring sample points in the same
// epoch (they're all part of the same rift), and spawning a new plate
// per point would balloon the plate count into a cluster of
// near-duplicates for what is really one rift event.
//
// Rift needs two guards, confirmed empirically (a 300-epoch run without
// them produced ~300 rifts — essentially one every epoch — and an
// unbounded plate count):
// - hasRifted (below): one-shot per crust point, since a still-diverging
//   boundary keeps its thickness near the rift threshold indefinitely.
// - riftBudgetRemaining: a per-point guard alone isn't enough, because as
//   plates drift, a single ongoing divergent *boundary* sweeps across an
//   endless supply of fresh, never-yet-rifted lattice points — so it
//   keeps minting new plates from a moving location rather than actually
//   being capped. The budget bounds how many rift events a world can
//   produce in total, which a per-point flag structurally can't do.
// Merge doesn't need either guard — each merge permanently removes a
// continental plate, which self-limits how often it can recur. Merging
// does need to reattach any terrain features that were riding on the
// removed plate onto the survivor (applyRiftAndMergeEvents) — otherwise
// they'd be left with no plate to move with at all.

export interface TerrainFeature {
  position: Vector3
  thickness: number
  // Plate id (PlateWorld.ids, not an array index) of whichever side
  // subducts here, or -1 if this feature isn't a subduction pair
  // (continental-continental fold mountains have no subducting side).
  subductingPlateId: number
  // Plate id this feature currently rotates with each epoch. For a
  // subduction pair this is the overriding side (the one whose crust
  // actually keeps the arc, per real geology); for continental-
  // continental collision there's no natural "which side" so it's
  // whichever of the pair happened to be nearest when the feature formed.
  attachedPlateId: number
}

export interface CrustState {
  points: Vector3[]
  thickness: Float32Array
  // Consecutive epochs this point has been continental-continental
  // convergent with thickness at/above the merge threshold — the "held
  // for enough consecutive epochs" condition the merge decision needs.
  // Resets to 0 the moment either condition breaks.
  lockedEpochs: Uint16Array
  // 1 once this point has ever spawned a rift — permanent, never reset.
  hasRifted: Uint8Array
  // Hard cap on total rift events for this world's lifetime — see the
  // module comment for why a per-point guard alone doesn't bound this.
  // Decrements on every rift; not currently replenished, so a world
  // eventually stops rifting even under indefinite play. Revisit if we
  // want rifting to stay available across arbitrarily long runs.
  riftBudgetRemaining: number
  boundaryGapThreshold: number
  falloffRadius: number
  // Continues the same seeded stream used to build the crust lattice, so
  // rift-spawned plates (type/color/kinematics) stay deterministic for a
  // given seed + epoch sequence instead of drawing from Math.random().
  rng: () => number
  terrainFeatures: TerrainFeature[]
  // What the user asked for at generation time — the thing continental
  // weight adaptation (adaptContinentalWeights) keeps nudging actual
  // rendered land area back toward, since the one-time calibration at
  // generation drifts badly over a long run (verified: one run swung
  // from 36% land down to 9% purely from plates randomly drifting into
  // crowded configurations, with no tectonic event involved).
  targetLandOceanRatio: number
  // Fixed once at generation (see coastlineNoise.ts) so a given seed's
  // coastline wobble stays the same across every epoch's texture redraw
  // — regenerating this per redraw would make coastlines visibly
  // flicker/shift every epoch even though the underlying geography
  // hadn't actually changed.
  coastlineNoise: CoastlineNoiseField
}

// Spacing here (~sqrt(4*PI/count) radians) is what limits how finely
// boundary curves are *detected* — independent of the render mesh's
// vertex density, and no longer of elevation-query cost either, since
// elevationAt now reads terrainFeatures (typically far fewer points),
// not this grid.
const CRUST_POINT_COUNT = 1600
const MAX_THICKNESS = 1
const MIN_THICKNESS = -0.3
const DIVERGENT_RELAX_RATE = 0.5
// Tuned so a boundary under steady convergence visibly rises over the
// default 10-epochs-per-click batch.
const UPLIFT_STEP_SCALE = 6
// Stand-in for erosion until the real ridged-fractal-noise pass exists
// (docs/vision.md Phase 3): every point/feature loses a few percent of
// its accumulated thickness each epoch, active boundary or not.
// Negligible against a strongly convergent boundary's per-epoch gain,
// but it's what lets thickness actually settle back toward baseline once
// a boundary stops being active, instead of holding its last value
// forever.
const EROSION_RELAXATION_RATE = 0.03
// Exponential decay never actually reaches zero, so without a floor an
// orphaned feature (its boundary long since moved elsewhere, or gone
// quiet) lingers indefinitely at a tiny-but-nonzero thickness — small
// enough to look negligible but still enough to flip elevation's sign
// within its own falloff radius against the (already small) base
// elevation below, showing up as a spurious little coastline ring with
// no relation to any real, currently active boundary. Confirmed directly
// via saved checkpoint renders: these rings were scattered across both
// land and ocean and grew more numerous over a run, tracking total
// feature count rather than any actual boundary activity. Below this
// magnitude a feature is pruned outright instead of kept shrinking.
const NEGLIGIBLE_FEATURE_THICKNESS = 0.05

const CONTINENTAL_BASE_ELEVATION = 0.03
const OCEANIC_BASE_ELEVATION = -0.05
const CONTINENTAL_BUOYANCY = 0.35
const OCEANIC_BUOYANCY = 0.15
// Subduction-zone overrides: the same accumulated thickness reads as an
// arc on the overriding side and a trench — deeper than either arc is
// tall, same as real subduction zones — on the subducting side. The
// overriding arc is taller when continental (volcanic arcs like the
// Andes) than when oceanic (island arcs like Japan), even though both
// arise from the same TRENCH_BUOYANCY on the subducting side.
const SUBDUCTION_ARC_BUOYANCY = 0.4
const ISLAND_ARC_OVERRIDE_BUOYANCY = 0.22
const TRENCH_BUOYANCY = -0.45
// Real mid-ocean ridges bulge up from mantle upwelling rather than
// sinking, unlike a continental rift valley — oceanic-oceanic divergence
// gets this instead of DIVERGENT_RELAX_RATE.
const MID_OCEAN_RIDGE_RATE = -DIVERGENT_RELAX_RATE

const RIFT_THICKNESS_THRESHOLD = -0.28
const MERGE_THICKNESS_THRESHOLD = 0.75
const MERGE_HOLD_EPOCHS = 8
// Never merge down past this — nearestTwoPlateIndices (and the rest of
// the model) assumes at least two plates exist.
const MIN_PLATES_BEFORE_MERGE = 3

// Young collision = jagged/tall, old = eroded/rounded, per the docs —
// modeled as a multiplier on convergent uplift rate driven by the
// colliding plates' average age, decaying by half every this many
// epochs. Never reaches exactly 0: an old collision still builds
// (modestly), it just doesn't stay dramatic forever.
const AGE_UPLIFT_HALF_LIFE_EPOCHS = 150

function ageUpliftMultiplier(averageAge: number): number {
  return Math.pow(0.5, averageAge / AGE_UPLIFT_HALF_LIFE_EPOCHS)
}

function convergentUpliftRate(typeA: PlateType, typeB: PlateType): number {
  if (typeA === 'continental' && typeB === 'continental') return 1.2 // fold mountains
  if (typeA === 'oceanic' && typeB === 'oceanic') return 0.5 // island arc
  return 0.8 // subduction arc, magnitude only — see subductingPlateId for the elevation asymmetry
}

// The plate id (not index — see PlateWorld.ids) of whichever side
// subducts, or -1 for continental-continental (no subduction).
function computeSubductingPlateId(world: PlateWorld, a: number, b: number): number {
  const typeA = world.types[a]
  const typeB = world.types[b]
  if (typeA === typeB) {
    if (typeA === 'continental') return -1
    return world.ages[a] >= world.ages[b] ? world.ids[a] : world.ids[b] // oceanic-oceanic: older/denser subducts
  }
  return typeA === 'oceanic' ? world.ids[a] : world.ids[b] // continental-oceanic: oceanic always subducts
}

function overridingArcBuoyancy(overridingType: PlateType): number {
  return overridingType === 'continental' ? SUBDUCTION_ARC_BUOYANCY : ISLAND_ARC_OVERRIDE_BUOYANCY
}

function buoyancy(type: PlateType): number {
  return type === 'continental' ? CONTINENTAL_BUOYANCY : OCEANIC_BUOYANCY
}

function tangentDirection(from: Vector3, to: Vector3, at: Vector3): Vector3 {
  const diff = to.subtract(from)
  const tangent = diff.subtract(at.scale(Vector3.Dot(diff, at)))
  const length = tangent.length()
  return length > 1e-6 ? tangent.scale(1 / length) : tangent
}

function plateVelocity(world: PlateWorld, plateIndex: number, at: Vector3): Vector3 {
  return Vector3.Cross(world.eulerAxes[plateIndex], at).scale(world.angularSpeeds[plateIndex])
}

export function createCrustState(
  seedText: string,
  continentCount: number,
  landOceanRatio: number,
  initialTotalPlateCount: number,
): CrustState {
  const rng = mulberry32(hashSeedString(`${seedText}:crust:${continentCount}:${landOceanRatio}`))
  const phaseOffset = rng() * Math.PI * 2
  const axis = randomUnitVector(rng)
  const angle = rng() * Math.PI * 2
  const points = fibonacciSpherePoints(CRUST_POINT_COUNT, phaseOffset).map((point) =>
    rotateAroundAxis(point, axis, angle),
  )
  const averageSpacing = Math.sqrt((4 * Math.PI) / CRUST_POINT_COUNT)
  // Warp amplitude relative to average *plate* spacing (not the crust
  // detection grid's much finer spacing above) — coastline wobble should
  // scale with how big continents actually are, not with detection-grid
  // resolution.
  const averagePlateSpacing = Math.sqrt((4 * Math.PI) / initialTotalPlateCount)
  const coastlineNoise = buildCoastlineNoiseField(rng, averagePlateSpacing * 0.16)
  return {
    points,
    thickness: new Float32Array(CRUST_POINT_COUNT),
    lockedEpochs: new Uint16Array(CRUST_POINT_COUNT),
    hasRifted: new Uint8Array(CRUST_POINT_COUNT),
    riftBudgetRemaining: Math.max(5, Math.round(initialTotalPlateCount * 0.75)),
    boundaryGapThreshold: averageSpacing * 0.6,
    falloffRadius: averageSpacing * 1.8,
    rng,
    terrainFeatures: [],
    targetLandOceanRatio: landOceanRatio,
    coastlineNoise,
  }
}

// Deposits uplift onto a plate-attached terrain feature near `point`,
// reusing an existing one (same attached plate, within the smoothing
// footprint already used for elevation queries) if there is one,
// otherwise creating a new one. This is what actually carries
// mountain/ridge/valley thickness forward — the detection grid's own
// `thickness` (updated by the caller) stays purely for rift/merge
// triggers now. Used for both convergent (mountain-building) and
// divergent (ridge/valley) deposits — subductingPlateId is only
// meaningful for the former; divergent deposits always pass -1, since
// there's no subducting side while pulling apart.
function depositOntoTerrainFeature(
  crust: CrustState,
  point: Vector3,
  attachedPlateId: number,
  subductingPlateId: number,
  increment: number,
): void {
  let target: TerrainFeature | undefined
  for (const feature of crust.terrainFeatures) {
    if (feature.attachedPlateId !== attachedPlateId) continue
    if (angularDistance(point, feature.position) <= crust.falloffRadius) {
      target = feature
      break
    }
  }
  if (!target) {
    target = { position: point.clone(), thickness: 0, subductingPlateId, attachedPlateId }
    crust.terrainFeatures.push(target)
  }

  target.subductingPlateId = subductingPlateId
  target.thickness = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, target.thickness + increment))
}

// Overriding plate for a subducting pair, or plate `a` (arbitrary but
// consistent) when there's no subducting side — continental-continental
// collision, or any divergent pair.
function attachedPlateIdFor(world: PlateWorld, a: number, b: number, subductingPlateId: number): number {
  if (subductingPlateId === -1) return world.ids[a]
  return subductingPlateId !== world.ids[a] ? world.ids[a] : world.ids[b]
}

export function advanceCrustState(crust: CrustState, world: PlateWorld): void {
  // Reuses the nearestTwoPlateIndices call the loop below already makes
  // for boundary detection as a free area-fraction sample for weight
  // adaptation — no separate Monte Carlo sampling pass needed.
  const areaHits = new Array(world.seeds.length).fill(0)

  for (let i = 0; i < crust.points.length; i++) {
    let next = crust.thickness[i] * (1 - EROSION_RELAXATION_RATE)

    const point = crust.points[i]
    const nearest = nearestTwoPlateIndices(point, world)
    areaHits[nearest.first] += 1
    const gap = nearest.secondCost - nearest.firstCost
    let isLockingContinentalCollision = false
    if (gap <= crust.boundaryGapThreshold) {
      const { first: a, second: b } = nearest
      const typeA = world.types[a]
      const typeB = world.types[b]
      const dir = tangentDirection(world.seeds[a], world.seeds[b], point)
      const relativeVelocity = plateVelocity(world, a, point).subtract(plateVelocity(world, b, point))
      const convergence = Vector3.Dot(relativeVelocity, dir)

      let rate: number
      let subductingPlateId = -1
      if (convergence > 0) {
        const averageAge = (world.ages[a] + world.ages[b]) / 2
        rate = convergentUpliftRate(typeA, typeB) * ageUpliftMultiplier(averageAge)
        subductingPlateId = computeSubductingPlateId(world, a, b)
      } else {
        rate = typeA === 'oceanic' && typeB === 'oceanic' ? MID_OCEAN_RIDGE_RATE : DIVERGENT_RELAX_RATE
      }
      const increment = convergence * rate * UPLIFT_STEP_SCALE
      const attachedPlateId = attachedPlateIdFor(world, a, b, subductingPlateId)
      depositOntoTerrainFeature(crust, point, attachedPlateId, subductingPlateId, increment)
      next += increment
      isLockingContinentalCollision = convergence > 0 && typeA === 'continental' && typeB === 'continental'
    }

    crust.thickness[i] = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, next))
    const isPastMergeThreshold = isLockingContinentalCollision && crust.thickness[i] >= MERGE_THICKNESS_THRESHOLD
    crust.lockedEpochs[i] = isPastMergeThreshold ? crust.lockedEpochs[i] + 1 : 0
  }

  // Erosion applies to the actual terrain material now, wherever its
  // plate has carried it — not to a fixed location the plate may have
  // long since drifted away from. Features eroded down to a negligible
  // thickness are pruned outright — see NEGLIGIBLE_FEATURE_THICKNESS for
  // why leaving them to shrink forever isn't enough on its own.
  crust.terrainFeatures = crust.terrainFeatures.filter((feature) => {
    feature.thickness *= 1 - EROSION_RELAXATION_RATE
    return Math.abs(feature.thickness) >= NEGLIGIBLE_FEATURE_THICKNESS
  })

  adaptContinentalWeights(world, areaHits, crust.points.length, crust.targetLandOceanRatio)
}

// A single global continental weight, fixed at generation, drifts badly
// over a long run: plates keep independently rotating (some completing a
// full revolution or more over hundreds of epochs) and rifting keeps
// adding new competing oceanic seeds, so a continental plate can end up
// crowded by neighbors with no correction — verified one run swinging
// from 36% land down to 9% with no merge or other tectonic event
// involved, just geometry drifting into an unlucky configuration. This
// nudges each continental plate's own weight up when it's holding less
// area than its fair share (target ratio split evenly across however
// many continental plates currently exist) and down when it's holding
// more — organic, gradual correction rather than a hard periodic reset.
// Self-stabilizing by construction (the correction shrinks as the error
// shrinks), so no explicit clamp is needed to prevent runaway.
const WEIGHT_ADAPTATION_RATE = 0.15

function adaptContinentalWeights(
  world: PlateWorld,
  areaHits: number[],
  totalSamples: number,
  targetLandOceanRatio: number,
): void {
  let continentalCount = 0
  for (const type of world.types) if (type === 'continental') continentalCount++
  if (continentalCount === 0) return

  const targetFractionPerPlate = targetLandOceanRatio / continentalCount
  for (let i = 0; i < world.types.length; i++) {
    if (world.types[i] !== 'continental') continue
    const currentFraction = areaHits[i] / totalSamples
    world.weights[i] += WEIGHT_ADAPTATION_RATE * (targetFractionPerPlate - currentFraction)
  }
}

// Rotates every terrain feature by its attached plate's rotation this
// epoch — the actual fix for "mountains don't travel with their plate."
// Must run after stepPlateEpoch so world.eulerAxes/angularSpeeds reflect
// the same motion the plate itself just took.
export function advanceTerrainFeatures(crust: CrustState, world: PlateWorld): void {
  for (const feature of crust.terrainFeatures) {
    const plateIndex = world.ids.indexOf(feature.attachedPlateId)
    if (plateIndex === -1) continue // shouldn't happen if merge reattachment ran correctly
    feature.position = rotateAroundAxis(feature.position, world.eulerAxes[plateIndex], world.angularSpeeds[plateIndex])
  }
}

// Applies at most one rift and one merge this epoch — see the module
// comment for why events are capped rather than applied to every
// threshold-crossing point found.
export function applyRiftAndMergeEvents(crust: CrustState, world: PlateWorld): void {
  let riftIndex = -1
  if (crust.riftBudgetRemaining > 0) {
    for (let i = 0; i < crust.thickness.length; i++) {
      if (crust.hasRifted[i] === 1) continue
      if (crust.thickness[i] <= RIFT_THICKNESS_THRESHOLD) {
        if (riftIndex === -1 || crust.thickness[i] < crust.thickness[riftIndex]) riftIndex = i
      }
    }
  }
  if (riftIndex !== -1) {
    const color = createPlateColor('oceanic', crust.rng)
    const { axis, angularSpeed } = randomEulerKinematics(crust.rng)
    addPlate(world, crust.points[riftIndex].clone(), 'oceanic', 0, color, axis, angularSpeed)
    crust.thickness[riftIndex] = 0
    crust.lockedEpochs[riftIndex] = 0
    crust.riftBudgetRemaining -= 1
    crust.hasRifted[riftIndex] = 1
  }

  if (world.totalCount > MIN_PLATES_BEFORE_MERGE) {
    let mergeIndex = -1
    for (let i = 0; i < crust.lockedEpochs.length; i++) {
      if (crust.lockedEpochs[i] >= MERGE_HOLD_EPOCHS) {
        if (mergeIndex === -1 || crust.lockedEpochs[i] > crust.lockedEpochs[mergeIndex]) mergeIndex = i
      }
    }
    if (mergeIndex !== -1) {
      const { first, second } = nearestTwoPlateIndices(crust.points[mergeIndex], world)
      const removedIndex = Math.max(first, second)
      const survivorIndex = Math.min(first, second)
      const removedId = world.ids[removedIndex]
      const survivorId = world.ids[survivorIndex]
      // Reattach before removing — otherwise these features are left
      // pointing at a plate id that no longer exists.
      for (const feature of crust.terrainFeatures) {
        if (feature.attachedPlateId === removedId) feature.attachedPlateId = survivorId
      }
      removePlate(world, removedIndex)
      crust.lockedEpochs[mergeIndex] = 0
    }
  }
}

// elevationAt used to scan the *entire* terrainFeatures list for every
// query — fine at mesh-vertex counts (~19k), but measured directly: at
// texture-generation counts (hundreds of thousands to millions of
// texels), that scan dominates completely (2048x1024 measured at ~15s
// for one texture). This buckets features into a coarse 3D grid so a
// query only needs to check nearby cells instead of the whole list.
//
// First version used string cell keys (`${cx},${cy},${cz}`) and gave
// *zero* measured speedup — confirmed directly: 125 string-keyed Map
// lookups over 2M iterations cost ~9.2s versus ~0.6s for the same
// lookups with numeric keys, so the string construction/hashing was
// eating the entire saving from not scanning the full feature list.
// Numeric keys below fix that.
export interface TerrainFeatureIndex {
  cellSize: number
  buckets: Map<number, number[]>
}

// Packs (cx, cy, cz) into one integer key. Offset/range comfortably
// covers even a generous feature count (cellSize shrinks as features
// grow, per buildTerrainFeatureIndex, so cell coordinates grow too) —
// range 1024 supports cell coordinates up to ±512, far beyond what any
// realistic feature count needs, well inside JS's safe integer range.
const CELL_KEY_OFFSET = 512
const CELL_KEY_RANGE = 1024

function cellKey(cx: number, cy: number, cz: number): number {
  return (cx + CELL_KEY_OFFSET) * CELL_KEY_RANGE * CELL_KEY_RANGE + (cy + CELL_KEY_OFFSET) * CELL_KEY_RANGE + (cz + CELL_KEY_OFFSET)
}

// Cell size targets roughly one feature per cell on average (same
// sqrt(4*PI/count) spacing formula used elsewhere for sphere-point
// density) — adaptive because feature count changes over a session
// (rift/merge/erosion), not a fixed constant tuned for one snapshot.
export function buildTerrainFeatureIndex(features: TerrainFeature[]): TerrainFeatureIndex {
  const count = features.length
  const cellSize = count > 0 ? Math.sqrt((4 * Math.PI) / count) : 1
  const buckets = new Map<number, number[]>()
  for (let i = 0; i < count; i++) {
    const p = features[i].position
    const key = cellKey(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize), Math.floor(p.z / cellSize))
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(i)
  }
  return { cellSize, buckets }
}

// Reused across calls (module-level, not per-call) to avoid allocating on
// every one of potentially millions of texture-generation queries.
const candidateScratch: number[] = []

// 5x5x5 (125 cells), not just the immediately-surrounding 27: measured
// directly against the exact full-scan implementation across 20,000
// sample points on a real 100-epoch world (972 terrain features).
// Shrinking to 3x3x3 (27 cells) was tried first for the extra speed, but
// correctness measurably degraded — max difference 4.6e-2 in elevation
// versus 7.1e-4 at 5x5x5, with 2,034 of 20,000 points differing versus
// just 1. That matters here specifically because coastline detection
// depends on elevation's *sign* — a few-percent error can flip which
// side of sea level a point lands on. With numeric keys (see above),
// 125 lookups is still cheap: a 2048x1024 texture (2.1M queries) measured
// at ~957ms total, so there's no real cost pressure to shrink further.
function gatherNearbyFeatureIndices(point: Vector3, index: TerrainFeatureIndex): number[] {
  candidateScratch.length = 0
  const { cellSize, buckets } = index
  const cx = Math.floor(point.x / cellSize)
  const cy = Math.floor(point.y / cellSize)
  const cz = Math.floor(point.z / cellSize)
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        const bucket = buckets.get(cellKey(cx + dx, cy + dy, cz + dz))
        if (bucket) for (const featureIndex of bucket) candidateScratch.push(featureIndex)
      }
    }
  }
  return candidateScratch
}

// Blending the nearest few terrain features (inverse-distance weighted)
// instead of picking a single nearest one avoids hard value jumps
// wherever the nearest-feature assignment flips, which would otherwise
// read as faceted, cone-shaped bumps rather than smooth ridges. Squared
// falloff (not linear) so the nearest feature dominates — linear
// weighting measurably washed out real peaks in testing, down to ~15% of
// their unblended height. Reused scratch buffers (module-level, not
// per-call) avoid allocating on every one of the thousands of calls a
// single render makes.
const ELEVATION_BLEND_K = 4
const blendIndexScratch = new Int32Array(ELEVATION_BLEND_K)
const blendDistanceScratch = new Float64Array(ELEVATION_BLEND_K)

// Takes the plate's type and id rather than looking them up itself, since
// callers evaluating this per mesh vertex already need the nearest-plate
// index for coloring and shouldn't pay for that Voronoi lookup twice.
// featureIndex must be built (buildTerrainFeatureIndex) from the same
// crust.terrainFeatures this is querying against.
export function elevationAt(
  point: Vector3,
  plateType: PlateType,
  plateId: number,
  crust: CrustState,
  featureIndex: TerrainFeatureIndex,
): number {
  const base = plateType === 'continental' ? CONTINENTAL_BASE_ELEVATION : OCEANIC_BASE_ELEVATION
  const features = crust.terrainFeatures
  if (features.length === 0) return base

  const candidates = gatherNearbyFeatureIndices(point, featureIndex)
  if (candidates.length === 0) return base

  let filled = 0
  for (const i of candidates) {
    const distance = angularDistance(point, features[i].position)
    if (filled < ELEVATION_BLEND_K) {
      blendIndexScratch[filled] = i
      blendDistanceScratch[filled] = distance
      filled++
    } else {
      let worst = 0
      for (let k = 1; k < ELEVATION_BLEND_K; k++) if (blendDistanceScratch[k] > blendDistanceScratch[worst]) worst = k
      if (distance < blendDistanceScratch[worst]) {
        blendDistanceScratch[worst] = distance
        blendIndexScratch[worst] = i
      }
    }
  }

  let nearestDistance = Infinity
  let weightSum = 0
  let weightedUplift = 0
  for (let k = 0; k < filled; k++) {
    const distance = blendDistanceScratch[k]
    if (distance < nearestDistance) nearestDistance = distance
    const feature = features[blendIndexScratch[k]]
    const upliftFactor =
      feature.subductingPlateId === -1
        ? buoyancy(plateType)
        : feature.subductingPlateId === plateId
          ? TRENCH_BUOYANCY
          : overridingArcBuoyancy(plateType)
    const weight = 1 / (distance * distance + 0.0001)
    weightedUplift += weight * feature.thickness * upliftFactor
    weightSum += weight
  }

  const blendedUplift = weightSum > 0 ? weightedUplift / weightSum : 0
  // Fade to baseline with distance from the single closest feature, same
  // as before blending — blending only smooths the *value* among nearby
  // features, it doesn't change how quickly influence fades out with
  // distance from the boundary.
  const falloff = Math.max(0, 1 - nearestDistance / crust.falloffRadius)
  return base + blendedUplift * falloff
}

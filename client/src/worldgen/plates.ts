import { Vector3 } from '@babylonjs/core'
import { hashSeedString, mulberry32 } from './rng'
import { angularDistance, fibonacciSpherePoints, randomUnitVector, rotateAroundAxis, shuffleIndices } from './sphere'

// Spatial substrate + initial per-plate parameters, per
// docs/decisions/plate-tectonics-initial-state.md (A2: continuous
// unit-sphere points, geodesic-distance Voronoi) and
// docs/decisions/plate-tectonics-simulation.md (kinematics: Euler-pole
// rotation per plate). generatePlateWorld builds the initial state;
// stepPlateEpoch advances the kinematics by one epoch.

export type PlateType = 'continental' | 'oceanic'

export interface PlateWorld {
  seeds: Vector3[]
  types: PlateType[]
  weights: number[]
  colors: Array<[number, number, number]>
  eulerAxes: Vector3[]
  angularSpeeds: number[]
  // Epochs since this plate was born — 0 for everything spawned by
  // generatePlateWorld, since B2 rift/merge (crust.ts) is what gives later
  // plates a younger age than the ones they split from.
  ages: number[]
  // Stable identity, independent of array position. removePlate (a merge)
  // shifts every later plate's index down by one, so crust.ts can't hold
  // onto a plate *index* across epochs to remember "which side subducts"
  // at a boundary — it holds this id instead.
  ids: number[]
  nextId: number
  totalCount: number
  oceanicCount: number
}

// Land/ocean ratio only decides plate *count* within this range; extreme
// ratios would otherwise blow up the total plate count (ratio -> 0) or
// collapse it to just the continental seeds (ratio -> 1).
const MIN_RATIO_FOR_SIZING = 0.05
const MAX_RATIO_FOR_SIZING = 0.95
const MAX_TOTAL_PLATES = 60

const WEIGHT_CALIBRATION_SAMPLES = 2000
const WEIGHT_CALIBRATION_ITERATIONS = 16

const CONTINENTAL_BASE: [number, number, number] = [0.42, 0.5, 0.27]
const OCEANIC_BASE: [number, number, number] = [0.11, 0.33, 0.62]
const COLOR_JITTER = 0.08

// Chosen so ~10 epochs of drift reads as gradual movement rather than a
// jump cut or no visible change at all.
const MIN_ANGULAR_SPEED_DEG = 0.3
const MAX_ANGULAR_SPEED_DEG = 2

function continentalAreaFraction(
  seeds: Vector3[],
  types: PlateType[],
  continentalWeight: number,
  samplePoints: Vector3[],
): number {
  let continentalHits = 0
  for (const point of samplePoints) {
    let bestIndex = 0
    let bestCost = Infinity
    for (let i = 0; i < seeds.length; i++) {
      const weight = types[i] === 'continental' ? continentalWeight : 0
      const cost = angularDistance(point, seeds[i]) - weight
      if (cost < bestCost) {
        bestCost = cost
        bestIndex = i
      }
    }
    if (types[bestIndex] === 'continental') continentalHits++
  }
  return continentalHits / samplePoints.length
}

// Area-weighting mechanism for the land/ocean ratio is explicitly left open
// in docs/decisions/plate-tectonics-initial-state.md. This binary-searches
// an additive weight (a power-diagram / weighted-Voronoi bias) for
// continental seeds so their *sampled surface area* approximates the
// target ratio, refining the rough count-based sizing above.
function calibrateContinentalWeight(
  seeds: Vector3[],
  types: PlateType[],
  targetRatio: number,
  rng: () => number,
): number {
  const samplePoints = Array.from({ length: WEIGHT_CALIBRATION_SAMPLES }, () => randomUnitVector(rng))
  let low = -Math.PI
  let high = Math.PI
  for (let i = 0; i < WEIGHT_CALIBRATION_ITERATIONS; i++) {
    const mid = (low + high) / 2
    const fraction = continentalAreaFraction(seeds, types, mid, samplePoints)
    if (fraction < targetRatio) low = mid
    else high = mid
  }
  return (low + high) / 2
}

function jitterColor(base: [number, number, number], amount: number, rng: () => number): [number, number, number] {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
  const jitter = () => (rng() * 2 - 1) * amount
  return [clamp01(base[0] + jitter()), clamp01(base[1] + jitter()), clamp01(base[2] + jitter())]
}

export function createPlateColor(type: PlateType, rng: () => number): [number, number, number] {
  return jitterColor(type === 'continental' ? CONTINENTAL_BASE : OCEANIC_BASE, COLOR_JITTER, rng)
}

// Used to give a rift-spawned plate (crust.ts) the same kind of kinematics
// a plate would get at world generation, without reworking generatePlateWorld's
// own draw order below.
export function randomEulerKinematics(rng: () => number): { axis: Vector3; angularSpeed: number } {
  const axis = randomUnitVector(rng)
  const degreesPerEpoch = MIN_ANGULAR_SPEED_DEG + rng() * (MAX_ANGULAR_SPEED_DEG - MIN_ANGULAR_SPEED_DEG)
  return { axis, angularSpeed: (degreesPerEpoch * Math.PI) / 180 }
}

export function generatePlateWorld(seedText: string, continentCount: number, landOceanRatio: number): PlateWorld {
  const rng = mulberry32(hashSeedString(seedText))

  const sizingRatio = Math.min(MAX_RATIO_FOR_SIZING, Math.max(MIN_RATIO_FOR_SIZING, landOceanRatio))
  const totalCount = Math.min(MAX_TOTAL_PLATES, Math.max(continentCount, Math.round(continentCount / sizingRatio)))
  const oceanicCount = totalCount - continentCount

  const phaseOffset = rng() * Math.PI * 2
  const rotationAxis = randomUnitVector(rng)
  const rotationAngle = rng() * Math.PI * 2
  const seeds = fibonacciSpherePoints(totalCount, phaseOffset).map((point) =>
    rotateAroundAxis(point, rotationAxis, rotationAngle),
  )

  // Randomize *which* seeds are continental, not how many (target count is
  // always hit exactly), per the "Type" decision in
  // docs/decisions/plate-tectonics-initial-state.md.
  const shuffledOrder = shuffleIndices(totalCount, rng)
  const types: PlateType[] = new Array(totalCount)
  shuffledOrder.forEach((seedIndex, orderPosition) => {
    types[seedIndex] = orderPosition < continentCount ? 'continental' : 'oceanic'
  })

  const continentalWeight = calibrateContinentalWeight(seeds, types, landOceanRatio, rng)
  const weights = types.map((type) => (type === 'continental' ? continentalWeight : 0))
  const colors = types.map((type) => createPlateColor(type, rng))

  // Euler-pole kinematics per docs/decisions/plate-tectonics-simulation.md:
  // rigid rotation about a random axis, not a translation vector.
  const eulerAxes = seeds.map(() => randomUnitVector(rng))
  const angularSpeeds = seeds.map(() => {
    const degreesPerEpoch = MIN_ANGULAR_SPEED_DEG + rng() * (MAX_ANGULAR_SPEED_DEG - MIN_ANGULAR_SPEED_DEG)
    return (degreesPerEpoch * Math.PI) / 180
  })
  const ages = new Array(totalCount).fill(0)
  const ids = Array.from({ length: totalCount }, (_, i) => i)

  return { seeds, types, weights, colors, eulerAxes, angularSpeeds, ages, ids, nextId: totalCount, totalCount, oceanicCount }
}

export function stepPlateEpoch(world: PlateWorld): void {
  for (let i = 0; i < world.seeds.length; i++) {
    world.seeds[i] = rotateAroundAxis(world.seeds[i], world.eulerAxes[i], world.angularSpeeds[i])
    world.ages[i] += 1
  }
}

// Rift/merge (crust.ts) are threshold crossings on the crust-curve state,
// per docs/decisions/plate-tectonics-simulation.md — these two just keep
// PlateWorld's parallel arrays (and the derived counts) in sync with that.
export function addPlate(
  world: PlateWorld,
  seed: Vector3,
  type: PlateType,
  weight: number,
  color: [number, number, number],
  eulerAxis: Vector3,
  angularSpeed: number,
): void {
  world.seeds.push(seed)
  world.types.push(type)
  world.weights.push(weight)
  world.colors.push(color)
  world.eulerAxes.push(eulerAxis)
  world.angularSpeeds.push(angularSpeed)
  world.ages.push(0)
  world.ids.push(world.nextId)
  world.nextId += 1
  world.totalCount += 1
  if (type === 'oceanic') world.oceanicCount += 1
}

export function removePlate(world: PlateWorld, index: number): void {
  const removedType = world.types[index]
  world.seeds.splice(index, 1)
  world.types.splice(index, 1)
  world.weights.splice(index, 1)
  world.colors.splice(index, 1)
  world.eulerAxes.splice(index, 1)
  world.angularSpeeds.splice(index, 1)
  world.ages.splice(index, 1)
  world.ids.splice(index, 1)
  world.totalCount -= 1
  if (removedType === 'oceanic') world.oceanicCount -= 1
}

export function nearestPlateIndex(point: Vector3, world: PlateWorld): number {
  let bestIndex = 0
  let bestCost = Infinity
  for (let i = 0; i < world.seeds.length; i++) {
    const cost = angularDistance(point, world.seeds[i]) - world.weights[i]
    if (cost < bestCost) {
      bestCost = cost
      bestIndex = i
    }
  }
  return bestIndex
}

export interface NearestPlates {
  first: number
  firstCost: number
  second: number
  secondCost: number
}

// Used to detect points sitting near a plate boundary (small gap between
// the nearest and second-nearest plate) for the crustal-thickness
// accumulation in crust.ts.
export function nearestTwoPlateIndices(point: Vector3, world: PlateWorld): NearestPlates {
  let first = 0
  let firstCost = Infinity
  let second = 0
  let secondCost = Infinity
  for (let i = 0; i < world.seeds.length; i++) {
    const cost = angularDistance(point, world.seeds[i]) - world.weights[i]
    if (cost < firstCost) {
      second = first
      secondCost = firstCost
      first = i
      firstCost = cost
    } else if (cost < secondCost) {
      second = i
      secondCost = cost
    }
  }
  return { first, firstCost, second, secondCost }
}

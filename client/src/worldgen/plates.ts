import { Vector3 } from '@babylonjs/core'
import { hashSeedString, mulberry32 } from './rng'

// Spatial substrate + initial per-plate parameters, per
// docs/decisions/plate-tectonics-initial-state.md (A2: continuous
// unit-sphere points, geodesic-distance Voronoi). This module only builds
// the *initial* state — no epoch stepping.

export type PlateType = 'continental' | 'oceanic'

export interface PlateWorld {
  seeds: Vector3[]
  types: PlateType[]
  weights: number[]
  colors: Array<[number, number, number]>
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

function randomUnitVector(rng: () => number): Vector3 {
  const z = rng() * 2 - 1
  const theta = rng() * Math.PI * 2
  const radius = Math.sqrt(Math.max(0, 1 - z * z))
  return new Vector3(radius * Math.cos(theta), radius * Math.sin(theta), z)
}

function fibonacciSpherePoints(count: number, phaseOffset: number): Vector3[] {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const points: Vector3[] = []
  for (let i = 0; i < count; i++) {
    const y = count === 1 ? 0 : 1 - (2 * i) / (count - 1)
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = goldenAngle * i + phaseOffset
    points.push(new Vector3(Math.cos(theta) * radiusAtY, y, Math.sin(theta) * radiusAtY))
  }
  return points
}

function rotateAroundAxis(point: Vector3, axis: Vector3, angle: number): Vector3 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dot = Vector3.Dot(axis, point)
  const cross = Vector3.Cross(axis, point)
  return point.scale(cos).add(cross.scale(sin)).add(axis.scale(dot * (1 - cos)))
}

function angularDistance(a: Vector3, b: Vector3): number {
  const dot = Math.min(1, Math.max(-1, Vector3.Dot(a, b)))
  return Math.acos(dot)
}

function shuffleIndices(count: number, rng: () => number): number[] {
  const indices = Array.from({ length: count }, (_, i) => i)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }
  return indices
}

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
  const colors = types.map((type) => jitterColor(type === 'continental' ? CONTINENTAL_BASE : OCEANIC_BASE, COLOR_JITTER, rng))

  return { seeds, types, weights, colors, totalCount, oceanicCount }
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

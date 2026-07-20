import { Vector3 } from '@babylonjs/core'

export function randomUnitVector(rng: () => number): Vector3 {
  const z = rng() * 2 - 1
  const theta = rng() * Math.PI * 2
  const radius = Math.sqrt(Math.max(0, 1 - z * z))
  return new Vector3(radius * Math.cos(theta), radius * Math.sin(theta), z)
}

export function fibonacciSpherePoints(count: number, phaseOffset: number): Vector3[] {
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

export function rotateAroundAxis(point: Vector3, axis: Vector3, angle: number): Vector3 {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dot = Vector3.Dot(axis, point)
  const cross = Vector3.Cross(axis, point)
  return point.scale(cos).add(cross.scale(sin)).add(axis.scale(dot * (1 - cos)))
}

export function angularDistance(a: Vector3, b: Vector3): number {
  const dot = Math.min(1, Math.max(-1, Vector3.Dot(a, b)))
  return Math.acos(dot)
}

export function shuffleIndices(count: number, rng: () => number): number[] {
  const indices = Array.from({ length: count }, (_, i) => i)
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }
  return indices
}

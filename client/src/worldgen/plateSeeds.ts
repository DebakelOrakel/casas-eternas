import { toroidalDistanceSq } from './toroidal'

export interface PlateSeed {
  x: number
  y: number
}

// Dart-throwing Poisson-disc sampling on a toroidal domain: repeatedly
// proposes a random point and accepts it only if it's at least
// minDistance (wrapped) from every previously accepted point. Plain
// uniform-random seed placement tends to cluster points together and
// leave large empty gaps; this rejection step is what keeps plate sizes
// roughly even instead.
//
// minDistance relaxes (shrinks) whenever a run of attempts fails to place
// a point, rather than looping forever — guarantees `count` seeds are
// always reached even if the initial spacing target turns out too tight
// for the space actually left once most points are placed.
export function generatePlateSeeds(count: number, width: number, height: number, random: () => number): PlateSeed[] {
  const seeds: PlateSeed[] = []
  let minDistance = 0.75 * Math.sqrt((width * height) / count)
  const maxAttemptsBeforeRelax = 200

  while (seeds.length < count) {
    let placed = false
    for (let attempt = 0; attempt < maxAttemptsBeforeRelax && !placed; attempt++) {
      const candidateX = random() * width
      const candidateY = random() * height
      const minDistanceSq = minDistance * minDistance
      const farEnough = seeds.every((seed) => toroidalDistanceSq(candidateX, candidateY, seed.x, seed.y, width, height) >= minDistanceSq)
      if (farEnough) {
        seeds.push({ x: candidateX, y: candidateY })
        placed = true
      }
    }
    if (!placed) minDistance *= 0.9
  }

  return seeds
}

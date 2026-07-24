import { toroidalDistanceSq } from './toroidal'

export interface PlateSeed {
  x: number
  y: number
}

// Dart-throwing placement on a toroidal domain, but with a *per-seed* spacing
// drawn from a skewed distribution rather than one uniform minimum — so plate
// sizes come out skewed (a few large plates, many small), the way real plates
// span a ~400x size range (Pacific vs. Juan de Fuca) instead of the uniform
// cells an even Poisson-disc gives. Each candidate proposes a "reach" (its
// desired clear radius); a large reach must land in open space (→ a large
// plate), a small reach slots into gaps between big ones (→ a small plate).
//
// The exponential tail on the reach is what produces the size skew; the 0.35
// floor keeps even the smallest plates from collapsing to slivers. `relax`
// shrinks all reaches whenever a run of attempts can't place a point, so
// `count` seeds are always reached even once space runs tight.
export function generatePlateSeeds(count: number, width: number, height: number, random: () => number): PlateSeed[] {
  const seeds: PlateSeed[] = []
  const meanSpacing = Math.sqrt((width * height) / count)
  const maxAttemptsBeforeRelax = 200
  let relax = 1

  while (seeds.length < count) {
    // Exponential-tailed reach: mostly ~0.35-1.5x the mean spacing, occasionally
    // much larger. -ln(1-u) is a unit-mean exponential.
    const reach = meanSpacing * relax * (0.35 + -Math.log(1 - random()) * 0.55)
    const reachSq = reach * reach
    let placed = false
    for (let attempt = 0; attempt < maxAttemptsBeforeRelax && !placed; attempt++) {
      const candidateX = random() * width
      const candidateY = random() * height
      const farEnough = seeds.every((seed) => toroidalDistanceSq(candidateX, candidateY, seed.x, seed.y, width, height) >= reachSq)
      if (farEnough) {
        seeds.push({ x: candidateX, y: candidateY })
        placed = true
      }
    }
    if (!placed) relax *= 0.9
  }

  return seeds
}

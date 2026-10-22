import type { Domain } from '../core/domain'
import { mantleMesh } from '../mantle/mantleField'
import { sq } from '../core/detMath'

// Mantle plumes, derived from the mantle field rather than scattered at random.
//
// **A plume is a persistent upwelling.** That is the same definition the Archean
// already uses to decide where crust nucleates (crustNucleation's upwellingStreak),
// which is the point: one rule on both sides of the hand-off instead of two.
//
// They used to be five uniformly random points, created once at the hand-off and
// never moved again — "fixed for the world's life". Two things were wrong with that:
//
//  - **Real plumes drift**, just slowly. The Hawaiian plume moved roughly 15° south
//    between ~80 and ~50 Ma, which is part of why the Hawaiian-Emperor chain has a
//    bend in it. Inter-hotspot drift runs 1-2 cm/yr against plate speeds of 5-10.
//  - **The world already had them moving, on the other side of the hand-off.** In the
//    Archean the plume role is played by the mantle field's upwellings, and that
//    pattern reorganises completely across the phase (correlation against its start
//    falls to 0.21). So the same physical thing flipped from mobile to frozen at the
//    hand-off — and in the wrong direction, since the Archean mantle was the hotter,
//    more vigorous one.
//
// Deriving them from the field rather than giving the fixed points a random walk is
// deliberate, and it is the same move that fixed plate motion (see
// docs/decisions/evolving-euler-poles.md, which sets out to model the CAUSE instead of
// scripting the effect). A random walk would be motion without a reason, untethered
// from the field that drives everything else here.
//
// Three properties fall out for free rather than needing to be tuned:
//
//  - **Speed.** The field's pattern changes at ~0.996 correlation per epoch, while
//    plates are re-fitted to its flow every epoch and move fast. Plumes are therefore
//    automatically much slower than the plates riding over them — the real
//    relationship, with no ratio to calibrate.
//  - **Bent chains.** A plume that creeps while the plate above it races produces
//    exactly the geometry the Hawaiian-Emperor bend records.
//  - **Clustering.** Real plumes cluster (at the margins of the deep mantle's two
//    large provinces) rather than being uniformly spread. Field-derived plumes
//    inherit the field's own spatial organisation; uniformly random points cannot.

// Mantle value a cell must reach to host a plume. Above the Archean's nucleation
// threshold (0.70): a plume should mark a genuinely strong upwelling, not merely one
// hot enough to make crust.
const PLUME_THRESHOLD = 0.85
// Upper bound only. The count is otherwise emergent from how many strong upwellings
// the mantle actually organises itself into — the same way the plate count comes from
// the convection cells. Capped because vigorous convection can offer a great many.
const PLUME_MAX_COUNT = 8
// Two plumes closer than this, metres, are one upwelling found twice. A
// fraction of the chart's height until DEC-0036 phase 8f (0.14 × 1024
// cells of the torus's 7.8 km; on the sphere's 10 000 km from pole to pole
// it was 25 % longer).
const PLUME_MIN_SEPARATION_M = 1_118_208

// The strongest upwellings, strongest first, thinned so each is a distinct one.
// Kin to finalizeArchean's convectionCellSeeds, which does the same sweep for plate
// seeds — but that one wants extrema of BOTH signs at a different prominence, so they
// are deliberately separate rather than one function with flags.
export interface Plume {
  x: number
  y: number
  // Identity, so a plume is more than its position in an array — retiring one splices
  // the list, and without an id "the same plume" would silently become "whichever is
  // now at that index". The chain a plume builds is the reason it exists, so losing
  // track of which is which loses the feature.
  id: number
  birthEpoch: number
}

// Ids continue from whatever is already there, so no counter has to be carried in the
// simulation state (and none has to be serialised).
//
// A site is a cell of the mantle's field mesh no neighbour of which is higher
// (its Voronoi neighbours, DEC-0036), at the cell's centre.
export function findPlumeSites(mantle: Float64Array, domain: Domain, epoch = 0, exclude: Plume[] = []): Plume[] {
  const { mesh } = mantleMesh(domain)
  let nextId = exclude.reduce((m, p) => Math.max(m, p.id), -1) + 1
  const candidates: { x: number; y: number; strength: number }[] = []
  for (let i = 0; i < mesh.count; i++) {
    const v = mantle[i]
    if (v < PLUME_THRESHOLD) continue
    let isMax = true
    for (let e = mesh.nbrStart[i]; e < mesh.nbrStart[i + 1]; e++) {
      if (mantle[mesh.nbr[e]] > v) { isMax = false; break }
    }
    if (!isMax) continue
    candidates.push({ x: mesh.x[i], y: mesh.y[i], strength: v })
  }
  candidates.sort((a, b) => b.strength - a.strength)
  const minSepSq = sq(PLUME_MIN_SEPARATION_M / domain.metresPerUnit)
  const chosen: { x: number; y: number }[] = exclude.map((p) => ({ x: p.x, y: p.y }))
  const fresh: Plume[] = []
  for (const c of candidates) {
    if (chosen.length >= PLUME_MAX_COUNT) break
    if (chosen.some((s) => domain.distanceSq(s.x, s.y, c.x, c.y) < minSepSq)) continue
    chosen.push({ x: c.x, y: c.y })
    fresh.push({ x: c.x, y: c.y, id: nextId++, birthEpoch: epoch })
  }
  return fresh
}

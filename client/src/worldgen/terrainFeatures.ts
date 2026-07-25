import { wrappedDelta } from './toroidal'
import { getVelocityAt, advancePointByMotion } from './plateMotion'
import type { PlateMotion } from './plateMotion'

// A feature is a mountain *range* (or arc/ridge), or a *trench* — the
// paired negative depression on the subducting side of a subduction/
// island arc (see plateSimulation.ts's trench deposit). Both are oriented
// ridge features; the distinction keeps a trench from ever merging into
// its own arc's range feature in findOrCreateFeatureIndex (same plate
// pair, only offset apart), and lets computeElevation give a trench a
// narrower, deeper cross-section than a broad range.
export type FeatureKind = 'range' | 'trench'

export interface TerrainFeature {
  x: number
  y: number
  // Signed relative crustal thickness change from baseline, driving
  // elevation via isostasy (elevationField.ts): positive means the crust
  // has thickened (mountains, arcs, ridges), negative means it's thinned
  // (rift valleys stretching/sinking) — see boundaryClassification's
  // elevationSign for which boundary characters deposit which sign. This
  // is the rendering-relevant accumulator, separate from the lattice's
  // own signed rift/merge trigger state in plateSimulation.ts.
  thickness: number
  // Unit vector along the boundary curve at this feature's location (the
  // ridge's own long axis) — perpendicular to the seed-to-seed normal at
  // deposit time. computeElevation uses it for an anisotropic falloff:
  // long along this tangent (so features spaced along one boundary blend
  // into a single continuous linear range instead of a row of round
  // blobs), narrow across it (so the range reads as a ridge with a crest,
  // not a dome). Refreshed toward the current boundary tangent whenever a
  // feature is deposited onto again, so an active range keeps following
  // its boundary as it reorients; a feature drifting inactively keeps a
  // slightly stale tangent, which is harmless since it's decaying anyway.
  tangentX: number
  tangentY: number
  kind: FeatureKind
  // The two plates on either side of the boundary that created this
  // feature — kept as an unordered pair (see findOrCreateFeatureIndex)
  // even for asymmetric uplift, where only one side actually builds
  // terrain, so a *different* boundary that happens to share only one of
  // these plates can't merge into and deposit onto this feature. Confirmed
  // empirically without this: an unrelated rift boundary drifted within
  // MERGE_RADIUS of an established fold-mountain feature (both merely
  // touching the same plate on their own far sides) and canceled it —
  // thickness went from a steady climb to strongly negative within ~25
  // epochs.
  plateA: number
  plateB: number
  // Which plate's motion actually carries this feature — one of
  // plateA/plateB *by value* (not by position, since detectBoundaries can
  // relabel which plate is "A" vs "B" for the same physical boundary
  // across epochs) for asymmetric uplift, where only the owning side's
  // own crust the arc/range physically rides on. 'both' for symmetric
  // collisions (fold mountains, mid-ocean ridges): averages both plates'
  // velocity at the feature's position instead of attaching to either
  // plate alone (see advanceTerrainFeatures) — attaching a symmetric
  // collision's shared range to just one side was confirmed empirically
  // to pull the two sides' deposits apart (45px within 40 epochs),
  // fragmenting one ridge into two separately-drifting mounds.
  movesWithPlate: number | 'both'
  // Whether this feature rides on oceanic crust and should subside as it
  // ages away from its boundary — island arcs, mid-ocean ridges, and
  // trenches (all oceanic), as opposed to continental fold mountains and
  // subduction-arc ranges, which persist. Set from the boundary character
  // at creation (see plateSimulation.ts). Drives the extra age-depth decay
  // that keeps drifted oceanic features from cluttering the ocean: real
  // oceanic crust cools and sinks as it moves off the ridge, so an old,
  // drifted mid-ocean-ridge/arc feature should fade, while a continental
  // range stays put.
  subsides: boolean
  // Epochs since this feature last received a deposit — reset to 0 in
  // plateSimulation.ts's stepEpoch whenever it's touched, incremented
  // every other epoch. Drives pruning: without it, every feature ever
  // created (even ones whose boundary went inactive epochs ago, decaying
  // toward zero thickness) stays in this array forever, since nothing
  // else ever removes one. Confirmed empirically that this is the actual
  // cause of the simulation slowing down over a long run — features grew
  // from 237 to 7625 over 550 epochs, and per-render time grew right
  // alongside it (561ms to 8.8s) since every pixel's elevation query
  // scans nearby features.
  epochsSinceDeposit: number
  // Whether this feature is a volcanic arc — a subduction arc (oceanic-continental
  // convergent) or island arc (oceanic-oceanic convergent), the two boundary
  // characters that build a chain of volcanoes (Andes, Cascades, Aleutians), as
  // opposed to (non-volcanic) continental fold mountains or a mid-ocean ridge. Set
  // from the boundary character at deposit time in plateSimulation.ts. A pure render
  // hint: the screen flags these with volcano markers, distinct from the hotspot
  // (plateB = -1) and flood-basalt (plateB = -2) volcanoes. Optional so old
  // deserialized features (which lack it) simply read as non-volcanic.
  volcanic?: boolean
}

// How close an active boundary point needs to be to an existing feature
// to deposit onto it rather than spawning a new one — keeps feature
// count bounded to roughly one cluster per active stretch of boundary,
// instead of a new feature at every lattice point every epoch. Kept well
// below computeElevation's along-tangent reach (RANGE_ALONG_RADIUS) so
// consecutive features along one boundary overlap heavily and blend into
// a continuous ridge rather than reading as separate lumps.
const MERGE_RADIUS = 40

// Weight of the current boundary tangent when refreshing an existing
// feature's stored tangent (exponential moving average) — low, so a
// range's orientation is stable across epochs but still tracks a boundary
// slowly reorienting under plate drift rather than being pinned to
// whatever tangent it happened to be born with.
const TANGENT_REFRESH_RATE = 0.1

function normalizeTangent(tx: number, ty: number): { tangentX: number; tangentY: number } {
  const length = Math.sqrt(tx * tx + ty * ty) || 1
  return { tangentX: tx / length, tangentY: ty / length }
}

// Finds the feature (x, y, plateA, plateB) would deposit onto, creating
// one on the spot if none matches yet — but does NOT apply any thickness
// change itself. A dense detection lattice (see boundaryLattice.ts) means
// many adjacent lattice points along the same physical boundary stretch
// all resolve to the *same* feature within one epoch; depositing
// immediately, once per lattice point, would add uplift to that one
// feature many times over in a single epoch instead of once. Callers
// should batch same-epoch contributions to each returned index (sum
// them, then average) and apply the result once — see
// plateSimulation.ts's per-epoch aggregation.
//
// Matches the (plateA, plateB) pair unordered — detectBoundaries assigns
// "nearest"/"second-nearest" by current distance, which is free to swap
// which physical plate is labeled A vs B for the same boundary between
// epochs, the same identity-swap hazard the old baseline blend had.
export function findOrCreateFeatureIndex(
  features: TerrainFeature[],
  x: number,
  y: number,
  plateA: number,
  plateB: number,
  movesWithPlate: number | 'both',
  tangentX: number,
  tangentY: number,
  kind: FeatureKind,
  subsides: boolean,
  width: number,
  height: number,
): number {
  const mergeRadiusSq = MERGE_RADIUS * MERGE_RADIUS
  for (let i = 0; i < features.length; i++) {
    const feature = features[i]
    // Kind must also match — a trench and its own arc's range feature
    // share the same plate pair and can drift within MERGE_RADIUS of each
    // other, but must never merge into one feature (they carry opposite-
    // sign thickness and opposite cross-sections).
    if (feature.kind !== kind) continue
    const samePair = (feature.plateA === plateA && feature.plateB === plateB) || (feature.plateA === plateB && feature.plateB === plateA)
    if (!samePair) continue
    const dx = wrappedDelta(x, feature.x, width)
    const dy = wrappedDelta(y, feature.y, height)
    if (dx * dx + dy * dy <= mergeRadiusSq) {
      // Refresh orientation toward the current boundary tangent. Tangent
      // direction is sign-ambiguous (a line and its reverse are the same
      // axis), so flip the incoming one to the stored one's hemisphere
      // first — otherwise an EMA between t and -t cancels to near-zero.
      const aligned = feature.tangentX * tangentX + feature.tangentY * tangentY < 0 ? -1 : 1
      const blended = normalizeTangent(
        feature.tangentX * (1 - TANGENT_REFRESH_RATE) + aligned * tangentX * TANGENT_REFRESH_RATE,
        feature.tangentY * (1 - TANGENT_REFRESH_RATE) + aligned * tangentY * TANGENT_REFRESH_RATE,
      )
      feature.tangentX = blended.tangentX
      feature.tangentY = blended.tangentY
      return i
    }
  }
  const normalized = normalizeTangent(tangentX, tangentY)
  features.push({ x, y, thickness: 0, tangentX: normalized.tangentX, tangentY: normalized.tangentY, kind, subsides, plateA, plateB, movesWithPlate, epochsSinceDeposit: 0 })
  return features.length - 1
}

// Rotates every feature along with whichever plate(s) it's attached to,
// so terrain travels with its plate instead of staying fixed in the
// world while the plate rotates out from under it — same local
// rotate-then-rewrap toroidal treatment plate seeds themselves get.
// Symmetric ('both') features use Euler integration (velocity * angle
// step) off the average of both plates' instantaneous velocity at the
// feature's own position, rather than an exact rotateAroundCenter —
// there's no single shared center to rotate two different plates'
// motions around. For the small per-epoch angle steps this system uses
// (a fraction of a degree), this agrees closely with an exact rotation;
// single-sided features keep the exact rotation since only one motion
// applies and there's no reason to approximate it.
export function advanceTerrainFeatures(features: TerrainFeature[], motions: PlateMotion[], angleStep: number, width: number, height: number): void {
  for (const feature of features) {
    if (feature.movesWithPlate === 'both') {
      const velocityA = getVelocityAt(feature, motions[feature.plateA], width, height)
      const velocityB = getVelocityAt(feature, motions[feature.plateB], width, height)
      const vx = (velocityA.vx + velocityB.vx) / 2
      const vy = (velocityA.vy + velocityB.vy) / 2
      feature.x = (((feature.x + vx * angleStep) % width) + width) % width
      feature.y = (((feature.y + vy * angleStep) % height) + height) % height
    } else {
      const motion = motions[feature.movesWithPlate]
      const rotated = advancePointByMotion(feature.x, feature.y, motion, angleStep, width, height)
      feature.x = rotated.x
      feature.y = rotated.y
    }
  }
}

import type { PlateSeed } from '../tectonics/plateSeeds'
import { advancePointByMotion, type PlateMotion } from '../tectonics/plateMotion'
import type { Raft, RaftBlob, RaftMergeEvent, RaftSplitEvent } from './raftTypes'
import { toroidalDistanceSq, wrappedDelta } from '../core/toroidal'
import { sampleNearestWorld, wrapValue } from '../core/field'
import { deservesContinentName, pickUnusedRaftName } from './raftNames'

// Continental crust modeled as persistent "rafts" that ride on the kinematic
// plates, decoupled from them — see docs/decisions/continental-crust-rafts.md. A
// raft is a set of soft metaball blobs whose union is one continent's outline.
//
// The lifecycle: how rafts MOVE and CHANGE over an epoch — drifting with their
// host plate, growing by accretion at subduction arcs, suturing when they
// collide, tearing at a rift, and shattering into separate continents when the
// tear leaves disconnected pieces. Blob-set operations, all of them.

function nearestPlateIndex(x: number, y: number, seeds: PlateSeed[], width: number, height: number): number {
  let best = 0
  let bestDistSq = Infinity
  for (let i = 0; i < seeds.length; i++) {
    const distSq = toroidalDistanceSq(x, y, seeds[i].x, seeds[i].y, width, height)
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      best = i
    }
  }
  return best
}

// Advances every raft with the plate it rides on — Phase 1 keeps this
// rigid: the raft's whole blob set rotates with a single host plate (the
// one nearest the raft's first blob), re-resolved every epoch so it stays
// correct as plate indices shift (rift/merge) without storing a stale
// host. Splitting a raft across a rift is a later phase.
export function advanceRafts(rafts: Raft[], seeds: PlateSeed[], motions: PlateMotion[], angleStep: number, width: number, height: number): void {
  for (const raft of rafts) {
    if (raft.blobs.length === 0) continue
    const host = nearestPlateIndex(raft.blobs[0].x, raft.blobs[0].y, seeds, width, height)
    const motion = motions[host]
    for (const blob of raft.blobs) {
      const rotated = advancePointByMotion(blob.x, blob.y, motion, angleStep, width, height)
      blob.x = rotated.x
      blob.y = rotated.y
    }
  }
}

// Accretion: grow the continent nearest (x, y) by welding a small margin blob
// there — new continental crust added to the overriding plate at a subduction
// arc (Andean-type arc magmatism). Guarded two ways so a subduction margin
// advances the raft outward without exploding the blob count or attaching to a
// far-off continent: skip if an existing blob of the nearest raft already
// covers the spot (minGapSq), and skip if the nearest raft is too far to weld
// onto (maxAttachSq). Returns whether crust was added.
// Destroys continental crust that has not yet stabilised and is sitting over a
// mantle downwelling — the counterweight to accreteToNearestRaft below.
//
// Returns how many blobs were recycled. Rafts left with no blobs are dropped, so
// callers never see an empty raft (advanceRaftsOnFlow and advanceRafts both index
// blobs[0], and blobArea would divide by nothing).
//
// The age gate is the whole mechanism: a blob younger than `stabilisationEpochs`
// can be destroyed, an older one never can. Production therefore continues
// unchanged while the *destructible pool* stays bounded, which is what converts
// the runaway into an equilibrium rather than just slowing it down. See
// STABILISATION_EPOCHS for the measurements that motivated it.
// Drifts rafts on the mantle flow directly, with no plates involved — the Archean
// counterpart to advanceRafts below, which picks a host plate and rotates the raft
// with it.
//
// This is not a simplification of the plate version, it is the physically prior
// case: plate tectonics initiates somewhere around 3.0-2.5 Ga, and before that
// crust rides the convection directly. The raft model already being decoupled from
// the plates (docs/decisions/continental-crust-rafts.md) is what makes this a small
// function rather than a parallel system.
//
// A raft moves by the MEAN flow across its blobs, plus `1 - rigidity` of each blob's
// own departure from that mean. Rigidity 1 is a rigid plate, 0 reproduces the purely
// local advection this used to do.
//
// It used to advect every blob independently, reasoning that a continent straddling
// two convection cells SHOULD be pulled apart and that splitDisconnectedRafts would
// turn that into two continents. The reasoning was right; the omission was that
// nothing then held a continent together either. mergeOverlappingRafts computes a
// suture, raises a collision event and hands the name on — and then the next epoch
// re-advected each blob separately and undid it. Cratons approached, touched and
// drifted apart again, and no continent ever assembled.
//
// Measured over 250 epochs at three vigour settings: crust drifts 36-200 world pixels
// per epoch against a blob radius of 70, and its nearest-neighbour spacing does fall
// (1.8 → 0.55 radii, i.e. the blobs end up overlapping) — but the largest contiguous
// landmass never exceeds ~26% of the land at any setting and shows no upward trend.
// Locally dense, globally shattered.
//
// The blend keeps the original intent available: differential motion still stretches
// a raft spanning opposed flow, so break-up remains possible, and in the Archean that
// is the ONLY break-up mechanism there is — the tectonic phase tears continents apart
// at rifts (splitRaftAtRift), which needs plates that do not exist yet. So rigidity
// deliberately stops short of 1.
export function advanceRaftsOnFlow(
  rafts: Raft[],
  flow: Float32Array,
  flowResX: number,
  flowResY: number,
  width: number,
  height: number,
  rigidity: number,
): void {
  const flowAt = (x: number, y: number, component: number): number => {
    const gx = Math.min(flowResX - 1, Math.floor((wrapValue(x, width) / width) * flowResX))
    const gy = Math.min(flowResY - 1, Math.floor((wrapValue(y, height) / height) * flowResY))
    return flow[(gy * flowResX + gx) * 2 + component]
  }
  for (const raft of rafts) {
    if (raft.blobs.length === 0) continue
    // Averaging velocities, not positions — so no seam handling is needed here.
    let meanX = 0
    let meanY = 0
    for (const blob of raft.blobs) {
      meanX += flowAt(blob.x, blob.y, 0)
      meanY += flowAt(blob.x, blob.y, 1)
    }
    meanX /= raft.blobs.length
    meanY /= raft.blobs.length
    const differential = 1 - rigidity
    for (const blob of raft.blobs) {
      const localX = flowAt(blob.x, blob.y, 0)
      const localY = flowAt(blob.x, blob.y, 1)
      blob.x = wrapValue(blob.x + meanX + differential * (localX - meanX), width)
      blob.y = wrapValue(blob.y + meanY + differential * (localY - meanY), height)
    }
  }
}

// Rounds each raft toward the compact shape its own area implies — the
// Archean's stand-in for what makes real continents blocky rather than
// stringy: collision thickens crust and gravitational spreading pushes it
// outward, so a filament of accreted terranes reorganises into a massif.
// The Archean model has neither force, and its aggregation geometry is
// actively AGAINST compactness: crust collects along the mantle's linear
// downwelling convergence zones, so continents came out as strings of beads
// ("wie beim Bleigießen", user, 2026-08-06).
//
// Mechanics: only blobs OUTSIDE the raft's compact-disc target radius are
// pulled toward the centroid, by `rate` of their excess distance per epoch.
// The target is sqrt(N/π) x the raft's own MEASURED median nearest-neighbour
// blob spacing — i.e. the radius the raft would have if its blobs kept their
// current packing but arranged as a disc. Measured (2026-08-06, epoch-300
// rafts): a 306-blob raft runs blobs of radius ~70 at ~19 px spacing,
// giving a ~190 px compact target against actual blob distances of 450 px
// median / 880 px max — plenty for the pull to act on. (The first version
// used sqrt(Σ radius²) ≈ 1224 px for that same raft — six times too large,
// because heavily-overlapping metaballs cover far less area than their
// radii sum to — and was measured to be a complete no-op.) The spacing term
// is clamped to [0.5, 1.2] of the mean blob radius so the equilibrium can't
// run away: as compaction crowds blobs the measured spacing shrinks, and an
// unclamped target would chase it downward into a full collapse. A raft
// that is already compact is untouched. Centroid via
// unwrap-relative-to-the-first-blob, the same seam handling
// splitDisconnectedRafts relies on; a raft spanning more than half the
// torus would wobble, but a raft that size has outgrown "string" long ago.
//
// Archean-only by design: in the tectonic phase a raft's geometry is plate
// kinematics' business, and a compaction force there would fight the very
// motions the mantle coupling fits.
export function compactRafts(rafts: Raft[], rate: number, width: number, height: number): void {
  if (rate <= 0) return
  for (const raft of rafts) {
    const n = raft.blobs.length
    if (n < 3) continue
    const ref = raft.blobs[0]
    let sumX = 0
    let sumY = 0
    let radiusSum = 0
    for (const blob of raft.blobs) {
      sumX += wrappedDelta(blob.x, ref.x, width)
      sumY += wrappedDelta(blob.y, ref.y, height)
      radiusSum += blob.radius
    }
    const cx = ref.x + sumX / n
    const cy = ref.y + sumY / n
    const meanRadius = radiusSum / n
    // Median nearest-neighbour spacing — O(n²), but n is a few hundred and
    // this runs once per raft per epoch, far below the mantle solve's cost.
    const nearest = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let best = Infinity
      const bi = raft.blobs[i]
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const bj = raft.blobs[j]
        const d = toroidalDistanceSq(bi.x, bi.y, bj.x, bj.y, width, height)
        if (d < best) best = d
      }
      nearest[i] = Math.sqrt(best)
    }
    nearest.sort()
    const spacing = Math.min(1.2 * meanRadius, Math.max(0.5 * meanRadius, nearest[n >> 1]))
    const compactRadius = Math.sqrt(n / Math.PI) * spacing
    for (const blob of raft.blobs) {
      const dx = wrappedDelta(blob.x, cx, width)
      const dy = wrappedDelta(blob.y, cy, height)
      const dist = Math.hypot(dx, dy)
      const excess = dist - compactRadius
      if (excess <= 0) continue
      const pull = (excess * rate) / dist
      blob.x = wrapValue(blob.x - dx * pull, width)
      blob.y = wrapValue(blob.y - dy * pull, height)
    }
  }
}

// Merges near-concentric blob pairs within a raft into single larger blobs —
// the follow-up to compactRafts: compaction piles blobs into ~90% overlap
// (measured: median spacing 19 px at radius ~70), where dozens of beads
// contribute the same field one larger blob would, at dozens of times the
// query cost, and their summed edges are what keeps coastlines fringy.
//
// Constraints that shape the rule:
// - Only pairs that are BOTH stabilised (age ≥ stabilisationEpochs) merge.
//   recycleUnstabilisedCrust destroys young crust blob-by-blob; merging a
//   young blob away would silently change what can still be recycled, and
//   merging young INTO old would grant it immunity it hasn't earned. Both
//   already-immune: recycling semantics untouched.
// - birthEpoch of the merged blob is the area-weighted mean — both inputs
//   are immune, so the only consumer left is the craton-age field (iron
//   placement, ecology), which wants the average age of the material.
// - Radius caps at maxRadius: unbounded consolidation converges on one
//   mega-blob per craton, whose single smooth kernel erases the metaball
//   coastline character entirely.
// - Radius combines area-conservingly (√(r₁²+r₂²)) and each blob merges at
//   most once per epoch — consolidation is gradual and measurable, not a
//   one-epoch phase change.
export function consolidateRaftBlobs(rafts: Raft[], epoch: number, stabilisationEpochs: number, proximityFactor: number, maxRadius: number, width: number, height: number): number {
  let merged = 0
  for (const raft of rafts) {
    const blobs = raft.blobs
    const dead = new Uint8Array(blobs.length)
    const used = new Uint8Array(blobs.length)
    for (let i = 0; i < blobs.length; i++) {
      if (dead[i] || used[i]) continue
      const a = blobs[i]
      if (epoch - (a.birthEpoch ?? 0) < stabilisationEpochs) continue
      for (let j = i + 1; j < blobs.length; j++) {
        if (dead[j] || used[j]) continue
        const b = blobs[j]
        if (epoch - (b.birthEpoch ?? 0) < stabilisationEpochs) continue
        const newRadius = Math.sqrt(a.radius * a.radius + b.radius * b.radius)
        if (newRadius > maxRadius) continue
        const reach = proximityFactor * Math.min(a.radius, b.radius)
        if (toroidalDistanceSq(a.x, a.y, b.x, b.y, width, height) >= reach * reach) continue
        const wa = a.radius * a.radius
        const wb = b.radius * b.radius
        const t = wb / (wa + wb)
        a.x = wrapValue(a.x + wrappedDelta(b.x, a.x, width) * t, width)
        a.y = wrapValue(a.y + wrappedDelta(b.y, a.y, height) * t, height)
        a.radius = newRadius
        a.birthEpoch = Math.round((a.birthEpoch ?? 0) * (1 - t) + (b.birthEpoch ?? 0) * t)
        dead[j] = 1
        used[i] = 1
        merged++
        break
      }
    }
    if (merged > 0) raft.blobs = blobs.filter((_, i) => !dead[i])
  }
  return merged
}

export function recycleUnstabilisedCrust(
  rafts: Raft[],
  mantle: Float32Array,
  mantleResX: number,
  mantleResY: number,
  epoch: number,
  stabilisationEpochs: number,
  downwellingThreshold: number,
  width: number,
  height: number,
): number {
  let recycled = 0
  for (const raft of rafts) {
    const kept: RaftBlob[] = []
    for (const blob of raft.blobs) {
      const age = epoch - (blob.birthEpoch ?? 0)
      const overDownwelling = sampleNearestWorld(mantle, mantleResX, mantleResY, blob.x, blob.y, width, height) < downwellingThreshold
      if (age < stabilisationEpochs && overDownwelling) { recycled++; continue }
      kept.push(blob)
    }
    raft.blobs = kept
  }
  for (let i = rafts.length - 1; i >= 0; i--) {
    if (rafts[i].blobs.length === 0) rafts.splice(i, 1)
  }
  return recycled
}

export function accreteToNearestRaft(
  rafts: Raft[],
  x: number,
  y: number,
  blobRadius: number,
  epoch: number,
  minGapSq: number,
  maxAttachSq: number,
  width: number,
  height: number,
): boolean {
  let nearestRaft = -1
  let nearestDistSq = Infinity
  for (let i = 0; i < rafts.length; i++) {
    for (const blob of rafts[i].blobs) {
      const d = toroidalDistanceSq(x, y, blob.x, blob.y, width, height)
      if (d < nearestDistSq) {
        nearestDistSq = d
        nearestRaft = i
      }
    }
  }
  if (nearestRaft < 0 || nearestDistSq < minGapSq || nearestDistSq > maxAttachSq) return false
  // Young crust: stamped with the accretion epoch so the raft's margins read
  // younger than its cratonic interior (see RaftBlob.birthEpoch).
  rafts[nearestRaft].blobs.push({ x, y, radius: blobRadius, birthEpoch: epoch })
  return true
}

// Merge (Phase 2c): when two continents drift together so their crust
// overlaps, they suture into one — combine the two rafts' blob sets into the
// lower-indexed one and drop the other. Repeats until no overlapping pair
// remains (a three-way pileup collapses to one). overlapFactor scales the
// sum of two blobs' radii into the center-distance at which they count as
// overlapping (~0.5 ≈ their coastlines meet). Cheap at realistic raft/blob
// counts.
// The closest *overlapping* blob pair between two rafts (nearest pair that's
// within the overlap threshold), or null if none overlap. That pair's
// midpoint is where the two coastlines actually meet — the collision seam —
// so it doubles as the overlap test and the seam-geometry source.
function closestOverlappingBlobs(a: Raft, b: Raft, overlapFactor: number, width: number, height: number): { blobA: RaftBlob; blobB: RaftBlob } | null {
  let best: { blobA: RaftBlob; blobB: RaftBlob } | null = null
  let bestDistSq = Infinity
  for (const ba of a.blobs) {
    for (const bb of b.blobs) {
      const threshold = (ba.radius + bb.radius) * overlapFactor
      const d = toroidalDistanceSq(ba.x, ba.y, bb.x, bb.y, width, height)
      if (d < threshold * threshold && d < bestDistSq) {
        bestDistSq = d
        best = { blobA: ba, blobB: bb }
      }
    }
  }
  return best
}

// Sutures every pair of rafts whose coastlines have come into contact this
// epoch into one, repeatedly until nothing overlaps. Returns one
// RaftMergeEvent per collision (with seam geometry) so the caller can raise a
// "continents collided" event. A name is carried through a collision — if the
// survivor is unnamed but the absorbed raft had a name, the survivor inherits
// it, so a named continent doesn't lose its identity by absorbing a nameless
// (freshly-split or arc-born) piece.
export function mergeOverlappingRafts(rafts: Raft[], overlapFactor: number, epoch: number, width: number, height: number): RaftMergeEvent[] {
  const merges: RaftMergeEvent[] = []
  let mergedAny = true
  while (mergedAny) {
    mergedAny = false
    for (let i = 0; i < rafts.length && !mergedAny; i++) {
      for (let j = i + 1; j < rafts.length && !mergedAny; j++) {
        // Skip a pair while either side is in its post-split no-merge window.
        if ((rafts[i].noMergeUntilEpoch ?? 0) > epoch || (rafts[j].noMergeUntilEpoch ?? 0) > epoch) continue
        const overlap = closestOverlappingBlobs(rafts[i], rafts[j], overlapFactor, width, height)
        if (overlap) {
          const nameA = rafts[i].name
          const nameB = rafts[j].name
          // Seam point: midpoint of the meeting blob pair (wrapped). Seam
          // tangent: perpendicular to the convergence direction between them.
          const dx = wrappedDelta(overlap.blobB.x, overlap.blobA.x, width)
          const dy = wrappedDelta(overlap.blobB.y, overlap.blobA.y, height)
          const seamX = wrapValue((overlap.blobA.x + dx / 2), width)
          const seamY = wrapValue((overlap.blobA.y + dy / 2), height)
          const len = Math.hypot(dx, dy) || 1
          merges.push({ nameA, nameB, x: seamX, y: seamY, tangentX: -dy / len, tangentY: dx / len })
          if (!rafts[i].name && rafts[j].name) rafts[i].name = rafts[j].name
          for (const blob of rafts[j].blobs) rafts[i].blobs.push(blob)
          rafts.splice(j, 1)
          mergedAny = true
        }
      }
    }
  }
  return merges
}

// Split (Phase 2d): a rift tearing through a continent partitions its blobs
// along the rift line (through the rift point, perpendicular to `normal` —
// which points along the seed-to-seed divergence axis) into the two diverging
// halves. Only the raft the rift actually runs through (a blob within
// maxDistSq of the rift point) is split, and only if it has crust on both
// sides; an oceanic rift, or one grazing a continent's edge, does nothing.
// The far half becomes a new raft (id `newId`); the near half stays. Returns
// the RaftSplitEvent (parent name + rift axis) if a split happened, else null.
export function splitRaftAtRift(
  rafts: Raft[],
  riftX: number,
  riftY: number,
  normalX: number,
  normalY: number,
  newId: number,
  maxDistSq: number,
  gap: number,
  currentEpoch: number,
  mergeImmunity: number,
  width: number,
  height: number,
): RaftSplitEvent | null {
  let target = -1
  let bestDistSq = Infinity
  for (let i = 0; i < rafts.length; i++) {
    for (const blob of rafts[i].blobs) {
      const d = toroidalDistanceSq(riftX, riftY, blob.x, blob.y, width, height)
      if (d < bestDistSq) {
        bestDistSq = d
        target = i
      }
    }
  }
  if (target < 0 || bestDistSq > maxDistSq) return null
  const raft = rafts[target]
  const near: RaftBlob[] = []
  const far: RaftBlob[] = []
  for (const blob of raft.blobs) {
    const side = wrappedDelta(blob.x, riftX, width) * normalX + wrappedDelta(blob.y, riftY, height) * normalY
    if (side >= 0) near.push(blob)
    else far.push(blob)
  }
  if (near.length === 0 || far.length === 0) return null
  // Open an ocean gap between the two halves by pushing them apart across the
  // rift line, so their seam blobs no longer overlap and the merge pass won't
  // immediately weld them back together — a rift genuinely separates the
  // diverging continents. They keep drifting apart afterward with their plates.
  for (const blob of near) {
    blob.x = wrapValue((blob.x + normalX * gap), width)
    blob.y = wrapValue((blob.y + normalY * gap), height)
  }
  for (const blob of far) {
    blob.x = wrapValue((blob.x - normalX * gap), width)
    blob.y = wrapValue((blob.y - normalY * gap), height)
  }
  const parentName = raft.name
  raft.blobs = near
  // Both halves get a no-merge window so they don't re-weld before they've
  // had time to drift apart (the fixed convergent motions otherwise pull
  // them straight back — see Raft.noMergeUntilEpoch).
  raft.noMergeUntilEpoch = currentEpoch + mergeImmunity
  rafts.push({ id: newId, name: null, blobs: far, noMergeUntilEpoch: currentEpoch + mergeImmunity })
  // Rift axis runs perpendicular to the divergence normal (the tear line
  // itself, not the pull-apart direction).
  return { parentName, x: riftX, y: riftY, axisX: -normalY, axisY: normalX }
}

// Connected components of a raft's blobs: two blobs are "connected" if their
// centers are within (ra+rb)*connectFactor, i.e. their metaball fields still
// join above the coastline threshold between them. Union-find, O(n²) over the
// (small) blob set. connectFactor is chosen wider than MERGE_OVERLAP_FACTOR so
// pieces declared disconnected here are also beyond merge range — they won't
// immediately re-weld and ping-pong.
function connectedBlobComponents(blobs: RaftBlob[], connectFactor: number, width: number, height: number): RaftBlob[][] {
  const n = blobs.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const threshold = (blobs[i].radius + blobs[j].radius) * connectFactor
      if (toroidalDistanceSq(blobs[i].x, blobs[i].y, blobs[j].x, blobs[j].y, width, height) <= threshold * threshold) {
        parent[find(i)] = find(j)
      }
    }
  }
  const groups = new Map<number, RaftBlob[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const g = groups.get(root)
    if (g) g.push(blobs[i])
    else groups.set(root, [blobs[i]])
  }
  return [...groups.values()]
}

// Decomposes any raft whose blobs have drifted into spatially separate
// clusters (accretion at scattered margins, a rift leaving a stray arm) into
// one raft per cluster — so each visibly-separate landmass is its own named
// continent, not several under one label. The largest cluster keeps the
// raft's id + name; the rest become fresh rafts with new ids/names. Mutates
// `rafts` in place. No events raised — this is a rendering/identity cleanup,
// not a tectonic breakup (which stays the continental-rift path's job).
// Returns how many NEW rafts the split produced (0 = nothing came apart). That count
// is the counterweight to raft rigidity: it is the Archean's only break-up mechanism,
// so a rigidity high enough to drive it to zero would freeze the continents for the
// rest of the eon. See advanceRaftsOnFlow.
// `nameNewFragments` is false in the Archean, where naming is deliberately deferred to
// the hand-off: proto-cratons split and merge constantly, so naming here produced a
// stream of names for things that dissolved a few epochs later — and then
// finalizeArchean reshuffled them all anyway, so the names visibly changed the moment
// you left the phase.
export function splitDisconnectedRafts(rafts: Raft[], connectFactor: number, random: () => number, width: number, height: number, nameNewFragments = true): number {
  let maxId = rafts.reduce((m, raft) => Math.max(m, raft.id), -1)
  const result: Raft[] = []
  for (const raft of rafts) {
    const components = connectedBlobComponents(raft.blobs, connectFactor, width, height)
    if (components.length <= 1) {
      result.push(raft)
      continue
    }
    const blobArea = (blobs: RaftBlob[]): number => blobs.reduce((s, b) => s + b.radius * b.radius, 0)
    components.sort((a, b) => blobArea(b) - blobArea(a))
    result.push({ ...raft, blobs: components[0] })
    for (let k = 1; k < components.length; k++) {
      result.push({ id: ++maxId, name: null, blobs: components[k], noMergeUntilEpoch: raft.noMergeUntilEpoch })
    }
  }
  // Name the freshly-separated pieces (after the full set exists, so names stay unique
  // across everything) — but only the ones big enough to be continents. Naming every
  // fragment is what put a continent name on each of a dozen islands, and it undid the
  // hand-off's own size rule one epoch after that rule had been applied.
  if (nameNewFragments) {
    const areas = result.map((raft) => raft.blobs.reduce((sum, b) => sum + b.radius * b.radius, 0))
    const total = areas.reduce((a, b) => a + b, 0)
    for (let i = 0; i < result.length; i++) {
      if (result[i].name === null && deservesContinentName(areas[i], total)) result[i].name = pickUnusedRaftName(result, random)
    }
  }
  const created = result.length - rafts.length
  rafts.length = 0
  rafts.push(...result)
  return created
}

// Blobs per craton and their size spread (as a fraction of the craton's
// own reach) — several jittered blobs give an irregular, non-circular
// continent once unioned.

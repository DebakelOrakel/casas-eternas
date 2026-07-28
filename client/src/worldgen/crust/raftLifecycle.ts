import type { PlateSeed } from '../tectonics/plateSeeds'
import { advancePointByMotion, type PlateMotion } from '../tectonics/plateMotion'
import type { Raft, RaftBlob, RaftMergeEvent, RaftSplitEvent } from './raftTypes'
import { toroidalDistanceSq, wrappedDelta } from '../core/toroidal'
import { sampleNearestWorld, wrapValue } from '../core/field'
import { pickUnusedRaftName } from './raftNames'

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
// Each blob is advected independently rather than the raft moving rigidly: a
// continent straddling two convection cells SHOULD be pulled apart, and
// splitDisconnectedRafts then turns that into two continents. Rigid motion would
// suppress exactly the break-ups the Archean is supposed to produce.
export function advanceRaftsOnFlow(
  rafts: Raft[],
  flow: Float32Array,
  flowResX: number,
  flowResY: number,
  width: number,
  height: number,
): void {
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      const gx = Math.min(flowResX - 1, Math.floor((wrapValue(blob.x, width) / width) * flowResX))
      const gy = Math.min(flowResY - 1, Math.floor((wrapValue(blob.y, height) / height) * flowResY))
      const i = (gy * flowResX + gx) * 2
      blob.x = wrapValue(blob.x + flow[i], width)
      blob.y = wrapValue(blob.y + flow[i + 1], height)
    }
  }
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
export function splitDisconnectedRafts(rafts: Raft[], connectFactor: number, random: () => number, width: number, height: number): void {
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
  // Name the freshly-separated pieces (after the full set exists, so names
  // stay unique across everything).
  for (const raft of result) {
    if (raft.name === null) raft.name = pickUnusedRaftName(result, random)
  }
  rafts.length = 0
  rafts.push(...result)
}

// Blobs per craton and their size spread (as a fraction of the craton's
// own reach) — several jittered blobs give an irregular, non-circular
// continent once unioned.

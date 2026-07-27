import type { PlateSeed } from './plateSeeds'
import { advancePointByMotion, type PlateMotion } from './plateMotion'
import type { PlateType } from './plateTypes'
import { toroidalDistanceSq, wrappedDelta } from './toroidal'
import { CONTINENT_NAME_POOL } from './continentNames'
import { ABYSSAL_FLOOR, SEA_LEVEL, marginParameter, marginProfile } from './elevationScale'

// Continental crust modeled as persistent "rafts" that ride on the
// kinematic plates, decoupled from them — see
// docs/decisions/continental-crust-rafts.md. A raft is a set of soft
// metaball blobs whose union is one continent's outline; a point is
// "continental" where the summed metaball field crosses a threshold, so
// membership stays an analytic query-anywhere distance-field (fits the A3
// model and the domain warp), and rafts grow/merge/split as blob-set
// operations. Phase 1 (this file's first cut): rafts are generated at init
// and drift rigidly with their host plate, but don't yet split/merge/grow
// — that lifecycle is a later phase.

export interface RaftBlob {
  x: number
  y: number
  radius: number
  // World epoch this piece of continental crust formed: 0 for the original
  // cratonic nuclei (oldest), the accretion epoch for margin blobs welded on at
  // subduction arcs (younger). Gives a real old-interior/young-margin craton-age
  // gradient (continents grow by marginal accretion) that the Ecology layer
  // samples for iron (old cratons). Optional so pre-existing saved rafts, which
  // lack it, simply read as age 0 (oldest). See docs/decisions/ecology.md P2.
  birthEpoch?: number
}

export interface Raft {
  id: number
  // The continent's name (rafts, not plates, are continents now).
  name: string | null
  blobs: RaftBlob[]
  // Freshly-split halves get this stamp so they don't instantly re-weld:
  // mergeOverlappingRafts skips any pair where either side is still within
  // its window. Lets a breakup stay visible instead of splitting and merging
  // back on consecutive epochs (a band-aid over the fixed-Euler-pole ceiling
  // — see the raft decision doc). Absent/0 = mergeable now.
  noMergeUntilEpoch?: number
}

// What a raft collision (mergeOverlappingRafts) reports for the event/overlay
// layer: the two continents' names (either may be null) plus the suture
// geometry — a point on the collision seam and the tangent the seam runs
// along (perpendicular to the convergence direction, i.e. along the
// fold-mountain belt). The map marker draws a short band there.
export interface RaftMergeEvent {
  nameA: string | null
  nameB: string | null
  x: number
  y: number
  tangentX: number
  tangentY: number
}

// A persisted collision-belt record: the accumulated history of every raft
// suture, kept for the world's life (NOT pruned like terrain features) so
// deep-time orogens survive as the Ecology layer's provenance for tin, lode
// gold, and metamorphic gems. One is appended per RaftMergeEvent (see
// plateSimulation.stepEpoch); `epoch` stamps when the collision happened, so an
// old suture can read differently from a fresh one. See docs/decisions/ecology.md P1.
export interface Suture {
  x: number
  y: number
  // Unit tangent along the collision seam (the fold-mountain belt's long axis).
  tangentX: number
  tangentY: number
  epoch: number
}

// What a continental breakup (splitRaftAtRift) reports: the parent
// continent's name plus the rift axis — a point on the tear and the
// direction the rift line runs (perpendicular to the divergence normal).
export interface RaftSplitEvent {
  parentName: string | null
  x: number
  y: number
  axisX: number
  axisY: number
}

// Metaball kernel: (1 - (d/r)²)² inside the blob, 0 outside. Smooth, finite
// support (so a query only sums nearby blobs), peaks at 1 at the center.
function blobKernel(distSq: number, radius: number): number {
  const r2 = radius * radius
  if (distSq >= r2) return 0
  const s = 1 - distSq / r2
  return s * s
}

// The summed metaball field maps to continental membership via a smooth
// threshold band: below FIELD_LO fully oceanic, above FIELD_HI fully
// continental, smoothstep between. A single blob peaks at field 1 at its
// center, so a lone blob's coastline sits partway out; overlapping blobs
// sum higher and union into one landmass with no seam.
const FIELD_LO = 0.35
const FIELD_HI = 0.65

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// The raw summed metaball field at a world point — 0 far from any crust, 1 at a
// lone blob's centre, higher where blobs overlap. Sums every blob's kernel
// (toroidally wrapped); brute-force over blobs for now, like the feature query
// was before bucketing — add a spatial index later if it shows up in a profile.
//
// Exposed separately from raftMembership because elevation needs the field
// itself, not the thresholded membership: the margin profile (elevationScale.ts)
// runs its own, wider band over this same field so a continental shelf has room
// to exist. Thresholding first would throw away exactly the range it needs.
export function raftField(x: number, y: number, rafts: Raft[], width: number, height: number): number {
  let field = 0
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      field += blobKernel(toroidalDistanceSq(x, y, blob.x, blob.y, width, height), blob.radius)
    }
  }
  return field
}

// Continental membership 0..1 at a world point — 0 open ocean, 1 solid
// continental interior. This is the "is it continental crust" question (plate
// typing, accretion, mantle insulation, rift eligibility), NOT "is it above
// water" — see marginProfile for the latter.
export function raftMembership(x: number, y: number, rafts: Raft[], width: number, height: number): number {
  return smoothstep(FIELD_LO, FIELD_HI, raftField(x, y, rafts, width, height))
}

// Continental membership sampled onto a coarse grid, computed ONCE per epoch and
// shared by every consumer that needs "is there continent here" over the whole
// surface. raftMembership is a brute-force scan over every blob of every raft, so
// a full-surface sweep costs cells × blobs — and blob counts grow through a run as
// margins accrete. mantleField already paid that (128×64 per epoch); adding a
// second independent sweep for the ocean-age sink would have roughly quintupled it
// at the 256×128 age resolution. One field, sampled by world coordinate, keeps it
// at a single sweep regardless of how many consumers there are.
export function computeMembershipField(rafts: Raft[], resX: number, resY: number, width: number, height: number): Float32Array {
  const out = new Float32Array(resX * resY)
  for (let gy = 0; gy < resY; gy++) {
    const wy = ((gy + 0.5) / resY) * height
    for (let gx = 0; gx < resX; gx++) {
      const wx = ((gx + 0.5) / resX) * width
      out[gy * resX + gx] = raftMembership(wx, wy, rafts, width, height)
    }
  }
  return out
}

// Nearest-cell sample of a membership field at a world point (torus-wrapped), so
// consumers on their own grids can read it without caring what resolution it was
// computed at. Nearest rather than bilinear on purpose: every consumer thresholds
// the result (> 0.5) rather than using its magnitude, so interpolation would only
// cost time.
export function sampleMembershipField(field: Float32Array, resX: number, resY: number, x: number, y: number, width: number, height: number): number {
  const gx = Math.min(resX - 1, Math.floor((((x % width) + width) % width) / width * resX))
  const gy = Math.min(resY - 1, Math.floor((((y % height) + height) % height) / height * resY))
  return field[gy * resX + gx]
}

// A coarse (resX×resY) field of continental crust "oldness" 0..1 — 1 where the
// crust formed at epoch 0 (the ancient cratonic cores), lower toward margins
// accreted later (see RaftBlob.birthEpoch). Metaball-weighted mean birth epoch
// per cell, normalized against the current epoch. Cells over ocean / no crust get
// -1. Feeds iron placement (old cratons) in the Ecology layer. O(cells × blobs);
// called on-demand, not per frame.
export function computeCratonOldnessField(rafts: Raft[], currentEpoch: number, resX: number, resY: number, width: number, height: number): Float32Array {
  const out = new Float32Array(resX * resY)
  for (let gy = 0; gy < resY; gy++) {
    const wy = ((gy + 0.5) / resY) * height
    for (let gx = 0; gx < resX; gx++) {
      const wx = ((gx + 0.5) / resX) * width
      let wSum = 0
      let ageSum = 0
      for (const raft of rafts) {
        for (const blob of raft.blobs) {
          const w = blobKernel(toroidalDistanceSq(wx, wy, blob.x, blob.y, width, height), blob.radius)
          if (w > 0) { wSum += w; ageSum += w * (blob.birthEpoch ?? 0) }
        }
      }
      out[gy * resX + gx] = wSum === 0 ? -1 : currentEpoch <= 0 ? 1 : Math.max(0, Math.min(1, 1 - (ageSum / wSum) / currentEpoch))
    }
  }
  return out
}

// Phase 1 bridge: the existing crust-type-consuming code (boundary
// classification, events, rift/merge) still reads a per-plate PlateType, but
// rafts are the source of truth now, so a plate's type is DERIVED — it's
// continental if a raft covers its seed. Later phases move those consumers
// onto direct raft geometry and this goes away.
const SEED_CONTINENTAL_THRESHOLD = 0.5

export function derivePlateTypes(seeds: PlateSeed[], rafts: Raft[], width: number, height: number): PlateType[] {
  return seeds.map((seed) => (raftMembership(seed.x, seed.y, rafts, width, height) >= SEED_CONTINENTAL_THRESHOLD ? 'continental' : 'oceanic'))
}

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
          const seamX = (((overlap.blobA.x + dx / 2) % width) + width) % width
          const seamY = (((overlap.blobA.y + dy / 2) % height) + height) % height
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
    blob.x = (((blob.x + normalX * gap) % width) + width) % width
    blob.y = (((blob.y + normalY * gap) % height) + height) % height
  }
  for (const blob of far) {
    blob.x = (((blob.x - normalX * gap) % width) + width) % width
    blob.y = (((blob.y - normalY * gap) % height) + height) % height
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
const MIN_BLOBS_PER_CRATON = 4
const MAX_BLOBS_PER_CRATON = 8

// Fraction of the surface that is actually DRY — the target the blob-radius
// binary search in generateInitialRafts calibrates the user's land-fraction
// slider against.
//
// Tests the margin profile's own zero crossing rather than `membership >= 0.5`,
// which is what this used to do. That worked only by coincidence: under the old
// linear ocean→continent lerp, sea level happened to fall at membership ≈ 0.56,
// close enough to 0.5 for the proxy to pass. It stops holding the moment the
// profile is shaped — the shoreline now sits at t = 0.88 — and a slider that
// silently over-reports land by a wide margin is worse than one that's merely
// approximate. Asking the profile directly can't drift out of sync again.
function measureLandFraction(rafts: Raft[], width: number, height: number): number {
  // Coarse sample — exact enough to calibrate blob sizes against.
  const sx = 128
  const sy = 64
  let land = 0
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const x = (i + 0.5) * (width / sx)
      const y = (j + 0.5) * (height / sy)
      // Ocean age is irrelevant here: the shoreline sits above the deep end of
      // the profile, so any floor value gives the same land/water verdict.
      if (marginProfile(marginParameter(raftField(x, y, rafts, width, height)), ABYSSAL_FLOOR) > SEA_LEVEL) land++
    }
  }
  return land / (sx * sy)
}

// Builds the initial rafts: N cratons (from seed), each a cluster of
// jittered blobs, then a global radius scale binary-searched so the
// measured continental coverage hits `landFraction`. `clustering` (0..1)
// controls how tightly the cratons pack: 1 packs them into one region
// (supercontinent), 0 spreads them across the whole map.
export function generateInitialRafts(random: () => number, landFraction: number, clustering: number, cratonCount: number, width: number, height: number): Raft[] {
  // Craton placement in two steps so the clustering slider behaves
  // intuitively: first scatter each craton's "spread" position across the
  // whole map (stable per seed), then pull each toward a common anchor
  // (the first craton's spread position) by `clustering` along the wrapped
  // shortest path. clustering 0 => the scattered positions (dispersed
  // continents); clustering 1 => all collapse onto the anchor (a single
  // supercontinent); in between the continents slide smoothly together.
  // Drawing all spread positions up front keeps the random sequence — and
  // thus every craton and blob — identical as the slider moves; only the
  // pull changes.
  const spread: { x: number; y: number }[] = []
  for (let c = 0; c < cratonCount; c++) spread.push({ x: random() * width, y: random() * height })
  const anchor = spread[0]
  // Base blob reach before calibration — a fraction of the map, later
  // scaled to hit the target land fraction, so this only sets relative
  // craton/blob proportions, not absolute size.
  const baseReach = Math.min(width, height) * 0.12

  // Build cratons at their SPREAD (dispersed) positions first. Calibration
  // below sizes them against this fixed, minimal-overlap layout; the
  // clustering pull afterward only TRANSLATES whole cratons, never resizes
  // them. Recalibrating per clustering instead made continents balloon as
  // they converged (overlap wastes coverage — measured +72% blob radius from
  // dispersed to supercontinent), which read as unstable; physically,
  // cratons keep their area when they suture together, they don't grow.
  const rafts: Raft[] = []
  for (let c = 0; c < cratonCount; c++) {
    const cx = spread[c].x
    const cy = spread[c].y
    const blobCount = MIN_BLOBS_PER_CRATON + Math.floor(random() * (MAX_BLOBS_PER_CRATON - MIN_BLOBS_PER_CRATON + 1))
    const blobs: RaftBlob[] = []
    for (let b = 0; b < blobCount; b++) {
      // Jitter blobs within the craton's reach so they overlap into one
      // irregular mass rather than scattering into islands.
      const angle = random() * Math.PI * 2
      const dist = random() * baseReach
      const bx = (((cx + Math.cos(angle) * dist) % width) + width) % width
      const by = (((cy + Math.sin(angle) * dist) % height) + height) % height
      // Original cratonic nuclei: age 0, the oldest crust in the world.
      blobs.push({ x: bx, y: by, radius: baseReach * (0.5 + random() * 0.5), birthEpoch: 0 })
    }
    rafts.push({ id: c, name: null, blobs })
  }

  // Binary-search a global radius scale so measured land coverage matches the
  // target on the dispersed layout — same calibrate-against-a-sample idea the
  // sphere version used for its continental weights, since blob overlap makes
  // the area-from-radii relation non-analytic.
  const baseRadii = rafts.map((raft) => raft.blobs.map((blob) => blob.radius))
  const applyScale = (scale: number): void => {
    for (let r = 0; r < rafts.length; r++) {
      for (let b = 0; b < rafts[r].blobs.length; b++) rafts[r].blobs[b].radius = baseRadii[r][b] * scale
    }
  }
  let lo = 0.2
  let hi = 8
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) / 2
    applyScale(mid)
    if (measureLandFraction(rafts, width, height) < landFraction) lo = mid
    else hi = mid
  }
  applyScale((lo + hi) / 2)

  // Clustering pull: move each craton toward the anchor along its own radial
  // direction, but stop at a minimum RING distance (about one craton's reach)
  // rather than collapsing onto the anchor. So at clustering=1 the cratons
  // pack into an adjacent, sutured supercontinent — land roughly conserved —
  // instead of stacking on one point, which would hide most of the land under
  // itself. Sizes are already fixed, so this is pure translation and the
  // continents just slide together as the slider moves.
  const cratonReach = rafts.map((raft, c) => {
    let maxReach = 0
    for (const blob of raft.blobs) {
      // ~0.57·radius is where the metaball membership crosses 0.5 (the
      // coastline) for a lone blob — see FIELD_LO/HI.
      const reach = Math.sqrt(toroidalDistanceSq(blob.x, blob.y, spread[c].x, spread[c].y, width, height)) + blob.radius * 0.57
      if (reach > maxReach) maxReach = reach
    }
    return maxReach
  })
  const ringDist = cratonReach.reduce((a, b) => a + b, 0) / cratonReach.length
  for (let c = 0; c < cratonCount; c++) {
    const wdX = wrappedDelta(spread[c].x, anchor.x, width)
    const wdY = wrappedDelta(spread[c].y, anchor.y, height)
    const dist = Math.hypot(wdX, wdY)
    if (dist < 1e-6) continue
    const targetDist = dist * (1 - clustering) + ringDist * clustering
    const targetX = anchor.x + (wdX / dist) * targetDist
    const targetY = anchor.y + (wdY / dist) * targetDist
    const deltaX = wrappedDelta(targetX, spread[c].x, width)
    const deltaY = wrappedDelta(targetY, spread[c].y, height)
    for (const blob of rafts[c].blobs) {
      blob.x = (((blob.x + deltaX) % width) + width) % width
      blob.y = (((blob.y + deltaY) % height) + height) % height
    }
  }

  return assignRaftNames(rafts, random)
}

// Picks a pool name not already used by any current raft, for a newly born
// continent (a rift's far half, or a future island arc). Random among the
// still-free names; null only if the whole pool is in use.
export function pickUnusedRaftName(rafts: Raft[], random: () => number): string | null {
  const used = new Set(rafts.map((raft) => raft.name).filter((name): name is string => name !== null))
  const available = CONTINENT_NAME_POOL.filter((name) => !used.has(name))
  if (available.length === 0) return null
  return available[Math.floor(random() * available.length)]
}

// Gives each raft a unique name from the shared pool — same shuffle-then-
// take pattern as assignContinentNames, but keyed to rafts (continents)
// rather than plates.
function assignRaftNames(rafts: Raft[], random: () => number): Raft[] {
  const pool = [...CONTINENT_NAME_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return rafts.map((raft, i) => ({ ...raft, name: i < pool.length ? pool[i] : null }))
}

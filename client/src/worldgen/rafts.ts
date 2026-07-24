import type { PlateSeed } from './plateSeeds'
import type { PlateMotion } from './plateMotion'
import type { PlateType } from './plateTypes'
import { rotateAroundCenter, toroidalDistanceSq, wrappedDelta } from './toroidal'
import { CONTINENT_NAME_POOL } from './continentNames'

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
}

export interface Raft {
  id: number
  // The continent's name (rafts, not plates, are continents now).
  name: string | null
  blobs: RaftBlob[]
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

// Continental membership 0..1 at a world point — 0 open ocean, 1 solid
// continental interior, the band between is the coastal shelf. Sums every
// blob's kernel (toroidally wrapped); brute-force over blobs for now, like
// the feature query was before bucketing — add a spatial index later if it
// shows up in a profile.
export function raftMembership(x: number, y: number, rafts: Raft[], width: number, height: number): number {
  let field = 0
  for (const raft of rafts) {
    for (const blob of raft.blobs) {
      field += blobKernel(toroidalDistanceSq(x, y, blob.x, blob.y, width, height), blob.radius)
    }
  }
  return smoothstep(FIELD_LO, FIELD_HI, field)
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
      const rotated = rotateAroundCenter(blob.x, blob.y, motion.centerX, motion.centerY, motion.angularSpeed * angleStep, width, height)
      blob.x = rotated.x
      blob.y = rotated.y
    }
  }
}

// Blobs per craton and their size spread (as a fraction of the craton's
// own reach) — several jittered blobs give an irregular, non-circular
// continent once unioned.
const MIN_BLOBS_PER_CRATON = 4
const MAX_BLOBS_PER_CRATON = 8

function measureLandFraction(rafts: Raft[], width: number, height: number): number {
  // Coarse membership sample — exact enough to calibrate blob sizes against.
  const sx = 128
  const sy = 64
  let land = 0
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const x = (i + 0.5) * (width / sx)
      const y = (j + 0.5) * (height / sy)
      if (raftMembership(x, y, rafts, width, height) >= 0.5) land++
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
      blobs.push({ x: bx, y: by, radius: baseReach * (0.5 + random() * 0.5) })
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

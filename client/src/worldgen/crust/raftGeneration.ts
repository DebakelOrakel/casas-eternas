import type { Raft, RaftBlob } from './raftTypes'
import { raftField } from './raftField'
import { toroidalDistanceSq, wrappedDelta } from '../core/toroidal'
import { wrapValue } from '../core/field'
import { ABYSSAL_FLOOR, SEA_LEVEL, marginParameter, marginProfile } from '../elevation/elevationScale'
import { assignRaftNames } from './raftNames'

// Continental crust modeled as persistent "rafts" that ride on the kinematic
// plates, decoupled from them — see docs/decisions/continental-crust-rafts.md. A
// raft is a set of soft metaball blobs whose union is one continent's outline.
//
// World generation: the initial craton layout, and the binary search over blob
// radii that makes the land-fraction slider mean what it says.

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
      blob.x = wrapValue((blob.x + deltaX), width)
      blob.y = wrapValue((blob.y + deltaY), height)
    }
  }

  return assignRaftNames(rafts, random)
}

// Picks a pool name not already used by any current raft, for a newly born
// continent (a rift's far half, or a future island arc). Random among the
// still-free names; null only if the whole pool is in use.

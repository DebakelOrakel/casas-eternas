import { SEA_LEVEL, SHELF_BREAK, metersToElevation } from '../elevation/elevationScale'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { gradedSeaCap } from './erosion'

// Reduced-complexity delta growth for the micro tile — the missing mechanism
// the 2026-08-06 prototype identified: stream-power + MFD + a transport-
// capacity law builds a compact deposit at a mouth, but it has no
// avulsion/bifurcation dynamics, so no amount of rounds or retention tuning
// produces a distributary fan (measured: 26→36 cells with heavy
// amplification, diminishing). Real fans come from a different process:
// flow leaving the mouth decelerates, drops sediment as a MOUTH BAR, and the
// bar then SPLITS the flow around itself — repeat at each new mouth and the
// channel network bifurcates into a fan on its own.
//
// This is a deliberately small caricature of that process in the spirit of
// DeltaRCM (Liang et al. 2015) — water/sediment parcels doing weighted random
// walks over the wet surface — not a port of it: no water-surface iteration,
// no explicit discharge field, just the three ingredients the emergent
// bifurcation actually needs: depth-weighted routing (flow prefers deeper
// water), inertia (flow doesn't U-turn), and shallow-water deposition (bars
// grow exactly where they will later split the flow).
//
// Runs on the TILE only. The macro map keeps its capacity-law deltas — this
// model needs sub-cell room to express a fan, which is exactly the micro
// tier's purpose. Deposits obey the same graded freeboard cap as
// depositSediment (gradedSeaCap, keyed on the tile's tectonic envelope), so
// emerged delta plain stays a low, seaward-thinning surface.
//
// Deterministic: all randomness comes from a seeded xorshift32 — same tile,
// same world, same fan. (Project rule: a tile must regenerate bit-identically.)

export interface DeltaGrowthParams {
  // Total sediment parcels released at the mouth. The fan's size knob:
  // parcels × loadPerParcelM of column-metres end up in the fan (minus the
  // share written off past the shelf).
  parcels: number
  // Sediment carried by one parcel, in metres of elevation over one fine cell.
  loadPerParcelM: number
  // Water shallower than this counts as "decelerating" — the parcel starts
  // dropping its load here. A few metres: mouth-bar depth, not shelf depth.
  depositBelowDepthM: number
  // Fraction of remaining load dropped per deposition step — spreads one
  // parcel's load over several cells along its dying path instead of one
  // spike.
  depositFraction: number
  // Give up past this many steps (safety; typical parcels stop far earlier).
  stepLimit: number
  // No deposition within this Chebyshev radius of the mouth — without it the
  // very first shallow cells clog solid, the entry seals itself into land,
  // and every later parcel dies landlocked on the doorstep. Real DeltaRCM
  // keeps its feeder channel open through water-depth dynamics it actually
  // simulates; this caricature just declares the throat off-limits.
  mouthProtectRadius: number
  // e-folding DEPTH (metres) of the deposition rate — THE concentration
  // knob, and the survivor of two measured failures. A gentle quadratic
  // depth ramp smeared the budget across the whole 140 m shelf band (no cell
  // ever reached the cap → no land → no bifurcation); an exponential decay
  // over STEPS-from-the-mouth concentrated beautifully but self-limited: as
  // the fan grows, its front sits ever more steps from the throat, so
  // progradation strangled itself at ~40 px radius (measured: 46 new land
  // cells, then nothing). Depth does both jobs at once: parcels shed almost
  // nothing over deep water, and shed fast wherever it is shallow — INCLUDING
  // the front's own foresets, which their deposits keep making shallower, so
  // the front advances itself instead of starving with distance.
  depositDepthScaleM: number
  // A cell visited by more than this share of the walkers released so far
  // counts as CHANNEL and takes no deposits. The missing DeltaRCM half:
  // deposition happens on the flow's flanks, not in its thalweg. Without
  // this, the nearshore fringe filled to the cap in the first few hundred
  // parcels, the grown land encircled the protected mouth pocket, and every
  // remaining walker spent its full stepLimit trapped in the pond — measured:
  // 428 column-metres deposited (exactly the fringe's capacity), then 59k
  // parcels × 1200 wasted steps (the mysterious 17 s). High-traffic corridors
  // staying water is also precisely what draws the distributary channels
  // between the growing bars.
  channelVisitFraction: number
}

export const DEFAULT_DELTA_GROWTH_PARAMS: DeltaGrowthParams = {
  parcels: 120000,
  loadPerParcelM: 4,
  depositBelowDepthM: 12,
  depositFraction: 0.35,
  stepLimit: 1200,
  mouthProtectRadius: 4,
  depositDepthScaleM: 15,
  channelVisitFraction: 0.05,
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0
  if (s === 0) s = 0x9e3779b9
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]

// Grows a fan at `mouth` by mutating `elevations` in place. `envelope` is the
// tile's tectonic reference for the freeboard cap. `heading` is the initial
// seaward flow direction (unit-ish); parcels inherit it as their starting
// inertia. Bounded grid — a parcel that steps off the tile is done (its
// remaining load leaves the window, same accounting as the rim drain).
export function growDelta(
  elevations: Float32Array,
  envelope: Float32Array,
  n: number,
  mouth: { x: number; y: number },
  heading: { x: number; y: number },
  seed: number,
  params: DeltaGrowthParams = DEFAULT_DELTA_GROWTH_PARAMS,
): void {
  const rng = makeRng(seed)
  const depositBelowDepth = metersToElevation(params.depositBelowDepthM)
  const loadPerParcel = metersToElevation(params.loadPerParcelM)
  // Past the SHELF BREAK a parcel's load is written off rather than carried
  // into the abyss — the same accounting cutoff as depositSediment's. The
  // first version used a much tighter band (6× the shallow threshold ≈ 36 m)
  // and the fan never happened: mouth bays drop below that within a few
  // cells, so 30k parcels transited the sliver of shallow water and wrote
  // everything off in ~0 s flat.
  const abandonDepth = SEA_LEVEL - SHELF_BREAK

  const weightDepthCap = depositBelowDepth * 2
  const weights = new Float64Array(8)
  const visits = new Uint32Array(n * n)
  for (let p = 0; p < params.parcels; p++) {
    // Channel test threshold for this parcel: share of walkers so far, with a
    // floor so the very first parcels (tiny denominators) don't classify
    // every touched cell as channel and never deposit at all.
    const channelThreshold = Math.max(8, (p + 1) * params.channelVisitFraction)
    let x = mouth.x
    let y = mouth.y
    let hx = heading.x
    let hy = heading.y
    let load = loadPerParcel
    // Spent parcels stop early — below 2% of their starting load the walk
    // only costs time (their remaining deposits are invisible).
    const loadFloor = loadPerParcel * 0.02
    for (let step = 0; step < params.stepLimit && load > loadFloor; step++) {
      // Candidate weights over the D8 ring: water only, deeper preferred,
      // inertia against turning, near-zero for reversal.
      let total = 0
      for (let k = 0; k < 8; k++) {
        const nx = x + OFFSETS[k][0]
        const ny = y + OFFSETS[k][1]
        if (nx < 0 || nx >= n || ny < 0 || ny >= n) { weights[k] = 0; continue }
        const e = elevations[ny * n + nx]
        if (e > SEA_LEVEL) { weights[k] = 0; continue } // land blocks flow — this is what bends parcels around a grown bar
        const depth = Math.min(SEA_LEVEL - e, weightDepthCap)
        const len = Math.hypot(OFFSETS[k][0], OFFSETS[k][1])
        const forward = (hx * OFFSETS[k][0] + hy * OFFSETS[k][1]) / len
        const inertiaBase = forward > 0 ? SURFACE_TUNING.backwardWeight + forward : SURFACE_TUNING.backwardWeight * Math.max(0, 1 + forward)
        // Squared: the mouth JET must persist — with linear inertia the walk
        // diffused within ~5 steps and every walker drifted alongshore into
        // the shallow fringe, building a coast-parallel strand plain instead
        // of a seaward fan (measured run: 818 new-land cells, all hugging the
        // old shoreline).
        const w = Math.pow(depth + metersToElevation(0.5), SURFACE_TUNING.depthExponent) * inertiaBase * inertiaBase
        weights[k] = w
        total += w
      }
      if (total <= 0) break // fully landlocked (or cornered) — parcel dies here
      let pick = rng() * total
      let k = 0
      for (; k < 7; k++) {
        pick -= weights[k]
        if (pick <= 0) break
      }
      // Floating-point spill can land the cursor on a zero-weight slot (land/
      // off-grid) — walk back to the heaviest real candidate instead.
      if (weights[k] === 0) {
        let best = 0
        for (let j = 0; j < 8; j++) if (weights[j] > weights[best]) best = j
        k = best
      }
      x += OFFSETS[k][0]
      y += OFFSETS[k][1]
      // Smoothed inertia update (EMA) so the heading reflects the recent
      // path, not just the last hop.
      const len = Math.hypot(OFFSETS[k][0], OFFSETS[k][1])
      hx = 0.8 * hx + 0.2 * (OFFSETS[k][0] / len)
      hy = 0.8 * hy + 0.2 * (OFFSETS[k][1] / len)

      const i = y * n + x
      visits[i]++
      const depth = SEA_LEVEL - elevations[i]
      if (depth > abandonDepth) break // past the shelf break — load written off
      const inThroat = Math.max(Math.abs(x - mouth.x), Math.abs(y - mouth.y)) <= params.mouthProtectRadius
      const isChannel = visits[i] > channelThreshold
      if (!inThroat && !isChannel) {
        // Depth-exponential deposition — see depositDepthScaleM for why depth
        // (not distance, not a gentle ramp) carries the concentration. Full
        // rate in water shallower than depositBelowDepthM, e-folding decay
        // below that.
        const excess = depth - depositBelowDepth
        const fraction = params.depositFraction * (excess <= 0 ? 1 : Math.exp(-excess / metersToElevation(params.depositDepthScaleM)))
        {
          // Capped at the graded freeboard so a bar can emerge as LAND (which
          // then splits the flow) but never grows a tower.
          const cap = gradedSeaCap(envelope, i)
          const room = cap - elevations[i]
          if (room > 0) {
            const drop = Math.min(load * fraction, room)
            elevations[i] += drop
            load -= drop
          } else if (elevations[i] > SEA_LEVEL) {
            // Walked onto grown land (possible on the entry cell itself) — done.
            break
          }
        }
      }
    }
  }
}

// The fan's feed point: the SEA cell carrying the most drainage accumulation
// that touches the shore AND has genuine open-water access. Two measured
// wrong answers preceded this: the max-accumulation coastal LAND cell sits in
// the stream-burnt trunk groove (a landlocked 0.2 m puddle — every walker
// died on the doorstep), and the max-accumulation sea cell unconditioned
// slides down-slope with the MFD accumulation into the deepest basin floor
// (5683 m). Heading = toward the entry's deepest sea neighbour.
export function pickDeltaEntry(elevations: Float32Array, accumulation: Float32Array, n: number): { x: number; y: number; headingX: number; headingY: number } | null {
  const minAccess = metersToElevation(2)
  let entry = -1
  let entryAcc = -1
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x
      if (elevations[i] > SEA_LEVEL) continue
      let touchesLand = false
      let openWater = false
      for (const [dx, dy] of OFFSETS) {
        const e = elevations[(y + dy) * n + x + dx]
        if (e > SEA_LEVEL) touchesLand = true
        else if (SEA_LEVEL - e >= minAccess) openWater = true
      }
      if (touchesLand && openWater && accumulation[i] > entryAcc) { entryAcc = accumulation[i]; entry = i }
    }
  }
  if (entry < 0) return null
  const ey = (entry / n) | 0
  const ex = entry - ey * n
  let hx = 0
  let hy = 0
  let bestDepth = -1
  for (const [dx, dy] of OFFSETS) {
    const e = elevations[(ey + dy) * n + ex + dx]
    if (e <= SEA_LEVEL && SEA_LEVEL - e > bestDepth) { bestDepth = SEA_LEVEL - e; hx = dx; hy = dy }
  }
  const len = Math.hypot(hx, hy) || 1
  return { x: ex, y: ey, headingX: hx / len, headingY: hy / len }
}

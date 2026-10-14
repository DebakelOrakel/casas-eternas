import type { ArcheanSimulation } from './archeanState'
import { buildBlobIndex } from '../crust/raftField'
import { raftBaselineAt } from '../elevation/elevationField'
import { dynamicTopographyAt } from '../elevation/dynamicTopography'
import { mantleMesh } from '../mantle/mantleField'
import { domainArea } from '../core/domain'

// THE LAND SHARE LEVER (DEC-0036 phase 8b-1): the Archean makes crust until
// its LAND reaches the world's target (raised by what the history takes
// back, archeanLandAim), and then makes only what holds it.
//
// What is measured is the land, not the crust: the solid surface above the
// sea, the raft baseline (the margin profile, the hypsometry, the warp)
// plus the mantle's dynamic topography — the height the Archean's render
// tests and the hand-over's terrain mesh starts from (pipeline/coupledEpoch
// solidBaselineAt; the render adds detail on the land only, which keeps
// the sign). Measured 2026-10-12 at 2048 × 1024, two seeds per shape,
// epochs 50–500: within 0.2 points of the same test on a mesh four times
// as fine, within 1–2 points of the raft field's own coastline
// (SHORELINE_FIELD), and the hand-over's mesh starts on it to 0.1 points.
//
// Measured on the mantle's field mesh (125 km cells, one area each on both
// shapes), in the step — never off the render: the render runs coarse while
// the Archean plays, is skipped by a replay, and is not part of the state.
// ~10 000 points a step.
export function archeanLandShare(sim: ArcheanSimulation): number {
  const { domain } = sim
  const { mesh, sampler } = mantleMesh(domain)
  const blobs = buildBlobIndex(sim.rafts, domain)
  let land = 0
  let total = 0
  for (let i = 0; i < mesh.count; i++) {
    const x = mesh.x[i]
    const y = mesh.y[i]
    const a = mesh.area[i]
    total += a
    if (raftBaselineAt(x, y, sim.rafts, null, domain, sim.warpSeed, blobs) + dynamicTopographyAt(sim.mantle, sampler, x, y) > 0) land += a
  }
  return land / total
}

// The controller's constants (ArcheanParams.land).
export interface LandShareParams {
  // The Archean epoch by which the land is to reach its aim. A player stops
  // the Archean at 1000–1500 Ma; see DEFAULT_ARCHEAN_PARAMS for why the
  // climb ends before that.
  reachEpoch: number
  // The horizon a deficit is closed over once the reach epoch is near or
  // past, epochs: the hold's gain is its inverse.
  holdEpochs: number
  // The land one nucleus adds, net, m²: the feed-forward's divisor (a
  // deficit in m² over the epochs left is nuclei per epoch). Net of what
  // recycling and compaction take back — see DEFAULT_ARCHEAN_PARAMS.
  nucleusLandM2: number
  // What the history takes back: the plates' first epochs recycle the
  // Archean's young crust and accrete their own, and the balance costs
  // land the more of it there is. The Archean aims above the target by
  // historySlope × (target − historyFrom) so that the land after the
  // first 40 epochs of the history is the target (archeanLandAim).
  historyFrom: number
  historySlope: number
  // Above historySteepFrom the toll rises faster (DEC-0036 phase 8g): the
  // aim gains historySteepSlope × (target − historySteepFrom) more.
  historySteepFrom: number
  historySteepSlope: number
  // The controller's ceiling is at least this many times the straight
  // ramp its aim needs (the aim's land over the reach epoch, in nuclei per
  // epoch), never below the nucleation's maxPerEpoch (DEC-0036 phase 8g).
  ceilingOverRamp: number
}

// The land share the Archean steers toward for a target (a fraction): the
// target, raised by what the history will take back (LandShareParams).
export function archeanLandAim(target: number, params: LandShareParams): number {
  const steep = target > params.historySteepFrom ? params.historySteepSlope * (target - params.historySteepFrom) : 0
  return target + params.historySlope * Math.max(0, target - params.historyFrom) + steep
}

// How many nuclei this epoch may place, from the land as it stands and the
// target (a fraction of the world's area). Feed-forward plus feedback in
// one rule — the deficit spread over the epochs left to the reach epoch
// (never fewer than holdEpochs), in nuclei:
//
//     rate = (target − land) / max(holdEpochs, reachEpoch − epoch) / nucleusShare
//
// Before the reach epoch it is the rate that closes the deficit just in
// time (a land falling behind raises it, one running ahead lowers it);
// after it, a proportional hold that replaces what recycling, compaction
// and merging take. Over the target it places none: the Archean never
// removes crust to fit. The rate accumulates as a credit (fractional
// nuclei carry over), capped at the per-epoch maximum, so a slow rate is a
// nucleus every few epochs, not none; the caller takes off what it placed.
// Deterministic: the state is the credit, saved with the Archean.
export function nucleationBudget(sim: ArcheanSimulation, land: number, target: number, params: LandShareParams, maxPerEpoch: number): number {
  const deficit = target - land
  if (!(deficit > 0)) {
    sim.nucleationCredit = 0
    return 0
  }
  const toGo = Math.max(params.holdEpochs, params.reachEpoch - sim.epoch)
  const worldM2 = domainArea(sim.domain) * sim.domain.metresPerUnit * sim.domain.metresPerUnit
  const rate = (deficit * worldM2) / (toGo * params.nucleusLandM2)
  // The ceiling: a 40 % target's aim needs 13 nuclei an epoch on the
  // straight ramp, and at the nucleation's 12 the climb lagged, went on to
  // 1000 Ma and handed the plates young crust they recycle (measured
  // 2026-10-14: at the ceiling 51–133 of 200 epochs, 42–46 % at 1000 Ma
  // against an aim of 46.8). The 30 % aim's ramp is 9.05, so its ceiling
  // stays 12.
  const ramp = (target * worldM2) / (params.reachEpoch * params.nucleusLandM2)
  const ceiling = Math.max(maxPerEpoch, params.ceilingOverRamp * ramp)
  sim.nucleationCredit = Math.min(ceiling, sim.nucleationCredit + rate)
  return Math.floor(sim.nucleationCredit)
}

import { wrappedDelta } from '../core/toroidal'
import { SEA_LEVEL, slopeFromAngle } from '../elevation/elevationScale'
import { D8_OFFSETS, d8Neighbor, maybeYield, fillDepressionsAndRouteFlow, accumulateFlow } from './flowRouting'
import type { FlowRouting } from './flowRouting'

// The erosion processes themselves — stream-power fluvial incision and thermal
// (talus) mass wasting — plus the multi-round pass that alternates them.
//
// The drainage network they run on lives in flowRouting.ts. Splitting the two
// apart is what let hydrology.ts stop importing this module just to get at
// `FlowRouting`: routing is a property of a landscape, erosion is something you
// do to one.

export interface StreamPowerParams {
  iterations: number
  erodibilityK: number
  areaExponentM: number
  slopeExponentN: number
  timeStep: number
}

// erodibilityK re-verified for this grid via a headless dump script
// (createPlateSimulation -> 100 epochs -> the real elevation query at
// 2048x1024 -> runErosionPass -> diff against the pre-erosion field
// through the same redistribution+color path the renderer uses), not
// assumed. The sphere version's own value (0.00003) was calibrated
// against *that* grid's distance units — tiny (radians: a row's
// vertical step is π/height ≈ 0.003, similarly small longitude-scaled
// horizontal steps) — whereas a D8 step here is a plain pixel distance
// of 1 or √2, hundreds of times larger; since slope =
// Δelevation/distance, the unmodified sphere value against this grid's
// ~300x larger denominator measured out to only 13505/2097152 pixels
// (0.6%) shifting by even a single RGB unit after a 100-epoch run —
// erosion was running correctly end to end but numerically
// imperceptible. Scanning erodibilityK x{100, 300, 1000} against that
// same diff confirmed the ~300x theoretical scaling: 100x
// (erodibilityK=0.003, the value below) already reaches 279443/2097152
// pixels (13%) visibly changed with no sign of the stream-power loop's
// conditional-stability issues (elevations stayed bounded, no
// oscillation) — chosen as a deliberately less-aggressive starting point
// within the verified-safe range rather than 300x/1000x, since it's
// easier to push a visible-but-subtle effect further by eye than to walk
// back an overcorrected one.
export const DEFAULT_STREAM_POWER_PARAMS: StreamPowerParams = {
  iterations: 100,
  erodibilityK: 0.003,
  areaExponentM: 0.5,
  slopeExponentN: 1,
  timeStep: 1,
}

// Mutates `elevations` in place, starting from FlowRouting.filled.
// flowTarget/accumulation are held fixed for the whole loop — recomputing
// full priority-flood every iteration is not viable at this grid size;
// only slope (and therefore dh) changes iteration to iteration. Ocean
// cells are excluded via isLand (derived from *raw*, not filled,
// elevation) so a river mouth doesn't carve an unphysical trench where
// accumulation peaks.
//
// Iterates in popOrder (downstream-to-upstream topological order, not
// flat cell-index order) specifically so that when a cell eroded this
// iteration reads its downstream target's elevation, that target has
// already been updated *this same iteration* — a Gauss-Seidel-style
// update that propagates changes coherently outward from the ocean each
// pass, rather than mixing this-iteration and previous-iteration values
// depending on arbitrary index order.
//
// This is explicit forward-Euler, only conditionally stable — too large
// a timeStep/erodibilityK relative to grid spacing can oscillate into
// spiky, unrealistic terrain rather than smooth incision. The
// elevations[cell] = max(elevations[target], ...) clamp below is the
// first line of defense; if tuning timeStep down doesn't tame it, the
// known escape hatch is Braun & Willett (2013)'s semi-implicit scheme
// (unconditionally stable, more code) — not built here.
export async function runStreamPowerIterations(
  elevations: Float32Array,
  routing: FlowRouting,
  accumulation: Float32Array,
  isLand: Uint8Array,
  width: number,
  height: number,
  params: StreamPowerParams,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { flowTarget, popOrder, poppedCount } = routing
  const useSqrtForArea = params.areaExponentM === 0.5
  const slopeExponentIsOne = params.slopeExponentN === 1

  for (let iteration = 0; iteration < params.iterations; iteration++) {
    for (let k = 0; k < poppedCount; k++) {
      const cell = popOrder[k]
      if (!isLand[cell]) continue
      const target = flowTarget[cell]
      if (target === -1) continue

      const y = (cell / width) | 0
      const x = cell - y * width
      const ty = (target / width) | 0
      const tx = target - ty * width

      // Wrapped in both axes (unlike the sphere version, which only
      // needed to wrap x) — a D8 step off the top/bottom edge here wraps
      // through to the opposite edge rather than not existing.
      const dx = wrappedDelta(tx, x, width)
      const dy = wrappedDelta(ty, y, height)
      const distance = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy))

      const slope = Math.max(0, (elevations[cell] - elevations[target]) / distance)
      const area = useSqrtForArea ? Math.sqrt(accumulation[cell]) : Math.pow(accumulation[cell], params.areaExponentM)
      const slopeTerm = slopeExponentIsOne ? slope : Math.pow(slope, params.slopeExponentN)

      const dh = -params.erodibilityK * area * slopeTerm
      elevations[cell] = Math.max(elevations[target], elevations[cell] + dh * params.timeStep)
    }
    onProgress?.((iteration + 1) / params.iterations)
    await maybeYield()
  }
}

export interface ThermalErosionParams {
  iterations: number
  // Critical slope (dimensionless rise/run, matching runStreamPowerIterations'
  // own slope units) — below this, a land cell's own material is treated
  // as stable and untouched; at or above it, the excess above this angle
  // slides toward the lower neighbor. This is what makes thermal erosion
  // target steep terrain specifically rather than smoothing everything.
  talusSlope: number
  // Fraction of a downhill pair's excess-above-talusSlope that actually
  // moves each iteration — see DEFAULT_THERMAL_EROSION_PARAMS for how
  // this was picked.
  transportRate: number
}

// The critical slope is stated as a real ANGLE, not a bare number. It used to be
// 0.006, set at the 90th percentile of the then-measured slope distribution — a
// sound-looking calibration that turned out to describe the wrong thing, and the
// metre anchor (elevationScale.ts) is what made that visible. In real units 0.006
// is 0.40°, so the model was declaring anything steeper than a fifth of a degree
// to be unstable scree.
//
// A talus threshold is an ATTRACTOR, not a filter: whatever starts above it is
// ground down toward it, and with 50 iterations a round over 5 rounds the whole
// map converges on it. At 0.40° that planed the mountains. Measured over a full
// pass, mean local relief above 2 km: 693 m on the tectonic surface, 365 m after
// erosion — the stream-power step carved it up to 748 m and this step then took
// more than half of that back off. Which is exactly the "valleys everywhere on
// the plains, none in the mountains" the terrain was showing.
//
// So the question is what the steepest SUSTAINABLE slope is at this grid's scale,
// and the answer is not the angle of repose. Repose is ~33°, but at 7.8 km per
// cell no such slope can exist — averaged over 8 km, even the Himalayan front is
// only ~5.7°, and this world's tectonic surface measures p99 = 2.25° with an
// absolute maximum of 7.97°. 3° sits just above the p99.9 of 4.13°... deliberately
// below it: it fires on the steepest ~0.5% of downhill pairs, which are real range
// fronts and freshly-incised channel banks, and leaves ordinary mountain slope
// alone.
//
// Swept against the alternatives (mean local relief above 2 km after a full pass):
//   0.40° (old) 365 m, fires on 10.1% of pairs
//   1°          542 m,  3.7%
//   2°          731 m,  1.3%
//   3°          831 m,  0.5%   <- chosen
//   5°          901 m,  0.03%  — effectively disabled
//   8°+         915 m,  0%     — fully disabled, the no-thermal-erosion value
// Above ~5° the step stops doing anything at all, which would leave the
// valley-widening it exists for unimplemented; 3° keeps it working on the terrain
// it was meant for while erosion now ADDS relief in the mountains (831 m against
// the tectonic surface's 693 m) instead of removing it.
//
// transportRate = 0.3 and iterations = 50 are unchanged, but note they now apply
// to a far smaller set of pairs, which is the point.
const TALUS_ANGLE_DEGREES = 3

export const DEFAULT_THERMAL_EROSION_PARAMS: ThermalErosionParams = {
  iterations: 50,
  talusSlope: slopeFromAngle(TALUS_ANGLE_DEGREES),
  transportRate: 0.3,
}

// Gravity-driven mass-wasting (talus slide), independent of drainage
// area or flow direction entirely — the standard complement to stream-
// power erosion in landscape-evolution models, and the piece that
// actually answers "make erosion reach the mountains directly": stream-
// power only ever carves where a channel happens to route (an area-
// driven process a ridge crest structurally can't attract, since by
// definition almost nothing drains into one), while this acts on local
// slope alone, which is highest exactly at peaks and ridgelines
// regardless of any drainage network.
//
// Whole-map delta computed before any of it is applied (not updated
// cell-by-cell in place mid-pass) so processing order doesn't bias which
// direction material happens to slide first — each downhill pair is only
// evaluated once, from the higher cell's own neighbor scan (the lower
// cell's own scan sees a non-positive drop to that same neighbor and
// skips it), so mass moved off a cell and mass moved onto it never
// double-counts within one iteration.
export async function runThermalErosion(elevations: Float32Array, isLand: Uint8Array, width: number, height: number, params: ThermalErosionParams, onProgress?: (fraction: number) => void): Promise<void> {
  const cellCount = width * height
  const delta = new Float32Array(cellCount)

  for (let iteration = 0; iteration < params.iterations; iteration++) {
    delta.fill(0)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = y * width + x
        if (!isLand[cell]) continue
        const ownElevation = elevations[cell]
        for (const [dx, dy] of D8_OFFSETS) {
          const neighbor = d8Neighbor(x, y, dx, dy, width, height)
          const drop = ownElevation - elevations[neighbor]
          if (drop <= 0) continue
          const distance = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1
          const slope = drop / distance
          if (slope <= params.talusSlope) continue
          const excess = (slope - params.talusSlope) * distance
          // Split in half — the pair moves toward equalizing at the
          // critical angle rather than fully in one iteration, which is
          // what keeps this stable without needing a separate clamp the
          // way runStreamPowerIterations needs one against its target.
          const amount = excess * params.transportRate * 0.5
          delta[cell] -= amount
          delta[neighbor] += amount
        }
      }
    }
    for (let i = 0; i < cellCount; i++) elevations[i] += delta[i]
    onProgress?.((iteration + 1) / params.iterations)
    await maybeYield()
  }
}

export type ErosionPhase = 'flooding' | 'accumulating' | 'streamPower' | 'thermal'

export interface ErosionPassParams {
  // How many times to redo the whole flooding -> accumulation ->
  // fluvial -> thermal cycle, each round starting from the previous
  // round's own output. See runErosionPass's own comment for why this
  // — not just larger iteration counts within a single round — is what
  // actually gets valley-widening to happen in one call: a channel's
  // banks only get steep enough for thermal erosion to act on *after*
  // fluvial erosion has cut down, and the drainage network itself needs
  // to be re-derived from that new shape before the next fluvial
  // increment reads it, or it just keeps deepening the same channel
  // forever against a stale network instead of ever letting it widen or
  // shift.
  rounds: number
  // Coupled tectonic uplift, per round: each land cell is nudged back
  // toward its original tectonic height (the "envelope") by this fraction
  // of its own tectonic relief, before that round erodes. This is what
  // turns the pass from pure denudation into a forcing/response balance
  // (uplift feeding the mountains, erosion carving them) — the competing
  // terms are what let incised, near-equilibrium valley networks develop
  // instead of a fixed shape just rounding down (per Cordonnier et al.,
  // the model this whole system takes its cue from). 0 recovers the old
  // pure-denudation behavior exactly. See runErosionPass for why it's
  // capped at the envelope rather than an unbounded uplift term.
  upliftRate: number
  // Applied identically every round, not divided across them — e.g.
  // streamPower.iterations is iterations *per round*, so total fluvial
  // work scales with rounds * streamPower.iterations.
  streamPower: StreamPowerParams
  thermal: ThermalErosionParams
  // How many times to RE-DERIVE the drainage network (priority-flood + flow
  // accumulation) WITHIN a single round's fluvial phase, splitting streamPower.iterations
  // evenly across them. 1 = the original behaviour (network frozen for the whole 100-iter
  // phase). >1 lets rivers migrate and capture each other as the terrain incises — the
  // real realism gain, only affordable because Braun-Willett is O(n) and unconditionally
  // stable (the explicit scheme would risk oscillating between re-routings). Total cost
  // adds (rounds · (networkRefreshes − 1)) extra priority-floods, so keep it modest.
  networkRefreshes: number
}

// rounds=5 chosen to fold what manual testing showed needed ~5 repeated
// button clicks into a single one — see the module-level history in
// DEFAULT_STREAM_POWER_PARAMS/DEFAULT_THERMAL_EROSION_PARAMS' own
// comments for how the per-round values themselves were calibrated;
// this is a coarser, separately-tuned multiplier on top of those, not a
// re-derivation of them.
export const DEFAULT_EROSION_PASS_PARAMS: ErosionPassParams = {
  rounds: 5,
  // Per-round fraction of a cell's tectonic relief re-applied as uplift
  // (see ErosionPassParams.upliftRate). A moderate starting value —
  // enough that valleys stay incised against the uplift rather than being
  // refilled flat, without the uplift overpowering erosion — meant to be
  // retuned by eye alongside `rounds`, like the rest of this file's
  // visual-tuning constants. 0 would restore pure denudation.
  upliftRate: 0.15,
  streamPower: DEFAULT_STREAM_POWER_PARAMS,
  thermal: DEFAULT_THERMAL_EROSION_PARAMS,
  networkRefreshes: 1,
}

// The one function callers actually need — chains flow-routing through
// accumulation and the stream-power + thermal loops, repeated for
// params.rounds (see ErosionPassParams' own comment for why a single
// routing-then-erode pass alone doesn't produce real valley widening).
// Takes the raw elevation field directly (unlike the sphere version's
// runErosionPass, which sampled it from a PlateWorld/CrustState itself)
// since this map's tectonics worker already has that array on hand from
// its own last render (see SimulationRenderResult.rawElevations in
// elevationMapImage.ts) — no need for this module to know how to
// produce it.
//
// Uplift IS modeled here, but as a forcing derived from that same input
// field rather than a separately-supplied rate: `rawElevations` is the
// finished tectonic surface, so its own positive relief doubles as both
// the uplift pattern (where, and how strongly, to push crust up) and the
// envelope (how high — the tectonic height this pass won't exceed). Each
// round re-applies params.upliftRate of that relief before eroding (see
// the round loop), so mountains are held up while valleys incise into
// them — a coupled uplift/erosion balance, not pure denudation of a fixed
// shape. Capping at the envelope (rather than an unbounded Cordonnier-style
// uplift term that would set equilibrium height purely from the uplift/
// erodibility ratio) keeps the already-tuned tectonic heights as the
// ceiling and makes the pass unconditionally non-inflating: uplift can
// only ever resist erosion up to the original surface, never grow past it.
export async function runErosionPass(
  rawElevations: Float32Array,
  width: number,
  height: number,
  params: ErosionPassParams = DEFAULT_EROSION_PASS_PARAMS,
  onProgress?: (phase: ErosionPhase, fraction: number) => void,
  // Awaited after every round, given a *copy* of that round's own
  // elevations — lets a caller (plateSimulationWorker.ts) redraw the map
  // once per round instead of only once at the very end, without this
  // module needing to know anything about rendering. Awaited (not fired
  // and forgotten) deliberately, so a slow redraw can't overlap with the
  // next round's computation touching the same underlying arrays.
  onRoundComplete?: (elevations: Float32Array, round: number) => void | Promise<void>,
  // Checked at each round boundary — return true to stop early (the user hit stop). The
  // partial result (rounds done so far) is returned as-is, so the caller can keep it and
  // a later erode continues from there. Round 0 always completes so routing is valid.
  shouldCancel?: () => boolean,
): Promise<{ elevations: Float32Array; routing: FlowRouting; accumulation: Float32Array; preFillElevations: Float32Array }> {
  const cellCount = width * height
  // Copied rather than aliased — the round loop mutates `elevations` in
  // place, and rawElevations may be a caller-retained array (the tectonics
  // worker's own cached "last raw elevations") that shouldn't be silently
  // reshaped as a side effect of eroding it once. rawElevations is still
  // read directly as the uplift envelope, so it must stay intact.
  let elevations = rawElevations.slice()
  let routing: FlowRouting | undefined
  let accumulation: Float32Array | undefined
  // The last round's elevations *before* its depression fill — i.e. the eroded
  // terrain with its closed basins still intact (the final `elevations` has them
  // filled for drainage, so no basins survive there). This is what a rivers/lakes
  // pass needs to place lakes: the filled terrain is basin-free by construction.
  let preFillElevations: Float32Array | undefined

  // Each phase's own onProgress reports 0->1 for *itself* — without
  // weighting, naively scaling every phase's fraction by 1/rounds would
  // have the overall progress climb to the round's ceiling and then drop
  // back down at every one of the 5 phase boundaries within that same
  // round, instead of climbing smoothly across the whole call. Weighted
  // by iteration count (a reasonable proxy for relative cost — the two
  // single-pass O(cells) steps that don't have their own iteration count
  // get small fixed shares instead), so a phase with more iterations
  // — and therefore more onProgress calls, i.e. more visible granularity
  // — also claims a proportionally bigger slice of the overall bar.
  const FLOODING_WEIGHT = 15
  const ACCUMULATING_WEIGHT = 5
  const phaseOrder: ErosionPhase[] = ['flooding', 'accumulating', 'streamPower', 'thermal']
  const phaseWeight: Record<ErosionPhase, number> = {
    flooding: FLOODING_WEIGHT,
    accumulating: ACCUMULATING_WEIGHT,
    streamPower: params.streamPower.iterations,
    thermal: params.thermal.iterations,
  }
  const roundWeightTotal = phaseOrder.reduce((sum, phase) => sum + phaseWeight[phase], 0)
  const phaseStartFraction: Record<ErosionPhase, number> = {} as Record<ErosionPhase, number>
  let cumulativeWeight = 0
  for (const phase of phaseOrder) {
    phaseStartFraction[phase] = cumulativeWeight / roundWeightTotal
    cumulativeWeight += phaseWeight[phase]
  }

  for (let round = 0; round < params.rounds; round++) {
    // Stop early if the user cancelled — but only after round 0, so `routing`/
    // `accumulation` are always set for the return.
    if (round > 0 && shouldCancel?.()) break
    const roundProgress = (phase: ErosionPhase, fraction: number): void => {
      const withinRound = phaseStartFraction[phase] + (fraction * phaseWeight[phase]) / roundWeightTotal
      onProgress?.(phase, (round + withinRound) / params.rounds)
    }

    // Coupled uplift: before this round erodes, push every land cell back
    // toward its tectonic height by params.upliftRate of that cell's own
    // tectonic relief, capped at the tectonic envelope (rawElevations) so
    // peaks are held up against erosion but never inflated past their
    // tuned height. This is the forcing term that competes with the
    // round's erosion below — see runErosionPass's and
    // ErosionPassParams.upliftRate's own comments. Runs before isLand so a
    // valley refilled back above sea level counts as land again this round.
    if (params.upliftRate > 0) {
      for (let i = 0; i < cellCount; i++) {
        const envelope = rawElevations[i]
        if (envelope <= SEA_LEVEL) continue
        const restored = elevations[i] + envelope * params.upliftRate
        elevations[i] = restored < envelope ? restored : envelope
      }
    }

    // Re-derived every round from that round's own starting elevations
    // (not fixed once from the very first raw field) — a cell fluvial
    // erosion pushes below sea level in an earlier round should stop
    // taking further land-only erosion in later ones, the same way it
    // already would if that round were a separate manual click.
    const isLand = new Uint8Array(cellCount)
    for (let i = 0; i < cellCount; i++) isLand[i] = elevations[i] > SEA_LEVEL ? 1 : 0

    routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL, (fraction) => roundProgress('flooding', fraction))

    roundProgress('accumulating', 0)
    accumulation = accumulateFlow(routing)
    roundProgress('accumulating', 1)
    await maybeYield()

    // Capture the last round's basins before the fill flattens them (for lakes).
    if (round === params.rounds - 1) preFillElevations = elevations.slice()

    // Fluvial phase, with the drainage network re-derived params.networkRefreshes times
    // across it (not frozen for the whole phase) — rivers can migrate/capture as they
    // incise. The first sub-pass reuses the network already routed above; each later one
    // re-runs priority-flood + accumulation on the partially-incised terrain (isLand is
    // held for the round, so only the drainage geometry updates). streamPower.iterations
    // is split evenly across the sub-passes so total fluvial work is unchanged.
    const refreshes = Math.max(1, params.networkRefreshes)
    const itersPerRefresh = Math.max(1, Math.round(params.streamPower.iterations / refreshes))
    const refreshParams: StreamPowerParams = { ...params.streamPower, iterations: itersPerRefresh }
    for (let r = 0; r < refreshes; r++) {
      if (r > 0) {
        routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL)
        accumulation = accumulateFlow(routing)
      }
      elevations = routing.filled.slice()
      await runStreamPowerIterations(elevations, routing, accumulation, isLand, width, height, refreshParams, (fraction) => roundProgress('streamPower', (r + fraction) / refreshes))
    }
    // Order matters only a little here (both passes reread whatever the
    // other just wrote next round, since routing gets rederived from
    // the combined result either way) — runs second so a talus slide's
    // own runoff isn't immediately re-carved by this same round's
    // stream-power step, which read accumulation computed before either
    // pass touched elevations.
    await runThermalErosion(elevations, isLand, width, height, params.thermal, (fraction) => roundProgress('thermal', fraction))

    await onRoundComplete?.(elevations.slice(), round)
  }

  return { elevations, routing: routing!, accumulation: accumulation!, preFillElevations: preFillElevations ?? elevations }
}

// Rivers/lakes seam (not implemented here): `routing.filled` differing
// from the raw sampled elevation at a cell already identifies lake
// bodies, and the point where routing.flowTarget first crosses back to a
// cell where filled==raw is that lake's outlet — exactly
// docs/vision.md Phase 4's "a lake should have at least an outlet".
// `accumulation` thresholded and traced along flowTarget is exactly what
// river polylines need. A future rivers/lakes pass can consume this
// module's exports directly with no recomputation, given the same
// FlowRouting/accumulation this file already produces.

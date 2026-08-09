import { wrappedDelta } from '../core/toroidal'
import { SURFACE_TUNING } from './surfaceTuneParams'
import { SEA_LEVEL, SHELF_BREAK, metersToElevation, slopeFromAngle } from '../elevation/elevationScale'
import { D8_OFFSETS, d8Neighbor, maybeYield, fillDepressionsAndRouteFlow, accumulateFlow, largestWaterComponent } from './flowRouting'
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
  // Transport-capacity coefficient. A river carries a sediment load up to
  // Kt·A·S (drainage area × slope); whatever exceeds that settles out. 0 skips
  // the deposition pass entirely and restores the original detachment-limited
  // model exactly — every excavated cubic metre deleted — so it is the off
  // switch too. See depositSediment for the law and for why it cannot dam a
  // valley.
  transportCapacityKt: number
  // Whether sediment may settle below the waterline (deltas) and above it (alluvial
  // aggradation). Separate switches because they were measured to be worth very
  // different things — see the notes on depositSediment — and because the
  // 2026-07-27 attempt bundled them and had to revert the working half along with
  // the broken one.
  depositBelowSeaLevel: boolean
  depositOnLand: boolean
  // Minimum drainage area (in cells) a river must have at its mouth before it may
  // build a delta at all. Without it every coastal trickle built one — 715 bodies on
  // a single map — which is both dull and wrong: small rivers do NOT build deltas,
  // because waves and longshore drift clear their sediment faster than it arrives. A
  // delta forms only where a river delivers more than the sea can carry off, which is
  // why Earth has a dozen worth naming and not one per estuary. Ignored when
  // depositBelowSeaLevel is false.
  deltaMinDrainageCells: number
}

// erodibilityK re-verified for this grid via a headless dump script
// (a world built straight from plate seeds -> 100 epochs -> the real elevation query at
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
  // Marine deposition (deltas) ON — shipped 2026-08-01 (see the worldgen
  // changelog); land deposition measured and NOT recommended, see
  // depositSediment's notes. An earlier stage had both off after the first
  // look at real maps: under the land-donor ceiling only ~27% of a body
  // emerged (physically correct — a prodelta is submarine — but on screen a
  // fringe averaging two cells per mouth); the sea-reference ceiling in
  // depositSediment is what fixed that and justified turning marine back on.
  // Kt=0.016 gives Danube-to-Nile bodies, Kt=0.004 roughly triples the
  // emerged area and reaches Ganges scale.
  transportCapacityKt: 0.016,
  depositBelowSeaLevel: true,
  depositOnLand: false,
  // Set from the map's OWN river sizes, not from Earth's. The first value here was
  // 8000 cells, reasoned from Earth's 100 000 km² delta-building rivers — but the
  // largest catchment on a measured map is 3405 cells, so the gate sat above the
  // maximum and no river ever qualified. At a quarter Earth with ~11% land the rivers
  // are simply small. 2000 leaves roughly fifteen mouths building deltas.
  deltaMinDrainageCells: 2000,
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
//
// (The doc block above belongs to runStreamPowerIterations, which follows
// depositSediment below — the helper is defined first because the loop calls it.)

// The graded freeboard depositSediment caps its deposits at. Was exported for the
// micro tile's delta-growth model, which was removed 2026-08-09 along with the rest
// of that prototype; nothing outside this file asks for it now.
function gradedSeaCap(tectonic: Float32Array, cell: number): number {
  const depth = SEA_LEVEL - tectonic[cell]
  const t = depth <= 0 ? 0 : depth >= SURFACE_TUNING.deltaFreeboardDepthRange ? 1 : depth / SURFACE_TUNING.deltaFreeboardDepthRange
  return SEA_LEVEL + SURFACE_TUNING.deltaFreeboardNear - (SURFACE_TUNING.deltaFreeboardNear - SURFACE_TUNING.deltaFreeboardFar) * t
}

function depositSediment(
  elevations: Float32Array,
  routing: FlowRouting,
  accumulation: Float32Array,
  isLand: Uint8Array,
  excavated: Float32Array,
  load: Float32Array,
  donorFloor: Float32Array,
  // The tectonic envelope (runErosionPass's rawElevations) — the ORIGINAL
  // bathymetry the graded freeboard keys on. Deliberately not the live
  // elevations: the gradient must hold still while the delta builds on top
  // of it, or each round would re-derive its own cap from the previous
  // round's deposit and the tilt would flatten itself out.
  tectonic: Float32Array,
  width: number,
  height: number,
  transportCapacityKt: number,
  depositBelowSeaLevel: boolean,
  depositOnLand: boolean,
  deltaMinDrainageCells: number,
): void {
  const { flowTarget, popOrder, poppedCount } = routing
  load.fill(0)
  donorFloor.fill(Infinity)

  for (let k = poppedCount - 1; k >= 0; k--) {
    const cell = popOrder[k]
    const target = flowTarget[cell]
    let flux = load[cell]
    // A headwater (donorFloor still Infinity) has no upstream supply to drop, and
    // must not re-deposit its own excavation onto itself — that would just undo the
    // incision in place. Own material joins the outgoing load below instead.
    // The ceiling, and the one place land and sea genuinely differ.
    //
    // On LAND it is the donor floor: never rise above the lowest cell draining into
    // you, so no deposit can close a basin (see above).
    //
    // BELOW the waterline that rule is wrong, and applying it there is what made the
    // first deltas look like silt fans instead of deltas. One cell seaward of a mouth
    // the donor is already sea floor, so the ceiling sits under water — and every cell
    // beyond it is capped by an ever-deeper predecessor. The deposit could only ever
    // be a seaward-thinning veneer; just 21% of it emerged, all of it hugging the old
    // shoreline. But there is no river to dam under water: the reference surface is
    // the sea. A real delta aggrades TO the waterline and then progrades seaward, so
    // that is the cap — plus the metre or two of freeboard a delta plain actually
    // stands at, without which the cells would sit exactly at SEA_LEVEL and still
    // count as ocean (every land test here is a sign test).
    //
    // A LAND donor still constrains even below the waterline, so a delta growing at a
    // low-lying coast cannot rise above the ground behind it and seal it off.
    const seaCap = gradedSeaCap(tectonic, cell)
    const donor = donorFloor[cell]
    const ceiling = isLand[cell]
      ? donor
      : donor > SEA_LEVEL && donor < seaCap ? donor : seaCap
    // Below the shelf break the load is written off rather than carried on. The
    // priority flood lays a flow network over the seafloor too, and the first
    // version followed it down into the abyss — where slope, and therefore
    // capacity, is zero everywhere, so material rained out along the whole path.
    // The result was 6 million km² of raised seabed with only 2% of it touching a
    // coastline: a blanket over the ocean floor, not deltas. A delta is a shelf
    // feature, so the shelf edge is where the accounting stops.
    const belowShelf = elevations[cell] < SHELF_BREAK
    if (belowShelf) {
      load[cell] = 0
      continue
    }
    // No outflow (a river mouth, or a closed basin's floor) means no gradient and so
    // no transport capacity at all: the whole remaining load settles there, which is
    // exactly how a delta builds.
    let slope = 0
    if (target !== -1) {
      const y = (cell / width) | 0
      const x = cell - y * width
      const ty = (target / width) | 0
      const tx = target - ty * width
      const dx = wrappedDelta(tx, x, width)
      const dy = wrappedDelta(ty, y, height)
      const distance = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy))
      slope = Math.max(0, (elevations[cell] - elevations[target]) / distance)
    }
    const allowed = isLand[cell] ? depositOnLand : depositBelowSeaLevel && accumulation[cell] >= deltaMinDrainageCells
    if (flux > 0 && allowed && ceiling < Infinity) {
      // The donor ceiling still applies, so a deposit is graded to the surface that
      // fed it rather than piling into a plug.
      const capacity = transportCapacityKt * accumulation[cell] * slope
      if (flux > capacity) {
        const surplus = flux - capacity
        // Marine deposits keep only (1 - SURFACE_TUNING.deltaSpreadFraction) of the surplus on
        // the flow-path cell — the rest settles onto the D8 ring below. Land
        // deposits are unchanged: the spread is a delta-lobe-shape fix, and
        // depositOnLand has its own unresolved problems (see the notes above).
        const centerShare = isLand[cell] ? surplus : surplus * (1 - SURFACE_TUNING.deltaSpreadFraction)
        let deposit = centerShare
        const room = ceiling - elevations[cell]
        if (deposit > room) deposit = room
        if (deposit > 0) {
          elevations[cell] += deposit
          flux -= deposit
        }
        if (!isLand[cell]) {
          // The lateral share, split evenly over the ring. A neighbour takes its
          // slice only up to its own graded ceiling and never below the shelf
          // break (same accounting cutoff as the flow path itself); whatever
          // doesn't fit stays in the flux and carries on downstream like any
          // other uncarried load, so mass is conserved either way.
          const y = (cell / width) | 0
          const x = cell - y * width
          const slice = (surplus * SURFACE_TUNING.deltaSpreadFraction) / D8_OFFSETS.length
          for (const [dx, dy] of D8_OFFSETS) {
            const neighbor = d8Neighbor(x, y, dx, dy, width, height)
            if (isLand[neighbor] || elevations[neighbor] < SHELF_BREAK) continue
            const neighborRoom = gradedSeaCap(tectonic, neighbor) - elevations[neighbor]
            const placed = slice < neighborRoom ? slice : neighborRoom
            if (placed <= 0) continue
            elevations[neighbor] += placed
            flux -= placed
          }
        }
      }
    }
    flux += excavated[cell]
    if (target !== -1) {
      load[target] += flux
      // Recorded with this cell's FINAL height, which is settled by now — the
      // reverse walk guarantees every donor is done before its target is reached.
      if (elevations[cell] < donorFloor[target]) donorFloor[target] = elevations[cell]
    }
  }
}

// Not zero. A dead-flat plain gives the priority flood nothing to route along, and the
// trunk rivers then wander on numerical noise instead of on terrain.
//
// 0.30, from 0.15 (2026-08-06, flatland river-spread work): with the plains
// micro-relief seed in computeElevation (see PLAIN_DETAIL_MAX there), letting
// plains take 30% incision is what connects the seeded texture into dendritic
// valley networks. Measured, one seed, plain cells only:
//
//                       junctions/1k   mean dist to stream   mtn roughness
//     0.15, no seed         139            13.7 px               84.2 m
//     0.15 + seed           174            10.4 px               84.2 m
//     0.30 + seed           198             9.6 px               86.0 m   <- this
//     0.30, no seed         160            13.0 px               86.0 m
//
// The old worry (plains incision fights flatness) stays bounded: plains mean
// roughness moved 27.2 -> 27.5 m.
export const EROSION_PLAIN_FACTOR = 0.3

// The thresholds are METRES on the tectonic envelope, so the same mask logic is
// valid at any grid resolution — which is why this used to be exported, for the
// micro tile. That went 2026-08-09; it is local again.
function buildErosionMask(tectonic: Float32Array, plainFactor = EROSION_PLAIN_FACTOR): Float32Array {
  const lo = metersToElevation(SURFACE_TUNING.erosionPlainTopM)
  const hi = metersToElevation(SURFACE_TUNING.erosionMountainFullM)
  const mask = new Float32Array(tectonic.length)
  for (let i = 0; i < tectonic.length; i++) {
    const e = tectonic[i]
    const t = e <= lo ? 0 : e >= hi ? 1 : (e - lo) / (hi - lo)
    mask[i] = plainFactor + (1 - plainFactor) * t
  }
  return mask
}

export async function runStreamPowerIterations(
  elevations: Float32Array,
  routing: FlowRouting,
  accumulation: Float32Array,
  isLand: Uint8Array,
  width: number,
  height: number,
  params: StreamPowerParams,
  erosionMask: Float32Array,
  // Tectonic envelope, for depositSediment's graded delta freeboard — see its
  // own `tectonic` parameter for why it must be the original field.
  tectonic: Float32Array,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { flowTarget, popOrder, poppedCount } = routing
  const useSqrtForArea = params.areaExponentM === 0.5
  const slopeExponentIsOne = params.slopeExponentN === 1
  // Allocated once for the whole call, not per iteration. Left null when deposition
  // is off so the original model costs exactly what it always did.
  const depositing = params.transportCapacityKt > 0
  const excavated = depositing ? new Float32Array(elevations.length) : null
  const load = depositing ? new Float32Array(elevations.length) : null
  const donorFloor = depositing ? new Float32Array(elevations.length) : null

  for (let iteration = 0; iteration < params.iterations; iteration++) {
    excavated?.fill(0)
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

      const dh = -params.erodibilityK * area * slopeTerm * erosionMask[cell]
      const before = elevations[cell]
      elevations[cell] = Math.max(elevations[target], before + dh * params.timeStep)
      // The REALISED drop, not -dh·dt: the clamp above often bites, and booking the
      // intended cut as sediment would invent material that was never removed.
      if (excavated) excavated[cell] = before - elevations[cell]
    }
    if (excavated && load && donorFloor) {
      depositSediment(elevations, routing, accumulation, isLand, excavated, load, donorFloor, tectonic, width, height, params.transportCapacityKt, params.depositBelowSeaLevel, params.depositOnLand, params.deltaMinDrainageCells)
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

export const DEFAULT_THERMAL_EROSION_PARAMS: ThermalErosionParams = {
  iterations: 50,
  talusSlope: slopeFromAngle(SURFACE_TUNING.talusAngleDegrees),
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
          // Ocean receivers are skipped ENTIRELY — neither side of the pair
          // moves (2026-08-06). Sliding talus into the sea unbounded built
          // "apron" land out of coastal cliffs, up to 772 m above sea level and
          // ~10× the area of all genuine deltas on a measured seed — nothing
          // like reality, where waves and turbidity currents export cliff scree
          // (real scree shores are tens of metres wide, deep sub-pixel at
          // 7.8 km/cell) and sea cliffs stay steep precisely because their toe
          // is kept clear. Skipping the pair (not just the deposit — removing
          // only the receiver's gain would let the donor grind itself down to
          // sea level) keeps coastal cliffs at their tectonic steepness and
          // matches the pipeline's deliberate "erosion deletes its material"
          // convention. Deltas are unaffected: they come from depositSediment's
          // capacity law, not from talus.
          if (!isLand[neighbor]) continue
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
  // The plains damping of the erosion mask (see buildErosionMask /
  // EROSION_PLAIN_FACTOR) — how much of full incision land below
  // SURFACE_TUNING.erosionPlainTopM receives. Optional so existing callers keep the
  // long-standing default; made a parameter (2026-08-06) for the flatland
  // river-spread work, which sweeps it against seeded plains micro-relief.
  plainFactor?: number
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
  plainFactor: EROSION_PLAIN_FACTOR,
}

// Every constant in these params is argued per 7.8 km cell, and several
// hide a cell size in their units — so running them unchanged on a finer
// grid quietly changes the physics. This is the rescaling, derived rather
// than guessed. `cellSizeRatio` is fineCellMetres / macroCellMetres (1/2 at
// a 2x refinement, 1/8 for a micro tile).
//
// Under refinement by 1/r, for the SAME physical terrain: a slope between
// neighbours scales by r (the same gradient over a shorter run is a smaller
// rise), and a drainage area counted in CELLS scales by 1/r².
//
//  • talusSlope — a real ANGLE converted through the cell size, so ×r
//    re-converts it for the finer cell. Not optional: leaving it declares
//    everything above a quarter of the old angle unstable and planes the
//    mountains flat, the exact failure the talus comment above documents.
//  • transportCapacityKt — capacity Kt·A·S scales by (1/r²)·r = 1/r, so
//    deposition would grow as the grid refines (deltas swallowing coasts);
//    ×r cancels it.
//  • deltaMinDrainageCells — an area gate counted in cells, so ÷r² keeps
//    "big enough river to build a delta" meaning the same physical
//    catchment.
//  • stream-power incision dh = K·Aᵐ·Sⁿ is SCALE-INVARIANT at m = 0.5,
//    n = 1, because Aᵐ ∝ 1/r cancels Sⁿ ∝ r. Nothing to do — but only
//    because of those exponents; if either is retuned this stops holding.
//  • iterations, rounds, upliftRate, plainFactor and the metre-denominated
//    thresholds are counts or physical heights, scale-free by construction.
export function scaleErosionParamsForCellSize(base: ErosionPassParams, cellSizeRatio: number): ErosionPassParams {
  return {
    ...base,
    thermal: { ...base.thermal, talusSlope: base.thermal.talusSlope * cellSizeRatio },
    streamPower: {
      ...base.streamPower,
      transportCapacityKt: base.streamPower.transportCapacityKt * cellSizeRatio,
      deltaMinDrainageCells: base.streamPower.deltaMinDrainageCells / (cellSizeRatio * cellSizeRatio),
    },
  }
}

// What the erosion panel's two sliders MEAN, in one place: `strength` scales
// the stream-power time step (more incision per step, same operation count —
// free), `networkRefreshes` sets how often the drainage network is re-derived
// within a round. Both travel in a save (`spec.erosion.erosionStrength` /
// `drainageRefresh`), so both the generator's own erode request and the
// worldmap's amplification bake have to apply them the same way — hence a
// shared function rather than the mapping living in whichever worker
// happened to need it first.
export function erosionParamsWithControls(base: ErosionPassParams, controls: { strength?: number; networkRefreshes?: number }): ErosionPassParams {
  const strength = controls.strength && controls.strength > 0 ? controls.strength : 1
  return {
    ...base,
    streamPower: { ...base.streamPower, timeStep: base.streamPower.timeStep * strength },
    networkRefreshes: controls.networkRefreshes && controls.networkRefreshes > 0 ? Math.floor(controls.networkRefreshes) : base.networkRefreshes,
  }
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
  // elevations — lets a caller (pipeline/runtime.ts) redraw the map
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
  // Built once from the tectonic envelope — see buildErosionMask for why the zoning
  // keys on that rather than on the terrain as it erodes.
  const erosionMask = buildErosionMask(rawElevations, params.plainFactor)
  // Enclosed water (sub-sea-level cells NOT part of the world ocean — landlocked
  // seas, deep rift grabens). Since the priority flood seeds only the world
  // ocean (2026-08-06), these are depressions to it, and `elevations =
  // routing.filled.slice()` would BAKE their fill into the terrain: the basin
  // rises to its spill in round 1, the uplift term skips water-envelope cells,
  // and a 3000 m deep landlocked sea leaves the map as a plateau forever
  // (measured: the largest enclosed body, 4218 cells at −3122 m, vanished from
  // preFillElevations entirely). The fill is a ROUTING surface for these
  // cells, not terrain — after each refresh their pre-fill values (which still
  // carry any marine deposition) are restored.
  const oceanMask = largestWaterComponent(rawElevations, width, height, SEA_LEVEL)
  let enclosedWater: Uint8Array | null = null
  if (oceanMask) {
    enclosedWater = new Uint8Array(cellCount)
    let any = false
    for (let i = 0; i < cellCount; i++) {
      if (rawElevations[i] <= SEA_LEVEL && !oceanMask[i]) { enclosedWater[i] = 1; any = true }
    }
    if (!any) enclosedWater = null
  }
  let routing: FlowRouting | undefined
  let accumulation: Float32Array | undefined
  // The last round's elevations *before* its depression fill — i.e. the eroded
  // terrain with its closed basins still intact (the final `elevations` has them
  // filled for drainage, so no basins survive there). This is what a rivers/lakes
  // pass needs to place lakes: the filled terrain is basin-free by construction.
  let preFillElevations: Float32Array | undefined
  // Enclosed-water cells as a sparse index list + a scratch for their
  // pre-fill depths, built once on first use (see the round loop).
  let enclosedIndices: Int32Array | null = null
  let enclosedDepths: Float32Array | null = null

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

    // Dropped BEFORE the next one is built, not after: the flood allocates a
    // full routing (filled + popOrder + flowTarget + the MFD edges) while the
    // variable still references the previous one, so without this the peak
    // holds two complete networks at once — the single largest avoidable
    // allocation in the pass, and the previous round's routing is dead by
    // here in any case (its `filled` was already copied into `elevations`).
    routing = undefined
    accumulation = undefined
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
        routing = undefined // see the same release at the top of the round
        accumulation = undefined
        routing = await fillDepressionsAndRouteFlow(elevations, width, height, SEA_LEVEL)
        accumulation = accumulateFlow(routing)
      }
      // Adopt the filled surface IN PLACE rather than `elevations =
      // routing.filled.slice()`: that allocated a fresh full-size array on
      // every refresh of every round, and briefly held three of them at once
      // (the old elevations, the new copy, and routing.filled). Enclosed
      // seas keep their real bathymetry — see enclosedWater above — so their
      // pre-fill values are stashed sparsely first, which is a few thousand
      // numbers rather than another full raster.
      if (enclosedWater) {
        if (enclosedIndices === null) {
          const indices: number[] = []
          for (let i = 0; i < cellCount; i++) if (enclosedWater[i]) indices.push(i)
          enclosedIndices = Int32Array.from(indices)
          enclosedDepths = new Float32Array(enclosedIndices.length)
        }
        for (let k = 0; k < enclosedIndices.length; k++) enclosedDepths![k] = elevations[enclosedIndices[k]]
        elevations.set(routing.filled)
        for (let k = 0; k < enclosedIndices.length; k++) elevations[enclosedIndices[k]] = enclosedDepths![k]
      } else {
        elevations.set(routing.filled)
      }
      await runStreamPowerIterations(elevations, routing, accumulation, isLand, width, height, refreshParams, erosionMask, rawElevations, (fraction) => roundProgress('streamPower', (r + fraction) / refreshes))
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

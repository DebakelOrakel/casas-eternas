import { SEA_LEVEL, SHELF_BREAK, metersToElevation } from '../elevation/elevationScale'

// Algorithm tuning grouped into one object so it can be hashed — see the module
// contract in client/src/worldgen/CLAUDE.md.
//
// Out of scope for this pass: the DEFAULT_*_PARAMS objects in erosion.ts. They are
// function ARGUMENTS with defaults, not module constants —
// callers already pass them explicitly and the amplification bake overrides three of
// them per call. They are also nested three deep and carry two booleans, so they do not
// fit a Record<string, number> without being flattened at the hash, not here.
//
// Also out: EROSION_PLAIN_FACTOR and CHANNEL_SLOPE_EXPONENT (exported =
// contract), RIVER_MIN/MAX_WIDTH (drawn width, presentation), EPSILON_FLOOD_STEP (a
// numerical epsilon), and AMPLIFY_CONSTANTS, which already exists as its own hashed set
// and MIRRORS amplify.ts's constants instead of owning them — the drift that let three
// values fall out of the artifact key. Turning that around is its own step.

export const SURFACE_TUNING = {
  // --- from erosion.ts ---
  // Routes the material the erosion pass just excavated downstream and lets rivers
  // drop part of it again, so lowlands aggrade instead of being incised forever.
  // Without this the model deletes every cubic metre it cuts — `dh` in the loop below
  // is always negative and nothing ever receives it — which is why the map is valleys
  // all the way down with no plains, and why river mouths are drowned estuaries rather
  // than deltas (drainage area, and therefore incision, peaks exactly where a delta
  // should build). runThermalErosion already conserves its material; this pass was the
  // only sink in the model.
  //
  // Walks popOrder in REVERSE — the order in which every cell is visited only after
  // all of its own upstream contributors (the same property accumulateFlow relies on),
  // so `load[cell]` is complete before the cell spends it.
  //
  // The one invariant that matters, and the one the 2026-07-27 attempt was missing on
  // land: **a cell may never be raised above the lowest cell that drains into it.**
  // That is what `donorFloor` tracks. Aggradation on land was unbounded upward last
  // time, so a deposit at a valley mouth grew taller than the valley behind it and
  // dammed it — which is where the huge lakes, the coast-only rivers and the softened
  // mountains all came from (a lake cell carries no river, and material cut off a peak
  // landed back in the valley a few cells down). With the ceiling in place a deposit
  // cannot close a basin by construction: every cell stays at or below each of its
  // donors, so the downstream profile keeps decreasing and no depression can form.
  //
  // The law is transport capacity, NOT the Davy-Lague `G·load/area` form that was
  // tried first. That form has no slope dependence, so it drops material where the
  // drainage area is small — i.e. high in the catchment. Measured over G = 0.25…5 it
  // softened mountain relief 10% while flattening lowlands only 6%: it dissolved the
  // mountains instead of building the plains, and turning it up made the ratio worse,
  // which is the signature of a wrong shape rather than a wrong constant.
  //
  // Capacity ∝ drainage area × slope is the classic transport-limited form and puts
  // the deposition where it belongs: wherever a river loses gradient. That is the
  // mountain front, the lowland plain, and — since slope goes to zero there — the
  // river mouth, so the same equation that builds plains also builds deltas once
  // deposition below the waterline is allowed.
  //
  // Land and sea are separate switches, and measurement says they are worth very
  // different things:
  //
  //   depositOnLand      MEASURED, NOT RECOMMENDED. Retains mass, but the flat-area
  //                      share moved +22% on one seed and −14% on another — an effect
  //                      that changes sign between seeds is not an effect — while
  //                      costing 15-18% of mountain relief and doubling to septupling
  //                      lake area.
  //
  // A bedrock/alluvial regime gate was tried on top of that (2026-08-01) and REMOVED:
  // deposit only where the along-flow slope is under 1°, so that steep channels carry
  // their load through and mountains cannot be softened. It did neither. Mountain
  // relief still fell to 890 m against 882 m ungated and 1009 m with deposition off —
  // nothing changed — for two reasons. Channel slope is not relief: a high valley has
  // a gentle long profile, so its floor passes the gate and gets filled, which is
  // exactly what closes the peak-to-floor gap the metric measures. And the gate was
  // already satisfied, because the capacity law only deposits where slope is low. A
  // gate that would really protect mountains has to be on ELEVATION.
  //
  // Why the plains do not appear is still open. "Below this grid's resolution" is the
  // obvious guess and it is weaker than it sounds: the Mississippi and Amazon
  // floodplains are 50-125 km wide, i.e. 6-16 cells here, so the big ones ought to
  // resolve. The better suspect is that there is no accommodation space to begin with
  // — the raw terrain is smooth metaball rafts, erosion cuts valleys into it and
  // deposition fills them back, netting out at the smooth original.
  //   depositBelowSeaLevel  WORKS. Delta bodies at Kt=0.016 come out at 12 800 /
  //                      12 300 / 9 800 km² (Danube ~4 000, Nile ~22 000, Mississippi
  //                      ~28 000), ~760 of them, with ~73 000 km² of new delta plain.
  //                      Lake area and mountain relief are unchanged (1.82→1.81%,
  //                      1009→1008 m).
  //
  // Note that marine deposition is NOT confined to the sea in its effects: it lifts
  // base level at the mouths, and runErosionPass re-derives routing and the land mask
  // from the current terrain every round, so land elevations do shift (57% of land
  // cells, up to ~280 m). That feedback is physically right — a prograding delta
  // really does raise base level — but "land stays bit-identical" is false, and was
  // asserted before it was checked.
  //
  // The two switches stay separate because the 2026-07-27 attempt shipped both halves
  // together and had to revert the working half along with the broken one.
  // Real delta plains stand a metre or two above the sea, not level with it — and here
  // that is also load-bearing: every land test in the pipeline is `elevation > SEA_LEVEL`,
  // so a deposit capped exactly at sea level would still be ocean everywhere.
  //
  // The freeboard is GRADED seaward (2026-08-06), not uniform: a delta plain caps
  // near NEAR where the original seabed was shallow (the old shoreline) and decays
  // to FAR where it approached the shelf break. The old single 2 m cap put every
  // delta cell at literally identical elevation — a dead-flat plate with one hard
  // rim. Keying the gradient on the ORIGINAL (tectonic) bathymetry needs no notion
  // of "distance to the mouth": seaward simply is where the water was deeper, and
  // the tectonic field holds still while the delta builds. Honest caveat: a few
  // metres of tilt across a fan is invisible in the colour ramp (0..200 m is one
  // sand→green blend) and in the 45× hillshade — this is for the 3D preview, the
  // detail texture's headroom, and downstream hydrology. What the EYE gets from
  // this change is the lobe-shape fix below (DELTA_SPREAD_FRACTION), which ships
  // together with it.
  deltaFreeboardNear: metersToElevation(4),

  deltaFreeboardFar: metersToElevation(0.5),

  // Depth range the freeboard grades across: original seabed at 0 depth → NEAR,
  // at shelf-break depth (the deepest a delta may build, see belowShelf) → FAR.
  deltaFreeboardDepthRange: SEA_LEVEL - SHELF_BREAK,

  // Fraction of each marine surplus that settles onto the surrounding D8 ring
  // instead of the flow-path cell itself. Pure D8 deposition builds a delta one
  // cell-wide arm at a time — the fans came out as ragged staircase lobes ("noch
  // ein wenig roh", 2026-08-06). Physically, a sediment plume leaving a mouth
  // spreads laterally as it decelerates; splitting each deposit 60/40 between the
  // path cell and its underwater neighbours (each capped by its own graded
  // ceiling, anything that doesn't fit carried on downstream like any other
  // uncarried load) rounds the lobes without changing how much material a river
  // delivers. Raise for wider, gentler fans; 0 restores pure-D8 deposition.
  deltaSpreadFraction: 0.4,

  // Fluvial incision is scaled by the cell's TECTONIC height, not its current one.
  //
  // The reason is a coupling that no single global setting can break: the same incision
  // that makes mountains striking — deep valleys between peaks — also furrows the
  // lowlands. Measured over the erosion-strength slider, mountain relief and flat-area
  // share move together in opposite directions every time (strength 4: relief 1895 m but
  // only 4.7% of land flat; strength 1: relief 1009 m and 9.6% flat). Raising the slope
  // exponent instead was tried and does the same thing more expensively.
  //
  // So the zoning is deliberate and frankly unphysical: erode the highlands hard, leave
  // the plains nearly alone, and the two stop fighting. Rivers are unaffected either way
  // — the network is drawn from flow accumulation, not from incision — so a trunk stream
  // still crosses a plain it is no longer allowed to carve.
  //
  // Keyed on the TECTONIC field so the zones hold still. Using the live elevation would
  // let a valley cut into a mountain drop below the threshold and freeze mid-incision,
  // and a plain that happened to sit high would erode forever.
  // at or below this: plains, essentially left alone,
  erosionPlainTopM: 600,

  // at or above this: full incision,
  erosionMountainFullM: 1500,

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
  talusAngleDegrees: 3,

  // --- from hydrology.ts ---
  // A modest per-cell runoff floor so even a bone-dry landmass still develops
  // channels from drainage area alone (precip only MODULATES density, it doesn't
  // gate rivers entirely) — the user disliked rivers vanishing outside the wettest
  // regions. Wet cells sit far above this, so precip still dominates where it's high.
  runoffFloor: 200,

  // Lake water depth per full-res cell (0 = dry). Climate-aware / endorheic:
  // priority-flood `filled` marks every depression's cells (filled > raw) and its
  // spill level; for each basin (a connected flooded region) we weigh the water
  // arriving (max discharge through it) against evaporation from the lake surface
  // (evaporationPotential × area). If inflow ≥ evaporation at the spill-full area,
  // the basin brims to its spill and overflows (an open lake feeding the river
  // below); otherwise it's ENDORHEIC — the level settles where inflow balances
  // evaporation, a shrunken closed lake (a hot dry basin becomes a small salt lake,
  // or nothing). Depth = level − raw for cells under the level. 4-connected,
  // toroidally wrapped. See docs/decisions/climate-biomes.md.
  // Basins shallower than this (spill level minus the basin's lowest point)
  // are not lakes — they are terrain texture. Became necessary 2026-08-06 when
  // computeElevation gained the plains micro-relief seed (PLAIN_DETAIL_MAX,
  // ±10 m typical): every noise dimple with any inflow classified as a lake and
  // the plains drowned in puddles. Re-swept under the overflow-only rule
  // (one seed; "plains" = bodies whose basin sits below 600 m tectonic):
  //
  //     gate    lakes   on plains
  //      0 m     816       740      <- every dimple on a river overflows
  //      4 m     199       139
  //      8 m      88        35      <- chosen: plains keep a visible lake
  //     12 m      71        22         population without the puddle flood
  //     15 m      66        20      <- at 15 (under the older endorheic
  //                                    model) the plains read as lakeless
  //
  // The 135k km² shallow mega-pan (a genuine Lake-Chad-style feature, present
  // without the noise too) survives every gate under the overflow rule — the
  // spill-brimming level keeps it a throughflow lake. Genuine deep lakes sit
  // far above the gate either way (rift grabens are depth-capped in the
  // hundreds of metres).
  minLakeBasinReliefM: 8,

  // Evaporites concentrate where the last water stood — the salt flat is a BAND
  // above the waterline, not the whole exposed floor (a fully-dry 2800 m deep
  // basin is a salt PAN at the bottom and hot desert rock on the slopes, not a
  // kilometres-tall salt wall). Thickness is a starting value for the usual
  // by-eye pass.
  saltBandM: 75,

  // Peak precipitation bonus (mm/yr) a cell gets right at a full-strength river/lake
  // — enough to lift a hot desert (P<250) into savanna/forest (the Nile effect).
  maxRiparianMm: 900,

  // How far the moisture bleeds into neighbouring coarse cells, and its per-step
  // falloff. Coarse cells are large (~60 km), so 1 step already reads as a green
  // valley band without washing out the whole continent.
  riparianSpread: 1,

  riparianDecay: 0.45,

  // --- the river-density curve's endpoints ---------------------------------
  //
  // These were FUNCTION-LOCAL inside `densityToCriticalArea`, which put them
  // beyond the reach of any grouping and, more to the point, beyond the artifact
  // key: the bake re-extracts rivers on the amplified field, so changing either
  // one changes the baked network under an unchanged key.
  channelAreaMax: 4000,
  // Floored well above 1 cell: on smooth (un-eroded) terrain a too-low threshold
  // draws a channel from nearly every cell, and D8 picks the same steepest
  // direction for whole neighbourhoods → a mess of parallel lines. Keeping even
  // max density at a few hundred cells of support suppresses that noise.
  channelAreaMin: 150,
} as const

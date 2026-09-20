import { metersToElevation } from './elevationScale'

// Algorithm tuning grouped into one object so it can be hashed — see the module
// contract in client/src/generator/CLAUDE.md.
//
// elevationScale.ts is NOT folded in. Its reference heights ARE tuned (grid-searched
// against Earth targets), but the file's whole job is to be the single place that says
// what a height MEANS, and its values are a cross-module contract read by fifteen files.
// Splitting a definition module to chase a hash it has no consumer for is the wrong
// trade today; it wants its own decision.
//
// Also out: the EXPORTED constants of this module (RIDGE_MEAN, FINE_DETAIL_SEED_SALT,
// LAND_TARGET_MIN/MAX). An export is a contract with other modules; this pass groups
// what a module keeps to itself. LAND_TARGET_MIN/MAX are a slider's endpoints anyway —
// input schema, not tuning.

export const ELEVATION_TUNING = {
  // --- from elevationField.ts ---
  // A terrain feature is no longer an isotropic blob but an oriented ridge
  // segment: its influence reaches far ALONG its own boundary tangent
  // (feature.tangentX/Y) and only a short distance ACROSS it. Two effects
  // fall out of that anisotropy, both deliberate:
  //  - Along-axis reach is generous (well past terrainFeatures' MERGE_RADIUS
  //    of 40) so consecutive features laid down along one boundary overlap
  //    heavily end-to-end and blend into a single *continuous linear range*,
  //    instead of the row of distinct rounded blobs an isotropic radial
  //    falloff produced (the previous model had to keep widening a single
  //    radius to fight exactly that, and still read as domes, not ridges).
  //  - Across-axis reach is much shorter, so the range has a real ridge
  //    cross-section with a crest, not a broad dome.
  // A trench (the paired subduction depression) is narrower still across its
  // axis than a range — deep and tight, the way a real trench reads against
  // its broad companion arc.
  // Perp radii calibrated to physical scale: at a ~1/4-Earth-area world
  // (~127.5 Mkm² over 2048x1024) one pixel is ~7.8 km, so an 85px half-width
  // range spanned ~1300 km — 2-4x wider than real orogens (Andes ~500-700 km,
  // Himalaya ~250-400 km) and read as broad massifs swallowing continent
  // interiors rather than narrow cordilleras. 28px ≈ 440 km full width lands
  // in the realistic band and, as a bonus, sharpens the crest (steeper across-
  // ridge falloff). Trench perp scaled down with it, keeping roughly its old
  // proportion to the range.
  //
  // Along radii must stay in proportion to the (now much smaller) perp radii,
  // NOT at their original large values: a feature is an oriented ellipse, and
  // a very long-but-thin one (the old 220x28 ≈ 8:1) sits tangent to the plate
  // boundary and extends its thin needle ~1700 km along that tangent into open
  // ocean, where — no fat neighbor left to blend with at that distance — each
  // needle shows as an isolated ray. On a curved boundary the adjacent needles
  // splay apart, producing a radial starburst fanning out of each plate. A
  // range still reads as long because it's a *chain* of these features along
  // the boundary (spaced MERGE_RADIUS=40 apart), not one long feature — so the
  // along radius only needs to be a few times that spacing for the chain to
  // blend continuously, keeping the per-feature ellipse a modest ~3-4:1 rather
  // than a needle.
  // Each terrain feature is rendered as a finite line SEGMENT (a short stretch
  // of its boundary curve) rather than an oriented ellipse: a "capsule" —
  // distance to the segment, then a perpendicular profile. This is the
  // boundary-curve (distance-to-polyline) model: consecutive features along one
  // boundary are short segments that abut/overlap into a continuous ridge, and
  // — crucially — a segment is FINITE, so beyond its ends it falls off as a
  // rounded cap instead of a long soft gradient. That's what lets ranges be
  // realistically narrow (perp ~30px ≈ 470 km) without the radial "starburst"
  // the old anisotropic ellipse produced: the ellipse's long soft along-axis
  // overshot past every boundary curve/Voronoi vertex as a thin needle into
  // open ocean (root cause confirmed via a headless render sweep, 2026-07-24 —
  // it survived removing trenches, keeping only active features, and aggressive
  // pruning, so it was the shape, not clutter); a capsule can't overshoot past
  // its segment ends. Half-length ~ the feature spacing (terrainFeatures'
  // MERGE_RADIUS) so consecutive segments chain continuously.
  rangePerpRadius: 30,

  rangeSegmentHalfLength: 35,

  trenchPerpRadius: 15,

  trenchSegmentHalfLength: 25,

  // Converts accumulated crustal thickness into actual elevation — a
  // simple isostasy-style relation (thicker/more compressed crust sits
  // higher), not a real buoyancy simulation. Dropped from 0.06 to 0.02
  // early on because most boundaries were reaching the elevation clamp
  // within under a minute — but that was fixed independently since (decay
  // now caps thickness at a real equilibrium instead of growing without
  // bound, and baseline blending means a tall peak reads as a smooth rise
  // rather than a stark discontinuity), so there's headroom to push this
  // back up a bit without reintroducing that problem.
  //
  // Deliberately UNCHANGED by the metre recalibration, against the initial
  // expectation that dropping the land baseline from 0.35 to 0.04 would need this
  // roughly tripled to compensate. Measured instead (50-epoch run, 2440 features):
  // land median 360 m, p90 1681 m — against Earth's ~300 m and ~1600 m. It was
  // already right; what was wrong was the baseline underneath it eating most of
  // the range. Lowering it to 0.030 or 0.027 was tried and only made the
  // distribution worse (p90 1451 / 1314) without removing the clamp saturation,
  // because that saturation isn't the mountain distribution at all — it's
  // plateSimulation's FLOOD_BASALT_DEPOSIT of 50, which at any scale in this range
  // is a single deposit worth more than the entire ±1 clamp. Pre-existing, and
  // unaffected either way by the recalibration.
  //
  // Note this is the ONE knob between crustal thickness and height, which is why
  // none of the deposition/decay constants in plateSimulation.ts, nor the boundary
  // rates in boundaryClassification.ts, needed touching: they are all in thickness
  // units and keep their proportions to each other automatically.
  thicknessToElevationScale: 0.035,

  // The ISOSTATIC SOFT KNEE on the uplift deck (docs/decisions/uplift-soft-knee.md).
  // Feature thickness is unbounded (long collisions stack it; measured on seed
  // alpha: p99 ≈ 9600 m of implied uplift, max ≈ 10000), and the capsule
  // averaging in computeElevation turns that fat tail into DECKS — 12.1% of
  // land above 6000 m by uplift alone (Earth: ~0.001%), with 800-1400 m deep
  // closed hollows on top holding brim-full ice-cold lakes. Above the knee the
  // deck saturates exponentially toward knee+span, linear below, C1 at the
  // knee: u' = knee + span·(1 − e^−(u−knee)/span). The ridged detail
  // deliberately keeps riding the RAW uplift (see computeElevation), so crests
  // still sharpen where the crust is thickest. Measured at 3000/3000: land
  // >6000 m 2.50% → 0.00%, >4500 m 4.62% → 0.56%, >2000 m 21.4% → 15.7%, land
  // share 11.4% → 11.0%, highest peak 9000 (the clamp) → 5695 m. Rare true
  // 7-8 km summits are NOT reachable from this knob — deck and peak overlap in
  // uplift VALUE, they only separate in the thickness sim itself; that
  // follow-up is recorded in the decision doc.
  upliftSoftKnee: metersToElevation(3000),
  upliftSoftSpan: metersToElevation(3000),

  // How strongly ridged-multifractal detail (ridgedNoise.ts) modulates
  // uplifted terrain, as a fraction of the local uplift itself — the detail
  // added at a point is (ridge - RIDGE_MEAN) * uplift * this. Scaling by the
  // local uplift is deliberate: flat plains and ocean (no uplift) stay
  // perfectly smooth, foothills get a little texture, and a high massif gets
  // proportionally rugged crests and valleys — mountain roughness reads as a
  // consequence of how much the crust was raised, not a uniform noise layer
  // bolted over everything. Tune by eye; higher = more dramatic ridging.
  ridgeRelativeStrength: 0.5,

  // Ocean depth from crustal age. Was RAFT_OCEANIC_BASELINE − 0.045·√age, the
  // textbook √age law — which is right for YOUNG crust and wrong in exactly the
  // way that mattered here: √age is unbounded, and oceanAge.ts ages crust by +1
  // every epoch forever. Starting from OCEAN_AGE_INIT = 40 that reached the −1
  // elevation clamp at age 149, i.e. epoch 109 of a run that typically goes 300
  // to 800. Past that point every ocean cell away from a spreading ridge was
  // pinned flat at the clamp: the age-depth law — the entire reason the age field
  // exists — stopped producing any basin shape at all, the hillshade had nothing
  // to shade, and the continent→ocean drop grew to its maximum possible size and
  // kept growing with runtime. Confirmed by direct computation, not inferred.
  //
  // The real plate-cooling model (GDH1 and friends) doesn't run away: √age only
  // holds for the first ~20 Ma of a plate's ~180 Ma life, after which subsidence
  // decays exponentially toward an asymptotic depth as the lithosphere reaches
  // thermal equilibrium with the mantle below it. Using that shape here means the
  // floor CANNOT reach the clamp no matter how long the sim runs — it's bounded by
  // construction rather than by a constant that has to be re-checked against the
  // longest run anyone might do.
  //
  // The shape used is GDH1 (Stein & Stein 1992), the standard two-branch fit to
  // real bathymetry: √age while the plate is young and cooling fast, switching at
  // 20 Ma to an exponential approach to the equilibrium depth. Taken as a
  // dimensionless 0..1 fraction of total subsidence, so the actual depths stay
  // ours — RIDGE_CREST and ABYSSAL_FLOOR set where the curve starts and ends, and
  // only its SHAPE comes from the literature.
  //
  // One epoch is read as one million years here, which is what lets GDH1's
  // published coefficients be used as-is; it's also roughly what oceanAge's
  // MAX_SEAFLOOR_AGE = 180 already implied.
  //
  // A single plain exponential was tried first and is the obvious cheaper thing to
  // write, but it misses badly exactly where ocean floor is most visible: it has a
  // finite slope at age 0 where the real curve has √age's near-vertical one, so
  // young crust subsides far too slowly — measured up to 490 m too shallow across
  // the 5-40 Ma band, i.e. across most of the floor around every spreading ridge.
  // The two branches meet at 20 Ma to within half a metre, so the seam is not
  // visible.
  gdh1YoungMaxAge: 20,

  gdh1YoungCoeff: 365 / (5651 - 2600),

  gdh1OldCoeff: 2473 / (5651 - 2600),

  gdh1OldDecay: 0.0278,

  // Stateless distance-field query, per the decided A3 model: elevation
  // anywhere is the (already blended) baseline plus a distance-weighted
  // blend of nearby terrain features' accumulated thickness (converted via
  // isostasy), not a value stored per point. A weighted AVERAGE (not sum)
  // of overlapping features' contribution — otherwise a cluster of
  // features along a long-lived range would stack without bound instead of
  // blending into one continuous ridge.
  //
  // Takes the already-warped sample point (wx, wy) and the precomputed ridged-
  // multifractal value there, rather than (x, y) + warpSeed: both are pure
  // functions of position that the render worker precomputes once per world and
  // caches (see warpedSamplePoint / elevationRenderWorker.ts), so this per-epoch
  // hot loop does no warp or ridge noise math at all — only the dynamic feature
  // blend and baseline, which are all that actually change epoch to epoch.
  // Sub-range-scale relief for the LOWLANDS, the counterpart of the ridged
  // multifractal (which is gated on uplift, so plains never see it): the raw
  // fineDetailNoise sample for this point (see FINE_DETAIL_SEED_SALT), scaled
  // here by min(20 m, half the cell's own height) — land only, fading to zero
  // at the coast so no shoreline speckle. Added 2026-08-06 for flatland river
  // spread: without ANY plains texture, lowland drainage follows the priority
  // flood's epsilon ramp into a few straight trunks. Measured (one seed, 2x2
  // sweep vs plainFactor): this seed alone raises plain channel junctions
  // 139->174 per 1k and cuts mean distance-to-stream 13.7->10.4 px; with
  // plainFactor 0.3 it reaches 198 and 9.6 px, at +2% mountain roughness.
  // Passed in precomputed (like ridgeValue) so the render pool can cache it
  // per world; default 0 keeps old callers' fields bit-identical.
  // 20 m, in elevation units,
  plainDetailMax: metersToElevation(20),

  // Redistribution exponent (a standard procedural-terrain technique — e.g.
  // Sebastian Lague's terrain series applies the same curve to raw Perlin
  // output): raises normalized land elevation to a power > 1, which pulls
  // low/mid values down much further than it pulls already-high ones —
  // most land reads as noticeably flatter while genuinely strong uplift
  // still produces a sharp, prominent peak, without changing anything
  // about how uplift itself accumulates.
  //
  // Crucially, "normalized" here means dividing by *this map's own* actual
  // highest land elevation, not the theoretical ±1 clamp — the tectonic
  // model rarely drives raw elevation anywhere near that clamp in
  // practice (peaks in a typical run top out around 0.5-0.7), so applying
  // the power curve against the fixed 0..1 domain was tried first and
  // crushed every peak along with the plains: even the map's actual
  // highest point was still a small fraction of "1", so it got squashed
  // down like everything else, and nothing ever reached the color ramp's
  // snow-cap band. Normalizing against the map's own achieved max first
  // (then rescaling back afterward) means the highest point always ends
  // up back near its own original height — genuinely prominent — while
  // everything below it is compressed in proportion to how far below the
  // peak it started.
  //
  // "This map's own" is now PER CONTINENT, not the whole world (2026-08-06
  // mountain-realism review). A single global maximum coupled every range on
  // the planet through one pixel: an exceptional summit anywhere — one lucky
  // long-lived collision, one tall hotspot chain — set the curve for every
  // OTHER continent's mountains too, flattening their relative prominence for
  // a reason that has nothing to do with their own geology. Grouping by
  // raftField.computeOwnerField's "which raft dominates this point" query
  // gives each continent its own achieved peak. Land that belongs to no raft
  // at all — a volcanic island or ridge/arc/hotspot feature standing on open
  // oceanic crust, which the raft model never claims as continental — forms
  // its own shared group (owner id -1) rather than falling back to the world
  // max, so an isolated seamount chain isn't coupled to a continent's
  // mountains either.
  //
  // Ocean (elevation <= 0) is left untouched. Raise
  // MOUNTAIN_REDISTRIBUTION_GAMMA for flatter plains with more dramatic
  // peaks, lower it (toward 1) for today's more continuous, gradual slope.
  mountainRedistributionGamma: 2.5,

  // --- from hypsometry.ts ---
  // Peak-to-trough swing around LAND_BASE. At ±320 m the interior spans roughly 40 m to
  // 680 m, which keeps nearly all of it inside the 0-600 m band the erosion zoning
  // treats as plains while still giving the coastline somewhere to move to. Larger, and
  // interior ground starts dropping below sea level as inland seas — interesting, but a
  // change to how much land a world has, so it is not a knob to turn by accident.
  hypsometryRangeM: 320,

  // Where the relief fades in, in margin-parameter units. The shelf and the continental
  // slope (t below ~0.45) must stay exactly as tuned — the shelf profile is what fixed
  // the 99 m/km coastline gradient — so this starts inland of the shelf break and is at
  // full strength by the coastal plain. Fading it in rather than switching it on keeps
  // the join free of a crease, the same reason marginProfile smoothsteps its segments.
  hypsometryTIn: 0.5,

  hypsometryTFull: 0.85,

  // --- from domainWarp.ts ---
  // How far, in pixels, a query point can be displaced — deliberately
  // modest relative to FEATURE_FALLOFF_RADIUS (160) and
  // BASELINE_BLEND_RADIUS (220) in elevationField.ts: this should read as
  // "coastlines and ridgelines are a little ragged," not "the tectonic
  // shapes are dissolved into noise." Tune by eye — this is a visual call,
  // not something with a formula to derive it from.
  warpAmplitudePx: 26,

  // axisSalt values for the two offset axes — arbitrary distinct constants,
  // just need to decorrelate the x-offset and y-offset noise fields from
  // each other (using the same salt for both would displace every point
  // along the line y=x instead of in an independent 2D direction).
  axisSaltX: 0,

  axisSaltY: 97,

  // --- from landTarget.ts ---
  // The search range for the offset, which is wider than the old slider's ±1350 m and
  // deliberately lopsided. Downward (less water, more land) there is room to spare —
  // ABYSSAL_FLOOR sits at −0.633 against the −1 clamp, some 3300 m of headroom. Upward
  // there is very little, because it is the land's own height that runs out: the
  // continental interior anchor is only 360 m, so a few hundred metres of extra water
  // already reaches it. The old symmetric range was sized against the wrong end.
  offsetSearchMinM: -3000,

  offsetSearchMaxM: 1350,

  // Coarse grid for the search. An eighth was tried first and is NOT good enough: at low
  // land fractions the coastline breaks into fragments that 62-km point sampling walks
  // straight past, so the search stopped at a measured 3% that was really 6.15%. A
  // quarter costs four times as much per step and tracks full resolution closely.
  solveDivisor: 4,
} as const

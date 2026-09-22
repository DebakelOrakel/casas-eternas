---
summary: A plan for rebuilding the erosion step — macro pass, refined bakes and hydrology together — as one mass-conserving, equilibrium-seeking surface-process engine with tectonic forcing and a multithreaded solver. Written after a week of measurements located four structural roots under ~20 accumulated crutches; the crutch inventory, the literature grounding, the tectonics interface, the thread model, the phased build with go/no-go gates, and an honest outcome estimate are all here.
date: 2026-08-16
updated: 2026-08-16
area: generator
stage: idea
status: plan agreed 2026-08-16; P0 prototype RUN the same day and its original gate FAILED — by design, cheaply, and informatively. The failure revised the plan (see "Refined bakes under v2, REVISED"): tier consistency cannot come from independent per-tier solves under ANY erosion model, it comes from one solve plus derived tiers — recorded as its own decision in decisions/derived-bake-tiers.md, valid for the current pipeline too. P0 is COMPLETE: cost measured, and the look question closed structurally — a full equilibrium erases its initial condition, so texture comes from finite landscape age + K contrast + U detail, not from scalar tuning (see the P0 section). The U-source fork below is narrowed but not closed.
---

# Erosion v2 — One Surface-Process Engine

## Why a rebuild, and why now

The current erosion is an explicit stream-power filter plus thermal talus,
run for N rounds, with hydrology re-derived afterwards and an amplification
bake that repeats both on finer grids. It has accumulated some twenty
special-case mechanisms ("crutches" — the full inventory is below). A week
of measurements (2026-08-14 … 16) traced nearly all of them to four
structural roots:

1. **No mass budget.** Excavated material is deleted (a documented,
   deliberate unrealism); marine deltas are a hand-wired exception with five
   sub-rules of their own; floodplains, fans and alluvium cannot exist.
2. **No notion of equilibrium.** The generator's "uplift" is a cap toward
   the tectonic envelope; the bake runs pure denudation (`upliftRate 0`)
   and never converges — measured 84/167/269/363 m of incision at 1/2/3/4
   rounds, still climbing. Every result depends on round count and cell
   size. This is the root of the bake-tier problem: tiers of the same
   world disagree by 100–140 m RMS about the same ground, mostly as
   SYSTEMATIC offsets (measured 2026-08-16: the finer tier denudes
   interfluves less and carves channels deeper). A cascade prototype
   (refine 16K from the finished 8K) failed BOTH goals at once — one
   erosion round destroyed inheritance at every scale (118 m RMS, 109 m
   even at 16 km cells) while a tapered dose lost the deep carving that
   makes a finer tier worth baking (230 m valleys vs 296 m from-macro).
3. **Uniform erodibility.** One global K forced the elevation-zoned
   erosion mask and the plain-damping factor into existence as substitutes
   for lithology and climate.
4. **Grid-scale conflation.** A 1950 m cell treats hillslope area as
   channel, so coarse tiers over-denude interfluves (+50 m per tier step,
   measured) — a resolution artifact no amount of constant-rescaling fixes,
   because the model has no hillslope/channel distinction at all.

Separately fixed already, and kept: the single-flow receiver is D8-LTD
since 2026-08-15 (plain D8's rounding error accumulated into axis-parallel
streaks, worse the finer the grid).

## What the literature does

- **Braun & Willett 2013 (Fastscape)** — implicit O(n) stream-power solver,
  unconditionally stable. NOTE: this repo built Braun–Willett once and
  dropped it as "too subtle" — but it was measured against the explicit
  scheme's receiver clamp, a stability guard that exists only because the
  scheme is explicit. In an implicit engine the clamp disappears and the
  solver is the foundation, not a refinement.
- **Davy & Lague 2009 (ξ–q) / Shobe et al. 2017 (SPACE)** — mass-conserving
  sediment routing: every cell erodes AND deposits, governed by a settling
  length. Short length = transport-limited (alluvial plains), long =
  detachment-limited (bedrock canyons). One mechanism replaces the deletion
  rule, the delta special case, and the plain damping simultaneously.
- **Roering et al. 1999** — nonlinear hillslope diffusion with a critical
  slope: convex ridgetops, planar sideslopes. The principled form of our
  thermal talus.
- **Yuan et al. 2019** — marine sediment transport as diffusion below sea
  level. Replaces all five delta sub-rules (area gate, graded freeboard,
  lateral spread, shelf cutoff, donor floor) with one physical term.
- **Lague 2014** — erosion thresholds (critical shear stress) are a main
  control on relief; our model has none, which is one reason its relief
  reads soft.
- **Cordonnier et al. 2016** (the model our code already cites) — uplift +
  stream power run to equilibrium; heights emerge from the U/K balance.
- Games/tools (World Machine, Gaea): artist raster ops without mass
  conservation — the road our masks and factors were already partway down,
  and the inventory shows where it ends. GPU pipe-model hydraulic erosion
  suits close-range detail, not continents. Génevaux-style "rivers first"
  already lives here as the near-field `channelField` and fits unchanged
  under the new engine.

**On flatland specifically** (a standing question): floodplains are flat
because rivers DEPOSIT there — aggradation fills local relief and lateral
migration planes valley floors. Flatness is an active sedimentary
equilibrium, not an absence of erosion. `plainFactor` forces the outcome
because the mechanism is missing; with deposition the outcome emerges, and
the seeded plains micro-relief inverts from a crutch into an emergent
property (channel wandering). The game-design constraint — plains must stay
legible as valuable building ground — remains valid but becomes a
display/content concern, not a terrain-model parameter.

## The model

One **surface-process engine** owning water, sediment and rock as one
state; rivers and lakes become VIEWS of that state instead of re-derivations
(today's extractor-vs-mask drift produced the v6/v7 mouth bugs).

State per cell: bedrock elevation `z_b`, sediment thickness `h_s` (the mass
budget), discharge `Q`.

Per iteration:

1. **Routing** — parallel priority flood, LTD single-flow receiver, MFD
   drainage area. All three survive from the current engine.
2. **Discharge from climate** — `Q` integrates the real precipitation
   field, not cell counts. Drainage density becomes climate-driven (arid =
   sparse), which retires both `runoffFloor` and the `riverDensity` recipe
   input; what remains is a cartographic "which rivers to DRAW" threshold
   on Q, display-side and outside the artifact key, exactly like today's
   rule for the density slider.
3. **Fluvial** — implicit stream power `E = K(x)·(Q^m S^n − θc)+` with an
   erosion threshold θc and a spatially varying K.
4. **Deposition** — Exner balance with a settling length; below sea level,
   marine diffusion of delivered sediment. Deltas, fans and valley floors
   emerge.
5. **Hillslope** — Roering diffusion with critical slope Sc, separated from
   channels by a channelization threshold. This is the structural fix for
   the measured interfluve bias: hillslope cells never see the channel law,
   however coarse the grid.
6. **Uplift** — from tectonics (see the interface below).
7. **Termination** — a convergence criterion (`max|Δz| < ε`), not a round
   count. `rounds` and `drainageRefresh` die as controls. Full steady state
   may read too "mature"; stopping at quasi-equilibrium or varying U over
   the run are the transient-look levers, to be judged by eye in P2.

**K as a field replaces seed roughness.** The 60 m noise cascade exists
because bilinear upsampling is glass. The physical name for that role is
lithology: a torus-periodic, resolution-independent K field (same lattice
family as `detailSeed`), sampled identically at every tier. Hard/soft bands
yield structural benches and knickpoints — relief classes the current model
cannot produce at all. The ridged-octave garnish stays optional pending
measurement; real range-scale carving may cover it.

## Rates in years (F7, 2026-09-22)

The engine counts iterations and its rate constants are per iteration.
`ITERATION_YEARS` (erosionEngine.ts) names the iteration: 20 000 years,
anchored on the uplift — 19.8 m per iteration at forcing 1 is 1 mm/yr,
the canonical active-orogen rate. Everything else follows and is
recorded there: K = 4.5e-7 /yr for m = 0.5, an age of 40 iterations is
0.8 Myr and 400 is 8 Myr (the 1–10 Myr a range needs to reach flux
steady state), the hillslope D is 25 m²/yr — landscape-scale mass
wasting at 7.8 km cells, not soil creep. The Cenozoic anchor (age 400 =
66 Myr) was weighed and rejected: it makes the uplift 0.12 mm/yr and K
5.5e-8, both at the slow end. Nothing in the engine reads the constant;
the age slider shows it (million years), and phase 5 turns an epoch's
length into iterations with it.

## The tectonics interface (agreed 2026-08-16)

Erosion "belongs to" tectonics only in the sense that it needs tectonics'
DATA, not its loop — which is exactly how the literature runs: tectonic
forcing INTO an LEM, never an LEM inside mantle convection. The
game-facing split stays as it is (tectonics gives the coarse picture,
erosion refines it — the practical ordering, kept deliberately).

What changes is the WIDTH of the interface. Today tectonics hands over one
elevation raster. Under v2 it additionally exports forcing fields it
already knows internally:

- **U(x)** — uplift rate from active convergence, rifts, hotspots and
  orogeny activity (boundary pass, feature activity, mantle coupling all
  exist).
- **K(x) inputs** — crust age (cratons hard), volcanic provinces (flood
  basalts as caprock), young orogens, sediment cover. Combined with the
  procedural lithology noise into the erodibility field.
- possibly **feature age** — young ranges as transient, still-uplifting
  landscapes.

The in-tectonics erosion stand-in (`thicknessDecayPerEpoch: 0.99`, whose
own comment calls it a placeholder for exactly this) STAYS as the tectonic
sim's numerical relaxation — its job is keeping the epoch loop bounded,
not modelling erosion. The elevation raster's role shifts from
envelope-ceiling to INITIAL CONDITION plus calibration target: K is
calibrated so equilibrium heights land in the tuned range, and the golden
metrics gate that. This narrows the U-source fork: no reverse-engineering
of U from the envelope is needed (option B survives only as fallback), and
option C (erosion inside the epoch loop) is explicitly rejected for
gameplay practicality.

Integration note: the BAKE re-runs erosion on fine grids, so U(x) must
travel in the save — a new coarse layer (climate resolution is plenty; U is
smooth). K needs no layer: procedural from seed plus tectonic inputs that
are either already saved or join U's layer. This touches the save format
and is an ALGO/world-version break — accepted, we are in the
hard-breaks-allowed phase.

STATUS 2026-08-16: **the U export is BUILT and measured**
(`elevation/upliftField.ts` — the terrain features already carry
everything needed: accumulated thickness for magnitude, tangent for the
capsule footprint, `epochsSinceDeposit` for ACTIVITY; U weights the same
capsule kernel elevation uses by recency, so active orogens force and
abandoned ranges do not). First measurement on a fresh 50-epoch world
(`scripts/erosion-v2-uplift-check.mts`): correlation with the standing-
relief stand-in only 0.53, just 16.9 % of real U's mass on today's high
ground (the stand-in: 70.3 % by construction) — cause and effect really
do diverge — and 8.2 % of real U is NEGATIVE (active rifts subsiding),
which no elevation-derived forcing can express. Engine runs at age 100
differ by 338 m RMS on land, concentrated exactly where the physics
says: the active island arc stays up under real U, the stand-in lets it
decay. Two open ends, on record: the per-world peak normalization can be
set by a submarine ridge (land forcing then under-scaled — the P2
calibration owns the final mapping), and `epochsSinceDeposit` is a
recency PROXY — the true per-feature deposit-rate EMA belongs to
stepEpoch when the interface is wired for real.

**The K inputs are BUILT too** (`elevation/erodibilityField.ts`, same
day): a smooth multiplicative K-factor field at climate resolution —
ancient cratons hard (via `computeCratonOldnessField`, the same crust-age
story that places the Ecology's iron), young sutures soft / old sutures
modestly hard (the persistent collision history), flood-basalt provinces
as caprock (features with plateB −2). The engine multiplies it into its
per-cell lithology noise. Measured on the test world: 12.2 % of cells
hardened (the cratons), landscape effect at age 100 is 38 m RMS on land
with ~1 km local capture shifts at craton margins — mechanism proven,
magnitudes deliberately left to the calibration pass.

Found on the way and FIXED the same day (user's call, 2026-08-16): **the
birthEpoch axis was broken across the archean→tectonic handover.** Blobs
were stamped in ARCHEAN epochs, never remapped, and the tectonic clock
restarts at zero — so against `sim.epoch` a young world's craton oldness
clamped to 0 everywhere, and a tectonic-era accretion could read OLDER
than an archean core. This also distorted the existing cratonAge overlay
and the Ecology iron placement on young worlds; on long-run worlds the
distortion faded, which is why it went unnoticed. The fix is one
continuous axis, `core/worldTime.worldEpoch(archeanEpochs, epoch)`: every
tectonic-era stamp (accretion, merges, split immunity, sutures,
stabilisation checks) and every reader (craton oldness in the pipeline,
the erodibility field) now uses it; archean stamps were already on it by
construction. Old saves' tectonic-born blobs keep restarted-axis stamps
and read somewhat too old — accepted, hard-breaks phase. Goldens
re-anchored with the fix.

## Hydrology merges into the engine

Discharge, lakes and channels already have to exist INSIDE the erosion
loop; deriving them a second time afterwards is the duplication. Lakes
become first-class during the solve (water balance with evaporation — the
existing computeLakes logic, moved inside), which retires the
enclosed-water restore hack. Rivers are extracted once from the final
state by the same LTD walker. Salt flats / terminal basins keep their
climate refinement, now consistent by construction.

STATUS 2026-08-17 — the merge turned out to be an ADAPTER, not a rewrite
(`surface/erosionEngineBridge.ts`): everything hydrology.ts consumes from
a FlowRouting — filled, single-flow receivers, the topological order —
the engine maintains as its own routing state; the bridge wraps it (MFD
converted stride-8 → CSR for contract honesty; hydrology never reads it).
Gated in the engine-check: accumulateDischarge + computeLakes run on the
engine's network and classify a sane water world. Two findings recorded:

- **The enclosed-water restore hack is retired BY CONSTRUCTION.** v1 needs
  it because it bakes the flood-filled surface into the terrain; the
  engine never writes `filled` into z, so a Caspian-class basin simply
  stays deep. Nothing to restore.
- **The climate-Q mechanism is in place, the wiring is a fork.**
  `accumulateFlowV2` accepts per-cell base weights (pass upsampled
  precipitation → the engine's erosion Q becomes water, not area). But
  today climate runs AFTER erosion; feeding real precipitation into the
  solve means reordering or iterating the stages — a user-visible
  pipeline question, deliberately left for the switchover decision.
- Open for lakes-first-class: the marine freeboard cap references SEA
  level, so a long transient can aggrade a sub-sea terminal basin toward
  +2 m; the basin's own balance level should cap it instead.

## Refined bakes under v2 — REVISED after the P0 measurement

The paragraph below is what this plan originally claimed, kept struck
through in spirit because P0 measured it FALSE the same day it was
written: ~~same engine, finer grid, same convergence criterion — the
systematic tier disagreements disappear structurally because both grids
discretize the same attractor~~.

P0 ran (512×256 vs 1024×512, same physical constants, same world-space
forcing and lithology fields, 800 iterations each) and the independent
solves disagreed by **464 m RMS, 426 m of it smooth, +142 m mean** —
WORSE than the current model's 144 m under the identical protocol.
Three calibration rounds removed genuine scale bugs (per-pair hillslope
fractions → physical diffusivity; constant settling length → Q-dependent
with exact exponential reach integration; the A0 sub-grid drainage
closure for headwater slopes) and the systematic gap survived them all.
The difference image says why: red interfluve cores veined with blue
channels — the finer grid RESOLVES hillslopes standing above channels
that the coarse grid, whose every cell carries trunk-scale drainage
area, cannot represent at all. That is not a constant to tune; it is the
known result that **LEM equilibria converge under grid refinement
statistically, not pointwise**. More physics resolves more
resolution-dependent structure, not less.

The revision (its own decision, valid for the CURRENT pipeline too —
see [decisions/derived-bake-tiers.md](../decisions/derived-bake-tiers.md)):
**one solve at the designated finest tier; every coarser tier is its
downsample.** Consistency by construction, byte-exact, no closure
acrobatics. v2's engine then never runs per tier — it runs once per
world at the finest grid, which also concentrates the threading budget
where it pays. A fast provisional 4K remains the immediate preview,
replaced by the derived family in one visible, in-game-documented swap.

What P0 still owed after the revision — LOOK and COST — is now measured
and closed (2026-08-16):

- **COST**: 0.36 s/iteration at 512×256, 0.55 s at 1024×512
  single-threaded; ~800 iterations to quasi-steady with ~30–40 m of
  residual capture flicker (the metastable river captures real LEMs also
  show). 443 s for a full 1024 run — the P1 threading gate (≥4× on
  8 cores) is what makes finest-tier runs affordable.
- **LOOK — the finding is structural, and it validates the plan's own
  slider.** A calibrated round (U/K ×2.7, lithoSigma 1.4) raised the
  equilibrium as the scaling law says it must (mean land 924 → 1460 m,
  p95 2455 → 4224 m) yet local relief barely moved: 39-km relief median
  233 m against the current model's 521 m at the same grid, and the crop
  renders as smooth massifs with no dendritic dissection. The reason is
  not a constant: **a full equilibrium erases its initial condition** —
  every metre of texture must then come from the forcing, and P0's
  forcing is smooth by construction (U smoothed at 256×128, K on a
  ~30-km lattice). The current model's dissection is inherited tectonic
  roughness that its transient erosion carves but never erases. So the
  look does NOT come from scalar tuning; it comes from the three inputs
  the plan already names: **finite landscape age** (run the transient
  from the real tectonic terrain — the Landschaftsalter attractor is
  load-bearing, full equilibrium is its far end, not the default),
  **fine-scale K contrast**, and **U detail exported by tectonics**.
  P2 integrates the engine against the real tectonic field, where the
  initial condition carries the texture P0's smooth restart could not.

  CONFIRMED at P2 kickoff (2026-08-16, spike runs at 2048 from the real
  v9 terrain): age 25 iterations keeps 39-km relief at 541 m median —
  above the current model's 521 — with dendritic texture intact; age 100
  reads softened (348 m); age 400 is the familiar near-equilibrium blob
  (271 m). The age axis IS the look control, measured end to end. Land
  drifted 28.0 → 29.5 % over the same range — the coastline-pinning
  constraint, confirmed on real terrain.

Two P2 constraints P0 surfaced, recorded before they get lost:

- **Coastlines must be pinned — and the lever is DEPOSITION, not uplift.**
  A free run moves them: P0's land fraction drifted 26.4 → 31.1 %, and the
  P2 engine at 2048/age 400 drifted 27.5 → 29.5 %. The obvious fix —
  uplift shut off seaward of the initial coastline (`coastMask`, built) —
  was measured NEARLY INERT: 29.4 % pinned vs 29.5 % free (2026-08-16).
  The actual mechanism is marine aggradation: submarine deposits build to
  the +2 m freeboard along broad shelf fronts and surface as land far
  beyond anything a delta earns. Capping deposition below sea level
  removed only half the drift (29.5 → 28.4 %); additionally disabling
  hillslope diffusion swung the balance NEGATIVE (26.5 % — coasts
  retreat under fluvial attack once talus stops replenishing them). The
  coastline is a BALANCE of ±1–2-point mechanisms, and no physics-side
  cap holds it; every knob just moves the equilibrium of the balance.

  The resolution is to stop treating this as one problem. It is two:

  - **In the generator**, the erosion pass's output BECOMES the macro —
    there is no external coastline to obey, and modest coast reshaping
    (deltas prograding, cliffs retreating) is a feature. Drift at young
    ages is small anyway (+0.5 points at age 25).
  - **In the bake**, the finest-tier solve refines an EXISTING macro,
    whose coasts are authority. Here the constraint is explicit, not
    emergent: one rule, asked in one place — "may this cell change its
    land/sea status?" — pinned to the macro coastline with a growth
    allowance at river mouths and nothing else. Enforcing status rather
    than tweaking three processes is what makes it auditable.

  The coastMask input stays (correct, nearly inert alone); the status
  rule is P3 work, where the bake meets the engine.
- **Relief needs its decouplers.** In the current model relief is inherited
  roughness; in an equilibrium model, peak height and valley relief both
  come from U/K unless something decouples them — the K-field contrast
  (soft bands carve, hard bands stand, peaks unmoved) and the erosion
  threshold θc (steepens low-Q reaches) are those decouplers, and the first
  look rounds quantified how much they carry: with neither, local relief
  came out 341 m against the current model's 904 m at the same grid.

Hypothesis to re-test, not a promise: region splitting diverged chaotically
(measured 2026-08-10) on the TRANSIENT explicit model; equilibrium problems
tolerate domain decomposition (Schwarz-style overlap iteration). Distributed
bakes may come back onto the table.

## Multithreading (a requirement, not an afterthought)

| piece | method | expected scaling | P1 MEASURED (2048, 8 workers, 4P+6E) |
|---|---|---|---|
| priority flood | Barnes 2016/17: flood tiles independently, resolve the border spill graph globally, correct | near-linear | BUILT: 16 fixed strips, spill graph + min-max Dijkstra; exact (max 0.02 m vs serial, ε-chains only), deterministic for any worker count; P1 288→78 ms, P2 322→95 ms (~3.5×, E-core-limited) |
| implicit fluvial solve | parallel per drainage basin + level scheduling inside large basins (Barnes 2019) | ~10× on 16 cores published | NOT built — measured serial: fluvial 18 + sediment 39 ms/iter; THE remaining wall, see below |
| MFD accumulation | level-parallel over the topological order | good | NOT built — serial 78 ms at refresh; the λ-walk (72 ms) is its sibling |
| diffusion / thermal / marine | stencil ops | linear | BUILT: 4–8× on the scans (LTD facet scan 215→48, MFD 73→19); small stencils are dispatch-bound (~1.3×) |

STATUS 2026-09-22 (ADAPTIVE_MESH_PLAN.md phase 0, ocean masking): the
strip flood row above is history. The engine now computes on an ACTIVE
SET — land, enclosed basins, a shelf band of ocean — with the deep ocean
frozen and absent from every state array (`erosionEngineState.ts`,
`EngineIndex`); kernels walk a per-cell neighbour table and never see a
coordinate, which is the shape the mesh port (adaptive-mesh.md step 4)
needs. The sixteen-strip Barnes flood, its spill graph and the pop-order
merge were retired for ONE serial priority flood over the active set:
with 11–15 % of the raster active it is cheaper than the strip machinery
was, and it removes `ENGINE_STRIPS` from the result. Measured on the
golden world at 2048, 20 iterations, routing every iteration:
single-threaded 21.6 → 2.0 s, pool(8) 9.3 → 1.7 s, pipelined 4+2 at
D=8 3.7 → 0.4 s; the golden harness dropped from ~13 min to 2.5 min. The
serial walks were then the whole iteration, so the same day the
fluvial and sediment walks went BASIN-PARALLEL: the receiver forest is
cut at every land→sea edge into segments (`buildSegments`), leaf
segments (river basins, unfed ocean trees) walk on the workers, the fed
ocean band and the enclosed basins in one serial stage each side —
fluvial serial first (receivers first), sediment serial last (donors
first, after the basins' mouth fluxes are delivered in segment order,
which is what keeps the sum independent of the worker split). Row 2 of
the table is therefore BUILT, in the coast-split form (b) above
described; the flood stays serial by measurement (it is 14 % of the
raster and off the iteration path).

The P1 spike (scratchpad `p1-spike.mjs`, 2026-08-16) ran the P0 physics
threaded end-to-end and byte-identical across worker counts. Three findings
beyond the table:

1. **A 57 % overhead nobody was measuring.** P0's per-iteration cost was
   dominated not by compute but by `maybeYield()` in the shared
   `fillDepressions` — an unconditional `setTimeout(0)` macrotask every
   ~n/200 pops, browser progress plumbing paid blindly in Node. Removing it
   cut the serial iteration 566→221 ms at 1024. This affects TODAY'S
   pipeline: the browser generator's erosion routing pays the same tax
   (v1 fix candidate: time-throttled yields, not unconditional ones).
2. **Routing refresh amortises, and the physics tolerates it.** Recomputing
   ocean/flood/LTD/MFD/accumulation every K iterations (v1's own
   drainage-refresh model) at K=4/K=8 leaves land fraction and convergence
   unchanged and moves the field only within the capture-flicker class
   (RMS 36/68 m at 512, 400 iters — the same magnitude two K=1 runs differ
   by after a few iterations). The equilibrium attractor does not care.
3. **The Amdahl wall is the ordered walks, precisely quantified**: λ-walk 72
   + accumulation 78 + sediment 39 + fluvial 18 + pop-order merge ~100 ms
   ≈ 310 ms serial at 2048. Everything else parallelises. This is what
   caps same-K threading at ~1.2–2×.

End-to-end at 2048×1024, 8 workers: serial best 830 ms/iter → K=1 threaded
614 → K=4 248 → K=8 169 ms/iter (**4.9× combined**; a full ~800-iteration
solve drops from ~11 to ~2.3 min). The honest split: threading alone gives
~1.2–2× at equal K; the rest is amortisation.

The P2 path THROUGH the wall, in order of leverage: (a) **pipelined
refresh** — the routing refresh reads a z-snapshot and nothing the physics
iterations write, so it can run on background workers while iterations
continue on the previous routing; with validated K≥8 the serial walks then
stop blocking the iteration path entirely; (b) basin-parallel
fluvial/sediment (land trees are independent; sediment needs a coast-split
stage for its marine tail); (c) tournament/parallel merge. GPU stays the
second stage.

STATUS 2026-08-16/17 — **the worker port is IN THE TREE**:
`surface/erosionEngineState.ts` (one buffer layout, identical for
ArrayBuffer and SharedArrayBuffer), `erosionEngine.ts` re-cut so every
parallel phase is an exported per-range/per-strip KERNEL and the
single-threaded ErosionEngine is a thin driver over them,
`erosionEngineWorker.ts` (dual-substrate entry: worker_threads AND
browser Worker via `?worker`), `erosionEnginePool.ts` (the coordinator —
blocking Atomics waits, legal because its home is the worldgen worker).
Gates all green in scripts/erosion-v2-engine-check.mts: engine
byte-identical to the measured spike, pool byte-identical to
single-threaded at 2 AND 8 workers (per-cell-deterministic kernels +
fixed strips = parity by construction). Measured at 2048, K=8:
single-thread 227 ms/iter, pool(8) 138.5 ms/iter — 6.0× vs the serial
baseline; an age-100 transient costs ~14 s, a full age-800 solve ~1.9
min. Node workers load the TS entry directly (tsx execArgv inheritance);
the browser side wires up at the switchover.

**The pipelined refresh is BUILT and measured** (same day): two routing
buffers, a dedicated refresh-coordinator WORKER running the refresh's
serial parts (ocean, spill graph, merge, λ, accumulation) plus its own
small kernel group — the whole measured serial wall moves OFF the
iteration path. Determinism survives by scheduling-free design: the main
coordinator copies the z-snapshot at a FIXED iteration boundary and swaps
at the NEXT fixed boundary regardless of when the refresh finished, so
active routing during [kD, (k+1)D) is always routing(z_{(k-1)D}) —
staleness D..2D, byte-identical across every worker split (gated in the
engine-check, along with land-fraction parity vs the synchronous engine).
The key structural simplification: STENCIL KERNELS NEVER READ ROUTING
STATE, so only the main coordinator and the refresh group see the double
buffer at all. Measured at 2048: sync pool(8) 128.7 ms/iter → pipelined
4+3+1 at D=8 104.1 ms (8.0× vs serial, staleness within the validated
K≤8 class ×2), 5+2+1 at D=12 94.9 ms (8.7×, staleness 12..24 —
pending its own validation before use). A full age-800 solve at 2048 now
costs ~83 s; an age-100 transient ~10 s.

Substrate: `SharedArrayBuffer` + the existing worker pool in the browser,
`worker_threads` in the Node baker. SAB needs COOP/COEP headers — dev
server and Go server must send them; small standalone task, do it early.
GPU (WebGPU) is deliberately a SECOND stage: the algorithms above are
GPU-friendly, but the CPU path is the one the repo has and runs everywhere.

Realistic outcome: 6–10× wall clock (K-amortisation + threading measured
at 4.9× before pipelining/basins). The 42-minute 16K bake lands near 5–8
minutes; the generator pass becomes interactive.

## Crutch scorecard

**Dies structurally**: plainFactor + elevation-zoned erosion mask (replaced
by deposition + K field + θc), receiver clamp (implicit solver), estuary
clamp (base level handled properly), enclosed-water restore (lakes
first-class), talus land-only rule (marine export term), runoffFloor
(climate-driven Q), seed-roughness cascade (K field), rounds +
drainageRefresh + envelope cap (convergence + real U), all five delta
sub-rules (marine diffusion), the second hydrology derivation.

**Survives**: LTD routing, MFD area, the metre anchor, the derived
scale-rescaling discipline, the harness culture, the near-field
channelField synthesis, and the MEASURED calibration targets (Danube-to-Nile
delta sizes, the channel-density-per-tier curve) as acceptance criteria.

**New, honestly counted**: settling length, hillslope diffusivity, Sc, θc,
K-field spectrum, U calibration, marine diffusivity. A similar number of
constants as before — but each is a physical parameter with a literature
range instead of a patch over a missing mechanism.

## Outcome estimate

- **Mechanics: high confidence.** Nothing here is research; it is the
  standard of the field since ~2013, and the measuring instruments built
  this week (transect tables, density tables, cross-tier RMS, goldens) are
  exactly its acceptance tests.
- **Look: medium confidence, tuning phase required.** Every world changes.
  Concrete wins the current model cannot reach: true valley floors and
  alluvial fans, concave graded river profiles, structural benches from K
  bands, climate-visible drainage density, mountain fronts with fans
  instead of furrows.
- **Structure: the big win.** Tier consistency, ~6–10× speed, one engine
  instead of three layers, and a model where "make it better" means moving
  understandable parameters again.
- **Biggest single risk**: not the code — the look acceptance. Weeks of
  eye-tuning follow the integration, gated by goldens re-anchored on
  purpose.

## Player-facing controls (agreed direction 2026-08-16)

Today's sliders expose the PROCESS (`erosionStrength` scales the timestep,
`drainageRefresh` the re-routing cadence) — solver internals that became
player controls only because a non-converging model makes the dose part of
the result. Under v2 both die with the round concept, and `riverDensity`
leaves the recipe entirely: real density is climate-driven, and what
remains is a cartographic "which rivers to draw" filter (already outside
the artifact key today).

Controls under v2 sit on the ATTRACTOR — each changes the landscape, is
explainable in one tooltip sentence, and has visibly different ends:

- **Landscape age** — how far toward equilibrium the run stops. Young =
  steep gorges, knickpoints; old = graded, subdued, wide valleys. The
  successor to "strength", and the best narrative lever.
- **Alluvium** — the settling length (transport- vs detachment-limited).
  Rocky canyons ↔ broad floodplains, fans, large deltas.
- **Rock contrast** — the K-field amplitude/spectrum. Uniform rock ↔
  structural benches, mesas, escarpments, waterfalls.

Not exposed: θc, hillslope diffusivity (calibration, not play), and no U
slider — forcing belongs to the tectonics panel. The three names above are
working titles; the real names and i18n keys go through the usual approval
when P2 arrives. The new slider set is a recipe/identity change and rides
the version break v2 already carries.

## Phased build with gates

- **P0 — physics prototype** (scratchpad, 512×256, single thread):
  implicit solver + diffusion + ξ–q + marine diffusion. ORIGINAL GATE
  (cross-tier consistency 512 vs 1024) RUN 2026-08-16 and FAILED —
  exactly the cheap stop it was designed to be, and the failure produced
  the derived-tiers decision. The remaining look and cost questions were
  then measured and closed the same day (see the P0 section above): cost
  is P1's problem to parallelise, and the look lives in the initial
  condition and forcing detail, not in the scalars — P0 is DONE.
- **P1 — threading spike**: parallel flood + level-scheduled solver at
  2048. GATE: ≥4× on 8 cores. RUN 2026-08-16 (see the multithreading
  section for the measured table): Barnes flood built and exact, scans
  4–8×, combined threading+amortisation 4.9× end-to-end (830→169 ms/iter)
  with physics validated at K≤8 — but threading ALONE at equal K is
  1.2–2×, capped by the ordered walks (~310 ms serial). Verdict: the gate
  is met only jointly, not by threads alone; the remaining wall is
  quantified and the pipelined-refresh design (routing off the iteration
  path) is how P2 breaks it.
- **P2 — generator integration** behind the existing `runErosionPass`
  surface; decide the U fork on P0 evidence; goldens re-anchored
  deliberately; the new slider set (see "Player-facing controls") proposed
  for approval (UI surface). STATUS 2026-08-17: the engine-side
  scaffolding is COMPLETE — `surface/erosionPassV2.ts` wraps the engine in
  v1's exact result contract (with two documented shifts: elevations are
  honest z, basins unbaked; preFill ≡ elevations), runs single-threaded or
  pooled+pipelined, finalizes routing on the finished terrain for the
  hydrology handoff; the climate-Q weights thread through every execution
  path (FLAG_HAS_ACCUM_WEIGHTS — fixed default-parameter provisional
  forcing per the 2026-08-17 decision, the live coupling/panel reorder is
  its own later step); chunked runs keep a global cadence cursor. The BAKE
  stays on v1 until P3 (stride-8 MFD memory at bake grids). SWITCHED OVER
  2026-08-17: the generator's erode stage runs the v2 engine
  (pipeline/runtime.ts assembles the forcing — activity-weighted U,
  crust-history K × world-seeded lithology noise, coast mask, provisional
  default-parameter climate as normalized Q weights — and runs pooled +
  pipelined when cross-origin isolation grants SAB, single-threaded
  otherwise). The slider swap shipped with it (approved keys
  `worldgen.panel.erosion.age`/`alluvium`/`rockContrast`; old
  strength/drainage keys removed): age = iterations, alluvium =
  settling-length scale (50 neutral), rock contrast = lithology σ.
  worldId derivation extended BACKWARD-STABLY (old saves' ids and
  cached artifacts stay valid; new saves hash the new controls).
  Roundtrip, pipeline and amplify harnesses green. The goldens turned out
  UNCHANGED at first — they call runErosionPass directly (their documented
  runtime.ts blind spot), so they were still gating the v1 pass. CLOSED
  the same day: the forcing assembly moved to `pipeline/erosionForcing.ts`
  (ONE function, shared by runtime and harness — the harness must gate
  byte-identical inputs to the player's erode), golden's erosion step now
  runs the v2 stage at the sliders' declared defaults, and the very first
  gated run caught a real bug the message-level harness could not: the
  engine breached the 9000 m representational ceiling on every seed
  (redistribution-normalized peaks + uplift). Fixed by saturating uplift
  at the anchor (kernelUplift — v1's envelope cap played the same role);
  spike/pool parity unaffected (the check world never reaches the
  ceiling). Baseline re-anchored on v2. The v1 pass remains ONLY as the
  bake's engine until P3.
- **P3 — bake tiers** on the new engine; re-measure the tier tables.
  Decided 2026-08-16: hard break for pre-v2 saves (they bake with neutral
  forcing; the v1 pass and its legacy control reads die, teardown at P5),
  build order engine → coastline status rule → threaded server bake →
  derived tiers, designated finest tier 8K (16K waits on the MFD memory
  work). STEP ① BUILT 2026-08-16 — the bake IS the engine:
  - The save grew two manifest layers, `uplift` and `erodibility` (raw f32
    at climate resolution, written from the live sim at save time via the
    shared `coarseForcingFields`) — the bake's forcing without carrying the
    simulation. The lithology seed is derived from the recipe like
    detailSeed (`erosionLithoSeed`), so no format field was needed for it.
  - The forcing assembly split: the pure grid half (upsample, lithology
    noise on its FIXED 512×256 world lattice — a finer bake samples the
    same rock bands more finely — water normalization, controls mapping)
    moved to `surface/erosionForcingFields.assembleFineForcing`, shared
    verbatim by the generator (golden re-run: 0 drifted metrics, the
    refactor is byte-neutral) and by `runAmplification`, whose water
    forcing is the save's REAL precipitation where the generator can only
    use its provisional climate.
  - Bake policy: `upliftDt 0` (v1's upliftRate-0 reasoning carried over —
    a refinement must not push interfluves above the finished macro), the
    engine's parameter object + salts hashed into AMPLIFY_CONSTANTS,
    ALGO_VERSION 10. No per-cell-size parameter scaling: the engine's
    physical units read the grid through cellM, which is exactly the
    scale-conflation v1 needed `scaleErosionParamsForCellSize` to paper
    over.
  - Dose measured on a real 2048 save at 4K (single thread): age 6/12/24 →
    channels p90 66/106/185 m carved, land mean −19/−35/−62 m, coast drift
    +0.28/+0.41/+0.62 pts, 28/39/62 s. AMPLIFY_EROSION_ROUNDS = 12 (engine
    iterations now; Go default mirrors it) — calibration placeholder until
    ②'s status rule pins the drift. The engine aggrades floodplains
    (channel p50 NEGATIVE) while its p90 tail carves — v1 could only cut.
  - The amplify harness re-anchored one invariant on measurement: mass
    conservation deposits broadly and shallowly (38 % of cells above the
    seeded ceiling but p50 0.44 m, only 1.4 % over by >5 m, two thirds of
    it marine settling), so the area bound now counts substantial (>5 m)
    fill; the worst-case bounds (150 m) still catch runaways. All other
    checks — N=1 splitting exactness, region determinism, byte determinism
    across machines — passed on the engine unchanged.

  STEP ② BUILT 2026-08-16 — the coastline status rule, exactly as this doc
  specified it: one rule, asked in one place.
  - MECHANISM (engine): `ErosionForcing.statusMask` (0 free / 1 keep land /
    2 keep sea) enforced by `kernelStatusClamp` once per iteration after
    every mechanism has moved material — a pinned cell that crossed sea
    level is set back to ±0.5 m (STATUS_CLAMP_M). Flag-gated like the
    coast mask: the generator passes nothing and its engine stays
    byte-identical to the spike (all six engine-check gates re-passed after
    the state-layout change). Excluded from the residual — a clamp is
    enforcement, not evolution.
  - POLICY (bake): pinned to the SEEDED field's status, with sea cells
    within DELTA_ALLOWANCE_KM (15 km, physical so every tier grants the
    same growth) of a river mouth left free. Mouths come from the seeded
    field's own routing under the SAME channel criterion the river
    extraction uses. The allowance grants GROWTH only — land never unpins,
    because a cliff retreating and the marine balance drowning a shelf are
    locally indistinguishable, and macro land is authority; retreat belongs
    to the generator, whose free-coast output becomes the next macro. Both
    constants hashed in AMPLIFY_CONSTANTS.
  - MEASURED (real 2048 save, 4K): drift +0.41/+0.62 pts (age 12/24) →
    +0.04/+0.04 with the rule — age-INDEPENDENT residual, i.e. delta
    progradation, not creep — while carving is untouched (channels p90
    106/187 m vs 106/185 free). Cost ~+7 s for the mask's routing
    pre-pass. Harness invariants: macro land drowned 0 cells; sea surfaced
    only 0.002 % (mouth allowance). The ①-era note "AMPLIFY_EROSION_ROUNDS
    is a placeholder until ② pins the drift" is hereby discharged: the
    dose is now free to be chosen on look alone.

  STEP ③ BUILT 2026-08-16 — the server bake is threaded.
  - MECHANISM: baker.mjs stays ONE esbuild bundle; `bake.ts` gates on
    `isMainThread` — a worker thread loading the bundle imports the engine
    worker module (whose parentPort handshake registers on import) and
    becomes an engine worker, so the pool's `createWorker` is simply
    `new Worker(new URL(import.meta.url))`. Nothing for the Go side to
    ship or know; `--version` still answers. Sizing mirrors the
    generator's (4+2 stencil/refresh at ≥8 cores, depth 8, no pool under
    4 cores) — a throughput knob, never part of the result.
  - MEASURED (real 2048 save, age 12, M-series 8 cores): 4K bake 24 s
    end-to-end (v1: ~94 s), 8K bake 113 s (v1: 2515 s — the engine plus
    threading is ~22× there). Two threaded 4K runs are byte-identical in
    every content-addressed file (meta.json differs only in bakeMs/
    createdAt) — the determinism doctrine holding through the bundle
    self-spawn, which is what lets browser and server keep keying one
    artifact.
  - The first threaded 8K bake found a real bug: the state layout's
    `align()` used `(offset + 7) & ~7`, whose bitwise ops coerce to 32-bit
    signed — the routing section crosses 2^31 bytes at 8K and the offset
    came back negative. Arithmetic alignment now; every gate re-passed.
    The browser bake stays single-threaded for now (an amplification
    worker spawning engine workers is the nested-worker case plus a
    crossOriginIsolated gate — deferred, the server is where 8K lives).

  STEP ④ BUILT 2026-08-16 — the derived tiers
  (decisions/derived-bake-tiers.md carries the decision and now the status;
  mechanics in short): AMPLIFY_FINEST_STAGE = 4 is the designated finest;
  its artifact carries every coarser tier as `family-<factor>/` files in
  the SAME entry — box-downsampled from the raw f32 field BEFORE
  quantisation (a member is box(finest), not box(quantised(finest))),
  rivers deliberately not duplicated (one polyline is the same river at
  every resolution; the member read scales texel coordinates). One key,
  atomically consistent, evicted as a unit; two path segments, not three,
  because the server store's listing walks exactly one level. The
  worldmap's ladder replaced AMPLIFY_FETCH_STAGES: family's coarse member
  first when the family exists (the follow-up to full resolution is then
  resolution-only — the terrain never moves), the independent provisional
  4K only when it does not — at most ONE terrain-changing swap, which was
  the decision's whole point. The family costs nothing visible at bake
  time (8K end-to-end 118 s, within noise of pre-family runs). Open, as
  its own step: the provisional state's in-game documentation (i18n
  approval) and the bake-button UX — the user flagged the UI for a joint
  look.
- **STAGE-2 CLIMATE COUPLING — BUILT 2026-08-16** (the deferred half of the
  2026-08-17 provisional-forcing decision): the climate panel's sliders now
  reach the erosion solve, and the panel sits BEFORE erosion.
  - The meteorology chain (temp → wind → currents → SST → amplitude →
    precip) moved to `climate/weather.computeWeather` — ONE chain shared by
    the climate stage and `assembleErosionForcing`, whose water forcing now
    evaluates it with the panel's parameters (and gains the currents/SST the
    provisional had skipped). `defaultWeatherParams()` reads the declared
    slider defaults, so headless callers and the goldens erode with exactly
    an untouched panel.
  - Stage graph: climate dependsOn tectonics, erosion dependsOn tectonics +
    climate — the climate edge is about the CONTROLS (the forcing
    self-evaluates; it never reads the stage's cache), so a climate-slider
    change invalidates the carved terrain via the same derived
    `downstreamOf` both sides already share. The climate stage computes on
    the PRE-EROSION terrain (the forcing's own input — its result must not
    depend on whether erosion ran).
  - The hydrology handler's climate refinement became UNCONDITIONAL: it is
    now where the post-erosion climate and biome truth comes from, not just
    the dry-basin correction. The first golden run after the reorder caught
    why this is load-bearing: v1 biomes (pre-erosion terrain) called
    erosion-grown coast cells Ocean above sea level — 7–17k cells per seed.
    Compute-on-save runs climate → hydrology → ecology whenever the world is
    eroded, so a save always carries refined fields.
  - Golden re-anchored deliberately (0 hard failures after the refinement
    fix; 19 drifted metrics, all the expected class: biome band shares 2–6 %
    from currents-in-forcing + refined-as-truth, small dry-basin counts now
    honestly evaluated). The panel reorder itself is DOM order; the joint
    UI look (badges, provisional labels) remains its own step.

- **P4 — BUILT 2026-08-16** (the hydrology-merge adapter itself had landed
  with P2; this is the remainder): drainage density is climate-driven and
  the density slider is a cartographic draw filter.
  - `runoffFloor` (200 mm/yr) removed from the runoff sampling: an arid
    cell contributes what actually falls on it, so arid regions genuinely
    lose rivers — the deliberate reversal of a once-explicit user wish,
    decided with this plan and stated for the record. The floor's second
    job (ocean-sentinel fallback at the coast) became a clamp to 0: a
    coast cell adds no runoff of its own but still passes upstream
    discharge along.
  - `riverDensity` left the recipe entirely: out of the world spec (old
    saves' key is ignored the partial-spec way), out of `ErosionControls`,
    out of every bake request. The model's one channel set sits at
    `CANONICAL_RIVER_DENSITY` (hydrology.ts, 55) — riparian biomes, the
    coast status mask, the baked network and the worldmap's macro rivers
    all read it. The panel slider remains as a DRAW filter in the
    generator screen only: it thresholds which channels are drawn, and a
    density-only pass now sends biomes EMPTY (the "unchanged" contract
    lakes already had) — before this, a display knob moved saved biomes,
    which the pipeline harness now asserts can no longer happen.
  - Artifacts: the per-density river files (`rivers-55.f32` …) collapsed
    to one canonical `rivers.f32`/`riverLengths.u32`;
    `canonicalRiverDensity` entered AMPLIFY_CONSTANTS and
    AMPLIFICATION_ALGO_VERSION went to 11 (the floor was never in the
    constants, so the hash alone would not have moved). identity.ts keeps
    the twice-removed story.
  - FOLLOW-UP, same day (user decision): the slider — and with it the whole
    hydrology PANEL — removed. A draw filter that acted on one screen,
    persisted nothing and contradicted the baked network shown beside it
    was not worth a panel; and density is now information (arid = sparse)
    that a global filter would only blur. The hydrology STAGE is untouched
    and became panel-less: it runs automatically when an erosion pass
    settles (the rivers are the solve's readout, drawn on the erosion
    panel), on entering the erosion panel with eroded terrain, and on
    demand from ecology/migration/save as before. `hydrologyRun` carries no
    parameters; the repeat-call contract (cached routing, empty "unchanged"
    buffers) is pipeline-harness-asserted. The three catalog keys
    (`worldgen.panel.hydrology.title`, `…riverDensity.label/.help`) were
    removed with user approval; the hydrology OVERLAY group keeps its keys
    and its place in the overlay bar.
- **P5 — BUILT 2026-08-16** — the teardown.
  - `surface/erosion.ts` DELETED whole: runErosionPass, the stream-power/
    thermal/deposition steps, erosionParamsWithControls,
    scaleErosionParamsForCellSize, the delta sub-rules — nothing imported it
    but a type, which moved. SURFACE_TUNING lost its entire "from erosion.ts"
    section (delta freeboards, estuary clamp, zoned-incision thresholds,
    talus angle); git history keeps the measurement essays that lived there.
  - The legacy recipe reads died: `spec.erosion.erosionStrength` /
    `drainageRefresh` are no longer read anywhere (an old save's lines are
    ignored the partial-spec way), ErosionControls carries v2 controls only,
    and deriveWorldId dropped the v1 scalars from its hash — a deliberate id
    break for every save (ALGO v11 had already orphaned all older artifacts;
    a changed id costs one re-bake). The roundtrip freeze was re-anchored on
    the new shape.
  - `erosionProgress` lost its `phase` field (one implicit solve has no
    named phases; the screen only ever drew the fraction).
  - makeTestSave.mjs and ridgeBands.mjs run the v2 engine now (same
    forcing + pass the golden harness gates); river-mouth-base-level.md's
    status records the estuary clamp as superseded by the engine.

Deliberately out of scope: GPU compute (second stage), erosion inside the
tectonic epoch loop (rejected for gameplay), glacial/aeolian processes.

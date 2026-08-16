---
summary: A plan for rebuilding the erosion step — macro pass, refined bakes and hydrology together — as one mass-conserving, equilibrium-seeking surface-process engine with tectonic forcing and a multithreaded solver. Written after a week of measurements located four structural roots under ~20 accumulated crutches; the crutch inventory, the literature grounding, the tectonics interface, the thread model, the phased build with go/no-go gates, and an honest outcome estimate are all here.
date: 2026-08-16
area: worldgen
stage: idea
status: plan agreed in discussion 2026-08-16 (including the tectonics-interface refinement); NOTHING BUILT. Next step is the P0 physics prototype, whose consistency gate decides whether the central promise holds. The U-source fork below is narrowed but not closed.
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

## Hydrology merges into the engine

Discharge, lakes and channels already have to exist INSIDE the erosion
loop; deriving them a second time afterwards is the duplication. Lakes
become first-class during the solve (water balance with evaporation — the
existing computeLakes logic, moved inside), which retires the
enclosed-water restore hack. Rivers are extracted once from the final
state by the same LTD walker. Salt flats / terminal basins keep their
climate refinement, now consistent by construction.

## Refined bakes under v2

Same engine, same equation, same K field, finer grid, run to the same
convergence criterion. The SYSTEMATIC tier disagreements (the ±50–90 m
offsets that dominate today's 100–140 m) disappear structurally — both
grids discretize the same attractor. Honest residual: exact channel
positions in the fine bands stay partly grid-dependent (the attractor is
not unique in network detail); macro valleys pin the large rivers. Expect a
large improvement, not byte agreement.

Hypothesis to re-test, not a promise: region splitting diverged chaotically
(measured 2026-08-10) on the TRANSIENT explicit model; equilibrium problems
tolerate domain decomposition (Schwarz-style overlap iteration). Distributed
bakes may come back onto the table.

## Multithreading (a requirement, not an afterthought)

| piece | method | expected scaling |
|---|---|---|
| priority flood | Barnes 2016/17: flood tiles independently, resolve the border spill graph globally, correct | near-linear |
| implicit fluvial solve | parallel per drainage basin + level scheduling inside large basins (Barnes 2019) | ~10× on 16 cores published |
| MFD accumulation | level-parallel over the topological order | good |
| diffusion / thermal / marine | stencil ops | linear |

Substrate: `SharedArrayBuffer` + the existing worker pool in the browser,
`worker_threads` in the Node baker. SAB needs COOP/COEP headers — dev
server and Go server must send them; small standalone task, do it early.
GPU (WebGPU) is deliberately a SECOND stage: the algorithms above are
GPU-friendly, but the CPU path is the one the repo has and runs everywhere.

Realistic outcome: 6–10× wall clock. The 42-minute 16K bake lands near
5–8 minutes; the generator pass becomes interactive.

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
  implicit solver + diffusion + ξ–q + marine diffusion. GATE: cross-tier
  consistency 512 vs 1024 must fall well below the current model's; if it
  does not, the central promise is false and we stop cheaply.
- **P1 — threading spike**: parallel flood + level-scheduled solver at
  2048. GATE: ≥4× on 8 cores.
- **P2 — generator integration** behind the existing `runErosionPass`
  surface; decide the U fork on P0 evidence; goldens re-anchored
  deliberately; the new slider set (see "Player-facing controls") proposed
  for approval (UI surface).
- **P3 — bake tiers** on the new engine; re-measure the tier tables.
- **P4 — hydrology merge**; riverDensity → display Q-filter; runoffFloor
  removed (user-visible: arid regions lose rivers — now wanted, once
  disliked; stated for the record).
- **P5 — teardown** of dead crutches, docs, decision records.

Deliberately out of scope: GPU compute (second stage), erosion inside the
tectonic epoch loop (rejected for gameplay), glacial/aeolian processes.

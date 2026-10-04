---
id: DEC-0006
title.en: Evolving Plate Motion via a Mantle Field (+ Volcanism)
title.de: Plattenbewegung aus einem Mantelfeld (und Vulkanismus)
summary.en: An evolving coarse mantle field drives the plates (kinematic coupling) so
  the supercontinent (Wilson) cycle and volcanism both emerge from one
  substrate, instead of fixed Euler poles + scripted band-aids.
summary.de: Ein sich entwickelndes grobes Mantelfeld treibt die Platten (kinematische
  Kopplung), sodass Superkontinent-Zyklus und Vulkanismus aus einem Substrat
  entstehen, statt aus festen Euler-Polen und geskripteten Notlösungen.
area: generator
stage: building
createdAt: 2026-07-25
updatedAt: 2026-08-12
concepts: [generator.concept.mantle-convection, generator.concept.hotspot, generator.concept.plate-boundaries]
related: [DEC-0002, DEC-0011]
---

**Status:** Planned, not built (2026-07-25). Chosen direction: model the **cause**
(a coarse evolving mantle field the plates ride on), from which the assemble/break
cycle AND volcanism emerge — rather than the lighter reactive-force/scripted-doming
options (kept as a fallback below). This is the "real fix" behind the raft model's
"breakup is limited by fixed motions" band-aids
(`docs/decisions/continental-crust-rafts.md`).

## Root cause

`plateMotion.ts`: each plate gets an Euler pole `{ centerX, centerY, angularSpeed }`
**once at spawn**, fixed for life. It is used two ways: `getVelocityAt` (instantaneous
`ω × r`, for boundary classification / arrows) and `rotateAroundCenter` (the finite
per-epoch advection of rafts, ocean-age, features, seeds). Nothing ever updates it,
so plates that converged to assemble a supercontinent keep converging → no divergence
under it to rift it apart (breakup ceiling), and split halves are pulled straight back
together (rift-then-merge). The shipped band-aids (merge-immunity, continental-rift
cooldown, lenient rift trigger) only paper over this.

## The physics we approximate

- **Mantle convection** drives plates: hot **upwellings** rise and spread laterally
  at the top (surface **divergence** → rifting/spreading), cold **downwellings** pull
  material in (surface **convergence** → subduction/assembly). Plates are dragged along
  the top of these cells (basal traction).
- **Supercontinent insulation → doming.** A large continent insulates the mantle
  beneath it; heat accumulates, an upwelling grows, and it **rifts the continent apart**
  — the only driver that creates *new* divergence under an assembled continent (the
  Wilson cycle; how Pangaea broke up). Slab pull / ridge push on the margins can't.
- **Volcanism** rides the same field: **arc** volcanoes above subducting slabs
  (convergent margins), **ridge** volcanism at divergent margins, **hotspots** over
  fixed mantle plumes (a drifting plate leaves an age-progressive chain — Hawaii), and
  **flood basalts / large igneous provinces** where a doming upwelling breaches a
  continent at breakup (Deccan/Siberian Traps). So motion change and volcanism share
  one cause.

## Chosen model — an evolving mantle field the plates ride

Precedent: we already run coarse evolving surface fields advected per epoch (the
256×128 **ocean-age** field) and a **streamfunction Poisson solve** (the ocean-current
gyres, `climate/oceanCurrents.ts`, Gauss-Seidel). The mantle field reuses both patterns.

1. **Field** — a coarse buoyancy/temperature field `T(x,y)` under the whole torus
   surface (grid like ocean-age). Hot = upwelling, cold = downwelling.
2. **Evolution per epoch** (bounded, so no runaway):
   - **Insulation:** where continental crust (rafts) sits, `T` accumulates over time
     (the doming driver).
   - **Cooling/downwelling:** under subduction zones and old, cold ocean, `T` drops.
   - **Ridges:** `T` high at divergent boundaries (already upwelling).
   - **Diffusion** (heat spreads) + **decay toward a baseline**.
3. **Flow from the field:** solve a Poisson problem for a potential `φ` with
   `∇²φ = T − T_mean` (reuse the ocean-current Gauss-Seidel), then surface horizontal
   flow `u = ∇φ` — diverges from upwellings, converges to downwellings. One smooth,
   wrapped flow field.
4. **Kinematic coupling (stable, no force integration):** each epoch, **fit each
   plate's rigid motion to the mantle flow under its footprint** — a least-squares fit
   of `{ drift, spin }` to the sampled `u` over the plate's cells, blended with the
   previous epoch's motion for inertia. Because the motion is a bounded function of a
   bounded field, this avoids the runaway/limit-cycle risk of integrating forces.
5. **Emergent Wilson cycle:** plates drift toward downwellings → continents assemble;
   the assembled continent insulates → an upwelling grows beneath it → the local flow
   reverses → its plates are pushed apart → **breakup, and the halves actually drift
   apart** (the thing fixed motions can't do). Then the band-aids can be **retired**.

### Volcanism (Phase M3, from the same field)

- **Arc** volcanoes at subduction boundaries (the surface classification already knows
  these) → volcanic mountains on the overriding side.
- **Hotspots** = a few persistent upwelling columns fixed in the mantle frame; as a
  plate drifts over one it punches an **age-progressive chain** (island arc / seamount
  trail).
- **Flood basalts / LIPs** where a doming upwelling breaches a continent at breakup →
  a **volcanic plateau** terrain feature + an eruption event/marker.
- **Scale:** at ~8 km/cell individual cones are sub-grid — we represent **provinces and
  chains** (arcs, hotspot trails, flood-basalt plateaus), consistent with the macro view
  (same as rivers).
- **Surface effects:** new volcanic **terrain features** (elevation), eruption
  **events**/markers, and an optional **volcanism overlay**.

## Representation prerequisite

`PlateMotion` changes from `{ center, angularSpeed }` to `{ driftX, driftY, spin,
centroidX, centroidY }`. `getVelocityAt = drift + spin·(ẑ × wrappedDelta(p, centroid))`
(callers unchanged). The four finite-step `rotateAroundCenter(...motion...)` advections
(oceanAge, rafts, terrainFeatures, plateSimulation seeds) become a **rigid advance**
(rotate about centroid by `spin·step`, then translate by `drift·step`, wrapped) plus its
**inverse** for ocean-age's backward semi-Lagrangian step. NOTE: this subtly changes the
finite-step advection (exact offset-center rotation → rotation+translation), so it is
**not a pure no-op** — verify the sim stays healthy via the harnesses, not bit-identical.

## Phasing (each phase independently verifiable, like the raft/climate builds)

- **M1 — Motion representation. DONE 2026-07-25.** `PlateMotion` is now
  `{ driftX, driftY, spin, centroidX, centroidY }`; `getVelocityAt` unchanged for
  callers; added `advancePointByMotion` (rigid advance) + `reversePointByMotion`
  (inverse, for ocean-age's backward step); the 4 finite `rotateAroundCenter(...motion...)`
  advections (oceanAge, rafts, terrainFeatures, plateSimulation seeds) now use them.
  `generatePlateMotions` seeds drift+spin equivalent to the old Euler pole. Harness-
  verified (160 epochs, dispersed + supercontinent): 0 NaN, raft cycle intact
  (supercontinent oscillates 1–2, dispersed 1–3), land/features healthy. No visible
  change — the field-driven update is M2.
- **M2 — Mantle field + coupling (the payoff). DONE 2026-07-25.** New `mantleField.ts`:
  a coarse 128×64 `T` field, `createMantleField` (smoothed random blobs → convection from
  epoch 0), `evolveMantleField` (continents +INSULATION, ocean −COOLING, 1 diffusion pass,
  DECAY to zero mean, clamp), `computeMantleFlow` (Gauss-Seidel Poisson `∇²φ=T−mean` → `u=∇φ`,
  scaled by FLOW_SPEED_SCALE), `fitMotionsToFlow` (each coarse cell → nearest plate seed →
  least-squares rigid `{drift,spin}` fit). `plateSimulation`: `sim.mantle` state; `stepEpoch`
  step 0 evolves the field, computes the flow, and relaxes each motion toward the fit by
  `MANTLE_COUPLING_RATE` (0.15). **Harness-verified: the Wilson cycle EMERGES** — supercontinents
  assemble AND break up (raft count oscillates 1–4/1–5 across seeds; fixed motions never broke
  them), field bounded (~[−1.2, 1.1]), 0 NaN, plate speeds ~75–115 avg (variable, physically
  motivated, near the old 30–90 band). TUNING that mattered: FLOW_SPEED_SCALE (speed) + 1
  diffusion pass (over-diffusion flattened the upwelling and starved breakup). Mantle NOT
  serialized — regenerated fresh on restore (independent RNG). **Band-aids REVIEWED 2026-07-25
  (harness A/B, 3 seeds × 300 epochs; metric = breakups / collisions / raft min-max / strobing
  = max breakups in any 20-epoch window / tail breakups):** only one was truly a fixed-motion
  crutch. **Merge-immunity RETIRED** (`SPLIT_MERGE_IMMUNITY_EPOCHS` 30 → 0): identical to
  baseline (7 breakups, raft 1–4, no strobing) because the mantle upwelling now drives the split
  halves apart on its own. **Cont-rift cooldown KEPT** (`CONT_RIFT_COOLDOWN_EPOCHS` = 40): not a
  band-aid after all — removing it (0) still strobes catastrophically *with* the mantle field
  (breakups 7 → 73, strobing 1 → 12, raft → 35), because coupling relaxes motion only ~0.15/epoch
  and the fixed Voronoi lattice keeps the rift point divergent long before the flow reverses; it's
  a legitimate rate-limiter. **Lenient trigger KEPT** (`CONT_RIFT_LOCK_EPOCHS` 20 /
  `CONT_RIFT_THRESHOLD_FACTOR` 0.55): the strict plate-rift threshold (40 / 1.0) also breaks
  continents up but fewer/smaller (5 vs 7 breakups, raft to 3 vs 4) — lenient gives a livelier,
  more dramatic Wilson cycle without strobing, so it now tunes breakup vigour rather than
  compensating for fixed motions. The three constant comments in plateSimulation.ts were rewritten
  to this reality.
  - **Classification of the two kept constants (2026-07-25) — where they sit on the
    artifact ↔ real-physics axis:**
    - *Lenient continental-rift trigger = a real mechanism, only PRESCRIBED not EMERGENT.*
      Continents rift on less divergence than oceanic ridges because an insulating
      supercontinent traps heat (the very `INSULATION_RATE` doming the mantle field models),
      which thermally weakens the lithosphere and lowers the rifting stress — that is the
      genuine Wilson-cycle breakup driver. It also compensates a modelling gap: the kinematic
      mantle coupling (rate 0.15) under-transmits the doming's divergence signal to the boundary
      accumulator, so the lenient threshold makes up the difference. In a fuller model
      (temperature-dependent lithospheric strength, crustal thickness, inherited weak zones) the
      leniency would *emerge*; the **effect** (continents rift more readily) would remain — you'd
      change its derivation, never remove it. Verdict: keep; it's physically honest.
    - *Cont-rift cooldown = an ARTIFACT of static plate boundaries* (theoretically removable).
      It stands in for a missing model feature: real rifts become spreading ridges / new ocean
      basins (rift → ridge → passive margin), so the rifted spot literally *becomes ocean* and
      cannot re-qualify as a continental rift. The fixed Voronoi lattice never reorganizes, and —
      critically — the continental rift (`raftSplit`) moves the raft halves apart but, unlike the
      plate rift (`applyRift`, which already pushes a new oceanic seed), does NOT birth an oceanic
      plate in the gap; so the same two continental seeds stay adjacent+divergent and re-fire every
      epoch. The cooldown (and its being GLOBAL, not per-margin — it would wrongly block a second
      supercontinent from rifting) is the crutch for that. It disappears once the continental rift
      also spawns a ridge plate (see the follow-up below). Verdict: keep for now; retire with
      dynamic boundaries.
  - **Follow-up (scoped 2026-07-25) — retire the cooldown by giving the continental rift a
    spreading ridge.** The plate rift already does exactly the needed thing (`applyRift` pushes a
    new oceanic seed at the rift so the gap becomes young ocean). Options: (A) **minimal** — make
    `raftSplit` also insert an oceanic seed at the rift point, so the spot becomes ocean, its
    `raftMembership` drops, and it can't re-qualify as a continental rift → no strobing, cooldown
    removable. Small, local, cheap (~1 seed per breakup, ~7/300 epochs; merges keep `seeds.length`
    bounded). (B) **local margin state** — replace the global timer with a per-lattice "recently
    rifted" flag; cheaper but still a band-aid, only less crude (fixes the global-blocks-everything
    wrongness). (C) **full rift→ridge→passive-margin lifecycle** integrated with `oceanAge` for
    symmetric Atlantic-style opening; biggest, best realism, but really (A) done thoroughly.
    Compute: NONE change complexity — per-epoch cost is dominated by the fixed-size boundary scan
    (256×128 = 32,768 lattice points × `seeds.length` nearest-seed search) + the 128×64 Poisson
    solve; the options only nudge `seeds.length`, which the Wilson cycle's merges already bound.
    Recommended: (A). **DECIDED 2026-07-25: build (C)** — the user explicitly chose the full
    rift→ridge→passive-margin lifecycle integrated with `oceanAge` ("keine Angst vor grossen
    Brocken, wenn es der sim hilft"), not the minimal (A). So: continental rift births a real
    spreading ridge that seeds age-0 ocean in the widening gap, the new seafloor ages/spreads
    symmetrically (Atlantic-style opening), the old rifted edges become passive margins, and the
    global `CONT_RIFT_COOLDOWN_EPOCHS` is retired once the rifted spot genuinely becomes ocean and
    can no longer re-qualify. (A) is the first phase of (C). **BUILT 2026-07-25 — with an honest
    finding that changes the outcome.** Implemented: `birthRidgePlate` (a young oceanic plate is
    born at every continental rift, mean-velocity drift so the basin opens symmetrically, age-0
    seafloor); `coolMantleAt` (the breakup releases the local mantle dome — the LIP/plume-head
    heat escapes); and a negative-lock **passive-margin recovery** in a radius around the rift (the
    ruptured zone must re-establish sustained divergence before rifting again). **But full
    retirement of the global cooldown proved NOT cheaply achievable, contra the original analysis.**
    The analysis was half-right: `birthRidgePlate` kills SAME-spot re-firing, but a single assembled
    supercontinent domes across the WHOLE torus and rifts all over that dome — and the local
    mechanisms (ridge birth, mantle release, margin recovery) act locally while the dome is global,
    and the ~0.15/epoch motion coupling keeps neighbouring points diverging faster than they drain.
    Harness (3 seeds × 300 epochs): cooldown 0 + ridge birth alone = 114 breakups (heavy strobing);
    + mantle release = 60; + zone lock-reset = 33; + dome-wide release (r900) = ~30 — never clean.
    **Resolution: the global cooldown is KEPT but reframed + HALVED (40 → 20).** It is a legitimate
    GLOBAL breakup-STAGING interval (a supercontinent rifts in pulses, not all at once — Pangaea),
    not a fixed-motion band-aid; the Option-C machinery is what let it halve while staying clean.
    Result at cooldown 20 (4 seeds × 300ep): 13-14 breakups (LIVELIER than the old 40's 7),
    **max 1 breakup per 20-epoch window (zero strobing)**, raft 1-4/1-7, seeds bounded (5-26,
    ridge plates born then subducted → real ocean basins open + close), 0 NaN; tsc + dev clean. The
    cooldown's one real defect (global → also gates a 2nd separate supercontinent) is mitigated by
    being short + rarely biting (one dominant landmass). Net win regardless: real ocean basins now
    open at breakup (Atlantic-style), the dome is released, margins go passive. FULL retirement is
    deferred — it needs a deeper change (break the dome's coherence at breakup, or a much faster
    motion response). Constants: `RIFT_COOL_RADIUS/AMOUNT` (380/1.8), `RIFT_RESET_RADIUS` (400),
    `RIFT_MARGIN_RECOVERY_EPOCHS` (45), `CONT_RIFT_COOLDOWN_EPOCHS` (20).
  - **Coupling of the two remaining knobs, and why full retirement was declined (2026-07-25).**
    The lenient continental-rift trigger and the cooldown are COUPLED: both tame strobing and both
    feed liveliness (inversely). Strobing needs BOTH abundant rift candidates AND no rate-limit, so
    you can tame it by removing either — a rate-limit (cooldown) OR a strict trigger that keeps
    candidates scarce. Verified matrix (Option-C machinery always on, 300 epochs): lenient+cd20 =
    13-14 breakups, no strobing, **plate count healthy (min 5)**; lenient+cd0 = 114 breakups
    (strobing); strict+cd20 = 4-7 (doubly-limited); strict+cd0 = 2-7, strobe-free BUT the plate
    count terminally **COLLAPSES to 1** on some seeds (~epoch 200, stuck — a single plate has no
    boundaries to rift back from); a middle trigger (0.75/30)+cd0 still collapsed on some seeds.
    KEY: the lenient trigger is *load-bearing for plate-count health* (its continental rifts birth
    ocean plates via `birthRidgePlate` that offset merges), not merely a liveliness knob — so it
    can't be traded away to drop the cooldown. **DECISION: keep lenient trigger + cd20** (the user
    confirmed "leave it as we had it"). The cooldown stays; it earns its keep.
- **M3 — Volcanism. DONE.** Hotspots 2026-07-25; arc + flood basalts followed — `collectVolcanoes`
  now emits all three kinds (`hotspot` / `flood` / `arc`), and since 2026-07-29 they have
  their own overlay, split off the mantle field's.
  `sim.hotspots` = 5 fixed plumes (world coords, stationary in the deep-mantle frame);
  `depositHotspotVolcanoes` (in stepEpoch, throttled to every 2 epochs) finds the
  overlying plate at each plume and deposits a `range` feature there with tangent =
  plate-motion direction (so successive deposits line up into a chain), marked
  `plateB = -1` (dedicated hotspot id — never merges with boundary ranges, immune to
  merge index-shifts) and `subsides: true` (the trail fades with age → old seamounts
  sink → the feature prune bounds chain length). Harness-verified: chains form on 4–5/5
  plumes, feature count bounded (~30–45), visible thickness, 0 NaN. Remaining: **arc**
  volcanoes (subduction boundaries already build arc ranges — could mark/enhance them)
  and **flood basalts** (a big volcanic province at a continental-rift/breakup event).
  Optional: distinct volcanic RENDERING (currently they read as ordinary mountains/
  islands) + a mantle-field/volcanism overlay. NOTE: vigorous M2 tectonics accumulates
  more boundary features on some seeds (total ~2–5k over long runs) — a pre-existing
  prune-tuning item, not caused by hotspots (which are bounded).
- **M4 (optional) — refinement.** Tuning, overlays, perf (the field adds a coarse
  advection/diffusion + one Poisson solve per epoch — comparable to ocean currents).

## Verification

Extend `stabilityTest.ts` / `eventsTest.ts`: field and motions stay **bounded** over a
long run; a clustering=1 world **breaks up AND inter-half distance grows** (no re-merge)
WITHOUT the band-aids; hotspot chains are **age-progressive**; assemble/break cycle count
stays healthy over ~260 epochs.

## Scope, risk, alternatives

- **Scope:** big — touches the sim's motion core + adds a mantle field + volcanism.
  Phased so M1 is safe and M2 is the pivotal, riskier step.
- **Main risks:** tuning the insulation/coupling to get a believable Wilson period; the
  M1 advection-semantics change; per-epoch cost (another coarse field + a Poisson solve).
- **Lighter fallback (was the earlier recommendation):** reactive boundary forces
  (slab-pull/ridge-push/collision/drag) + a **scripted** doming force, integrated on the
  drift+spin motion. Smaller, but keeps volcanism a separate bolt-on and scripts the one
  breakup rule instead of letting it emerge. The mantle field was chosen because it
  **unifies motion + volcanism** from one substrate.

## Relates to

- `docs/decisions/continental-crust-rafts.md` (rafts ride plate motion; band-aids live in
  `plateSimulation.ts` / `rafts.ts`).
- `docs/decisions/plate-tectonics-initial-state.md` (original unresolved drift-update gap).
- `climate/oceanCurrents.ts` (streamfunction Poisson solve to reuse), `oceanAge.ts`
  (coarse-field-advected-per-epoch pattern to reuse), `plateMotion.ts`.

## Status

M1 + M2 + M3 implemented (mantle field drives plates, Wilson cycle emerges,
all three volcanism kinds ship); M4 not built

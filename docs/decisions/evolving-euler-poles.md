---
summary: An evolving coarse mantle field drives the plates (kinematic coupling) so the supercontinent (Wilson) cycle and volcanism both emerge from one substrate, instead of fixed Euler poles + scripted band-aids.
date: 2026-07-25
status: planned; Phase M1 (motion representation) implemented; M2+ not built
---

# Evolving Plate Motion via a Mantle Field (+ Volcanism)

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
- **M2 — Mantle field + coupling (the payoff).** Add the coarse `T` field + evolution +
  Poisson flow; couple plate motions to the flow (rigid fit + inertia). The Wilson cycle
  emerges; **retire the band-aids**. Verify: bounded field/motion, supercontinent
  assembles then breaks up with halves drifting apart, believable cycle period.
- **M3 — Volcanism.** Arc + hotspot + flood-basalt provinces → terrain features +
  eruption events; optional volcanism overlay + a mantle-field overlay.
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

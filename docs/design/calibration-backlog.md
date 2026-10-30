---
id: DES-0027
title.en: The calibration's backlog — what phase 8 left open on purpose
title.de: Der Rückstand der Kalibrierung — was Phase 8 bewusst offen ließ
summary.en: The points the calibration of DEC-0036 (phase 8) measured but did
  not fix, so that the phase could close. Each entry has the measured state,
  the Earth reference, the suspected cause and an estimate. They are taken up
  one at a time, when a world shows the problem.
summary.de: Die Punkte, die die Kalibrierung von DEC-0036 (Phase 8) gemessen,
  aber nicht behoben hat, damit die Phase abschließen konnte. Jeder Eintrag
  hat den gemessenen Stand, den Erdbezug, die vermutete Ursache und eine
  Schätzung. Sie werden einzeln aufgenommen, wenn eine Welt das Problem zeigt.
area: generator
stage: building
createdAt: 2026-10-14
updatedAt: 2026-10-30
related: [DEC-0036, DEC-0035, DEC-0029, DEC-0003, DEC-0004, DEC-0006, DES-0016, DES-0019, DES-0020]
---

Recorded on the user's request (2026-10-14). The calibration (DEC-0036,
phase 8) closed with 8f (plate speed) and 8g (the uplift's rate, the mean
land height, the sphere's land share at 40 %), both 2026-10-14. The points below were measured on the way
and are skipped for now. The numbers are medians of 12 worlds per shape
(`npm run calibrate`, 2048 × 1024, archeanMa 1000, landShare 30) unless an
entry says otherwise; the phase's Status entries in
[fields-on-meshes.md](../decisions/fields-on-meshes.md) hold the tables.

Estimates are agent hours, including a 12-world measurement and the golden
procedure.

## Relief and plates

1. **No wide high plateau (Tibet class).** The largest patch above 4500 m
   is 18–36 thousand km² (Tibet: ~2 500 thousand). Land above 4500 m is
   0.08–0.16 % (Earth ~0.4 %), almost all on narrow crests. Cause: the
   uplift makes no broad thickened crust; the plateau force balance of 8b-3
   (1 − h̄/4000 m) caps it. A plateau would also bring back the high summits
   at its rim, which 8d's buzzsaw made rare (≥ 8 km on 1 world in 12).
   Found in 8b-3 and 8d. 4–6 h.
   *8g: not resolved, further off.* The uplift is a physical rate now, and
   the plateau's balance went from 4000 to 3000 m to hold the broad 2–3 km
   highlands that slow boundaries through continents build (entry 24); a
   plateau as wide and high as Tibet is rarer still. A plateau needs the
   thickening to spread sideways (the wedge widening, lower-crust flow),
   which the model does not have.
   *8g-2: closer, not resolved.* The uplift acts at the continents'
   margins now (entry 24): the largest patch above 4500 m is 53 / 53
   thousand km² (torus / sphere; 8g: 8 / 8), the land above 4500 m 0.46 /
   0.28 % (Earth ~0.4). A Tibet needs a collision that goes on after the
   suture (entry 28).
2. ~~**No keel drag.** Continental plates move as fast as oceanic ones
   (57 / 58 km/Myr torus, 48 / 53 sphere; Earth 10–30 / 50–100). The plates
   follow the rigid fit of the mantle flow without a force balance. Found
   in 8f. 3–5 h.~~
   Done 2026-10-29 (TEG-51): each plate's fitted motion is scaled by
   1 / (1 + `keelDrag` · f), f the continental crust it carries over its
   footprint (tectonics/epoch/mantle_coupling.rs `keel_factor`), and the
   mantle's flow is faster to bring the oceans back
   (`mantleFlowSpeedKmPerMyr` 16 → 28). Not a force balance. 6 seeds per
   shape (torus / sphere), 2048 × 1024, archean 200, epochs 1–100, the
   speed weighted by the crust's area, continents / oceans: before
   (with entry 4) 47 / 46 and 33 / 45 km/Myr; with `keelDrag` 3 and 25
   km/Myr 22 / 49 and 21 / 42; after entry 27 that setting gave a ratio
   of 0.52 on both shapes, so `keelDrag` 4 and 28 km/Myr: 23 / 55 and
   21 / 53 (ratio 0.42 / 0.39). By plate (a plate with more than half of
   continental crust against one with less than 15 %): 37 / 86 and 19 /
   73. The coupled history at epoch 40: 30 / 81 and 24 / 71. Tried on the
   way: `keelDrag` 2 with 22 km/Myr (25 / 46, 24 / 39), 3 with 30 (34 /
   68, 24 / 42), 4 with 30 (25 / 61, 21 / 42), 4 with 25 after entry 27
   (25 / 55, 21 / 48). The sphere's oceans gain little past 25 km/Myr. A
   seed makes a different world (pipeline v15).
3. **The supercontinent cycle is too short.** Assembly intervals of
   15–175 Ma on the torus (a noisy proxy), one assembly on one of three
   sphere seeds (Earth 400–600 Ma). It may not be reachable with today's
   mantle model; the largest uncertainty in this list. Found in 8f. 4–6 h,
   or a design question first.
4. ~~**Seeds cluster and freeze a world (sphere).** Seed zulu, 600 plain
   epochs: from about epoch 200, 11 of 12 seeds crowd one region; plates
   with no mantle cells fit no motion and crawl at 6–10 km/Myr against a
   fit of 35–50; no merge fires. Cause: the fit's nearest-seed footprint.
   Beyond the screen's 100 epochs. Found in 8f. 2–4 h.~~
   Done 2026-10-29 (TEG-53, TEG-104): each epoch, before the fit, a
   plate's seed moves `seedRecentreRate` (5 %) of the way to its
   footprint's centroid on the mantle mesh — a damped Lloyd step
   (tectonics/epoch/mantle_coupling.rs `recentre_seeds`). 6 seeds per
   shape (torus / sphere), 2048 × 1024, archean 200, 600 plain epochs,
   before → after: the Clark–Evans ratio of the seeds (1 a random
   pattern, over 1 spread) at epochs 500–600 0.54 / 0.95 → 1.31 / 1.39
   (epoch 100 0.82 / 0.91 → 1.32 / 1.36); the plates at epoch 600 3 / 9
   → 12 / 11.5, the fewest after epoch 100 3 / 6 → 8.5 / 7; plates with no
   mantle cell after epoch 200 0 / 0.08 an epoch → 0 / 0; the speed at
   epochs 300–600 28 / 22 → 36 / 29 km/Myr. The coupled history (60
   epochs): the land at epoch 60 31.1 / 31.1 → 30.9 / 30.9 %, its mean
   height 1060 / 788 → 922 / 732 m. With entries 2 and 27: the ratio
   1.21 / 1.39, 18 / 13 plates at epoch 600. A seed makes a different
   world (pipeline v15).

## Ocean margins

5. **Island arcs never rise in the history.** The uplift acts on land
   only. Found in 8e. Together with 6–8: 3–5 h.
6. **The tectonics' trench features sit 468 km (`trenchOffsetM`) inside the
   subducting plate**, not at the boundary; the history's trench term
   (8e, `tectonics/trench.ts`) is placed correctly. The synthesis trench
   deck is still clamped at −1 (golden worlds only).
7. **No outer rise, no sediment fill in trenches.**
8. ~~**The shelf is narrow.**~~ Done 2026-10-27 in
   [shelf-and-sea.md](../decisions/shelf-and-sea.md) (DEC-0049): 6.2 / 4.5 %
   of the ocean, 50 / 66 km; the coast's length stays. Was: 2.6–4 % of the ocean (Earth 7.3 %), median width
   34–38 km (Earth 50–80). Most of the gap is coast length: the coast is
   about 3–4× shorter than Earth's at scale, smooth at 8–31 km nodes. Deep
   ocean nodes are 160 km apart at budget 4, so a 100 km trench shows as a
   chain of beads on the map.
9. ~~**Enclosed sub-sea basins** take the sea level, not their own level, as
   the cap for deposits (already listed in DES-0016). The still-water
   variant of 8c gave mixed results.~~
   Done 2026-10-30 (TEG-57): a node below the sea that the world ocean
   does not reach (not a seed of the flood, which seeds only the largest
   sub-sea component) fills to its own spill level plus the freeboard, as
   a lake does (surface/erosion_engine.rs `sediment_cell`). 12 seeds per
   shape (torus / sphere), 2048 × 1024, archean 200, epochs 1–100, before
   → after: the deposit the sea's cap refused there 3.6 / 3.2 M km³ (23 /
   23 % of what such basins took) → 0; the sub-sea bodies of the hydrology
   at epoch 100 74 / 59 → 65 / 46 (with entry 18; 51 / 35 with entry 26),
   their area 836 / 602 → 1045 / 426 thousand km². Measured on Zephyra
   before: a cut-off ocean basin of 416 thousand km², floor −4331 m,
   spill +367 m. Left, as a note: such a basin is a lake to the hydrology
   but sea to the climate.

## Climate

10. **Too much Cwa.** About 10 % of all land below 30° is Cwa, mean height
    780 m: on highland tropical margins the coldest month falls under
    18 °C. The temperature gradient does not move it. Found in 8b-2. Together
    with 11–13: 4–6 h.
11. **The history's cheap seasonal range is small**: ~14 °C on polar coasts
    (Earth 20–30). The ice depends on it since 8b-2 (summer melt).
12. **The torus is cold**: mean 5.4 °C, ice 35–38 % of land, because about a
    third of its land lies above 60°. It may be a property of the shape
    rather than a fault. **Accepted as the shape's (2026-10-29):** the
    torus maps its rows linearly to latitude (DEC-0035), so every band of
    latitude has the same area and a third of the land lies past 60°; each
    band is as warm as the sphere's (Zephyra: 4.0 °C, reweighted to the
    sphere's band areas 12.5 °C). Not a fault of the climate.
13. **A rainless 8.5 km range (sphere calibration seed, 28°)**: all eight
    highest peaks get less than 0.5 mm/yr, so no ice at any height. A dry
    belt is plausible, a rainless high range is suspicious — the orographic
    rain may miss it. Found in 8d.
14. **Earth's relief run on the sphere** is 1.5 °C cold at its places, and
    its Köppen group shares are 13 points off (11 before 8b-2). Found in
    8b-2.
    *Instrument back 2026-10-29 (TEG-105):* `node
    engine/scripts/earthClimate.mjs [shape=torus]`, on the engine's native
    build (it was the TypeScript one, removed 2026-10-21). Baseline at
    ef0db233, sphere: places 18/47 class, 35/47 group; January 4.0 °C,
    July 3.8 °C off (bias of the mean −1.5 °C, of the swing +0.9); rain
    ×1.74; groups A 19 / B 24 / C 15 / D 22 / E 19 % of the land (Beck
    23 / 27 / 13 / 22 / 15), 14 points off; per cell 37 % right class,
    70 % right group. Torus: 17/47, 33/47; 4.1 / 3.7 °C; ×1.86; 16 points.
    The upslope rain runs at its world rate now (the TypeScript instrument
    ran it at 1/2.5): at 1/2.5 the sphere reads ×1.72 and 13 points, as
    above. Still open: the bias holds.

## Small points

15. **Do basins under an ice sheet count as lakes?** `computeLakesOn` does
    not know the ice; on the torus 3.7–7.2 points of land are frozen basins
    under ice sheets. A decision for the user, then a small change to the
    metric. Found in 8c. 1 h.
16. ~~**`peakOverElaM` reads −11 km**~~ on worlds whose peak never holds ice
    (the "never" value enters the median); the alpine metric of 8d works
    around it. 0.5 h.
    Done 2026-10-15: such a world records `peakOverElaM` as NaN and
    `peakNeverIce` 1; the summary prints the median over the rest and the
    count of such worlds.
17. **The ice's sliding cut keeps its 800 m per epoch cap**, which also
    bounds troughs and fjords. Found in 8d. 1–2 h.
18. ~~**Lake floors cut inside an epoch**: the engine cuts lake-floor nodes
    once the uplift lifts them above the old flood level. The routing every
    iteration (8c) mostly removes the stale level; what remains is not
    checked. 1 h.~~
    Done 2026-10-30 (TEG-65): the stream power never read the lake. A node
    whose flood level stands above the z it was routed on (by the
    hydrology's FLOOD_EPS) cuts nothing now (surface/erosion_engine.rs
    `fluvial_cell`; the single solver keeps the routed z as the pipelined
    one does). Not `filled > z`: the routing is one iteration old, and a
    node that the last iteration cut or lowered stands below its own
    level without being a lake. 12 seeds per shape (torus / sphere), 2048
    × 1024, archean 200, epochs 1–100, before → after (with entry 9): the
    cut on lake floors deeper than 1 m 3.4 / 2.8 % of all fluvial cut (up
    to 3.5 / 4.4 km on one node in an iteration) → 0; the land at epoch
    100 31.7 / 28.4 → 32.0 / 28.7 %, the lakes 5.9 / 4.0 → 6.4 / 4.0 % of
    it, the mean land height 763 / 719 → 794 / 748 m at epoch 40, 1210 /
    854 → 1300 / 926 m at epoch 100.
19. ~~**Coarse sea nodes become land** before the next remesh
    (`remeshEvery` 3); up to 95 000 km², cut 2.2 km in one epoch. Not a lake
    cause (8c). 1–2 h.~~
    Done 2026-10-29 (TEG-66): the coarsening thins the deep ocean to its
    160 km ahead of a raft's leading edge, and the moved baseline lifts
    those nodes above the sea in the next epoch. An epoch whose land holds
    a node coarser than twice the land's widest spacing (62.4 km at budget
    4, `HISTORY_DEFAULTS.remeshCoarseLand`) remeshes now
    (pipeline/coupled_epoch.rs `has_coarse_land`). Three worlds at full
    size (spheres m15 and Thalassor, torus Zephyra; 101 / 81 / 100
    epochs), before → after: in the epochs without a remesh the coarse
    land took at most 32 / 20 / 36 % of the land's cut in an epoch
    (median 0.12 / 0.14 / 0.58 %), now 0 (at most 0.16 % in any epoch);
    one node's cut in an epoch up to 4.4 km, now under 1 km. Remeshes in
    66 / 54 / 68 epochs (was 33 / 27 / 33); the replay +9 / +9 / +14 %
    (240 → 262, 156 → 171, 171 → 194 s). The land 26.0 → 25.9, 24.6 →
    24.6, 22.5 → 22.6 %; its mean height 748 → 754, 649 → 647, 1201 →
    1238 m; the lakes 1.9 → 1.8, 5.1 → 4.0, 5.7 → 5.8 % of the land (the
    last epoch; the lakes move a point from epoch to epoch). A seed makes
    a slightly different world (pipeline v15, no longer v14's worlds).
20. **Replays of old saves differ**: the collapse constants of 8b-3 are in
    no artifact key. 0.5 h.
21. ~~**The sample world's u16 encoding** clips summits above 9 km in a baked
    preview~~. 0.5 h.
    Done 2026-10-29: `worldLayers.ELEVATION_ENCODING` spans −2..2 (±18 km,
    a step of 0.27 m), was −1..1 (±9 km, 0.14 m), so a summit above 9 km
    and a trench below −9 km (the field has neither bound) keep their
    height. The two sample files were transcoded from the old range (their
    heights lie within 1.7 km / 5.6 km and −5.2 / −5.5 km, so nothing was
    clipped in them; worst change 0.14 m); the screen and
    `scripts/sampleWorld.mjs` read the one constant.
22. ~~**Golden's `erosion.deltaCells` counts the sea-level change**~~: it counts
    sea cells that rose over the last epoch, so a sea that falls by 0.7 m
    puts nearly the whole ocean in (90–124 k against 1.35–1.44 M cells,
    by the sign of `seaShift`). Deterministic, so the baseline holds, but it
    does not measure deltas. Fix: compare against the pre-erosion height
    plus the sea shift. Found in 8f. 0.5 h.
    Done 2026-10-15: the metric takes out the last epoch's sea shift and
    counts a sea cell that rose more than 1 m (76 k / 108 k / 191 k cells
    on the three golden seeds, was 1 152 k / 99 k / 144 k).

## Found in 8g

23. **Hotspot piles in the synthesis deck.** A plume deposits
    `hotspotDepositPerEpoch` (4) every second epoch onto the feature it
    finds within the merge radius (312 km). At 50 km/Myr the plate carries
    the feature out of reach in about 6 epochs, so one feature takes 20+
    thickness units, the largest in the world for the first 15–25 epochs
    (4 of 4 worlds measured). Until 8g it set the history's uplift scale
    and stood under the full rate itself (the narrow 11–15 km ranges of
    8f); since 8g a hotspot forces no uplift in the history, but the
    synthesis deck (a world restored from before its history) still
    stands the pile as height. A deposit per km of plate motion, as the
    boundaries have since 8f, would be the fix. Found in 8g. 1–2 h.
    *8g-2: not touched.*
24. ~~**Too much land at 2–3 km, too little above 4500 m.**~~ After 8g the
    land above 2000 m is 9.2 / 7.0 % (torus / sphere; Earth ~5) and above
    4500 m 0.07 / 0.04 % (Earth ~0.4); the mean land height is on target
    (728 / 735 m). Every slow boundary through a continent now thickens it
    at the rate it closes (the rafts are decoupled from the plates, so a
    plate boundary runs through a continent where it falls: on the
    calibration seed 7–38 % of the land lies under a positive uplift), and
    broad highlands stand where the erosion is slow. The variants of 8g
    trade one target against the other (the table in fields-on-meshes.md,
    phase 8g): a lower plateau balance cuts the 2–3 km band and the high
    land with it; a higher column balance lifts the high land and lets the
    odd seed's range pass 12 km. Note that 3 seeds per shape misled here:
    calibration / alpha / zulu put the sphere's land above 2000 m at 15 %,
    the 12 seeds at 7. Found in 8g. 3–5 h.
    *Resolved in 8g-2* (fields-on-meshes.md, phase 8g-2): the relief
    reads the crust on each side of a boundary and the plate that carries
    it. A plate boundary through one raft converges at nothing (one plate
    carries both sides) and builds at 0.3 of its rate; the ranges stand at
    the continents' own margins with another plate, which the Voronoi
    boundary missed (72–84 % of them). The land above 2000 m 5.3 / 5.2 %
    (torus / sphere), above 4500 m 0.46 / 0.28 %, above 6000 m 0.007 /
    0.002 %; the mean land height 745 / 640 m (the sphere's: entry 26).
25. **Plate boundaries diverge under continents at plate speed.** A
    divergent boundary under a raft is a rift (boundaryClassification), at
    the plates' 50 km/Myr, where a continental rift on Earth opens at 1–10.
    At the physical rate (8g) it lowered 15–23 % of the land by 0.4–1.4
    mm/yr and drowned 3–4 points in 12 epochs; 8g zeroes a rift's rate at
    its thickness floor (riftBasinFloorThickness), which holds the land,
    but a rift still lowers 1–11 % of the land by 0.3–0.7 mm/yr on its way
    there. The breakup is not tied to it. Found in 8g. 2–4 h.
    *8g-2: resolved for the relief.* A divergent plate boundary through
    one raft lays down nothing (the raft is rigid; the stress in a
    continent's interior is mostly compressive), and a raft that parts
    from the ocean opens new sea floor, not a rift; a rift is where two
    rafts on two plates part. Left: the continental breakup event
    (boundaryPass `continentalRift`) still fires on the plates' Voronoi
    divergence under a raft at the plates' speed.

## Found in 8g-2

26. **The sphere's land stands lower than the torus's.** Mean land height
    640 m (target 700–900; the torus 745 m), the land above 1000 m 12.0
    against 16.4 %. The sphere's continental margins close at about half
    the torus's rate (the edges where the crust's carrier changes next to
    a raft: p50 14–27 against 28–52 km/Myr, p90 42–74 against 77–91; 3
    worlds per shape, epochs 10–30), while its plate boundaries close at
    the same rate (p50 20–37 against 24–43 km/Myr, 6 seeds per shape). And
    56 % of the sphere's land lies within 30° of the equator (31 % on the
    torus), where the rain is heaviest. Why the margins are slower is not
    measured. A larger intraplate share would lift the sphere and push the
    torus's land above 2000 m past Earth's (0.4: 772 / 634 m, 6.5 / 4.8 %,
    6 seeds). Found in 8g-2. 2–4 h.
    *2026-10-30 (TEG-71): the shapes level at epoch 40, the torus's
    climb is left.* After entries 2, 4 and 27 the sphere stood lower only
    a little, and both shapes rose all history long. 12 seeds per shape
    (torus / sphere), 2048 × 1024, archean 200, the mean land height at
    epochs 40 / 60 / 100: 763 / 926 / 1210 and 719 / 790 / 854 m before
    this round, 794 / 998 / 1300 and 748 / 836 / 926 m with entries 18 and
    9. Target: 700–850 m on both shapes (Earth ~840), held from epoch 40
    to 100. The interior push `intraplateShortening` 0.3 → 0.2 and the
    plateau's balance `collapseHeightM` 4000 → 2500 m (the broad
    highlands at 2–3 km grew each epoch): 694 / 834 / 1020 and 679 / 722 /
    770 m; the land above 2000 m 5.2 / 8.0 / 12.9 and 4.7 / 6.2 / 7.7 %
    (was 9.2 / 14.0 / 24.5 and 5.8 / 9.1 / 11.8), above 4500 m 0.16 /
    0.21 / 0.19 and 0.28 / 0.32 / 0.19 % (was 0.6–1.2; Earth ~0.4); the
    land 31.4 / 31.1 / 31.5 and 29.1 / 29.1 / 28.5 %. Single knobs on 6
    seeds per shape, epoch 40 → 100: `uplift_scale` 0.8 814 → 1150 / 675
    → 790, `collapseHeightM` 3000 832 → 1160 / 691 → 803, 2500 799 → 1090
    / 678 → 764, 2000 with 0.15 696 → 903 / 629 → 695;
    `intraplateShortening` 0.15 771 → 1099 / 675 → 795, 0.6 1037 → 1540
    / 766 → 941. No uplift constant holds the torus: its land under ice
    grows (with 0.15: 26 → 33 % of the land from epoch 10 to 100, the
    land above 2000 m under ice 0.4 → 11 %; the sphere 7 → 9 and 0.2 →
    4 %), where
    the fluvial cut is 0 and the ice's cut is capped (entries 12 and 17).
    The climb is theirs. Above 4500 m the land is now below Earth's
    (entry 1).
27. ~~**The events still read the plates' derived type.**~~ The plate merge,
    the oceanic plate's consumption, the accretion at a subduction arc and
    the history's trench (tectonics/trench.ts) take a plate's type from
    the crust under its seed (DEC-0003's bridge); only the relief reads the
    crust beside the boundary since 8g-2. Measured 2026-10-14 (4 worlds,
    epochs 1–40): up to 17 % of the boundary points' deposit weight were
    boundaries with ocean on both sides classed as a subduction arc or a
    fold belt, so an accretion blob or a merge can fire where no
    continent is. Found in 8g-2. 2–3 h.
    Done 2026-10-29 (TEG-72): the boundary pass reads the crust 156 km
    into each side (`crustSideM`) for everything — the lattice's
    accumulation, the accretion (inset into the continental side along
    the boundary's normal), the merge and its oceanic plate's
    consumption (`MergeEvent.removed_oceanic`) — and the history's trench
    reads it at its point (tectonics/trench.rs). The plate rift's event
    and `derive_plate_types` stay for the rest. 6 seeds per shape (torus
    / sphere), 600 plain epochs, before (with entries 4 and 2, their
    final constants) → after: the convergent weight whose event
    character is not the crust's 24 / 30 % → 0 (epochs 1–100; ocean on
    both sides classed as an arc or a fold belt 9 / 15 % → 0);
    accretions in 600 Ma 1460 / 1490, 90 / 93 % of them where ocean
    meets ocean → 150 / 140, none; the continental crust's share at
    epoch 600 0.47 / 0.43 → 0.43 / 0.39 (0.36 / 0.35 at epoch 0; before
    entries 4 and 2 0.43 / 0.39). The coupled history at epoch 60: the
    land 31.8 / 33.2 → 29.9 / 29.1 %, its mean height 966 / 818 → 1010 /
    736 m, the land above 2000 m 13.8 / 9.5 → 14.8 / 6.7 % (the height
    is round 2's). A seed makes a different world (pipeline v15).
28. **A collision stops at the suture.** Rafts merge as soon as their
    coasts touch (mergeOverlappingRafts) and the merged raft rides one
    host plate, so the land across the suture converges no more; 0–1
    sutures formed per world in 40 epochs (3 worlds). The Himalaya-class
    relief comes only from fast ocean–continent margins (the highest
    summits 7–9 km, sampled every second epoch). India has pushed into
    Asia for 50 Ma after the suture; that would need a merged raft to keep
    two carriers for a while. Found in 8g-2; relates to entry 1. 3–5 h.
29. **The carriers' margins have no lock state.** Their age multiplier is
    1 (the Voronoi boundary's lattice counter does not follow them), and
    a margin's trench lies `trenchOffsetM` from the range at the coast,
    not from the plates' meeting line. Found in 8g-2. 1 h.
30. ~~**The history's highest node moves fast between the samples.**~~ The
    calibration samples the peak every tenth epoch; every second epoch on
    torus alpha and sphere zulu it reached 8.4 / 9.2 km where the samples
    read 7.8 / 7.0. Before 8g-2's integrated column balance a node beside a
    fast margin jumped by up to 5 km in an epoch (12.5 km). A per-epoch
    maximum in `npm run calibrate` would make the sampling exact. Found
    in 8g-2. 0.5 h.
    Done 2026-10-15: `calibrate` reads the peak after every epoch
    (`peakPerEpoch`, `historyPeakM`, `historyPeakEpoch`); torus alpha's
    history peak is 8571 m (epoch 39), its final peak 7837 m.
31. ~~**Too much ice.**~~ Done 2026-10-27 in
    [seasons-and-ice.md](../decisions/seasons-and-ice.md) (DEC-0050): the
    static annual range follows the refinement's; 31 / 5 % of the land,
    −67 to −85 m on the torus. Was: it covers 20–34 % of the torus's land and 15–20 % of
    the sphere's (Earth ~10 %); on the torus 10–14 % of the land between
    30° and 60° (sphere 0–3 %, Earth ~0); the sea it holds stands at −75
    to −170 m (torus) and −10 to −70 m (sphere). A glacial maximum as the
    steady state. Since DEC-0049 the sea no longer lays the shelf dry, but
    the incubator's glacial sea, and the climate, start from it. Found
    2026-10-27 (6 worlds, epoch 40). Not estimated.

## Status

2026-10-30: building — the list is worked one entry at a time (2, 4, 8,
9, 16, 18, 19, 22, 24, 27, 30 and 31 done, 25 for the relief, 26 at
epoch 40; 14 has its instrument back; see the entries below), the rest
stays open.

2026-10-29: building — entries 2, 4, 19 and 27 done.

2026-10-14: IDEA — the list, recorded when phase 8 was cut short. Take an
entry up when a world shows it; record its result in the doc of the
mechanism it changes, and strike it here.

2026-10-14: phase 8 closed with 8g. Entry 1 annotated; entries 23–25
found in 8g and added.

2026-10-14: phase 8g-2. Entry 24 resolved, entry 25 resolved for the
relief, entries 1 and 23 annotated; entries 26–30 found and added.

2026-10-15: entries 16, 22 and 30 done (tooling only, no change to the
worlds).

2026-10-27: entry 8 done (DEC-0049); entry 31 found and added, and done
(DEC-0050).

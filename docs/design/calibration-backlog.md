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
stage: idea
createdAt: 2026-10-14
related: [DEC-0036, DEC-0035, DEC-0029, DEC-0003, DEC-0004, DEC-0006, DES-0016, DES-0019, DES-0020]
---

Recorded on the user's request (2026-10-14). The calibration (DEC-0036,
phase 8) closes after 8f (plate speed) and 8g (mean land height, the
sphere's land share at 40 %). The points below were measured on the way
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
2. **No keel drag.** Continental plates move as fast as oceanic ones
   (57 / 58 km/Myr torus, 48 / 53 sphere; Earth 10–30 / 50–100). The plates
   follow the rigid fit of the mantle flow without a force balance. Found
   in 8f. 3–5 h.
3. **The supercontinent cycle is too short.** Assembly intervals of
   15–175 Ma on the torus (a noisy proxy), one assembly on one of three
   sphere seeds (Earth 400–600 Ma). It may not be reachable with today's
   mantle model; the largest uncertainty in this list. Found in 8f. 4–6 h,
   or a design question first.
4. **Seeds cluster and freeze a world (sphere).** Seed zulu, 600 plain
   epochs: from about epoch 200, 11 of 12 seeds crowd one region; plates
   with no mantle cells fit no motion and crawl at 6–10 km/Myr against a
   fit of 35–50; no merge fires. Cause: the fit's nearest-seed footprint.
   Beyond the screen's 100 epochs. Found in 8f. 2–4 h.

## Ocean margins

5. **Island arcs never rise in the history.** The uplift acts on land
   only. Found in 8e. Together with 6–8: 3–5 h.
6. **The tectonics' trench features sit 468 km (`trenchOffsetM`) inside the
   subducting plate**, not at the boundary; the history's trench term
   (8e, `tectonics/trench.ts`) is placed correctly. The synthesis trench
   deck is still clamped at −1 (golden worlds only).
7. **No outer rise, no sediment fill in trenches.**
8. **The shelf is narrow.** 2.6–4 % of the ocean (Earth 7.3 %), median width
   34–38 km (Earth 50–80). Most of the gap is coast length: the coast is
   about 3–4× shorter than Earth's at scale, smooth at 8–31 km nodes. Deep
   ocean nodes are 160 km apart at budget 4, so a 100 km trench shows as a
   chain of beads on the map.
9. **Enclosed sub-sea basins** take the sea level, not their own level, as
   the cap for deposits (already listed in DES-0016). The still-water
   variant of 8c gave mixed results.

## Climate

10. **Too much Cwa.** About 10 % of all land below 30° is Cwa, mean height
    780 m: on highland tropical margins the coldest month falls under
    18 °C. The temperature gradient does not move it. Found in 8b-2. Together
    with 11–13: 4–6 h.
11. **The history's cheap seasonal range is small**: ~14 °C on polar coasts
    (Earth 20–30). The ice depends on it since 8b-2 (summer melt).
12. **The torus is cold**: mean 5.4 °C, ice 35–38 % of land, because about a
    third of its land lies above 60°. It may be a property of the shape
    rather than a fault.
13. **A rainless 8.5 km range (sphere calibration seed, 28°)**: all eight
    highest peaks get less than 0.5 mm/yr, so no ice at any height. A dry
    belt is plausible, a rainless high range is suspicious — the orographic
    rain may miss it. Found in 8d.
14. **Earth's relief run on the sphere** is 1.5 °C cold at its places, and
    its Köppen group shares are 13 points off (11 before 8b-2). Found in
    8b-2.

## Small points

15. **Do basins under an ice sheet count as lakes?** `computeLakesOn` does
    not know the ice; on the torus 3.7–7.2 points of land are frozen basins
    under ice sheets. A decision for the user, then a small change to the
    metric. Found in 8c. 1 h.
16. **`peakOverElaM` reads −11 km** on worlds whose peak never holds ice
    (the "never" value enters the median); the alpine metric of 8d works
    around it. 0.5 h.
17. **The ice's sliding cut keeps its 800 m per epoch cap**, which also
    bounds troughs and fjords. Found in 8d. 1–2 h.
18. **Lake floors cut inside an epoch**: the engine cuts lake-floor nodes
    once the uplift lifts them above the old flood level. The routing every
    iteration (8c) mostly removes the stale level; what remains is not
    checked. 1 h.
19. **Coarse sea nodes become land** before the next remesh
    (`remeshEvery` 3); up to 95 000 km², cut 2.2 km in one epoch. Not a lake
    cause (8c). 1–2 h.
20. **Replays of old saves differ**: the collapse constants of 8b-3 are in
    no artifact key. 0.5 h.
21. **The sample world's u16 encoding** clips summits above 9 km in a baked
    preview. 0.5 h.
22. **Golden's `erosion.deltaCells` counts the sea-level change**: it counts
    sea cells that rose over the last epoch, so a sea that falls by 0.7 m
    puts nearly the whole ocean in (90–124 k against 1.35–1.44 M cells,
    by the sign of `seaShift`). Deterministic, so the baseline holds, but it
    does not measure deltas. Fix: compare against the pre-erosion height
    plus the sea shift. Found in 8f. 0.5 h.

## Status

2026-10-14: IDEA — the list, recorded when phase 8 was cut short. Take an
entry up when a world shows it; record its result in the doc of the
mechanism it changes, and strike it here.

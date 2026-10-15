---
id: DEC-0027
title.en: The uplift soft knee
title.de: Das weiche Knie der Hebung
summary.en: The uplift deck saturates through an isostatic soft knee (linear to 3000 m,
  exponential toward 6000 m) instead of climbing to the 9000 m clamp —
  ultra-high plateaus (2.5% of land above 6000 m; Earth ~0.001%) and their
  brim-full ice-cold basin lakes disappear, while ridged crests keep riding
  the raw crustal thickness. Rare true 7-8 km summits are out of this knob's
  reach and wait on a thickness-side treatment in the tectonics sim.
summary.de: Die Hebung sättigt über ein isostatisches weiches Knie (linear bis 3000 m,
  exponentiell gegen 6000 m), statt bis zur Grenze von 9000 m zu steigen —
  extreme Hochplateaus (2,5 % des Landes über 6000 m; Erde ~0,001 %) und
  ihre randvollen, eiskalten Beckenseen verschwinden, während Grate weiter
  der rohen Krustendicke folgen.
area: generator
stage: superseded
createdAt: 2026-08-16
updatedAt: 2026-10-14
supersededBy: DEC-0036
concepts: [generator.concept.plate-boundaries]
related: [DES-0016]
---

## The problem

Two user-reported symptoms on one screenshot (2026-08-16): lakes standing
above 6000 m, and — measured while chasing them — 2.5% of land above 6000 m
at default sliders, 7.5% at age 400 (Earth: ~0.001%). The lake census showed
every lake above 3000 m sitting in a PRE-erosion closed basin, 800–1400 m
deep at 6–7 km altitude, held brim-full by the cold-climate evaporation floor
(PET min 100 mm/yr at −50 °C). The erosion engine was innocent — age 400
drains 274 of 279 basins.

The decomposition put the cause in the elevation construction, not the
tectonics clamp: feature thickness is unbounded (long collisions stack it;
p50 ≈ 880 m, p90 ≈ 5250 m, p99 ≈ 9600 m, max ≈ 10000 m of implied uplift on
the measured world), and `computeElevation`'s capsule averaging turns that
fat tail into flat-topped DECKS at whatever height the thickness dictates —
the baseline contributes exactly nothing above 2000 m, the uplift deck alone
carried 12.1% of land above 6000 m. The 9000 m clamp itself caught only
0.03% of land; the plateaus form below it.

## The options

- **Hard cap on the deck** — the counterfactual showed a cap at 5500 m wipes
  the >6000 m land to 0.001% while moving total land only 11.4% → 11.2%. But
  a hard cap manufactures new decks AT the cap: the same pathology one floor
  down. Rejected.
- **Treat the thickness at its source** (bound collision stacking in the
  plate sim). The root treatment — but thickness feeds the crust budget and
  recycling, so it is the riskier surgery, and it is ALSO the only lever
  that can ever separate rare high summits from decks: deck and peak overlap
  in uplift *value* (4.6% of land sits above 7500 m raw uplift), they differ
  only in spatial extent, so no per-point function of uplift can keep one
  and kill the other. **Deferred, on the record by user request**: when rare
  Himalaya-class 7–8 km summits are wanted, this is where they come from —
  narrow the thickness tail so extreme values become spatially rare, then
  relax the knee.
- **Isostatic soft knee** (chosen): in `computeElevation`, the averaged deck
  passes through `u' = knee + span·(1 − e^−(u−knee)/span)` above the knee —
  linear below, C1-continuous at the knee, asymptotic to knee+span. The
  physical story is isostasy: more load presses the crust down; height
  saturates. The ridged detail term deliberately keeps reading the RAW
  uplift, so crests sharpen with true crustal thickness while the deck under
  them sinks.

## Calibration (seed alpha, 2048×1024, share of land)

| variant | >2000 m | >3000 m | >4500 m | >6000 m | peak |
|---|---|---|---|---|---|
| none (before) | 21.4% | 12.3% | 4.6% | 2.50% | 9000 m (clamp) |
| knee 3000 / span 3000 | 15.7% | 5.0% | 0.56% | 0.00% | 5695 m |
| knee 3500 / span 2500 | 17.3% | 5.9% | 0.73% | 0.00% | 5859 m |
| knee 2500 / span 2500 | 10.8% | 3.0% | 0.14% | 0.00% | 5331 m |
| Earth reference | ~5% | — | ~0.4% | ~0.001% | 8849 m |

Chosen: **3000/3000** — the >4500 m band lands nearest Earth's while the
2000–3000 m mountain mass stays generous (a game world wants mountains as
content). Peaks top out around 5.7 km until the thickness-side follow-up
exists; the goldens were re-anchored deliberately.

## Consequences

Every world changes shape above ~3000 m. The high closed basins lose their
altitude (their hollows survive lower, where PET is honest); frozen lakes at
−50 °C stop being a plausible state, and the separately-decided glacier
treatment (lakes below freezing render as ice) handles the remainder.
`applyMountainRedistribution` (display-only gamma) is untouched — it never
was part of the simulation truth.

## Addendum 2026-10-13: superseded by the plate's flexure

The user asked for Himalaya-class ranges, with no hard cap. The deferred
treatment above (narrow the thickness tail) was not needed: the fork it
named — deck and peak differ only in spatial EXTENT — is exactly what a
regional isostasy answers, and the field mesh had the solver for it since
DEC-0036 phase 6 (tectonics/flexure.ts, the plate equation). Built in
DEC-0036 phase 8b-3 ([fields-on-meshes.md](./fields-on-meshes.md),
Status, which has the tables):

- **The knee is gone** from `computeElevation`. The synthesis's deck is
  the raw crustal thickness as height; the plate carries its positive part
  as a load and the synthesis adds the deflection to the baseline
  (pipeline/coupledEpoch.ts `deckDeflection`). A deck wider than the
  flexural parameter (50–127 km on land) sinks towards its Airy share,
  1 − ρc / ρm = 0.18 of its height; a narrow one stands on the plate's
  strength.
- **The history's uplift loads the plate too**, both signs: the engine's
  uplift is now crustal thickening (or a rift's thinning), and the
  flexure takes it with the epoch's cuts and deposits.
  `HISTORY_DEFAULTS.upliftScale` 0.5 → 4 to match.
- **The plateau's force balance** (TECTONICS_TUNING.collapseHeightM
  4000 m over a 150 km regional mean): the thickening slows as the
  region's mean height rises, so a plateau stops while a narrow range goes
  on. The flexure alone cannot bound a plateau; it is linear.
- **The ±1 clamp has no ceiling any more** (the engine's uplift, the
  synthesis, the epoch's steps). The floor, −1 (9000 m below the sea),
  stays for the trenches.

## Addendum 2026-10-14: the uplift's rate from the plates

DEC-0036 phase 8g ([fields-on-meshes.md](./fields-on-meshes.md), Status,
which has the tables) changed what bounds the history's heights again:

- **The uplift is a physical rate.** The history's U was normalised per
  world to a peak of 1 (× upliftScale 4); its world's normaliser was
  often a hotspot's pile, and its rate did not follow the plates. Now U
  is the crust's thickening, v Hc / W (the boundary's shortening rate ×
  30 km of crust over the range's 234 km cross-section), and
  `HISTORY_DEFAULTS.upliftScale` is 1.
- **The column's force balance** (TECTONICS_TUNING.wedgeRadiusM 10 km,
  wedgeHeightM 7000 m): the thickening at a node falls as 1 − h̄ / H with
  h̄ the mean height of its own column. The plateau's balance did not
  see a narrow range in lowland; with the physical rate such ranges rose
  to 15–31 km.
- **The plateau's force balance at 3000 m**, not 4000 (collapseHeightM).

The flexure of the addendum above stays as it is; there is still no
ceiling.

## Addendum 2026-10-14: where the uplift acts

DEC-0036 phase 8g-2 ([fields-on-meshes.md](./fields-on-meshes.md),
Status, which has the tables) moved the uplift to where the crust
converges: a continent's margins with another plate (an ocean's or
another continent's), laid at the overriding side's coast, and a plate
boundary through one continent at 0.3 of its rate (boundaryPass, and
[continental-crust-rafts.md](./continental-crust-rafts.md)'s addendum of
the same date). With the broad interior uplift gone:

- **Hc 30 → 40 km** (TECTONICS_TUNING.orogenCrustM), the mean continental
  crust.
- **The plateau's force balance back at 4000 m** (collapseHeightM): the
  broad highlands that 3000 m held went with the interior uplift.

The column's force balance (7000 m) and the flexure stay as they are.

## Status

decided and built 2026-08-16; calibrated on seed alpha with
scripts/measureHydrology.mjs (deleted 2026-10-12 with the raster
hydrology it measured; in the git history) and a hypsometry decomposition.
Superseded 2026-10-13 by DEC-0036 phase 8b-3: the knee and the ceiling
are removed, the plate's flexure and the plateau's force balance bound
the heights (see the addendum).
Amended 2026-10-14 by DEC-0036 phase 8g: the uplift's rate from the
plates' convergence, the column's force balance (the second addendum);
and by phase 8g-2: the uplift at the crust's margins (the third).

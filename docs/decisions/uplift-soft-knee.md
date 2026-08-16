---
summary: The uplift deck saturates through an isostatic soft knee (linear to 3000 m, exponential toward 6000 m) instead of climbing to the 9000 m clamp — ultra-high plateaus (2.5% of land above 6000 m; Earth ~0.001%) and their brim-full ice-cold basin lakes disappear, while ridged crests keep riding the raw crustal thickness. Rare true 7-8 km summits are out of this knob's reach and wait on a thickness-side treatment in the tectonics sim.
date: 2026-08-16
area: worldgen
stage: built
status: decided and built 2026-08-16; calibrated on seed alpha with scripts/measureHydrology.mjs and a hypsometry decomposition
---

# The uplift soft knee

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

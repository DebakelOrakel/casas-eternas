---
id: DEC-0052
title.en: The arable land grows crops
title.de: Das Ackerland trägt Feldfrüchte
summary.en: The arable field read the wild land's productivity (the Miami
  model) averaged over twelve months, and the worlds had a third to a half
  of Earth's farmland. It now has a crop's own response to warmth and
  water, sums the months' growth over a season of seven, and the wet
  tropics leach their soils. Land with arable of 0.3 or more is 15–31 %
  of the land on the three worlds measured instead of 5–16 %.
summary.de: Das Ackerland las die Produktivität des wilden Landes (das
  Miami-Modell), gemittelt über zwölf Monate, und die Welten hatten ein
  Drittel bis die Hälfte des irdischen Ackerlands. Jetzt hat es eine
  eigene Antwort der Feldfrüchte auf Wärme und Wasser, summiert das
  Wachstum der Monate über eine Saison von sieben, und die feuchten
  Tropen laugen ihre Böden aus. Land mit Ackerland ab 0,3 ist auf den
  drei gemessenen Welten 15–31 % des Landes statt 5–16 %.
area: generator
stage: built
createdAt: 2026-10-29
concepts: [resource.arable, resource.carryingCapacity]
related: [DEC-0008, DEC-0030, DES-0032]
---

## Where this starts

The prehistory's second step ([DES-0032](../design/prehistory-in-three-steps.md))
lets farmers spread over the arable land. On the three worlds it ran on
(Morvane, Thalassor, Zephyra; their level 1 of 2026-10-28), land with
arable of 0.3 or more was 10.7 / 15.6 / 5.3 % of the land, and 0.5 or more
0.9 / 2.5 / 0.4 %. Earth has some 25–30 % of its land fit to farm; a
rough Earth share per Köppen class (GAEZ-like, from memory, not verified)
over these worlds' climates gives 23 / 25 / 13 %. The classes that are
Earth's grain belts were empty: Dfb 0.1 %, Dfa 0.2 %, Cfb 0.6 % on Morvane.

## What held it down

Measured per factor on level 1 (the arable's own rule, the save's
refined climate on the level's mesh):

- **The wild land's productivity.** The arable read the Miami model, the
  net primary productivity of natural vegetation, the same as game and
  pasture. Its warmth is half at 11 °C and 0.84 at 25 °C, so a temperate
  summer month counts some 0.6; its water, 1 − e^(−0.000664 P), is 0.5 only
  at 1 040 mm/yr, which a grain belt does not have.
- **The mean over twelve months.** The growth of the frost-free months
  was summed and divided by twelve: a field with five good months read
  5/12 of one with twelve. A field gives one harvest; a season of good
  months makes it.
- With the growth set to 1 the share of 0.3 or more would be 62 / 64 /
  51 %; with the flatness set to 1 it is 30 / 33 / 13 %, with no risk
  16 / 22 / 8 %. The flatness and the risk are real limits (slopes,
  unreliable rain) and stay.

## Options

(a) **As it was:** the Miami model and the twelve months' mean.

(b) **The season only:** the months' sum over a season, the Miami model
kept. Season 6: 0.3 or more on 27.3 / 32.1 / 16.0 % of the land — the
share is there, but the response is still the wild land's.

(c) **The precipitation constant only:** 1 − e^(−k P) with k 0.0012 to
0.002 (with a season of 6 and the crop's warmth: 39–42 % on Morvane).
Rejected: the saturating curve has no threshold, so the hot deserts become
rain-fed farmland (BWh 14–23 % of 0.3 or more on Morvane, 0.3 % before),
where Earth farms them only on their rivers and oases.

(d) **A crop response, a season and leaching (variant "B").** Chosen.

## Answer — (d)

Per month with the frost gate as before (`arable_frost_c`):

- warmth 1/(1 + e^(2.3 − 0.25 T)) — half at 9.2 °C, 0.98 at 25 °C;
- water smoothstep(0.5 · need, 1.4 · need, P + 1000 · fieldWater), need =
  150 + 30 · T mm/yr — a crop needs more water the warmer it is, and gets
  nothing below half of it, so a desert stays dry except on its rivers;
- growth = min(warmth, water).

The year is min(1, Σ growth / 7): a season of seven good months gives a
full harvest (6 gave the dry steppes BSh 51 % on Morvane against 43 %).
Where the year is 18 °C or warmer, × (1 − 0.6 · smoothstep(1500, 2500,
P_year)): the wet tropics' leached soils. Flatness and the harvest's risk
are as before. Game and pasture keep the Miami model: they are the wild
land. The constants are in `ecology_tune_params.rs` with their sweeps.

Tried on the way (the same three worlds): the need's band 0.4 / 1.2
(30.5 / 33.4 / 17.9 % — the dry steppes BSh 60 % on Morvane), a season of
6 with 0.5 / 1.4 (29.6 / 32.3 / 17.5 %), leaching off (at a season of 6
and 0.4 / 1.2: Af 63 / 80 / 71 % of 0.3 or more, with it 48 / 72 / 60 %).

## The months

`ecology_month`'s arable is the month's crop growth × flatness × risk ×
leaching, on the year's 0–1 scale of a month. The year is no longer the
mean of the twelve months: it is their sum over the season, capped at 1.
The other seasonal fields still average to their year.

## The worlds

Level 1 of the three worlds, the ecology computed again with this engine
on the level's mesh under the save's refined climate (the method gives
the old arable back to a mean |Δ| of 0.003). By area of land:

| arable ≥ 0.1 / 0.3 / 0.5, % of the land | before | after |
|---|---|---|
| Morvane | 40.0 / 10.7 / 0.9 | 47.4 / 26.9 / 12.9 |
| Thalassor | 39.1 / 15.6 / 2.5 | 43.8 / 31.2 / 19.6 |
| Zephyra | 23.2 / 5.3 / 0.4 | 28.3 / 15.3 / 6.9 |

By Köppen class, the share of the class with 0.3 or more (Morvane;
Thalassor and Zephyra alike in kind):

| class (share of the land) | before | after |
|---|---|---|
| Cwa (10.1 %) | 14.7 | 81.2 |
| Af (9.9 %) | 49.0 | 47.5 |
| BWh (9.8 %) | 0.3 | 0.7 |
| BSh (8.9 %) | 1.8 | 42.5 |
| Aw (5.1 %) | 38.6 | 66.6 |
| Cfb (4.7 %) | 0.6 | 13.4 |
| Dfb (4.3 %) | 0.1 | 33.0 |
| Dfa (4.2 %) | 0.2 | 12.3 |
| Cfa (3.5 %) | 23.7 | 42.0 |

The hot deserts stay at 1 % (on the rivers and oases); Dfb, Dfa and Cfb,
nothing before, become grain land; on Zephyra Dfb 0 → 45 %, Dfa 0 → 35 %.

The carrying capacity (1 − e^(−(1.1 · arable + …)), normalised to its
maximum): its land mean 0.409 → 0.434, 0.403 → 0.422, 0.287 → 0.300; land
with 0.5 or more 35.4 → 39.3, 31.8 → 35.5, 21.1 → 24.3 %. It was not
tuned again.

## Consequences

- `AMPLIFICATION_ALGO_VERSION` 15 (with [DEC-0053](./copper-arcs.md)):
  level 1 carries the ecology's fields; the worlds do not change (the
  ecology is a function on load), so a world v14 made is v15's
  (`worldPipeline.ts` SAME_WORLDS_AS), and its level 1 is baked again.
- The ecology's fixtures (`ecology.txt`) and the world stages'
  (`worldStages.txt`) are recorded from the engine (rust-engine.md,
  fork 7c).
- The TypeScript `ecologyField.ts` / `ecologyTuneParams.ts` had the Miami
  arable, and nothing ran them since 2026-10-22: the rules and the tuning
  were removed 2026-10-29, their explanations moved to the engine's
  ecology_field.rs and ecology_tune_params.rs.

## Status

Built 2026-10-29.

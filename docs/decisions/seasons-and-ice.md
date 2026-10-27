---
id: DEC-0050
title.en: The seasons the history's ice reads
title.de: Die Jahreszeiten, die das Eis der Geschichte liest
summary.en: The history builds its ice in the static climate, whose annual
  range was a third of the refinement's past 50°: its summers were some
  10 °C colder than those of the climate that classifies the finished
  world, and the land past 60° was iced nearly whole. The static range
  now follows the refinement's: 62 °C at a continental pole, falling as
  sin φ, a coast keeping 45 %. The ice covers 31 % of the torus's land
  instead of 44 %, 5 % of the sphere's instead of 9 %.
summary.de: Die Geschichte baut ihr Eis im statischen Klima, dessen
  Jahresspanne jenseits von 50° ein Drittel der Verfeinerung betrug: Seine
  Sommer waren gut 10 °C kälter als die des Klimas, das die fertige Welt
  einteilt, und das Land jenseits von 60° war fast ganz vereist. Die
  statische Spanne folgt jetzt der Verfeinerung: 62 °C an einem
  kontinentalen Pol, mit sin φ fallend, eine Küste behält 45 %. Das Eis
  bedeckt 31 % des Landes auf dem Torus statt 44 %, 5 % auf der Kugel
  statt 9 %.
area: generator
stage: built
createdAt: 2026-10-27
related: [DES-0027, DEC-0049]
---

## Where this starts

Entry 31 of the calibration backlog
([DES-0027](../design/calibration-backlog.md)): the ice covered 20–34 % of
the torus's land and 15–20 % of the sphere's (Earth ~10 %), 10–14 % of the
torus's land between 30° and 60°; the sea it held stood at −75 to −170 m
on the torus. A glacial maximum as the steady state. The prehistory's
first step ([DES-0034](../design/prehistory-in-three-steps.md)) reads that
ice: it closes the land to people.

## How it was measured

The script of [DEC-0049](./shelf-and-sea.md) (the native engine, the
screen's defaults, the Archean to 1200 Ma, 40 epochs), 3 seeds per shape,
with the last epoch's ice and climate by 10° of latitude, and the
refinement's twelve months after the history.

## What made the ice

The latitude's temperature profile is Earth's (65°: −7 °C at sea level).
The summers were not. The ice (`surface/glacial.rs`) melts from the
warmest month, the annual mean plus half the annual range, and the
history gives it the range of the static climate
(`climate/seasonality.rs`): 42 °C × φ × (0.3 + 0.7 × continentality),
the continentality saturating at 2808 km from the sea (45 cells of a
former grid). The refinement, which gives the finished world its months,
its Köppen classes and its biomes, solves an energy balance and gives
2–3 times the range:

| latitude | half range, static (was) | half range, refinement | warmest month, refinement |
|---|---|---|---|
| 50–60° | 5.2 °C | 15.7 °C | +15 °C |
| 60–70° | 5.9 °C | 16.9 °C | +9 °C |
| 70–80° | 6.7 °C | 14.2 °C | −2 °C |

So the history's ice grew in summers some 10 °C colder than the world's:
the land past 60° was iced to 84–97 %, and the biome map's glaciers
(45 % of the torus's land) stood 16 points above its Köppen EF (29 %).

## Fork — what the history's ice reads: DECIDED — the static range, fitted to the refinement's

(a) The refinement's months in every epoch: right, but the energy balance
is the slowest stage of the climate, and the history runs it 40 times and
more. (b) The static range, fitted to the refinement's.

**(b).** Fitted per land cell of the climate's chart (2 + 2 worlds), the
form A · g(φ) · (c + (1 − c) · min(1, d / S)) against the refinement's
range:

| form | A, c, S | RMS, all land | RMS, past 50° |
|---|---|---|---|
| φ (was) | 42 °C, 0.3, 2808 km | 15.2 °C | 17.8 °C |
| φ, fitted | 66 °C, 0.5, 2000 km | 8.4 °C | 9.7 °C |
| **sin φ (chosen)** | **62 °C, 0.45, 2808 km** | **6.5 °C** | **7.5 °C** |
| sin^0.75 φ | 52 °C, 0.5, 2000 km | 6.0 °C | 7.1 °C |

sin φ is how the summer's and the winter's sun differ, has no constant of
its own, and is nearly as close as the best fit. The distance to the sea
explains little either way: the refinement's range depends on the wind,
which the static one does not read. 62 °C at a continental pole is
Verkhoyansk's (67° N, 65 °C).

## The worlds

| 3 seeds per shape, epoch 40 | before | after |
|---|---|---|
| ice, % of the land, torus / sphere | 43.9 / 9.4 | 31.3 / 4.6 |
| torus land iced, 40–50° / 50–60° / 60–70° / 70–80° | 9 / 25 / 84 / 97 % | 5 / 10 / 24 / 80 % |
| sphere land iced, 50–60° / 60–70° / 70–80° | 10 / 82 / 97 % | 1 / 16 / 78 % |
| the sea the ice holds, torus / sphere | −106…−143 / −10…−28 m | −67…−85 / −2…−15 m (Earth −65) |
| glacier biome, torus / sphere | 45.3 / 9.8 % | 33.6 / 4.9 % |
| tundra biome, torus / sphere | 1.9 / 0.5 % | 10.4 / 4.0 % |

The Köppen classes come from the refinement and stay within 0.3 points;
the precipitation stays within 2 % but at 30–40° (−10 %, the monsoon's
seasonal contrast).

What is left is the torus's shape: its latitudes have equal areas, so
42 % of its land lies past 60° (the sphere's 9 %), and the refinement
gives 29 % of it an ice-cap climate (EF).

## Consequences

- The pipeline stays at `AMPLIFICATION_ALGO_VERSION` 14: v14 was never
  published. The climate's tuning moves the pipeline's hash.
- The engine's fixtures of the static climate, the refinement, the
  coupled epoch, the replay and the world stages are recorded from the
  engine (rust-engine.md, fork 7c); the climate's and the refinement's
  tests check through `tests/fixture/` now.
- The static range feeds the history's monsoon and its epoch biomes, as
  before.

## Status

Built 2026-10-27.

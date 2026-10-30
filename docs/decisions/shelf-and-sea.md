---
id: DEC-0049
title.en: The shelf and the sea it stands on
title.de: Der Schelf und das Meer, auf dem er steht
summary.en: The history's continental shelf was a third of Earth's: the
  margin profile lays one down, but the sea the ice holds down left its
  inner part dry, the plate's flexure sank the rest, and nothing filled it
  again. The profile now stands on the mean sea of the last epochs, the
  epoch's sediment export fills the shelf and builds it out over the
  upper slope, and the stops lie further out. The shelf is 4.5–6 % of
  the ocean instead of 2.2–2.5 %, and a sea 120 m lower lays twice as much
  land dry.
summary.de: Der Kontinentalschelf der Geschichte war ein Drittel des
  irdischen: Das Randprofil legt einen an, aber das vom Eis gesenkte Meer
  ließ seinen inneren Teil trocken, die Flexur der Platte senkte den Rest,
  und nichts füllte ihn wieder. Das Profil steht jetzt auf dem mittleren
  Meer der letzten Epochen, der Sedimentexport der Epoche füllt den Schelf
  und baut ihn über den oberen Hang hinaus, und die Stützstellen liegen
  weiter draußen. Der Schelf ist 4,5–6 % des Ozeans statt 2,2–2,5 %, und
  ein um 120 m tieferes Meer legt doppelt so viel Land frei.
area: generator
stage: built
createdAt: 2026-10-27
related: [DES-0027, DES-0032, DEC-0036]
---

## Where this starts

The prehistory's first step ([DES-0032](../design/prehistory-in-three-steps.md))
lets people walk the shelf a glacial sea lays dry. On the worlds it made,
a sea 120 m lower added 3.5–4 % land and joined no landmass; on Earth it
adds some 15 %. The shelf was narrow: 2.2–2.7 % of the ocean (Earth 7.3 %),
30–38 km wide at the median (Earth 50–80 km) — measured in phase 8
([fields-on-meshes.md](./fields-on-meshes.md)) and left in the backlog
([DES-0027](../design/calibration-backlog.md), entry 8). The deltas suffer
from the same shelf.

## How it was measured

A script built worlds at the real size with the native engine, the
screen's defaults: the Archean to 1200 Ma, the hand-over, 40 epochs; 6
seeds per shape. It measured on the terrain mesh: the land, the ocean's
depth bands, the shelf's width (an ocean node past 200 m beside one above
it, its distance to land), the land a sea 120 m lower adds, and the
landmasses of 100 000 km² that joins. Before: the land 32 % (torus) and
29 % (sphere), the shelf 2.5 / 2.2 % of the ocean, 30 / 33 km wide, +3.5
/ +3.9 % land at −120 m.

## What took the shelf

Right after the hand-over the shelf the profile lays down was there; after
one epoch half of it was gone, after five most. Taken apart:

- **The sea the ice holds down.** The sea level is the ice's volume over
  the ocean, 0 m an ice-free world. It stood at −75 to −170 m on the torus
  and −10 to −70 m on the sphere, and the profile, laid down against
  0 m, stood above it: its inner shelf was dry land, its break the coast.
- **The plate's flexure.** In the first epoch it took the shelf 50 m down
  at the mean: the history's uplift is crustal thickening and loads the
  plate (DEC-0036 phase 8b-3, deliberately), and its moat reaches the
  shelf; the ice's load added some 11 m. Not a fault — the moat of a range
  is a foreland basin — but on Earth sediment fills it.
- **Nothing filled it.** The marine deposits stay at the river mouths,
  at most 30 m an iteration within 40 km of the coast; the marine diffusion
  and the coast's waves change the shelf little (measured: nothing when
  switched off).

## Fork 1 — the sea the profile stands on: DECIDED — the mean of the last epochs

(a) The ice-free datum, as before. (b) The sea of the epoch, as it is.
(c) The sea's mean over the last `sea_mean_epochs` (5) epochs.

**(c).** The shoreline and the shelf are the waves' and the sediment's
work at the sea there is, which they keep up with in far less than an
epoch (a Ma): an icy world has its shelf at its own sea. The mean keeps
one epoch's swing from moving the profile at once. The epochs' sea levels
are in the save already (`climate_history`), so the anchor is derived, not
stored. What moves the coast now is the sea leaving its mean, as an ice
age; an icy world no longer has more land for its ice
(`coupled_epoch.rs profile_sea_m`).

## Fork 2 — what fills the shelf: DECIDED — the epoch's export

(a) The export of the epoch: the sediment the erosion carries past its
active band and the coast's drift carries off. (b) A background
sedimentation, from no budget.

**(a).** It conserves the mass, and it is enough: 1·10¹⁵ m³ an epoch
against 4–13·10¹³ m³ the shelf takes. The fill
(`surface/shelf_fill.rs`) lays it from the coast outward up to
`shelf_fill_depth_m` (20 m) below the sea, over a baseline down to
`shelf_fill_slope_m` (1500 m), no farther than `shelf_fill_reach_km`
(120 km) out — it builds the shelf out over the upper slope as a delta's
front does. It loads the plate, so a part of it sinks again by the next
epoch; the shelf settles at some 140–170 m at the median. The erosion's
ledger (`sediment_export_m3`) takes back what it laid of the erosion's
export; the coast's export was never in it.

The fill's depth and reach, swept (3 + 3 worlds, then 6 + 6):

| depth, reach | −120 m land (torus / sphere) | shelf, % of the ocean | width, km |
|---|---|---|---|
| fill to the break only, 100 m | +6.3 / +4.9 % | 4.6 / 2.8 | 36 / 47 |
| 100 m, 100 km | +6.8 / +6.3 % | 5.5 / 4.1 | 46 / 61 |
| 40 m, 100 km | +8.6 / +8.3 % | 6.0 / 4.4 | 49 / 68 |
| 40 m, 150 km | +9.0 / +7.8 % | 6.1 / 4.5 | 49 / 65 |
| **20 m, 120 km (chosen)** | **+9.0 / +8.4 %** | **6.2 / 4.5** | **50 / 66** |

## Fork 3 — the profile's stops: DECIDED — further out, a stop on the inner shelf

The stops (`elevation_scale.rs MARGIN_STOPS`) were the slope's foot at
t = 0.15, the break at 0.45, the coastal plain at 0.8; the shoreline lies
inside the last segment at t = 0.6729. A stop at the shoreline would make
the coast flat and let it wander (elevationScale.ts has why). Now: the
foot at 0.10, the break at 0.25, the inner shelf (−60 m) at 0.55, the
coastal plain at 0.7957 — the shoreline in the middle of that segment, at
the same t, so the shoreline field and the Archean's land do not move.
The shelf is twice as wide in t; at the hand-over it was 5.7 % of the
ocean, 67 km wide. Further (the break at 0.14) gave more land, not more
shelf, before fork 1 was built, and was not tried after.

## The worlds

| 6 seeds per shape, medians | before | after |
|---|---|---|
| land, torus / sphere | 32.2 / 29.4 % | 31.0 / 27.6 % |
| shelf (0–200 m), % of the ocean | 2.5 / 2.2 | 6.2 / 4.5 (Earth 7.3) |
| shelf width, median km | 30 / 33 | 50 / 66 (Earth 50–80) |
| land added at −120 m | +3.5 / +3.9 % | +9.0 / +8.4 % (Earth ~15) |
| landmasses ≥ 100 000 km² joined at −120 m, per world (median) | 0 / 0 | 2 / 1 |

The aim was +10 to 15 %. What is left is the coast: at 8–31 km nodes it is
3–4 times shorter than Earth's at scale (fields-on-meshes.md), so even an
Earth-wide shelf holds half Earth's share.

## Seen on the way: the ice — not changed

The ice covers 20–34 % of the torus's land and 15–20 % of the sphere's
(Earth ~10 %); on the torus 10–14 % of the land between 30° and 60°
(the sphere 0–3 %, Earth ~0): a glacial maximum as the steady state. Entry
31 of the backlog ([DES-0027](../design/calibration-backlog.md)).

## Consequences

- `AMPLIFICATION_ALGO_VERSION` 14: a recipe replays to other terrain.
- The engine's fixtures of the Archean, the elevation, the coupled
  epoch, the replay and the world stages are recorded from the engine
  (rust-engine.md, fork 7c).
- The surface tuning has `shelf_fill_depth_m`, `shelf_fill_slope_m`,
  `shelf_fill_reach_km`; the history's defaults `sea_mean_epochs`.

## Status

Built 2026-10-27.

2026-10-30: level 1 holds the ecology's fields of the shelf down to
120 m below the sea, computed with the shelf as land in today's climate
(`world_stages.rs shelf_ecology`, `shelfEcology.json`, TEG-13). The
incubator reads them where a glacial sea lays the shelf dry
([DES-0032](../design/prehistory-in-three-steps.md), open point 5).

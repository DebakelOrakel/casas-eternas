---
id: DEC-0053
title.en: Copper from every arc, the extinct ones too
title.de: Kupfer aus jedem Bogen, auch den erloschenen
summary.en: The copper stood only at the active volcanic arcs, and only at
  those the volcano map's marker grid kept: in the mountains, far from the
  farmland. It now reads every active arc, and the arcs no longer fed
  carry a weaker, tighter copper by a lottery of their own. Silver,
  obsidian and the volcanic provinces read the full list of active arcs
  with it.
summary.de: Das Kupfer stand nur an den tätigen Vulkanbögen, und nur an
  denen, die das Markierungsraster der Vulkankarte behielt: im Gebirge,
  fern vom Ackerland. Jetzt liest es jeden tätigen Bogen, und die nicht
  mehr gespeisten Bögen tragen ein schwächeres, engeres Kupfer nach einer
  eigenen Lotterie. Silber, Obsidian und die vulkanischen Provinzen lesen
  mit ihm die volle Liste der tätigen Bögen.
area: generator
stage: built
createdAt: 2026-10-29
concepts: [resource.copper]
related: [DEC-0008, DEC-0030, DEC-0052, DES-0032]
---

## Where this starts

The prehistory's second step ([DES-0032](../design/prehistory-in-three-steps.md))
has its farmers find copper within some 20 days of their villages. On the
three worlds it ran on (Morvane, Thalassor, Zephyra; level 1 of
2026-10-28), copper of 0.6 or more lay on 1.0–1.6 % of the land (of
0.3 or more, four fifths under glaciers), and on 0–0.1 % of the
arable land of 0.3 or more; from the arable land to it the median was
1 700–2 200 km, and of the 19 / 15 / 7 farming regions (arable of 0.3 or
more, 5 000 km² or more) one per world had it within 300 km. The first
farming centres were 1 100 to 3 900 km from it.

On Earth (from memory, not verified) copper lies mostly in porphyry and
volcanogenic deposits of arcs, and many of those an arc left behind long
ago: the Laramide porphyries of Arizona, the Cretaceous arc of the Balkans
(Timok, Bor, the Rudna Glava mines of the first smelting), Ergani in
Anatolia, Cyprus's ophiolite. An old arc is eroded to low hills, not a
range.

## What kept it in the mountains

- **Active arcs only.** The copper was a halo about the arc volcanoes of
  `collect_volcanoes`: arc features fed in the last 8 epochs, thicker
  than 3. An arc that stopped took its copper with it.
- **The marker grid.** `collect_volcanoes` is the volcano map's list: it
  keeps the tallest arc per 60-cell square (`ARC_MARKER_CELL`), so the
  map reads as a dotted chain. A display rule, and the ecology read it:
  108 of 163 active thick arcs on Morvane, 89 of 188 on Thalassor, 126 of
  209 on Zephyra. The tallest is the range's crest.

## Options

- **K0** As it was.
- **K1** The extinct arcs (volcanic range features fed 8 epochs ago or
  more, any thickness) carry copper too, weaker and tighter, by a lottery
  of their own.
- **K2** The ecology reads every active thick arc, not the marker grid's.
- **K3** More of the active arcs' copper: a keep of 0.6 instead of 0.33,
  or σ 240 km instead of 160. Rejected: it widens the copper about the
  same ranges (Morvane, copper of 0.3 or more: the arable land's median
  distance 1 607 → 1 222 km at keep 0.6, 1 475 km at σ 240), and covers
  land in proportion.
- **An upland lottery:** copper on hill country of 300–2 500 m by a noise.
  Rejected: not geology; it puts copper where no arc ever was.

## Answer — K1 "moderate" and K2

`tectonics/volcanoes.rs ecology_volcanoes` gives the ecology its own
list: hotspots and flood basalts as before, every active arc thicker than
3, and the extinct arcs (`VolcanoKind::ExtinctArc`; 949 / 532 / 164 on
the three worlds). The copper is max(the active arcs' halo, 0.7 × the
extinct arcs' halo): σ 110 km, a keep of 0.33 by its own salt
(`copper_extinct_*` in `ecology_tune_params.rs`). The sweep of K1 (0.7 /
0.33 / 110 km, 0.8 / 0.4 / 120 km, 0.8 / 0.5 / 100 km; with the old
arable and the grid on the extinct arcs): "moderate" brought 9 of
Morvane's 19 farming regions within 300 km of copper of 0.6, the stronger
two 12, with copper of 0.05 or more on 22–24 % of the land against
18.6 %. "Moderate" was chosen.

Silver (the active arcs' halo), obsidian (all live volcanoes) and the
volcanic province of the carrying capacity read the same list without
the grid; the extinct arcs are the copper's alone. The volcano map keeps
its marker grid (`collect_volcanoes`, TypeScript `collectVolcanoes`).

**Measured with the grid on the extinct arcs.** The probe that chose
"moderate" took the extinct arcs through the marker grid too (276 of 949
on Morvane). Without it, as built, the copper covers more: on a 2048 raster
copper of 0.05 / 0.3 / 0.6 or more on 32.8 / 17.6 / 6.4 % of Morvane's
land against 23.4 / 11.4 / 4.8 % with the grid (Thalassor 11.1 / 5.4 /
1.9 against 8.8 / 4.0 / 1.6, Zephyra about the same). A keep of 0.15
for the extinct arcs gives 26.0 / 13.2 / 5.2 %, 0.10 gives 21.8 / 11.2 /
4.8 %. Built at 0.33, as decided; `copper_extinct_keep` is the knob.

## The worlds

Level 1 of the three worlds, the ecology computed again with this engine
on the level's mesh (DEC-0052 has the method). By area of land:

| | before | after |
|---|---|---|
| copper ≥ 0.05 / 0.3 / 0.6, Morvane | 6.6 / 3.3 / 1.6 % | 27.8 / 14.6 / 5.4 % |
| Thalassor | 4.5 / 2.2 / 1.1 % | 14.0 / 6.8 / 2.5 % |
| Zephyra | 4.5 / 2.2 / 1.0 % | 13.3 / 6.2 / 2.6 % |
| arable ≥ 0.3 to copper ≥ 0.6, median km | 1 738 / 2 046 / 2 168 | 817 / 1 890 / 1 458 |
| farming regions with copper ≥ 0.6 within 300 km | 1/19, 1/15, 1/7 | 21/26, 2/12, 9/26 |
| copper ≥ 0.3 to tin ≥ 0.3, median km | 2 300 / 2 538 / 3 239 | 1 370 / 772 / 2 962 |
| copper ≥ 0.3 land that has tin ≥ 0.3 | 2.3 / 3.9 / 0 % | 2.8 / 3.7 / 1.6 % |
| silver ≥ 0.05 / 0.3, Morvane | 5.8 / 2.7 % | 7.1 / 3.6 % |
| tool stone ≥ 0.3 (obsidian), per world | 3.1 / 0.8 / 2.2 % | 4.0 / 1.7 / 2.9 % |
| gems ≥ 0.05 (they read the copper), per world | 3.0 / 2.2 / 0.0 % | 5.1 / 2.3 / 1.0 % |

"After" is with the new arable ([DEC-0052](./arable-crops.md)): its
farming regions are other ones. The tin stays apart from the copper: the
land that has both is 2–4 % of the copper's, as before (Zephyra 0 →
1.6 %). The province
layer moves the carrying capacity by less than 0.001 at the land's mean.
Thalassor's farmland lies far from its arcs, old and young.

## Consequences

- `AMPLIFICATION_ALGO_VERSION` 15 (with DEC-0052).
- Level 1's `volcanoes.f64` is the ecology's list, its kind 3 an extinct
  arc.
- The incubator's COPPER_RICH 0.6 → 0.5 (copper of 0.5 or more on 8.2 /
  3.7 / 3.6 % of the land); its settlement's SOURCE_RICH stays at 0.6: it
  is the tool stone's and the salt's too, and the copper has more sources
  above it now.
- The ecology's fixtures are recorded from the engine (DEC-0052).

## Status

Built 2026-10-29.

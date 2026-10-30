---
id: DES-0034
title.en: Polities from the land
title.de: Gemeinwesen aus dem Land
summary.en: Step 3 of the prehistory, the bronze age, simulates polities:
  tribes, chiefdoms, city-states, kingdoms, nomad confederations, empires.
  Their form is not picked from a table. A region's drivers — surplus, how
  taxable it is, how hard it is to leave, how the land connects, mobile
  wealth, chokepoints, pressure — give a polity its properties, and the
  form is the class of those properties, as a Köppen class is of a
  climate. Polities form a tree as peoples and languages do: they are
  born, split, conquer, join and fall, and their institutions are inherited,
  follow the land or spread by contact.
summary.de: Schritt 3 der Vorgeschichte, die Bronzezeit, simuliert
  Gemeinwesen: Stämme, Häuptlingstümer, Stadtstaaten, Königreiche,
  Nomadenbünde, Reiche. Ihre Form wird nicht aus einer Tabelle gewählt. Die
  Antriebe einer Region — Überschuss, wie besteuerbar er ist, wie schwer
  man fortgeht, wie das Land verbunden ist, beweglicher Reichtum, Engpässe,
  Druck — geben einem Gemeinwesen seine Eigenschaften, und die Form ist die
  Klasse dieser Eigenschaften, wie eine Köppen-Klasse die eines Klimas.
  Gemeinwesen bilden einen Baum wie Völker und Sprachen: Sie entstehen,
  teilen sich, erobern, verbünden sich und zerfallen, und ihre
  Institutionen werden vererbt, folgen dem Land oder verbreiten sich durch
  Kontakt.
area: incubator
stage: idea
createdAt: 2026-10-28
updatedAt: 2026-10-30
related: [DES-0032, DES-0033, DES-0036]
---

## Where this starts

Step 3 of the prehistory ([DES-0032](./prehistory-in-three-steps.md)) is
the game's own rules run without a player: a small simulation of empires.
Peoples ("groups" in a loose sense, not step 1's overlay) form
proto-states; these spread, fight, become small kingdoms, perhaps empires,
or nomad confederations where the niche fits. The forms must be many and
tell apart: two ("farmers make kingdoms, herders make hordes") are too
few.

## Egypt and the Greek cities

What sets them apart is the geography of power:

- **Egypt**: one river between deserts. The land is circumscribed
  (Carneiro): who will not pay cannot leave. The river is the one road,
  easy to hold. The flood gives a sure harvest every year, of grain, which
  can be counted, stored and taxed. One state, a god-king, scribes,
  monuments.
- **Greece**: many small valleys between mountains, each plain small, the
  sea between them. No place can hold the others, every place reaches the
  others by ship. Many small cities, citizen armies, leagues, colonies,
  trade.

## The drivers, per region

Read from the world and from H1:

1. **Surplus**: the arable land, its irrigation (floodplains), the rain's
   reliability.
2. **Taxability**: grain is seen, ripens at once and keeps; tubers and
   roots are none of these (James C. Scott, "Against the Grain"). Step 2's
   domesticates give it.
3. **Circumscription**: what it costs to leave — desert, mountains or sea
   around the fields.
4. **Connection**: a river as one line, a plain of many channels, valleys
   with the sea at hand, an open plain, the steppe.
5. **Mobile wealth**: herds instead of land; horses where tamed.
6. **Chokepoints**: copper and tin, passes, straits, oases.
7. **Pressure**: the neighbours, above all herders of the steppe next to
   farmland.

## The properties of a polity

- Centralisation: 0 segmentary … 1 bureaucratic.
- The basis of power: kinship, the sacred, the army, wealth.
- The economy: redistribution, tribute, trade, raiding.
- Settled or mobile.
- Its size and the number of its cultures.

## The forms they give

| Form | Example | Arises with | Behaves |
|---|---|---|---|
| Tribal confederation | Zagros tribes, Gauls | highlands, small surplus | resists states, unites only against an enemy |
| Chiefdom | Wessex, Hawaii | rain-fed farming, middling surplus | rank by redistribution and prestige (copper); splits at an inheritance |
| Temple city-states | Sumer (Uruk, Ur) | an alluvial plain of many channels, several centres | rival for water and land; priests redistribute |
| River kingdom, god-king | Egypt | one circumscribed river corridor | united once, then stable, with a bureaucracy |
| Palace economy | Knossos, Mycenae | hills, mixed farming, regional trade | the palace collects and gives out; breaks when trade breaks |
| Polis and league | Greece | broken valleys at the sea | many small ones, leagues, colonies over the sea |
| Thalassocracy | Phoenicia, the Minoans | a coast at a chokepoint, little land | a merchant oligarchy, colonies, a weak army |
| Feudal kingdom | Zhou China | large rain-fed plains | a weak centre, vassals; falls into parts |
| Steppe confederation | Scythians, Xiongnu, Mongols | steppe with horses next to farmland | raiding and tribute, a charismatic leader; falls apart after him |
| Oasis and caravan city | Ebla, Palmyra | a chokepoint in the desert | lives from the passage, hangs on foreign empires |
| Empire | Akkad, Assyria | a strong form conquers other cultures | grows to its logistics' limit, then revolts and falls apart |

## Change and collapse

- A chiefdom becomes a state where surplus, taxability and circumscription
  meet.
- City-states become an empire when one conquers the others.
- Collapse comes from drought, from broken trade (the tin of the bronze
  age), from the steppe.

That is the history step 3 tells.

## What step 2 must give

Not the rank (decided 2026-10-29): step 3 derives a people's rank at its
start from what step 2 gives, so that its rule can change without step 2
being run again.

The peoples with their lifeways; grain or tubers per region; the towns
and the villages; the copper and the ways to it. Drivers 3, 4 and 6 come
from the world itself.

## A polity as a unit

The drivers above say which form arises where. A polity also has a life:
an id, a birth, a parent and an end. The polities make a tree, as the
peoples and the languages do ([DES-0033](./naming-languages.md)):

- A node is a polity. It holds a set of settlements of H1; its land is
  derived from them.
- The edge to its parent means: it continues the parent's legitimacy.
  One parent only.
- Side edges, typed, carry substrate, not descent: absorbed by, member of,
  vassal of, tributary of.
- A conquered polity stays a node, as a province. At a collapse it can come
  out again as a polity (the stable unit of Marcus's dynamic model).

## Events

Nine, each with its cause:

- **Rise**: a chiefdom becomes a state where surplus, taxability and
  circumscription meet.
- **Partition**: at a succession, by a rule that divides (the Franks).
- **Secession**: an edge far from the seat, with its own cohesion.
- **Conquest** and **absorption**: by war where the land does not let the
  weaker side leave.
- **League** and **union**: against a common enemy, or by a marriage.
- **Collapse**: the cost of the administration passes the revenue after a
  shock: drought, broken trade, the steppe (Tainter).
- **Restoration**: a later polity claims an old one's legitimacy.

## Institutions

Some ten, each with a few values and its driver, as the customs in
[DES-0036](./customs-and-cults.md):

| Driver | Institutions |
|---|---|
| Inherited along the tree | succession (divided, eldest, elected from the kin, brother before son), legitimacy (kin, the sacred, the army, wealth), council or assembly |
| The land | revenue (staples or wealth, after Earle), administration |
| Contact | army, records and writing, law |
| Mixed | style of rule (one ruler's network or a shared council, after Blanton), the temple (the cult of DES-0036) |

After a conquest the conquered leave a substrate: the old seat as the
capital of a province, local law, their gods merged into the conqueror's
by domain, old titles (Caesar → Kaiser).

The form is not kept. It is derived per year from the properties and the
institutions, as a Köppen class is from the climate.

## Numbers

Six numbers per polity, after the complexity variables of Seshat: people,
land, size of the seat, levels above the village (a tribe 0, a chiefdom
1 to 2, a state 3 and more, after Wright and Johnson), offices, records.
Their mean is one score of complexity.

## Ruling houses

The game is a dynasty simulation, so step 3 gives it houses, not persons:

- A house is marked by how it came to rule: heir, branch, usurper,
  foreign, by marriage, restorer.
- Reigns are kept with their lengths; the end of a reign is a succession
  event. No persons; a ruler is a name made by the recipe.
- The game gets the house and the ruler of the time, the founder, old
  claims and recent ties by marriage.

## Dynamics

- Reach in days of travel from the seat; beyond it the hold gets weak.
- Cohesion at the edge with foreign peoples (Turchin's asabiya): states
  grow at such frontiers.
- War where the land does not let the weaker side leave.
- Institutions taken from strong neighbours (Renfrew's peer polity
  interaction).
- Institutions that follow the land change with a delay.

A start: the model of Turchin, Currie, Turner and Gavrilets (2013) on a
grid, with the drivers above.

## Names, cult, chronicle

- Names of polities and titles are made by the recipe of DES-0033; the
  lexicon gets some ten meanings (king, lord, house, land, city …). Old
  titles stay as substrate.
- Legitimacy from the sacred reads the cult of DES-0036.
- The chronicle gets some 10 to 100 events a world, filtered.
- The player sees an overlay of the polities, a card per polity and a view
  of its tree.

## What is kept

A log of events per polity, with the year; the state of any year is
derived from it. Under 0.5 MB a world. Every draw from the world's seed,
on a stream of its own.

## Open

1. A polity holds settlements or cells. Proposal: settlements.
2. Reigns, or only rates of succession. Proposal: reigns, without persons.
3. Do the institutions act on the history. Proposal: yes, one effect each.
4. A tree or a graph. Proposal: a tree by legitimacy, with side edges.
5. The form derived or kept. Proposal: derived.
6. The model to start from. Proposal: Turchin et al. 2013 with the drivers
   above.

Background: a survey of 2026-10-30 (Anderson, Marcus, Spencer, Earle,
Blanton, Turchin, Renfrew and Cherry checked; Carneiro, Tainter, Barfield,
Wright and Johnson and the games except Crusader Kings 3 from memory, to be
checked).

## Status

Idea, 2026-10-28. Nothing built; after the peoples of step 2.
2026-10-30: the polity tree, the events, the institutions, the numbers,
the ruling houses and the dynamics added from a survey; the forks above
are to decide.

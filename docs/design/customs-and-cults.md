---
id: DES-0036
title.en: Customs and cults of the peoples
title.de: Bräuche und Kulte der Völker
summary.en: Peoples have customs and cults as well as languages. Like the
  languages, they follow the people tree, split with it and change by
  contact; but each custom has its own driver: kinship follows descent, the
  way of life follows the land, styles follow contact. Material styles are
  kept per cell and cross the borders of peoples. A cult becomes a thing of
  its own only with temples and priests, in step 3.
summary.de: Völker haben neben Sprachen auch Bräuche und Kulte. Wie die
  Sprachen folgen sie dem Völkerbaum, spalten sich mit ihm und wandeln sich
  durch Kontakt; aber jeder Brauch hat seinen eigenen Treiber:
  Verwandtschaft folgt der Abstammung, die Lebensweise dem Land, Stile dem
  Kontakt. Materielle Stile werden pro Zelle gehalten und gehen über
  Volksgrenzen. Ein Kult wird erst mit Tempeln und Priestern eine eigene
  Sache, in Schritt 3.
area: incubator
stage: idea
createdAt: 2026-10-30
related: [DES-0032, DES-0033, DES-0034]
---

## Where this starts

The peoples of the prehistory ([DES-0032](./prehistory-in-three-steps.md))
have names and languages ([DES-0033](./naming-languages.md)). They also
need customs and cults: how they bury their dead, whom they marry, what
they hold sacred. The aim is the same as for the languages: real in feel,
small in number, and every value from a cause the simulation has.

## What the evidence says

- **Kinship follows the tree.** Descent, residence after marriage and the
  marriage payment follow the language tree most closely.
- **The way of life follows the land.** Traits tied to subsistence change
  with it: herders of cattle lose descent through the mother.
- **Styles follow contact.** Pottery, burial rites and monuments cross the
  borders of peoples and languages. An archaeological culture is not a
  people: the Bell Beaker style spread into one region with almost no
  migration, into Britain with a large one.
- **Cults follow the society.** Roughly: spirits of the land (animism) →
  cults of the ancestors where land is claimed by descent → gods of places
  and powers → temples and priests with the state. Moralising high gods
  come late, and the evidence for when is contested.
- **In games**, continuity and causes that can be read feel real; menus and
  bars of conversion feel like a game.

## The parts

Three levels, as for the languages:

- **A family of traditions** for each group of step 1.
- **A tradition** where a branch of the step-2 tree has lived apart long
  enough (the same rule as for a language, but its own ids, so that a
  tradition and a language can part by contact).
- **Customs** for each big people. The small peoples take their parent's.

Beside them, per cell: the **material styles** (pottery, burial, monuments).
Their clusters give an overlay of archaeological cultures beside the peoples.

Some 13 customs, each with a few values, each with its driver:

| Driver | Customs |
|---|---|
| Inherited along the tree | descent, residence, marriage payment, house form |
| The state, with a delay | the land and the dead, the spirits (land, ancestors, place gods, a sky god among herders), the rhythm of rites, the ritual specialist |
| Contact | pottery style, burial rite, monuments (megaliths along the coasts), prestige goods (from the goods of the far trade) |
| A list, anchored | the sacred places (peak, spring, cave, island, old tomb), a sacred animal from the fauna |

## How they change

- A split takes the parent's customs.
- A custom changes when its driver holds long enough, and does not change
  back at once.
- By contact, a people takes what most neighbours have, or what the
  prestigious one has.
- In a merge or a replacement the larger people's customs stay; the other
  leaves a substrate: its sacred places, sometimes its burial or pottery,
  as old river names stay.
- A small people cut off can lose pottery and monuments.

## Step 2 and step 3

- **Step 2** (New Stone Age): spirits of the land, ancestors, burial in the
  house → cemeteries → collective tombs and megaliths, sacred places,
  shamans. The cult is part of the customs, not a thing of its own.
- **Step 3** (Bronze Age, [DES-0034](./polities-from-the-land.md)): with
  temples and priests the cult becomes a thing of its own: a god of the
  city, a god-king, the chief's ancestors as gods. It spreads with the
  polities, by conquest (gods merged by their domain) and along the trade.
  Schisms follow the splits of polities or the tension at their edges.

## Names and the chronicle

The lexicon of DES-0033 gets a few meanings (god, spirit, ancestor, holy,
grave). Sacred places and the names of gods are made by the recipe, and
stay when a people is replaced. The chronicle gets some tens of events a
world: the first great tomb on a landmass, a burial rite that spreads, a
temple founded, a schism.

## What is kept

The tradition nodes and the changes per people, with the year, so that
the state of any year is derived, as a name is. Under 100 KB a world, plus
one or two bytes per cell for each kept state of the styles. Every choice
comes from a hash of the world's seed, on a stream of its own, so the
history of step 2 stays the same bit for bit.

## For the player

A short card per people: way of life, kin, the dead, the sacred. The rest
is there to be found in the detail and in the overlay of the styles.

## Open

1. The cult: part of the customs until step 3, or a thing of its own from
   step 2. Proposal: part of the customs until step 3.
2. How fine: customs per big people and only the styles per cell, or all
   per cell. Proposal: the split.
3. Do the customs act on the history (an ancestor cult holds a people
   together, monuments draw people)? Proposal: not in step 2, so the
   history stays the same; step 3 reads them for power from the sacred.
4. One tree for traditions and languages, or two. Proposal: the same rule,
   ids of their own.
5. Moralising high gods in the Bronze Age at all. Proposal: no, or only for
   a very large empire of many peoples late in step 3.

Background: a survey of 2026-10-30 (cultural phylogenetics: Mace, Gray,
Jordan, Holden; religion: Pulotu, Seshat and its critiques, Whitehouse;
D-PLACE / the Ethnographic Atlas; the games Crusader Kings 3, Stellaris,
Dwarf Fortress, Civilization, Humankind). The sources are from memory and
are to be checked before a decision cites them.

## Status

Idea, 2026-10-30. Nothing built. It waits on the peoples of step 2
(built) and, for the cults, on step 3.

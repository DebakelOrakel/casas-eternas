---
id: DES-0033
title.en: Names from made languages
title.de: Namen aus erzeugten Sprachen
summary.en: Villages, peoples, rivers and mountains need many names, and the
  names of one culture must sound alike. Not lists: each language is made
  from the world's seed, with its sounds, a small lexicon and a grammar of
  names; daughter languages come from their parent by sound changes, so
  related peoples have related names. Only the languages are kept; every
  name is derived.
summary.de: Dörfer, Völker, Flüsse und Berge brauchen viele Namen, und die
  Namen einer Kultur müssen ähnlich klingen. Keine Listen: Jede Sprache wird
  aus dem Seed der Welt erzeugt, mit ihren Lauten, einem kleinen Wortschatz
  und einer Grammatik der Namen; Tochtersprachen entstehen aus der
  Elternsprache durch Lautwandel, so haben verwandte Völker verwandte Namen.
  Nur die Sprachen werden gehalten; jeder Name wird abgeleitet.
area: incubator
stage: idea
createdAt: 2026-10-28
related: [DES-0032]
---

## Where this starts

A list of names serves the continents and the worlds: they are few. The
villages, the peoples, the rivers and the mountains are many, and the names
of one culture must sound alike, those of related cultures related. A list
gives neither the number nor the fit.

The approach is known from map generators (Martin O'Leary, "Naming
Languages", 2016): make the languages, and let the names come from them.

## The parts

1. **The sounds.** Each language takes from the seed a set of consonants
   and vowels, a syllable form (CV, CVC, CCV …), rules on what may stand
   where, and a spelling. The sounds alone make languages tell apart.
2. **A small lexicon.** Some 50 fixed meanings — water, river, lake, sea,
   mountain, hill, forest, stone, red, white, big, old, new, village, home,
   people, sun … — each a word made in the language's sounds.
3. **A grammar of names.** Whether a modifier stands before or after its
   noun, a joining sound, an ending for each kind of place. A name is a
   compound, as in real languages ("Whitby", "Rio Grande"): a village by a
   river in a forest is named from those words, with a word of its own so
   that not all are alike.
4. **Families.** A daughter language comes from its parent by fixed sound
   changes (p becomes f, final syllables fall away …) and by new words for
   a share of the lexicon. Related peoples then have related names.

## Who names what

- A village: the people that lives there.
- A river: the people at its mouth, or the one along most of its length.
- A mountain, a lake: the people around it.
- Later: each people's own name for a river (exonyms), and old names that
  stay when a people is pushed out (on the earth, river names are often
  older than the languages spoken along them).

## Where it hangs: family, language, dialect

The languages follow the people trees of the prehistory
([DES-0032](./prehistory-in-three-steps.md)), on three levels, so that
peoples can share a language and the tree stays small:

- **A family** for each group of step 1 (a branch of the step-1 tree, the
  overlay "Lineages"). Its proto-language is made fresh from the seed. The
  splits of step 1 are tens of thousands of years old; on the earth no
  relation shows past some 8 000 to 10 000 years, so two families are not
  related. A few to some tens of families a world.
- **A language** where a branch of the step-2 people tree has lived apart
  long enough (some 1 500 to 2 000 years) and is large enough. It comes
  from its parent by dated sound changes and new words for a share of the
  lexicon. Some tens of languages a world.
- **A dialect** for each big people (some 150 to 220). A few sound changes
  and a spelling of its own on top of its language; it shares the
  language's lexicon and grammar of names. The small peoples (some 2 000)
  take their parent's dialect.

The player sees the languages and their families; the dialects show in
the names' forms and in a people's detail. Not 2 000 languages.

## A name is a recipe

A word is kept as sounds, not as letters. A name is a recipe: the place,
the meanings, the pattern, the people that gave it, and the year. Its form
in a year is the recipe through the sound changes of the namer's line up
to that year, then spelt. So the chronicle can give the name of the time,
and old compounds wear down as real ones do (Eoforwic → York).

## Contact

The part that map generators do not have, and the one that makes names
feel real:

- **Exonyms**: a people names a place of its neighbours by borrowing the
  name (fitted to its own sounds), by translating it, or with a name of
  its own; which, by how close the contact is (a border, the ways'
  days, the exchange).
- **Old names**: where a people replaces or absorbs another (the merges
  and replacements of step 2, later the conquests of step 3,
  [DES-0034](./polities-from-the-land.md)), names may stay: rivers often,
  mountains sometimes, villages seldom. An old name that no longer means
  anything can take the new language's word for its kind again ("River
  Avon": avon is "river").
- **Loans**: a prestige or trade language gives words.

## What is needed by hand

Not fully generated: a small kit, some hundred lines, made by hand — a
table of sounds with their features, weights for the inventories, some
20 syllable forms, 50 to 80 templates of sound changes (from the attested
ones, Index Diachronica), a few spelling styles, some 100 to 150 meanings
that places are named for, and patterns of names for each kind of place.
No lists of real names: they have no sounds, so no families and no loans.

## What is kept

Per language node its resolved description (sounds, rules, lexicon; about
1 KB for a family's root, a few hundred bytes for a daughter), under
100 KB a world; per people only its language. Every choice comes from a
hash of the world's seed and the ids, in integers, so the native and the
WASM builds give the same names. The names are the world's content, not
the interface's: they do not go through i18n and are the same in every
language of the interface.

## Languages of the user (later)

A user can change a language or make one, and put it in beside the made
ones: as a family's root, as one people's language, or as a donor of
words. In three steps, of which v1 has at most the first:

1. **Character**: a preset, some sliders (harsh – soft, short – long
   words …), sample names at once, roll again.
2. **Builder**: the sounds on a grid, the syllable forms, the spelling, the
   patterns of names, own words.
3. **Expert**: the sound changes as text rules (as SCA² or Lexurgy).

A user's language must give its sounds (on the table), its syllable forms
and a spelling; the rest has defaults. It is kept in the world, and its
hash goes into the keys of what is derived from it.

## Open

1. The age that makes a language and not a dialect, and the size.
2. Foreign names in the namers' spelling, or in the player's people's.
3. Rust beside the peoples (job and WASM) or TypeScript in the client.
4. Names the user sets for one place (a river): do they spread into the
   exonyms?
5. Start with step 2's merges and replacements, or wait for step 3's
   conquests for the old names and loans.

Background: the survey of 2026-10-30 (mewo2's naming language, Zompist's
Gen and SCA², Lexifer, Lexurgy, Vulgarlang, Dwarf Fortress, Azgaar).

## Status

Idea, 2026-10-28. Nothing built. The peoples of step 2 it waits on are
built (2026-10-29). 2026-10-30: the three levels (family, language,
dialect), the name as a recipe, the contact and the user's languages
written down from a survey of the known tools; the forks above are to
decide.
2026-10-31: the hand-made kit is built (f01001fb,
`engine/crates/casas-incubator/data/language/`): the sounds, the
syllables, the spellings, the meanings, the patterns and the sound
changes. The read-only languages window is built (6b8c5216,
`client/src/ui/languagePanel/`): it shows the tree of the peoples'
languages, made by a stub engine. The forks above are still open
(TEG-135).

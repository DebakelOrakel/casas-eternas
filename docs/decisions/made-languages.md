---
id: DEC-0054
title.en: The made languages' five forks
title.de: Die fünf Gabelungen der erzeugten Sprachen
summary.en: DES-0033 left five forks open. A branch of the peoples becomes a
  language after some 1 500 years apart and when it is large; foreign names
  keep their namers' spelling; the languages are made in the incubator's
  engine in Rust; names the user sets spread into the exonyms; old names
  stay from step 2's replacements on.
summary.de: DES-0033 liess fünf Gabelungen offen. Ein Zweig der Völker wird
  nach rund 1 500 Jahren Trennung und wenn er gross ist zur eigenen Sprache;
  fremde Namen behalten die Schreibweise ihrer Namengeber; die Sprachen
  entstehen in der Engine des Inkubators in Rust; Namen, die der Nutzer
  setzt, gehen in die Exonyme ein; alte Namen bleiben ab den Verdrängungen
  von Schritt 2.
area: incubator
stage: decided
createdAt: 2026-10-31
related: [DES-0033, DES-0032, DES-0034]
---

## Where this starts

[DES-0033](../design/naming-languages.md) describes the names from made
languages: families, languages and dialects on the peoples' trees, a name
as a recipe through sound changes, contact between the peoples. Its
section "Open" lists five forks. The user decided them on 2026-10-31
(Linear TEG-135).

## The forks

1. **A language or a dialect.** A branch of step 2's people tree becomes
   a language of its own when it has lived apart some 1 500 years and is a
   big people; else it is a dialect of its parent's language. On the earth
   speakers barely understand each other after 1 000 to 2 000 years apart.
   The exact age and size are tuning, set when the tree is built (TEG-138).
2. **Foreign names.** A name keeps the spelling of the people that gave
   it. It is the world's content. A transcription into the player's
   people's spelling can come later; it is not part of this.
3. **Where the languages are made.** In the incubator's engine, in Rust
   (`casas-incubator`), beside the peoples. The names arise in the job
   worker with H1 and must be the same in the native and the WASM builds;
   the people tree is in that crate already. The generator's engine
   freeze does not apply: the incubator is not frozen.
4. **Names the user sets.** A name the user sets for one place spreads
   into the exonyms like a made name: the neighbours borrow it, translate
   it or give their own, by their contact.
5. **Old names.** From step 2 on: where a people replaces another
   (`peopleReplaced`, TEG-14) or absorbs it, names may stay, rivers often,
   mountains sometimes, villages seldom. Step 3's conquests use the same
   rule later.

## What follows

- TEG-137 (the language core) and the issues after it build in
  `casas-incubator`, with the hand-made kit in
  `engine/crates/casas-incubator/data/language/`.
- The window (`ui/languagePanel/`) reads a view model; it does not
  change with this decision.

# language/

The hand-made kit for the made languages of
[DES-0033](../../../../../docs/design/naming-languages.md) ("What is needed
by hand"). It is data only. It does not say which program reads it: the
language engine can be Rust or TypeScript. Both read JSON, and the kit uses
no feature of either.

The kit is beside the incubator's `catalog.json`, because both readers
already read this directory: the crate with
`include_str!("../data/language/…")`, the client with the import alias
`casas-incubator-data/language/…`. The root `data/` of the repository is
not a place for it: it is the server's store directory, and git ignores it.

The names that come from the kit are the world's content. They do not go
through i18n. Only the sentences in `changes.json` will become i18n keys
(`language.change.<id>`), so the ids of the changes are stable.

Every file has an `about` and a `sources` field at the top. Weights are
relative: divide by their sum in the same list. A `note` field is for the
reader only; a program ignores it.

## The files

| File | What it holds |
|---|---|
| `sounds.json` | The table of sounds: 56 consonants, 26 vowels. |
| `inventories.json` | How a proto-language draws its sounds. |
| `syllables.json` | 20 syllable forms, sonority sequencing, other constraints, root length. |
| `changes.json` | 80 templates of sound changes in 11 families, with the notation. |
| `meanings.json` | 148 meanings that places are named for, 48 of them in every lexicon. |
| `spelling.json` | 6 spelling styles. |
| `patterns.json` | The grammar of names and the patterns of names for 6 kinds of place. |

### sounds.json

- `sonority`: manner → a sonority value from 1 (stop) to 7 (vowel).
- `consonants[]`: `id` (the IPA symbol; the key everywhere in the kit),
  `place`, `manner`, `voice`, optional `series` (`aspirated`, `ejective`,
  `labialised`), optional `lateral`, `weight`, `roman`, optional `alt`.
- `vowels[]`: `id`, `height` (`close`, `nearClose`, `closeMid`, `mid`,
  `openMid`, `nearOpen`, `open`), `backness` (`front`, `central`, `back`),
  `rounded`, `long`, `nasal`, `weight`, `roman`, optional `alt`.
- `weight`: about the share of the PHOIBLE 2.0 inventories that have the
  sound. For the long and the nasal vowels, it is an estimate from the
  WALS chapters (10A and others), because PHOIBLE counts them as different
  segments.
- `roman`: the default letters (ASCII). `alt`: the letters to use when two
  sounds of one inventory have the same `roman` (see `spelling.json`,
  `collision`).

### inventories.json

The steps to draw an inventory:

1. Draw a class from `consonantCount` and from `vowelCount`, then a count in
   the class.
2. Draw each of the `series`. A series that is not drawn removes its sounds.
3. Take one member of each list in `always`.
4. Draw the `liquids` choice and the `gaps`.
5. Fill to the count by the weights of `sounds.json`.
6. Apply the `implications`: add the missing sound, or put the drawn sound
   back if the count is full.
7. Draw a `stress` rule.

A feature class (`[stop +voice]`) uses the notation of `changes.json`.

### syllables.json

- `complexity[]`: the three classes of WALS 12A, each with its forms.
- `forms[]`: `id` (C, V, N, G, L, O, P, s as given in `formsNote`),
  `weight`, `onsetMax`, `codaMax`, and optional limits on the onset, the
  nucleus or the coda.
- `sonority`: onsets rise, codas fall, by at least `minDistance`
  (drawn per language). The forms in `exceptions` may break this.
- `constraints[]`: other rules. `strength` is the chance that a language
  has the rule; without `strength`, every language has it.
- `rootLength[]`: the syllables of a lexicon root.

### changes.json

- `notation`: the rule syntax. In short:
  `TARGET > REPLACEMENT / ENVIRONMENT // EXCEPTION`, with sounds by id,
  sets `{a,b}`, feature classes `[stop -voice]`, class letters (`C`, `V`,
  `N` …), `_` for the target, `#` for a word edge, `∅` for nothing,
  `α` for a shared value. It is close to SCA² (Zompist) and Lexurgy.
- `families[]`: `id`, `text` (one sentence), `source` (keys of `sources`).
- `changes[]`: `id` (camelCase, stable), `family`, `rule`, optional
  `requires` (what the inventory must have), `weight`, `text` (one
  sentence in ASD-STE100 English), `attested` (the Index Diachronica
  section or the language pair), `example` (four strings: older language,
  older form, younger language, younger form).

A change can make a sound that is not in the language's inventory. The
sound must be in `sounds.json`; if it is not, the change does not apply to
that sound.

### meanings.json

- `kinds`: `village`, `river`, `mountain`, `lake`, `landmass`, `people`.
- `meanings[]`: `id`, `cat`, `pos` (`noun` or `adjective`), `core`,
  `head` (kinds for which it is the head word), `modifier` (kinds for
  which it is a likely modifier).

### spelling.json

- `styles[]`: `id`, `weight`, `diacritics`, `longVowel`, `nasalVowel`,
  `geminate`, `map` (sound → letters), `context` (letters by the
  neighbours). The `fields` object gives the meaning of each value.

### patterns.json

- `slots`: the letters of a pattern (`H` head, `A` adjective, `N` noun,
  `W` a word of its own, `X` the name of a near place, `E` the ending,
  `-` the joiner, a space for two words).
- `grammar`: what a language draws once: `adjOrder`, `genOrder`,
  `compounding`, `joiners`, `endings`, `articleWithKind`.
- `patterns`: kind → list of `id`, `form`, `weight`, and optional limits
  (`head`, `a`: the meanings allowed in that slot).
- `examples`: made words only. The kit holds no list of real names.

## Sources

- PHOIBLE 2.0: Moran, S. & McCloy, D. (eds.) 2019. https://phoible.org
- WALS Online: Dryer, M. S. & Haspelmath, M. (eds.) 2013. The World Atlas
  of Language Structures Online. https://wals.info — chapters 1A, 2A, 4A to
  8A, 10A to 14A, 86A, 87A.
- Maddieson, I. 1984. Patterns of Sounds. Cambridge University Press.
- Clements, G. N. 1990. The role of the sonority cycle in core
  syllabification.
- Campbell, L. 2013. Historical Linguistics: An Introduction. 3rd ed.,
  chapter 2.
- Hock, H. H. 1991. Principles of Historical Linguistics. 2nd ed.
- Index Diachronica, ed. C. Mitchell. https://chridd.nfshost.com/diachronica/
- Kümmel, M. J. 2007. Konsonantenwandel.
- Swadesh, M. 1971. The Origin and Diversification of Language.
- Tent, J. & Blair, D. 2011. Motivations for naming. Names 59(2).
- O'Leary, M. 2016. Naming languages. https://mewo2.com
- Daniels, P. T. & Bright, W. (eds.) 1996. The World's Writing Systems.

The counts from WALS and the weights from PHOIBLE are rounded and were
written from the published tables by hand. Check them against the sources
before a calibration depends on them.

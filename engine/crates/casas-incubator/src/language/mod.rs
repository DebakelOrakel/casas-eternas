//! THE LANGUAGES, part 1: the language core (TEG-137; docs/design/
//! naming-languages.md, DES-0033; docs/decisions/made-languages.md,
//! DEC-0054 fork 3). A proto-language made from a seed with the hand-made
//! kit (`data/language/`, its README.md):
//!
//! - THE SOUNDS (`inventory.rs`): consonants and vowels by the kit's
//!   counts, series, implications; a stress rule.
//! - THE SYLLABLES (`syllable.rs`): the forms, the onsets and codas by
//!   sonority and the other rules; a test that a word is pronounceable.
//! - THE LEXICON: a root for each core meaning of meanings.json, and for
//!   LEXICON_SHARE of the other meanings. A word is sounds (`Phoneme`),
//!   not letters.
//! - THE NAMES (`names.rs`): the grammar of names of patterns.json, and a
//!   name as a recipe whose form comes from a language.
//! - THE SPELLING (`spelling.rs`): a style of spelling.json, sounds to
//!   letters.
//! - THE SOUND CHANGES (`change.rs`): a template of changes.json applied
//!   to one word, and to a whole language (`Language::sound_change`). The
//!   tree of the languages (languages.rs, TEG-138) chains them.
//!
//! Every draw comes from hashes of the seed and of ids, in integers
//! (`draw.rs`): the native and the WASM builds give the same language.
//! Since TEG-138 the history (H1) makes the languages' tree, so the kit
//! and these constants are part of the incubator's version (tuning.rs).

mod change;
mod draw;
mod inventory;
mod kit;
mod names;
mod notation;
mod spelling;
mod syllable;
#[cfg(test)]
mod tests;

pub use change::{Change, apply_change, change, changes};
pub use draw::{Draw, mix, seed_of};
pub use inventory::{IMPLICATION_ROUNDS, Inventory, Stress};
pub use kit::{Kit, Sound, kit, weight};
pub use names::{
    Compounding, ENDING_TRIES, Ending, Grammar, JOINER_ALWAYS, Joiner, Kind, NameRecipe,
    PEOPLE_PREFIX, Slot,
};
pub use spelling::Spelling;
pub use syllable::{Phonotactics, WORD_LENGTH_LONG, WORD_LENGTH_SHIFT, WORD_LENGTH_SHORT};

use serde_json::{Value, json};

/// The share of the meanings that are not core which a proto-language has
/// a word for, in thousandths (DES-0033: "some 50" core meanings; the
/// others "as it needs them"). Each meaning is drawn on its own.
pub const LEXICON_SHARE: u32 = 500;

/// The tries for a root that no other meaning of the lexicon has.
pub const HOMOPHONE_TRIES: usize = 8;

/// A sound: an index into the kit's table of sounds (`sounds.json`, the
/// consonants then the vowels).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Phoneme(pub u8);

impl Phoneme {
    /// The sound's entry in the kit.
    pub fn sound(self) -> &'static Sound {
        &kit().sounds[self.0 as usize]
    }
    /// The IPA id.
    pub fn id(self) -> &'static str {
        &self.sound().id
    }
}

/// The IPA of a word, the ids one after the other.
pub fn ipa(word: &[Phoneme]) -> String {
    word.iter().map(|p| p.id()).collect()
}

/// A word: its sounds and the index of its stressed sound (a vowel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub sounds: Vec<Phoneme>,
    pub stress: Option<usize>,
}

/// A proto-language: everything it drew from the kit.
#[derive(Debug, Clone)]
pub struct Language {
    pub seed: u32,
    pub inventory: Inventory,
    pub syllables: Phonotactics,
    pub spelling: Spelling,
    pub grammar: Grammar,
    /// The roots by meaning, in the order of meanings.json.
    lexicon: Vec<(String, Word)>,
}

impl Language {
    /// The proto-language of a seed. The same seed gives the same
    /// language. Each part draws from a stream of its own, so a change in
    /// one part does not move the draws of the others.
    pub fn proto(seed: u32) -> Language {
        let kit = kit();
        let inventory = Inventory::draw(kit, &mut Draw::new(seed, "inventory"));
        let syllables = Phonotactics::draw(
            kit,
            &mut Draw::new(seed, "syllables"),
            &inventory.consonants,
            &inventory.vowels,
        );
        let grammar = Grammar::draw(kit, &mut Draw::new(seed, "grammar"), &inventory, &syllables);
        let mut style_draw = Draw::new(seed, "spelling");
        let style = style_draw
            .pick_by(&kit.spelling.styles, |s| u64::from(kit::weight(s.weight)))
            .unwrap();
        let spelling = Spelling::new(kit, style, &inventory.sounds());
        let mut lang = Language {
            seed,
            inventory,
            syllables,
            spelling,
            grammar,
            lexicon: Vec::new(),
        };
        for m in &kit.meanings.meanings {
            if !m.core && !Draw::new(seed, &format!("lexicon:{}", m.id)).chance(LEXICON_SHARE) {
                continue;
            }
            let mut d = Draw::new(seed, &format!("root:{}", m.id));
            let mut sounds = lang.syllables.root(kit, &mut d, None);
            for _ in 0..HOMOPHONE_TRIES {
                if !lang.lexicon.iter().any(|(_, w)| w.sounds == sounds) {
                    break;
                }
                sounds = lang.syllables.root(kit, &mut d, None);
            }
            let syllables = sounds.iter().filter(|p| p.sound().vowel).count();
            let free = d.below(syllables as u32) as usize;
            let stress = lang.stressed(&sounds, free);
            lang.lexicon.push((m.id.clone(), Word { sounds, stress }));
        }
        lang
    }

    /// The word for a meaning (an id of meanings.json), as sounds; None
    /// when the lexicon has no word for it.
    pub fn word(&self, meaning: &str) -> Option<&[Phoneme]> {
        self.root(meaning).map(|w| w.sounds.as_slice())
    }

    /// The word for a meaning with its stress.
    pub fn root(&self, meaning: &str) -> Option<&Word> {
        self.lexicon
            .iter()
            .find(|(m, _)| m == meaning)
            .map(|(_, w)| w)
    }

    /// The meanings of the lexicon, in the order of meanings.json.
    pub fn meanings(&self) -> impl Iterator<Item = &str> {
        self.lexicon.iter().map(|(m, _)| m.as_str())
    }

    /// The index of the stressed vowel of a word by the language's rule;
    /// `free` is the syllable a root keeps under free stress.
    pub fn stressed(&self, word: &[Phoneme], free: usize) -> Option<usize> {
        let vowels: Vec<usize> = (0..word.len()).filter(|&k| word[k].sound().vowel).collect();
        if vowels.is_empty() {
            return None;
        }
        Some(vowels[self.inventory.stress.syllable(vowels.len(), free)])
    }

    /// The letters of a word in the language's spelling, in small letters.
    pub fn spell(&self, word: &[Phoneme]) -> String {
        self.spelling.spell(kit(), word)
    }

    /// True when the syllable rules of the language allow the word.
    pub fn pronounceable(&self, word: &[Phoneme]) -> bool {
        self.syllables.pronounceable(kit(), word)
    }

    /// The lexicon: each meaning and its word, in the order of
    /// meanings.json.
    pub fn lexicon(&self) -> &[(String, Word)] {
        &self.lexicon
    }

    /// Gives a meaning of the lexicon a new word. A meaning the lexicon
    /// has no word for stays without one.
    pub fn set_word(&mut self, meaning: &str, word: Word) {
        if let Some(entry) = self.lexicon.iter_mut().find(|(m, _)| m == meaning) {
            entry.1 = word;
        }
    }

    /// A sound change on the whole language (TEG-138): every word of the
    /// lexicon, the endings and the joiner. A change that leaves an ending
    /// or the joiner without sounds leaves it as it was. The inventory
    /// follows the lexicon: a sound its words had and have no more goes, a
    /// sound they have and it had not comes; the spelling gives the new
    /// inventory its letters (`Spelling::new`). The first word of the
    /// lexicon the change changed, before and after; None when it changed
    /// none.
    pub fn sound_change(&mut self, change: &Change) -> Option<(Word, Word)> {
        let kit = kit();
        let mut had = [false; 256];
        let mut has = [false; 256];
        let mut first = None;
        for (_, w) in &mut self.lexicon {
            w.sounds.iter().for_each(|p| had[p.0 as usize] = true);
            if !change.may_change(&w.sounds) {
                w.sounds.iter().for_each(|p| has[p.0 as usize] = true);
                continue;
            }
            let next = apply_change(change, w);
            next.sounds.iter().for_each(|p| has[p.0 as usize] = true);
            if next.sounds != w.sounds {
                if first.is_none() {
                    first = Some((w.clone(), next.clone()));
                }
                *w = next;
            }
        }
        let bare = |sounds: &[Phoneme]| Word {
            sounds: sounds.to_vec(),
            stress: None,
        };
        for e in self.grammar.endings.iter_mut().flatten() {
            let next = apply_change(change, &bare(&e.sounds));
            if !next.sounds.is_empty() {
                e.sounds = next.sounds;
            }
        }
        if !self.grammar.joiner_sounds.is_empty() {
            let next = apply_change(change, &bare(&self.grammar.joiner_sounds));
            if !next.sounds.is_empty() {
                self.grammar.joiner_sounds = next.sounds;
            }
        }
        let gone = |p: &Phoneme| had[p.0 as usize] && !has[p.0 as usize];
        self.inventory.consonants.retain(|p| !gone(p));
        self.inventory.vowels.retain(|p| !gone(p));
        for k in 0..kit.sounds.len() {
            let p = Phoneme(k as u8);
            if !has[k]
                || self.inventory.consonants.contains(&p)
                || self.inventory.vowels.contains(&p)
            {
                continue;
            }
            let list = if kit.sounds[k].vowel {
                &mut self.inventory.vowels
            } else {
                &mut self.inventory.consonants
            };
            let at = list.partition_point(|q| q.0 < p.0);
            list.insert(at, p);
        }
        self.spelling = Spelling::new(kit, self.spelling.style, &self.inventory.sounds());
        first
    }

    /// The language in another style of spelling (spelling.json, by its
    /// index).
    pub fn respell(&mut self, style: usize) {
        self.spelling = Spelling::new(kit(), style, &self.inventory.sounds());
    }
}

/// The meanings of the kit that are in every lexicon.
pub fn core_meanings() -> Vec<&'static str> {
    kit()
        .meanings
        .meanings
        .iter()
        .filter(|m| m.core)
        .map(|m| m.id.as_str())
        .collect()
}

/// A short sample of a seed's language for the bindings and the harness
/// (a debug view, not a format): the inventory, the syllables, the
/// grammar, the first `core` words, and names of each kind (salts 0, 1 …).
pub fn sample(seed: u32) -> Value {
    let lang = Language::proto(seed);
    let k = kit();
    let ids = |list: &[Phoneme]| list.iter().map(|p| p.id()).collect::<Vec<_>>();
    let core: Vec<Value> = core_meanings()
        .into_iter()
        .take(10)
        .map(|m| {
            let w = lang.word(m).unwrap_or(&[]);
            json!({ "meaning": m, "ipa": ipa(w), "spelt": lang.spell(w) })
        })
        .collect();
    let names = |kind: Kind, n: u32| -> Vec<String> {
        (0..n)
            .map(|s| lang.name(kind, &[], s).form(&lang))
            .collect()
    };
    let g = &lang.grammar;
    json!({
        "seed": seed,
        "consonants": ids(&lang.inventory.consonants),
        "vowels": ids(&lang.inventory.vowels),
        "size": lang.inventory.consonants.len() + lang.inventory.vowels.len(),
        "stress": lang.inventory.stress.id(),
        "complexity": lang.syllables.complexity,
        "forms": lang.syllables.forms.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
        "spelling": lang.spelling.style_id(k),
        "grammar": {
            "adjAfter": g.adj_after,
            "genAfter": g.gen_after,
            "compounding": format!("{:?}", g.compounding),
            "joiner": format!("{:?}", g.joiner),
            "joinerAlways": g.joiner_always,
            "endings": Kind::ALL.iter().map(|&kind| g.ending(kind).map(|e| ipa(&e.sounds))).collect::<Vec<_>>(),
        },
        "lexicon": lang.lexicon.len(),
        "core": core,
        "village": names(Kind::Village, 5),
        "river": names(Kind::River, 3),
        "mountain": names(Kind::Mountain, 2),
        "people": names(Kind::People, 2),
    })
}

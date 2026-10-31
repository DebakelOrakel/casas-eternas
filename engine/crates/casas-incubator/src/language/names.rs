//! The grammar of names (`patterns.json`): what a language draws once
//! (the orders, the compounding, the joiner, the endings), the recipe of a
//! name, and the form of a recipe in a language.
//!
//! A recipe keeps meanings, not words: the form comes from the lexicon of
//! the language it is given, so a daughter language gives its own form of
//! the same recipe. Only a word of its own (`W`) is kept as sounds.

use super::draw::{Draw, mix};
use super::inventory::Inventory;
use super::kit::{Kit, kit, weight};
use super::spelling::capitalise;
use super::syllable::{Phonotactics, echoes};
use super::{Language, Phoneme};

/// The chance that a language with a vowel joiner puts it in every
/// compound, not only where the syllable rules need it ("joinerRule"), in
/// thousandths.
pub const JOINER_ALWAYS: u32 = 500;

/// The chance that the ending of the people is a prefix (the note of
/// "endings": "a prefix is allowed with weight 0.15"), in thousandths.
pub const PEOPLE_PREFIX: u32 = 150;

/// A name's syllables at most, over its words, and a word's (TEG-146: on
/// 300 seeds' proto-languages before the caps, 4.7 % of the names had 6
/// syllables or more, "Qmembajtlabjo", "Kemqemkamtomtja"; most of the
/// earth's place names have 2 to 4). A name over the caps is drawn again
/// (`Language::name`), NAME_TRIES_LENGTH times at most.
pub const NAME_SYLLABLES_MOST: usize = 5;
pub const WORD_SYLLABLES_MOST: usize = 4;
/// And a word's sounds at most: the clusters make a word of four
/// syllables long too ("Tlabjodjabem", 12 sounds; 5 % of the names' words
/// had more than 10 before the cap).
pub const WORD_SOUNDS_MOST: usize = 10;
pub const NAME_TRIES_LENGTH: u32 = 8;

/// The tries to draw an ending that the syllable rules allow.
pub const ENDING_TRIES: usize = 20;

/// The kinds of place (`kinds` of meanings.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Village,
    River,
    Mountain,
    Lake,
    Landmass,
    People,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Village,
        Kind::River,
        Kind::Mountain,
        Kind::Lake,
        Kind::Landmass,
        Kind::People,
    ];

    /// The id of the kit: "village", "river" …
    pub fn id(self) -> &'static str {
        match self {
            Kind::Village => "village",
            Kind::River => "river",
            Kind::Mountain => "mountain",
            Kind::Lake => "lake",
            Kind::Landmass => "landmass",
            Kind::People => "people",
        }
    }

    pub fn of(id: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.id() == id)
    }
}

/// How modifier and head stand together (`compounding`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compounding {
    OneWord,
    TwoWords,
    /// One word for a noun, two words for an adjective.
    Mixed,
}

/// The joiner between two parts of one word (`joiners`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Joiner {
    None,
    Vowel,
    /// A short genitive ending, with a noun only.
    Genitive,
    /// A consonant, only where two vowels meet.
    Consonant,
}

/// The ending of a kind of place.
#[derive(Debug, Clone)]
pub struct Ending {
    pub sounds: Vec<Phoneme>,
    pub prefix: bool,
}

/// What a language draws once from `patterns.json`.
#[derive(Debug, Clone)]
pub struct Grammar {
    pub adj_after: bool,
    pub gen_after: bool,
    pub compounding: Compounding,
    pub joiner: Joiner,
    /// The sounds of the joiner (empty for `None`).
    pub joiner_sounds: Vec<Phoneme>,
    /// The vowel joiner stands in every compound.
    pub joiner_always: bool,
    /// The vowel that stands where the syllable rules need one (the
    /// vowel joiner, if the language has one).
    pub link_vowel: Phoneme,
    /// The consonant that stands where two vowels meet and may not (the
    /// consonant joiner, if the language has one).
    pub link_consonant: Phoneme,
    /// By `Kind` (in the order of `Kind::ALL`).
    pub endings: Vec<Option<Ending>>,
    /// The language names the kind before a river or a mountain.
    pub article: bool,
}

fn pick_id(d: &mut Draw, list: &[super::kit::Weighted]) -> String {
    list[d.pick_by(list, |w| u64::from(weight(w.weight))).unwrap()]
        .id
        .clone()
}

impl Grammar {
    /// Draws the grammar of a language whose sounds and syllables are drawn.
    pub fn draw(kit: &Kit, d: &mut Draw, inv: &Inventory, syl: &Phonotactics) -> Grammar {
        let g = &kit.patterns.grammar;
        let adj_after = pick_id(d, &g.adj_order) == "after";
        let gen_after = pick_id(d, &g.gen_order) == "after";
        let compounding = match pick_id(d, &g.compounding).as_str() {
            "twoWords" => Compounding::TwoWords,
            "mixed" => Compounding::Mixed,
            _ => Compounding::OneWord,
        };
        let j = d
            .pick_by(&g.joiners, |w| u64::from(weight(w.weight)))
            .unwrap();
        let joiner = match g.joiners[j].id.as_str() {
            "vowel" => Joiner::Vowel,
            "genitive" => Joiner::Genitive,
            "consonant" => Joiner::Consonant,
            _ => Joiner::None,
        };
        let sound = |p: Phoneme| &kit.sounds[p.0 as usize];
        let short = Grammar::link_vowels(inv);
        let by_weight = |d: &mut Draw, list: &[Phoneme]| {
            list[d.pick_by(list, |&p| u64::from(sound(p).weight)).unwrap()]
        };
        let link_vowel = by_weight(d, &short);
        let onsets = Grammar::link_consonants(inv);
        let link_consonant = by_weight(d, &onsets);
        let codas: Vec<Phoneme> = inv
            .consonants
            .iter()
            .copied()
            .filter(|&c| syl.coda_ok(kit, c))
            .collect();
        let joiner_sounds = match joiner {
            Joiner::None => vec![],
            Joiner::Vowel => vec![link_vowel],
            Joiner::Consonant => vec![link_consonant],
            Joiner::Genitive => {
                let v = by_weight(d, &short);
                if codas.is_empty() {
                    vec![v]
                } else {
                    vec![v, by_weight(d, &codas)]
                }
            }
        };
        let joiner_always = joiner == Joiner::Vowel && d.chance(JOINER_ALWAYS);
        let mut grammar = Grammar {
            adj_after,
            gen_after,
            compounding,
            joiner,
            joiner_sounds,
            joiner_always,
            link_vowel,
            link_consonant,
            endings: Vec::new(),
            article: d.chance(weight(g.article_with_kind.weight)),
        };
        // The endings: by chance per kind, then a form filled from the
        // sounds, until the syllable rules allow it after a root.
        for kind in Kind::ALL {
            let chance = g.endings.chance.get(kind.id()).copied().unwrap_or(0.0);
            if !d.chance(weight(chance)) {
                grammar.endings.push(None);
                continue;
            }
            let prefix = kind == Kind::People && d.chance(PEOPLE_PREFIX);
            let mut ending = vec![link_vowel];
            for _ in 0..ENDING_TRIES {
                let form = &g.endings.form[d.below(g.endings.form.len() as u32) as usize];
                let sounds: Vec<Phoneme> = form
                    .chars()
                    .map(|c| {
                        if c == 'V' {
                            by_weight(d, &short)
                        } else {
                            by_weight(d, &onsets)
                        }
                    })
                    .collect();
                // The test word: a CV root before the ending (after it, for
                // a prefix), the vowel of the root dropped where two meet.
                let root = [link_consonant, link_vowel];
                let test = if prefix {
                    grammar.seam(kit, syl, &sounds, &[], &root)
                } else {
                    grammar.seam(kit, syl, &root, &[], &sounds)
                };
                if syl.pronounceable(kit, &test) {
                    ending = sounds;
                    break;
                }
            }
            grammar.endings.push(Some(Ending {
                sounds: ending,
                prefix,
            }));
        }
        grammar
    }

    /// The sounds of an inventory a link vowel may be: the short oral
    /// vowels.
    pub fn link_vowels(inv: &Inventory) -> Vec<Phoneme> {
        inv.vowels
            .iter()
            .copied()
            .filter(|&v| !v.sound().long && !v.sound().nasal)
            .collect()
    }

    /// The sounds of an inventory a link consonant may be: not a glide,
    /// not ŋ; all its consonants where none is left.
    pub fn link_consonants(inv: &Inventory) -> Vec<Phoneme> {
        let onsets: Vec<Phoneme> = inv
            .consonants
            .iter()
            .copied()
            .filter(|&c| !c.sound().glide() && c.id() != "ŋ")
            .collect();
        if onsets.is_empty() {
            inv.consonants.clone()
        } else {
            onsets
        }
    }

    /// The ending of a kind, if the language has one.
    pub fn ending(&self, kind: Kind) -> Option<&Ending> {
        self.endings.get(kind as usize).and_then(|e| e.as_ref())
    }

    // a, the link and b, one after the other. Where two vowels meet and
    // the language does not allow it, the joiner consonant stands between
    // them (joiner "consonant"), else the first vowel goes (joinerRule),
    // or the second if the first is the only vowel of its part.
    fn seam(
        &self,
        kit: &Kit,
        syl: &Phonotactics,
        a: &[Phoneme],
        link: &[Phoneme],
        b: &[Phoneme],
    ) -> Vec<Phoneme> {
        let vowel = |p: &Phoneme| kit.sounds[p.0 as usize].vowel;
        let mut out: Vec<Phoneme> = a.to_vec();
        for part in [link, b] {
            if part.is_empty() {
                continue;
            }
            let mut part = part.to_vec();
            let meet = out.last().is_some_and(vowel) && part.first().is_some_and(vowel);
            if meet && syl.rules.no_vowel_hiatus {
                if self.joiner == Joiner::Consonant {
                    out.push(self.link_consonant);
                } else if out.iter().filter(|p| vowel(p)).count() > 1 {
                    out.pop();
                } else if part.iter().filter(|p| vowel(p)).count() > 1 {
                    part.remove(0);
                } else {
                    out.push(self.link_consonant);
                }
            }
            out.extend(part);
        }
        out
    }

    /// a and b as one word: with the link, then with the link vowel, then
    /// with the link consonant, the first that the syllable rules allow.
    /// None when none of them is allowed.
    pub fn join(
        &self,
        kit: &Kit,
        syl: &Phonotactics,
        a: &[Phoneme],
        b: &[Phoneme],
        link: &[Phoneme],
    ) -> Option<Vec<Phoneme>> {
        let tries: [&[Phoneme]; 3] = [link, &[self.link_vowel], &[self.link_consonant]];
        tries
            .iter()
            .map(|l| self.seam(kit, syl, a, l, b))
            .find(|w| syl.pronounceable(kit, w))
    }
}

/// A part of a name's recipe, in the order of its pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    /// `H`: the meaning of the head.
    Head(String),
    /// `A`: the meaning of an adjective.
    Adjective(String),
    /// `N`: the meaning of a noun as a modifier.
    Noun(String),
    /// `W`: a word of its own, as sounds.
    Own(Vec<Phoneme>),
    /// `E`: the language's ending for the kind.
    Ending,
}

/// A name as a recipe: the kind, the pattern and what fills it. Its form
/// comes from a language (`form`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameRecipe {
    pub kind: Kind,
    /// The id of the pattern in patterns.json.
    pub pattern: String,
    pub slots: Vec<Slot>,
}

impl NameRecipe {
    /// The words of the name in a language, as sounds. A meaning that the
    /// language has no word for gives nothing.
    pub fn words(&self, lang: &Language) -> Vec<Vec<Phoneme>> {
        let kit = kit();
        let g = &lang.grammar;
        let form = &kit.patterns.patterns[self.kind.id()]
            .iter()
            .find(|p| p.id == self.pattern)
            .expect("the recipe's pattern")
            .form;
        let letters: Vec<char> = form.chars().filter(|c| c.is_ascii_uppercase()).collect();
        let space = form.contains(' ');
        let sounds = |slot: &Slot| -> Option<Vec<Phoneme>> {
            match slot {
                Slot::Head(m) | Slot::Adjective(m) | Slot::Noun(m) => {
                    lang.word(m).map(|w| w.to_vec())
                }
                Slot::Own(s) => Some(s.clone()),
                Slot::Ending => g.ending(self.kind).map(|e| e.sounds.clone()),
            }
        };
        let parts: Vec<Option<Vec<Phoneme>>> = self.slots.iter().map(sounds).collect();
        match (letters.as_slice(), parts.as_slice()) {
            ([_], [Some(w)]) => vec![w.clone()],
            ([_, 'E'], [Some(w), e]) => {
                let Some(e) = e else { return vec![w.clone()] };
                let prefix = g.ending(self.kind).is_some_and(|e| e.prefix);
                let joined = if prefix {
                    g.join(kit, &lang.syllables, e, w, &[])
                } else {
                    g.join(kit, &lang.syllables, w, e, &[])
                };
                vec![joined.unwrap_or_else(|| w.clone())]
            }
            ([_, _], [Some(a), Some(b)]) if space => vec![a.clone(), b.clone()],
            ([m, _], [Some(a), Some(b)]) => {
                let swap = match m {
                    'A' => g.adj_after,
                    'N' | 'X' => g.gen_after,
                    _ => false,
                };
                let one_word = match g.compounding {
                    Compounding::OneWord => true,
                    Compounding::TwoWords => false,
                    Compounding::Mixed => *m != 'A',
                };
                // The genitive ending on a noun.
                let a = if *m == 'N' && g.joiner == Joiner::Genitive {
                    g.join(kit, &lang.syllables, a, &g.joiner_sounds, &[])
                        .unwrap_or_else(|| a.clone())
                } else {
                    a.clone()
                };
                let link: &[Phoneme] = if g.joiner_always {
                    &g.joiner_sounds
                } else {
                    &[]
                };
                let (first, second) = if swap { (b, &a) } else { (&a, b) };
                match one_word
                    .then(|| g.join(kit, &lang.syllables, first, second, link))
                    .flatten()
                {
                    Some(w) => vec![w],
                    None => vec![first.clone(), second.clone()],
                }
            }
            _ => parts.into_iter().flatten().collect(),
        }
    }

    /// The name in a language: its words spelt, each with a capital.
    pub fn form(&self, lang: &Language) -> String {
        let words: Vec<String> = self.words(lang).iter().map(|w| lang.spell(w)).collect();
        capitalise(&words.join(" "))
    }
}

impl Language {
    /// A name for a place of this kind. `meanings` are what is at the
    /// place (a river, a forest, red rock …): they fill the slots first
    /// where they fit; the rest comes from the lexicon at random. `salt`
    /// tells two places apart: the same kind, meanings and salt give the
    /// same recipe. The patterns with `X` (the name of a near place) need
    /// that place and are not drawn here.
    ///
    /// TEG-146: a name of more than NAME_SYLLABLES_MOST syllables, with a
    /// word of more than WORD_SYLLABLES_MOST syllables or WORD_SOUNDS_MOST
    /// sounds, or with two like syllables side by side in a word
    /// (`echoes`), is drawn again, NAME_TRIES_LENGTH tries in all; where
    /// none keeps the caps, the one least over them stands (0.3 % of the
    /// names on 300 seeds).
    pub fn name(&self, kind: Kind, meanings: &[&str], salt: u32) -> NameRecipe {
        let mut d = Draw::new(mix(self.seed ^ mix(salt)), &format!("name:{}", kind.id()));
        let mut best: Option<((usize, usize), NameRecipe)> = None;
        for _ in 0..NAME_TRIES_LENGTH {
            let recipe = self.draw_name(kind, meanings, &mut d);
            let words = recipe.words(self);
            let syllables = |w: &[Phoneme]| w.iter().filter(|p| p.sound().vowel).count();
            let total: usize = words.iter().map(|w| syllables(w)).sum();
            let longest = words.iter().map(|w| syllables(w)).max().unwrap_or(0);
            let sounds = words.iter().map(Vec::len).max().unwrap_or(0);
            let echo = words.iter().any(|w| echoes(w));
            if total <= NAME_SYLLABLES_MOST
                && longest <= WORD_SYLLABLES_MOST
                && sounds <= WORD_SOUNDS_MOST
                && !echo
            {
                return recipe;
            }
            // The least over the caps, then the one without an echo.
            let over = (total.saturating_sub(NAME_SYLLABLES_MOST))
                + longest.saturating_sub(WORD_SYLLABLES_MOST)
                + sounds.saturating_sub(WORD_SOUNDS_MOST);
            let score = (over, usize::from(echo));
            if best.as_ref().is_none_or(|(b, _)| score < *b) {
                best = Some((score, recipe));
            }
        }
        best.expect("NAME_TRIES_LENGTH is not 0").1
    }

    // One draw of `name`.
    fn draw_name(&self, kind: Kind, meanings: &[&str], d: &mut Draw) -> NameRecipe {
        let kit = kit();
        let patterns = &kit.patterns.patterns[kind.id()];
        let lexicon: Vec<&super::kit::Meaning> = kit
            .meanings
            .meanings
            .iter()
            .filter(|m| self.word(&m.id).is_some())
            .collect();
        let candidates = |letter: char, p: &super::kit::Pattern| -> Vec<&str> {
            lexicon
                .iter()
                .filter(|m| match letter {
                    'H' => {
                        m.head.iter().any(|k| k == kind.id())
                            && p.head.as_ref().is_none_or(|h| h.contains(&m.id))
                    }
                    'A' => {
                        m.pos == "adjective"
                            && m.modifier.iter().any(|k| k == kind.id())
                            && p.a.as_ref().is_none_or(|a| a.contains(&m.id))
                    }
                    'N' => m.pos == "noun" && m.modifier.iter().any(|k| k == kind.id()),
                    _ => false,
                })
                .map(|m| m.id.as_str())
                .collect()
        };
        let feasible = |p: &super::kit::Pattern| {
            p.form
                .chars()
                .filter(|c| c.is_ascii_uppercase())
                .all(|c| match c {
                    'H' | 'A' | 'N' => !candidates(c, p).is_empty(),
                    'W' => true,
                    'E' => self.grammar.ending(kind).is_some(),
                    _ => false,
                })
        };
        let weights: Vec<u64> = patterns
            .iter()
            .map(|p| {
                if !feasible(p) {
                    return 0;
                }
                let article = self.grammar.article
                    && p.form == "H W"
                    && matches!(kind, Kind::River | Kind::Mountain);
                u64::from(weight(p.weight)) * if article { 3 } else { 1 }
            })
            .collect();
        // Every kind has a pattern of W alone or W and its ending; W alone
        // is the last resort.
        let Some(k) = d.pick(&weights) else {
            return NameRecipe {
                kind,
                pattern: patterns
                    .iter()
                    .find(|p| p.form == "W")
                    .map_or_else(|| patterns[0].id.clone(), |p| p.id.clone()),
                slots: vec![Slot::Own(self.own_word(d))],
            };
        };
        let p = &patterns[k];
        let mut used: Vec<&str> = Vec::new();
        let mut slots = Vec::new();
        for c in p.form.chars().filter(|c| c.is_ascii_uppercase()) {
            let slot = match c {
                'H' | 'A' | 'N' => {
                    let all: Vec<&str> = candidates(c, p)
                        .into_iter()
                        .filter(|m| !used.contains(m))
                        .collect();
                    let context: Vec<&str> = meanings
                        .iter()
                        .copied()
                        .filter(|m| all.contains(m))
                        .collect();
                    let from = if context.is_empty() { &all } else { &context };
                    let m = if from.is_empty() {
                        candidates(c, p)[0]
                    } else {
                        from[d.below(from.len() as u32) as usize]
                    };
                    used.push(m);
                    match c {
                        'H' => Slot::Head(m.to_string()),
                        'A' => Slot::Adjective(m.to_string()),
                        _ => Slot::Noun(m.to_string()),
                    }
                }
                'W' => Slot::Own(self.own_word(d)),
                _ => Slot::Ending,
            };
            slots.push(slot);
        }
        NameRecipe {
            kind,
            pattern: p.id.clone(),
            slots,
        }
    }

    // A word of its own: a root the language makes now (`new_root`: in
    // its sounds, through its line's changes; TEG-146, before a root of
    // its proto-language's sounds).
    fn own_word(&self, d: &mut Draw) -> Vec<Phoneme> {
        self.new_root(d).sounds
    }
}

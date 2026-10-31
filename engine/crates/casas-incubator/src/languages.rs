//! THE LANGUAGES, part 2: the tree of the families, the languages and the
//! dialects (TEG-138, 2026-10-31; docs/design/naming-languages.md,
//! DES-0033 "Where it hangs" and "What is kept"; docs/decisions/
//! made-languages.md, DEC-0054 fork 1). Made at the history's end from the
//! peoples' tree (peoples.rs `Tree`), with the language core
//! (`language/`), into H1 (pack.rs) and the log.
//!
//! - A FAMILY for each group of step 1 (the peoples' `group`): its
//!   proto-language `Language::proto` from a hash of the world's seed and
//!   the group. The families are not related.
//! - A LANGUAGE where a people (a branch of step 2's tree) lived
//!   LANGUAGE_APART_YEARS from its birth and was big with LANGUAGE_SHARE of
//!   the km² lived in at a tree step or more. It arises
//!   LANGUAGE_APART_YEARS after the people's birth; until then the people
//!   speaks what its parent spoke at its birth (its family's proto-language
//!   for a people with no parent). It comes from that language as it was at
//!   the people's birth.
//! - A DIALECT for each big people (peoples.rs `big`), of the language it
//!   speaks at its end: a few sound changes (dated in its people's life,
//!   drawn against the language at the language's last year) and a
//!   spelling of its own on top of the language; the lexicon and the
//!   grammar of names are the language's. A small people speaks the dialect of its nearest big
//!   forebear where that one speaks its language, else its language.
//!
//! A family's proto-language and a language change by DATED sound
//! changes (`changes.json`, drawn where `Change::fits` and in order, each
//! with its year) and new words for a share of the lexicon, every
//! CENTURY_YEARS of the time they are spoken. A new word is a root of the
//! family's proto-language through every sound change of the line up to
//! its year: an old synonym that takes the meaning over, in the language's
//! sounds.
//!
//! WHAT IS KEPT (DES-0033): per people its node (`of_people`, a dialect or
//! a language), and the tree of the nodes with their descriptions: the
//! choices made, not the words that follow from them (`describe`). A
//! language's form at a year is its description replayed (`speech`).
//! Speakers are not kept: the client derives them from the peoples' tree.
//!
//! THE CHRONICLE: a language arises (`LanguageArises`, not for a people of
//! step 2's start: those are there, as their splits are not told), a
//! language goes (`LanguageGone`, its last people ended: not where its
//! last speakers took a daughter language of it, and not a family's
//! proto-language, which ends with its family or lives on in its
//! daughters), a family goes (`FamilyGone`, its last people ended). The
//! hold of the peoples' events (peoples.rs THE HOLD) is in the rule: a
//! people's id lasts LANGUAGE_APART_YEARS only where it held so long (the
//! parts that part and join again take a new id each time, and none of
//! them becomes a language), and the tree is final when this runs, so no
//! event is taken back. The size is: a language's people had
//! LANGUAGE_SHARE, ten times the chronicle's SPLIT_TOLD_SHARE.

use crate::language::Draw;
use crate::language::{
    Change, Kind, Language, NameRecipe, Phoneme, Slot, Word, apply_change, changes, ipa, kit,
    seed_of,
};
use crate::log::LogEvent;
use crate::peoples::Tree;
use casas_generator::core::js;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

/// A branch of the peoples becomes a language of its own after this many
/// years apart (DEC-0054 fork 1: "some 1 500"). On the earth two speech
/// communities apart for 1 000 to 2 000 years barely understand each
/// other: Latin to the Romance languages some 1 500 years, Old Norse to
/// Icelandic and Norwegian some 1 000, the Bantu languages of one branch
/// some 2 000 (from memory, not checked against a source).
pub const LANGUAGE_APART_YEARS: f64 = 1500.0;
/// And when it is a big people: big (peoples.rs `big`) with this share of
/// the km² lived in at a tree step or more, ten times the chronicle's
/// SPLIT_TOLD_SHARE. On the three v15 worlds with the rain (own origins,
/// 2026-10-31; from the kept states, every 2 500 years) the peoples that
/// lived 1 500 years and were big: 255, 171 and 183; with a share of 0.005
/// 117, 104 and 113 (some 60 % of them of no parent), at 0.01 47, 53 and
/// 53. At every tree step (as built) at 0.01: 63, 62 and 67 languages
/// (Morvane, Thalassor, Zephyra), of 36, 35 and 32 families; 21, 18 and
/// 26 of them arise told (the rest of step 2's start). DES-0033 asks for
/// some tens a world.
pub const LANGUAGE_SHARE: f64 = 0.01;
/// The step of the dated changes, years.
pub const CENTURY_YEARS: f64 = 100.0;
/// The chance of a sound change in a century, thousandths: two a
/// millennium. A rate, not an earth measure: Latin to Spanish took some
/// 30 regular changes in 2 000 years (Index Diachronica's list, from
/// memory); the kit has 91 templates, and two a millennium keep the
/// daughters of one family alike for some thousands of years.
pub const SOUND_CHANGE_CHANCE: u32 = 200;
/// The chance that a meaning of the lexicon takes a new word in a century,
/// thousandths: 1 − 0.86^0.1. Glottochronology's anchor: some 86 % of the
/// Swadesh list of 100 meanings kept a millennium (Swadesh 1955; Lees
/// 1953 gave 81 % for the list of 200; from memory, not checked against
/// the papers). The kit's meanings are a place's (water, river, hill,
/// red …), near the Swadesh list's.
pub const WORD_LOSS_CHANCE: u32 = 15;
/// The tries to draw a sound change that changes CHANGE_LEAST_WORDS words
/// or more of the lexicon and leaves each a vowel.
pub const CHANGE_TRIES: usize = 12;
pub const CHANGE_LEAST_WORDS: usize = 2;
/// A dialect's sound changes on top of its language: as many as drawn
/// between these, dated within its people's life.
pub const DIALECT_CHANGES_LEAST: u32 = 1;
pub const DIALECT_CHANGES_MOST: u32 = 3;

/// A node's level, as packed (`languageLevel`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Family = 0,
    Language = 1,
    Dialect = 2,
}

impl Level {
    fn of(code: u8) -> Level {
        match code {
            0 => Level::Family,
            1 => Level::Language,
            _ => Level::Dialect,
        }
    }
}

/// What the tree takes of a people (peoples.rs `People`).
#[derive(Clone, Debug)]
pub struct PeopleInput {
    pub parent: i32,
    pub group: i32,
    pub born: f64,
    pub ended: f64,
    pub merged_into: i32,
    pub big: bool,
    pub share: f64,
    pub replaced: bool,
    pub heart: i32,
    pub heart_apart: i32,
}

impl PeopleInput {
    /// The peoples of a tree.
    pub fn of_tree(tree: &Tree) -> Vec<PeopleInput> {
        tree.peoples
            .iter()
            .map(|p| PeopleInput {
                parent: p.parent,
                group: p.group,
                born: p.born,
                ended: p.ended,
                merged_into: p.merged_into,
                big: p.big,
                share: p.share,
                replaced: p.replaced,
                heart: p.heart,
                heart_apart: p.heart_apart,
            })
            .collect()
    }
}

/// A sound change of a node: its year, the template (its index in
/// changes.json) and its choice (`Change::with_choice`).
#[derive(Clone, Debug, PartialEq)]
pub struct Dated {
    pub year: f64,
    pub change: usize,
    pub choice: usize,
}

/// A new word of a node: its year and the meaning (its index in
/// meanings.json). The word follows from the node's seed (`new_word`), as
/// a proto-language's lexicon follows from its.
#[derive(Clone, Debug, PartialEq)]
pub struct NewWord {
    pub year: f64,
    pub meaning: usize,
}

/// A node of the tree.
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub level: Level,
    /// The node it comes from (a language's: the one its people spoke at
    /// its birth; a dialect's: its language); -1 for a family.
    pub parent: i32,
    /// The people it is of: a language's and a dialect's; -1 for a family.
    pub people: i32,
    /// When its line parted from its parent's (its people's birth; a
    /// family's: its first people's), when it arose (a language's
    /// LANGUAGE_APART_YEARS later), and its last year spoken (or the
    /// history's end), years.
    pub from: f64,
    pub at: f64,
    pub until: f64,
    /// Its draws' seed; a family's is its proto-language's.
    pub seed: u32,
    /// Its style of spelling (spelling.json, by index).
    pub style: usize,
    pub changes: Vec<Dated>,
    pub words: Vec<NewWord>,
}

/// THE TREE: the nodes, the parents before their daughters; each people's
/// node.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Languages {
    pub nodes: Vec<Node>,
    pub of_people: Vec<i32>,
    /// What the nodes are, written out (`Packed::description`).
    pub description: String,
}

/// The tree as packed (pack.rs; its module's head names the arrays).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Packed {
    pub people_language: Vec<i32>,
    pub parent: Vec<i32>,
    pub level: Vec<u8>,
    pub people: Vec<i32>,
    pub from: Vec<f32>,
    pub at: Vec<f32>,
    pub until: Vec<f32>,
    pub seed: Vec<i32>,
    pub style: Vec<u8>,
    pub change_start: Vec<i32>,
    pub change_year: Vec<u16>,
    pub change: Vec<u8>,
    pub change_choice: Vec<u8>,
    pub word_start: Vec<i32>,
    pub word_year: Vec<u16>,
    pub word_meaning: Vec<u8>,
    /// JSON: by node, a language's sounds at its last year and a family's
    /// stress rule and syllable forms; null for a dialect. What the
    /// arrays give, written out for a reader without the kit.
    pub description: String,
}

/// A language as it is at a year: the language, every sound change of its
/// line in order (for the words that come later), and the node's own
/// changes with the first word each changed.
#[derive(Clone)]
pub struct Speech {
    pub lang: Language,
    pub applied: Vec<Change>,
    pub own: Vec<(Dated, Option<(Word, Word)>)>,
}

// The world's seed in 32 bits.
fn bits_of(seed: f64) -> u32 {
    let b = seed.to_bits();
    (b ^ (b >> 32)) as u32
}

fn vowel(p: &Phoneme) -> bool {
    p.sound().vowel
}

impl Languages {
    /// The tree of a history's peoples: `seed` the world's, `start` step
    /// 2's start (its first tree step), `end` the history's end. And the
    /// chronicle's events, by their time.
    pub fn build(
        peoples: &[PeopleInput],
        seed: f64,
        start: f64,
        end: f64,
    ) -> (Languages, Vec<LogEvent>) {
        let world = bits_of(seed);
        let n = peoples.len();
        let until_p: Vec<f64> = peoples.iter().map(|p| js::min(p.ended, end)).collect();
        // Seen at its language's arising: a people's `ended` is the first
        // tree step it was not seen at.
        let founder: Vec<bool> = (0..n)
            .map(|p| {
                let q = &peoples[p];
                let arises = q.born + LANGUAGE_APART_YEARS;
                q.big && q.share >= LANGUAGE_SHARE && q.ended > arises && end >= arises
            })
            .collect();
        let mut cache = Cache::default();
        let mut nodes: Vec<Node> = Vec::new();
        let mut family: BTreeMap<i32, usize> = BTreeMap::new();
        let mut own = vec![-1i32; n];
        let mut pre = vec![-1i32; n];
        let speaks = |own: &[i32], pre: &[i32], nodes: &[Node], q: usize, t: f64| -> i32 {
            if own[q] >= 0 && t >= nodes[own[q] as usize].at {
                own[q]
            } else {
                pre[q]
            }
        };
        for p in 0..n {
            let q = &peoples[p];
            let f = *family.entry(q.group).or_insert_with(|| {
                let s = seed_of(world, &format!("family:{}", q.group));
                let style = cache.proto(s).spelling.style;
                nodes.push(Node {
                    level: Level::Family,
                    parent: -1,
                    people: -1,
                    from: q.born,
                    at: q.born,
                    until: q.born,
                    seed: s,
                    style,
                    changes: Vec::new(),
                    words: Vec::new(),
                });
                nodes.len() - 1
            });
            pre[p] = if q.parent < 0 {
                f as i32
            } else {
                speaks(&own, &pre, &nodes, q.parent as usize, q.born)
            };
            if founder[p] {
                let style = nodes[pre[p] as usize].style;
                nodes.push(Node {
                    level: Level::Language,
                    parent: pre[p],
                    people: p as i32,
                    from: q.born,
                    at: q.born + LANGUAGE_APART_YEARS,
                    until: until_p[p],
                    seed: seed_of(world, &format!("language:{p}")),
                    style,
                    changes: Vec::new(),
                    words: Vec::new(),
                });
                own[p] = nodes.len() as i32 - 1;
            }
        }
        let last: Vec<i32> = (0..n)
            .map(|p| if own[p] >= 0 { own[p] } else { pre[p] })
            .collect();
        // The last year each language-level node is spoken: by whom, and
        // whether its speakers took a daughter of it then (a switch).
        let mut spoken: Vec<(f64, bool, i32)> = vec![(f64::NEG_INFINITY, false, -1); nodes.len()];
        let mut note = |k: i32, t: f64, switch: bool, p: usize| {
            let s = &mut spoken[k as usize];
            if t > s.0 || (t == s.0 && switch) {
                *s = (t, switch, p as i32);
            }
        };
        for p in 0..n {
            if own[p] >= 0 {
                note(pre[p], nodes[own[p] as usize].at, true, p);
                note(own[p], until_p[p], false, p);
            } else {
                note(pre[p], until_p[p], false, p);
            }
        }
        for (k, s) in spoken.iter().enumerate() {
            nodes[k].until = js::max(nodes[k].at, s.0);
        }
        // The dialects; each people's node.
        let languages = nodes.len();
        let mut dialect = vec![-1i32; n];
        for p in 0..n {
            if !peoples[p].big {
                continue;
            }
            let lang = last[p] as usize;
            let s = seed_of(world, &format!("dialect:{p}"));
            let styles = &kit().spelling.styles;
            let weights: Vec<u64> = styles
                .iter()
                .enumerate()
                .map(|(k, st)| {
                    if k == nodes[lang].style {
                        0
                    } else {
                        u64::from(crate::language::weight(st.weight))
                    }
                })
                .collect();
            let style = Draw::new(s, "style")
                .pick(&weights)
                .unwrap_or(nodes[lang].style);
            nodes.push(Node {
                level: Level::Dialect,
                parent: lang as i32,
                people: p as i32,
                from: peoples[p].born,
                at: peoples[p].born,
                until: until_p[p],
                seed: s,
                style,
                changes: Vec::new(),
                words: Vec::new(),
            });
            dialect[p] = nodes.len() as i32 - 1;
        }
        let mut of_people = vec![-1i32; n];
        for p in 0..n {
            of_people[p] = if dialect[p] >= 0 {
                dialect[p]
            } else {
                let mut a = peoples[p].parent;
                while a >= 0 && !peoples[a as usize].big {
                    a = peoples[a as usize].parent;
                }
                if a >= 0 && last[a as usize] == last[p] {
                    dialect[a as usize]
                } else {
                    last[p]
                }
            };
        }
        let mut tree = Languages {
            nodes,
            of_people,
            description: String::new(),
        };
        // The descriptions, the parents first.
        for k in 0..tree.nodes.len() {
            tree.describe(k, &mut cache);
        }
        tree.description = tree.summary(&mut cache);
        // THE CHRONICLE.
        let mut events = Vec::new();
        for k in 0..languages {
            let node = &tree.nodes[k];
            if node.level == Level::Language {
                let p = &peoples[node.people as usize];
                if p.born > start {
                    events.push(LogEvent::LanguageArises {
                        at: node.at,
                        cell: p.heart_apart as f64,
                        language: k as f64,
                        from: node.parent as f64,
                        people: node.people as f64,
                    });
                }
            }
            // A family's proto-language ends with its family, or lives on
            // in its daughters.
            let (t, switch, by) = spoken[k];
            if node.level == Level::Family
                || switch
                || by < 0
                || !peoples[by as usize].ended.is_finite()
            {
                continue;
            }
            let p = &peoples[by as usize];
            let into = if p.merged_into >= 0 {
                speaks(&own, &pre, &tree.nodes, p.merged_into as usize, t)
            } else {
                -1
            };
            events.push(LogEvent::LanguageGone {
                at: t,
                cell: p.heart as f64,
                language: k as f64,
                people: by as f64,
                into: into as f64,
                replaced: p.replaced,
            });
        }
        for (&group, &f) in &family {
            let mut lastp = -1i32;
            let mut at = f64::NEG_INFINITY;
            let mut alive = false;
            for (p, q) in peoples.iter().enumerate() {
                if q.group != group {
                    continue;
                }
                if !q.ended.is_finite() {
                    alive = true;
                    break;
                }
                if q.ended >= at {
                    at = q.ended;
                    lastp = p as i32;
                }
            }
            if alive || lastp < 0 {
                continue;
            }
            events.push(LogEvent::FamilyGone {
                at,
                cell: peoples[lastp as usize].heart as f64,
                family: f as f64,
                people: lastp as f64,
            });
        }
        events.sort_by(|a, b| a.at().total_cmp(&b.at()));
        (tree, events)
    }

    /// The tree as packed (pack.rs).
    pub fn pack(&self) -> Packed {
        let n = &self.nodes;
        let century = |node: &Node, year: f64| ((year - node.from) / CENTURY_YEARS).round() as u16;
        let mut out = Packed {
            people_language: self.of_people.clone(),
            parent: n.iter().map(|x| x.parent).collect(),
            level: n.iter().map(|x| x.level as u8).collect(),
            people: n.iter().map(|x| x.people).collect(),
            from: n.iter().map(|x| x.from as f32).collect(),
            at: n.iter().map(|x| x.at as f32).collect(),
            until: n.iter().map(|x| x.until as f32).collect(),
            seed: n.iter().map(|x| x.seed as i32).collect(),
            style: n.iter().map(|x| x.style as u8).collect(),
            change_start: vec![0],
            word_start: vec![0],
            ..Packed::default()
        };
        for node in n {
            for c in &node.changes {
                out.change_year.push(century(node, c.year));
                out.change.push(c.change as u8);
                out.change_choice.push(c.choice as u8);
            }
            out.change_start.push(out.change.len() as i32);
            for w in &node.words {
                out.word_year.push(century(node, w.year));
                out.word_meaning.push(w.meaning as u8);
            }
            out.word_start.push(out.word_meaning.len() as i32);
        }
        out.description = self.description.clone();
        out
    }

    // The descriptions written out (`Packed::description`): a language's
    // sounds at its last year, a family's stress rule and syllable forms;
    // null for a dialect.
    fn summary(&self, cache: &mut Cache) -> String {
        let n = &self.nodes;
        let list: Vec<Value> = (0..n.len())
            .map(|k| {
                if n[k].level == Level::Dialect {
                    return Value::Null;
                }
                let sp = self.speech(k, n[k].until, cache);
                let sounds: Vec<&str> = sp.lang.inventory.sounds().iter().map(|p| p.id()).collect();
                let mut o = serde_json::Map::new();
                o.insert("sounds".into(), json!(sounds.join(" ")));
                if n[k].level == Level::Family {
                    o.insert("stress".into(), json!(sp.lang.inventory.stress.id()));
                    let forms: Vec<&str> = sp
                        .lang
                        .syllables
                        .forms
                        .iter()
                        .map(|f| f.id.as_str())
                        .collect();
                    o.insert("forms".into(), json!(forms.join(" ")));
                }
                Value::Object(o)
            })
            .collect();
        Value::Array(list).to_string()
    }

    /// The tree again from its packed form. The kit's lists are the
    /// incubator version's: an index out of them is an error.
    pub fn unpack(p: &Packed) -> Result<Languages, String> {
        let count = p.parent.len();
        let same = [
            p.level.len(),
            p.people.len(),
            p.from.len(),
            p.at.len(),
            p.until.len(),
            p.seed.len(),
            p.style.len(),
        ];
        if same.iter().any(|&l| l != count)
            || p.change_start.len() != count + 1
            || p.word_start.len() != count + 1
        {
            return Err("the arrays by node are not one a node".into());
        }
        let (changes_n, meanings_n, styles_n) = (
            changes().len(),
            kit().meanings.meanings.len(),
            kit().spelling.styles.len(),
        );
        let mut nodes = Vec::with_capacity(count);
        for k in 0..count {
            let from = p.from[k] as f64;
            let year = |c: u16| from + CENTURY_YEARS * f64::from(c);
            let (c0, c1) = (p.change_start[k] as usize, p.change_start[k + 1] as usize);
            let (w0, w1) = (p.word_start[k] as usize, p.word_start[k + 1] as usize);
            if c1 > p.change.len() || w1 > p.word_meaning.len() || c0 > c1 || w0 > w1 {
                return Err("a change or a word out of its array".into());
            }
            let changes: Vec<Dated> = (c0..c1)
                .map(|j| Dated {
                    year: year(p.change_year[j]),
                    change: p.change[j] as usize,
                    choice: p.change_choice[j] as usize,
                })
                .collect();
            let words: Vec<NewWord> = (w0..w1)
                .map(|j| NewWord {
                    year: year(p.word_year[j]),
                    meaning: p.word_meaning[j] as usize,
                })
                .collect();
            if changes.iter().any(|c| c.change >= changes_n)
                || words.iter().any(|w| w.meaning >= meanings_n)
                || p.style[k] as usize >= styles_n
            {
                return Err("a change, a meaning or a style out of the kit".into());
            }
            nodes.push(Node {
                level: Level::of(p.level[k]),
                parent: p.parent[k],
                people: p.people[k],
                from,
                at: p.at[k] as f64,
                until: p.until[k] as f64,
                seed: p.seed[k] as u32,
                style: p.style[k] as usize,
                changes,
                words,
            });
        }
        Ok(Languages {
            nodes,
            of_people: p.people_language.clone(),
            description: p.description.clone(),
        })
    }

    // The family of a node.
    fn family_of(&self, mut k: usize) -> usize {
        while self.nodes[k].parent >= 0 {
            k = self.nodes[k].parent as usize;
        }
        k
    }

    /// A node's language at year `t`: its parent's at its `from` (a
    /// dialect's: at `t`), then its own changes and words to `t`, in
    /// their order (a change before a word of the same year). Kept in
    /// `cache`: a node's description must be whole when it is asked for.
    pub fn speech(&self, k: usize, t: f64, cache: &mut Cache) -> Speech {
        if let Some(sp) = cache.speeches.get(&(k, t.to_bits())) {
            return sp.clone();
        }
        let node = &self.nodes[k];
        let mut sp = match node.level {
            Level::Family => Speech {
                lang: cache.proto(node.seed).clone(),
                applied: Vec::new(),
                own: Vec::new(),
            },
            Level::Language => self.speech(node.parent as usize, node.from, cache),
            Level::Dialect => self.speech(node.parent as usize, t, cache),
        };
        sp.own.clear();
        let all = changes();
        let meanings = &kit().meanings.meanings;
        let proto = if node.words.is_empty() {
            None
        } else {
            Some(cache.proto(self.nodes[self.family_of(k)].seed).clone())
        };
        let put = |sp: &mut Speech, x: &NewWord| {
            let m = &meanings[x.meaning].id;
            if let Some(word) = new_word(proto.as_ref().unwrap(), node.seed, m, x.year, &sp.applied)
            {
                sp.lang.set_word(m, word);
            }
        };
        let (mut c, mut w) = (0, 0);
        loop {
            let next_c = node.changes.get(c).filter(|d| d.year <= t);
            let next_w = node.words.get(w).filter(|x| x.year <= t);
            match (next_c, next_w) {
                (Some(d), Some(x)) if x.year < d.year => {
                    put(&mut sp, x);
                    w += 1;
                }
                (Some(d), _) => {
                    let change = all[d.change].with_choice(d.choice);
                    let first = sp.lang.sound_change(&change);
                    sp.applied.push(change);
                    sp.own.push((d.clone(), first));
                    c += 1;
                }
                (None, Some(x)) => {
                    put(&mut sp, x);
                    w += 1;
                }
                (None, None) => break,
            }
        }
        sp.lang.seed = node.seed;
        if sp.lang.spelling.style != node.style {
            sp.lang.respell(node.style);
        }
        cache.speeches.insert((k, t.to_bits()), sp.clone());
        sp
    }

    // A node's description drawn: its dated changes and new words.
    fn describe(&mut self, k: usize, cache: &mut Cache) {
        let node = self.nodes[k].clone();
        if node.level == Level::Dialect {
            // Drawn against its language at the language's last year (one
            // speech a language, not one a dialect).
            let lang = node.parent as usize;
            let sp = self.speech(lang, self.nodes[lang].until, cache);
            let mut d = Draw::new(node.seed, "dialect");
            let count = d.range(DIALECT_CHANGES_LEAST, DIALECT_CHANGES_MOST);
            let centuries = (js::max(0.0, node.until - node.from) / CENTURY_YEARS) as u32;
            let mut years: Vec<f64> = (0..count)
                .map(|_| node.from + CENTURY_YEARS * f64::from(d.range(0, centuries)))
                .collect();
            years.sort_by(f64::total_cmp);
            let mut lang = sp.lang;
            for year in years {
                if let Some((change, choice)) = pick_change(&lang, &mut d) {
                    let c = changes()[change].with_choice(choice);
                    lang.sound_change(&c);
                    self.nodes[k].changes.push(Dated {
                        year,
                        change,
                        choice,
                    });
                }
            }
            return;
        }
        let mut sp = match node.level {
            Level::Family => Speech {
                lang: cache.proto(node.seed).clone(),
                applied: Vec::new(),
                own: Vec::new(),
            },
            _ => self.speech(node.parent as usize, node.from, cache),
        };
        let proto = cache.proto(self.nodes[self.family_of(k)].seed).clone();
        let mut d = Draw::new(node.seed, "years");
        let meanings: Vec<String> = sp.lang.meanings().map(str::to_string).collect();
        let index: HashMap<&str, usize> = kit()
            .meanings
            .meanings
            .iter()
            .enumerate()
            .map(|(k, m)| (m.id.as_str(), k))
            .collect();
        let mut year = node.from + CENTURY_YEARS;
        while year <= node.until {
            if d.chance(SOUND_CHANGE_CHANCE)
                && let Some((change, choice)) = pick_change(&sp.lang, &mut d)
            {
                let c = changes()[change].with_choice(choice);
                sp.lang.sound_change(&c);
                sp.applied.push(c);
                self.nodes[k].changes.push(Dated {
                    year,
                    change,
                    choice,
                });
            }
            for m in &meanings {
                if !d.chance(WORD_LOSS_CHANCE) {
                    continue;
                }
                let Some(word) = new_word(&proto, node.seed, m, year, &sp.applied) else {
                    continue;
                };
                sp.lang.set_word(m, word);
                self.nodes[k].words.push(NewWord {
                    year,
                    meaning: index[m.as_str()],
                });
            }
            year += CENTURY_YEARS;
        }
    }

    /// The view of the tree for the languages window (a debug view, not a
    /// format; the client's languageView.ts reads it): by node its name
    /// and, for a family's proto-language and a language, what the window
    /// shows of it (ui/languagePanel/languageTypes.ts LanguageDetail); by
    /// people its name. The names are the world's content: no i18n.
    pub fn view(&self) -> Value {
        let mut cache = Cache::default();
        let mut nodes = Vec::with_capacity(self.nodes.len());
        for k in 0..self.nodes.len() {
            let node = &self.nodes[k];
            let proto = cache.proto(self.nodes[self.family_of(k)].seed).clone();
            let sp = self.speech(k, node.until, &mut cache);
            let name = match node.level {
                Level::Family => people_name(&proto, 0).form(&proto),
                _ => form_in(&people_name(&proto, node.people as u32 + 1), &sp),
            };
            let detail = if node.level == Level::Dialect {
                Value::Null
            } else {
                detail(&sp)
            };
            nodes.push(json!({ "name": name, "detail": detail }));
        }
        let mut names = Vec::with_capacity(self.of_people.len());
        for (p, &k) in self.of_people.iter().enumerate() {
            if k < 0 {
                names.push(Value::String(String::new()));
                continue;
            }
            let k = k as usize;
            let proto = cache.proto(self.nodes[self.family_of(k)].seed).clone();
            let sp = self.speech(k, self.nodes[k].until, &mut cache);
            names.push(Value::String(form_in(
                &people_name(&proto, p as u32 + 1),
                &sp,
            )));
        }
        json!({ "nodes": nodes, "peoples": names })
    }
}

/// The tree of peoples given as arrays (the languages harness,
/// client/scripts/languageView.mjs, through the WASM build): the packed
/// arrays (`Languages::pack`, by their pack.rs names) and the events, as
/// JSON.
pub fn tree_json(peoples: &[PeopleInput], seed: f64, start: f64, end: f64) -> String {
    let (tree, events) = Languages::build(peoples, seed, start, end);
    let p = tree.pack();
    let arrays = json!({
        "peopleLanguage": p.people_language,
        "languageParent": p.parent,
        "languageLevel": p.level,
        "languagePeople": p.people,
        "languageFrom": p.from,
        "languageAt": p.at,
        "languageUntil": p.until,
        "languageSeed": p.seed,
        "languageStyle": p.style,
        "languageChangeStart": p.change_start,
        "languageChangeYear": p.change_year,
        "languageChange": p.change,
        "languageChangeChoice": p.change_choice,
        "languageWordStart": p.word_start,
        "languageWordYear": p.word_year,
        "languageWordMeaning": p.word_meaning,
        "languages": p.description,
    });
    let mut j = crate::log::Json::default();
    j.open_array();
    for e in &events {
        e.write(&mut j);
    }
    j.close_array();
    format!("{{\"arrays\":{arrays},\"log\":{}}}", j.out)
}

/// The proto-languages, and the nodes' speech by node and year, made
/// once.
#[derive(Default)]
pub struct Cache {
    protos: HashMap<u32, Language>,
    speeches: HashMap<(usize, u64), Speech>,
}

impl Cache {
    /// The speeches made so far forgotten, the proto-languages kept: the
    /// names (place_names.rs) ask one node's speech at many years, a node
    /// after the other.
    pub fn forget_speeches(&mut self) {
        self.speeches.clear();
    }

    fn proto(&mut self, seed: u32) -> &Language {
        self.protos
            .entry(seed)
            .or_insert_with(|| Language::proto(seed))
    }
}

// A sound change that fits the language's sounds and changes
// CHANGE_LEAST_WORDS words or more, leaving each a vowel: its template's
// index and its choice; None after CHANGE_TRIES.
fn pick_change(lang: &Language, d: &mut Draw) -> Option<(usize, usize)> {
    let all = changes();
    let sounds = lang.inventory.sounds();
    // A template that can change no word of the lexicon is not drawn.
    let mut seen = [false; 256];
    for (_, w) in lang.lexicon() {
        w.sounds.iter().for_each(|p| seen[p.0 as usize] = true);
    }
    let present: Vec<Phoneme> = (0..256)
        .filter(|&k| seen[k])
        .map(|k| Phoneme(k as u8))
        .collect();
    let mut weights: Vec<u64> = all
        .iter()
        .map(|c| {
            if c.fits(&sounds) && c.may_change(&present) {
                u64::from(c.weight)
            } else {
                0
            }
        })
        .collect();
    for _ in 0..CHANGE_TRIES {
        let k = d.pick(&weights)?;
        // Not drawn again in this pick.
        weights[k] = 0;
        let choice = d.below(all[k].choices() as u32) as usize;
        let c = all[k].with_choice(choice);
        let mut changed = 0;
        let mut ok = true;
        for (_, w) in lang.lexicon() {
            if !c.may_change(&w.sounds) {
                continue;
            }
            let next = apply_change(&c, w);
            if next.sounds != w.sounds {
                changed += 1;
                if !next.sounds.iter().any(vowel) {
                    ok = false;
                    break;
                }
            }
        }
        if ok && changed >= CHANGE_LEAST_WORDS {
            return Some((k, choice));
        }
    }
    None
}

// A node's new word for a meaning at a year: a root of the family's
// proto-language drawn from the node's seed, the meaning and the year,
// through every sound change of the line before it (`applied`); None
// where they leave it no vowel.
fn new_word(
    proto: &Language,
    seed: u32,
    meaning: &str,
    year: f64,
    applied: &[Change],
) -> Option<Word> {
    let mut d = Draw::new(seed, &format!("word:{meaning}:{year}"));
    let sounds = proto.syllables.root(kit(), &mut d, None);
    let syllables = sounds.iter().filter(|p| vowel(p)).count();
    let free = d.below(syllables as u32) as usize;
    let mut word = Word {
        stress: proto.stressed(&sounds, free),
        sounds,
    };
    for c in applied {
        if c.may_change(&word.sounds) {
            word = apply_change(c, &word);
        }
    }
    word.sounds.iter().any(vowel).then_some(word)
}

// The name of a people (salt: its id + 1) or of a family (0) in the
// family's proto-language: a word of its own and the people's ending
// (patterns.json "ownEnd"), so that two peoples are not named alike as
// the self-names ("the true people") would name them. Its form comes from
// the language that names it (`form_in`).
fn people_name(proto: &Language, salt: u32) -> NameRecipe {
    let mut d = Draw::new(proto.seed, &format!("name:{salt}"));
    NameRecipe {
        kind: Kind::People,
        pattern: "ownEnd".into(),
        slots: vec![
            Slot::Own(proto.syllables.root(kit(), &mut d, None)),
            Slot::Ending,
        ],
    }
}

// A recipe of the family's proto-language in a language of the family:
// its own words (`W`) through the sound changes of the language's line.
fn form_in(recipe: &NameRecipe, sp: &Speech) -> String {
    let mut r = recipe.clone();
    for slot in &mut r.slots {
        if let Slot::Own(sounds) = slot {
            let mut w = Word {
                sounds: sounds.clone(),
                stress: None,
            };
            for c in &sp.applied {
                if c.may_change(&w.sounds) {
                    w = apply_change(c, &w);
                }
            }
            if w.sounds.iter().any(vowel) {
                *sounds = w.sounds;
            }
        }
    }
    r.form(&sp.lang)
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// What the window shows of a language (languageTypes.ts LanguageDetail,
// without its id).
fn detail(sp: &Speech) -> Value {
    let lang = &sp.lang;
    let k = kit();
    let spell = |w: &[Phoneme]| lang.spell(w);
    let inv = &lang.inventory;
    let sounds: Vec<Value> = inv
        .sounds()
        .iter()
        .map(|&p| {
            json!({ "ipa": p.id(), "spelt": spell(&[p]), "kind": if vowel(&p) { "vowel" } else { "consonant" } })
        })
        .collect();
    let obstruents = inv
        .consonants
        .iter()
        .filter(|p| p.sound().obstruent())
        .count();
    let hardness = if inv.consonants.is_empty() {
        0.0
    } else {
        obstruents as f64 / inv.consonants.len() as f64
    };
    let (mut tokens, mut vowels, mut syllables) = (0usize, 0usize, 0usize);
    for (_, w) in lang.lexicon() {
        tokens += w.sounds.len();
        let v = w.sounds.iter().filter(|p| vowel(p)).count();
        vowels += v;
        syllables += v;
    }
    let words = lang.lexicon().len().max(1) as f64;
    let length = ((syllables as f64 / words - 1.0) / 3.0).clamp(0.0, 1.0);
    let vowel_share = ((vowels as f64 / tokens.max(1) as f64 - 0.25) / 0.35).clamp(0.0, 1.0);
    let marked: Vec<String> = inv
        .sounds()
        .iter()
        .map(|&p| (p, spell(&[p])))
        .filter(|(p, s)| s != p.id())
        .map(|(_, s)| s)
        .take(8)
        .collect();
    let spelling = if marked.is_empty() {
        inv.vowels
            .iter()
            .map(|&p| spell(&[p]))
            .collect::<Vec<_>>()
            .join(" · ")
    } else {
        marked.join(" · ")
    };
    let changes_list: Vec<Value> = sp
        .own
        .iter()
        .map(|(d, first)| {
            let t = &k.changes.changes[d.change];
            // In the spelling, or in the sounds where the spelling does
            // not show the change.
            let (before, after) = match first {
                Some((a, b)) if spell(&a.sounds) != spell(&b.sounds) => (spell(&a.sounds), spell(&b.sounds)),
                Some((a, b)) => (format!("/{}/", ipa(&a.sounds)), format!("/{}/", ipa(&b.sounds))),
                None => (String::new(), String::new()),
            };
            json!({ "year": d.year, "rule": t.rule, "template": t.id, "example": { "before": before, "after": after } })
        })
        .collect();
    let lexicon: Vec<Value> = lang
        .lexicon()
        .iter()
        .map(|(m, w)| json!({ "meaning": m, "word": spell(&w.sounds) }))
        .collect();
    let g = &lang.grammar;
    let mut samples = Vec::new();
    let mut heads: Vec<String> = Vec::new();
    for (s, kind) in [Kind::Village, Kind::River, Kind::Mountain, Kind::Lake]
        .into_iter()
        .enumerate()
    {
        let recipe = lang.name(kind, &[], s as u32);
        let mut meanings = Vec::new();
        for slot in &recipe.slots {
            match slot {
                Slot::Head(m) => {
                    meanings.push(m.clone());
                    if let Some(w) = lang.word(m) {
                        let w = spell(w);
                        if !heads.contains(&w) {
                            heads.push(w);
                        }
                    }
                }
                Slot::Adjective(m) | Slot::Noun(m) => meanings.push(m.clone()),
                _ => {}
            }
        }
        samples.push(json!({ "name": recipe.form(lang), "meanings": meanings }));
    }
    json!({
        "sounds": sounds,
        "syllables": lang.syllables.forms.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
        "character": { "hardness": round2(hardness), "length": round2(length), "vowels": round2(vowel_share) },
        "spelling": spelling,
        "changes": changes_list,
        "lexicon": lexicon,
        "lexiconSize": lang.lexicon().len(),
        "pattern": {
            "order": if g.adj_after { "headFirst" } else { "modifierFirst" },
            "joint": if g.joiner_sounds.is_empty() { Value::Null } else { Value::String(spell(&g.joiner_sounds)) },
            "heads": heads,
            "samples": samples,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people(
        parent: i32,
        group: i32,
        born: f64,
        ended: f64,
        big: bool,
        share: f64,
    ) -> PeopleInput {
        PeopleInput {
            parent,
            group,
            born,
            ended,
            merged_into: -1,
            big,
            share,
            replaced: false,
            heart: 7,
            heart_apart: 9,
        }
    }

    // Two groups: group 0's people 0 at the start, its daughter 1 that
    // lives apart and is big (a language), its daughter 2 small (people 1's
    // speech); group 1's people 3, which dies out, and 4 born of it, which
    // merges into people 1 (its language goes, and the family).
    fn sample() -> Vec<PeopleInput> {
        let mut list = vec![
            people(-1, 0, 0.0, f64::INFINITY, true, 0.2),
            people(0, 0, 500.0, f64::INFINITY, true, 0.05),
            people(1, 0, 3000.0, f64::INFINITY, false, 0.0),
            people(-1, 1, 0.0, 2500.0, true, 0.1),
            people(3, 1, 1000.0, 4000.0, true, 0.05),
        ];
        list[4].merged_into = 1;
        list[4].replaced = true;
        list
    }

    #[test]
    fn the_tree_has_families_languages_and_dialects() {
        let (tree, events) = Languages::build(&sample(), 42.0, 0.0, 6000.0);
        let level = |l: Level| tree.nodes.iter().filter(|n| n.level == l).count();
        assert_eq!(level(Level::Family), 2);
        // People 0 (from the start) and 1, and 4 (lived 3 000 years) and
        // 3 (2 500): all apart long enough and big.
        assert_eq!(level(Level::Language), 4);
        assert_eq!(level(Level::Dialect), 4);
        // The small people speaks its parent's dialect.
        assert_eq!(tree.of_people[2], tree.of_people[1]);
        assert_eq!(tree.nodes[tree.of_people[1] as usize].level, Level::Dialect);
        // A language arises for the people born after the start alone.
        let arises: Vec<f64> = events
            .iter()
            .filter_map(|e| match e {
                LogEvent::LanguageArises { at, people, .. } => Some(*people * 1e4 + at),
                _ => None,
            })
            .collect();
        assert_eq!(arises, vec![1.0 * 1e4 + 2000.0, 4.0 * 1e4 + 2500.0]);
        // People 4's language goes at its end, replaced by people 1's.
        let gone = events.iter().find_map(|e| match e {
            LogEvent::LanguageGone {
                people,
                into,
                replaced,
                at,
                ..
            } if *people == 4.0 => Some((*into, *replaced, *at)),
            _ => None,
        });
        let lang1 = tree
            .nodes
            .iter()
            .position(|n| n.level == Level::Language && n.people == 1)
            .unwrap();
        assert_eq!(gone, Some((lang1 as f64, true, 4000.0)));
        assert!(
            events
                .iter()
                .any(|e| matches!(e, LogEvent::FamilyGone { at, .. } if *at == 4000.0))
        );
        assert!(events.windows(2).all(|w| w[0].at() <= w[1].at()));
    }

    #[test]
    fn the_description_reads_back_and_gives_the_same_speech() {
        let (tree, _) = Languages::build(&sample(), 42.0, 0.0, 6000.0);
        assert!(tree.nodes.iter().any(|n| !n.changes.is_empty()));
        assert!(tree.nodes.iter().any(|n| !n.words.is_empty()));
        let back = Languages::unpack(&tree.pack()).unwrap();
        assert_eq!(back, tree);
        let view = back.view();
        assert_eq!(view["nodes"].as_array().unwrap().len(), tree.nodes.len());
        assert!(
            view["peoples"]
                .as_array()
                .unwrap()
                .iter()
                .all(|n| !n.as_str().unwrap().is_empty())
        );
        // The same seed, the same tree.
        assert_eq!(Languages::build(&sample(), 42.0, 0.0, 6000.0).0, tree);
    }
}

//! THE LANGUAGES, part 3: the names of the places (TEG-139, 2026-10-31;
//! docs/design/naming-languages.md, DES-0033 "Who names what" and "A name
//! is a recipe"). Made at the history's end, after the tree of the
//! languages (languages.rs), into H1 (pack.rs).
//!
//! WHO NAMES WHAT (`places_of`). A place's namer is a people; the name is
//! in the node that people speaks in the year the name is given
//! (`speaks_at`: its dialect, or before its own language arose the
//! language it came from).
//!
//! - A VILLAGE (a village or a camp of the history, a town and the city
//!   among them): the people of its cell when it was founded (the cell's
//!   people id then, `Traits::ident`, which settlers carry), in that year.
//! - A RIVER (a ribbon of level 1 that holds water some of the year and
//!   crosses RIVER_LEAST_CELLS land cells or more): the first people at
//!   its mouth (the last cell it crosses: the sea, a lake or the river it
//!   joins), when it came there; where no people came to the mouth, the
//!   first along the river.
//! - A MOUNTAIN: a range is a group of neighbouring land cells
//!   MOUNTAIN_LEAST_M high or more, MOUNTAIN_LEAST_CELLS of them or more;
//!   a landmass's MOUNTAINS_A_LANDMASS highest ranges (by their highest
//!   cell) have a name, each at its highest cell. A LAKE: a group of
//!   neighbouring cells with a lake, LAKE_LEAST_CELLS of them or more.
//!   Both: the first people around it (its cells and the ring around
//!   them).
//! - A LANDMASS of LANDMASS_LEAST_KM2 or more: its first people (not the
//!   largest: the first people names the land, as the first settlers of
//!   an island did on the earth).
//!
//! "The first people" of some cells: the people id each cell had at the
//! first tree step people lived in it (every CLIMATE_YEARS from step 2's
//! start; `first_people`), the earliest of them; where several came at
//! that step, the one with the most of the cells. Places no people
//! reached have no name.
//!
//! THE CONTEXT: what is at the place fills the slots A and N (and H) of
//! the patterns where the language has the word (`Language::name`): the
//! river, the lake, the sea, the hills, the forest, the lifeway … from the
//! habitat (its biome, near_sea, near_lake, river_size, slope, height).
//! The slot X (the name of a near place) is left out: a pattern with X is
//! never drawn (as the language core draws), because the near place's
//! name in the namer's language is an exonym (TEG-142).
//!
//! ONE RECIPE ONCE: a node that gave a recipe already draws again
//! (NAME_TRIES), so that its villages are not all named alike.
//!
//! KEPT AS RECIPES (DES-0033 "A name is a recipe"): by name its kind, its
//! place and cell, its namer (a node of the tree), its year, its pattern,
//! its meanings (two at most) and the sounds of its word of its own (`W`),
//! not the letters. The salt that drew it follows from its kind and place.
//! THE FORM IN A YEAR (`NameBook::form_at`): the recipe's words in the
//! namer's speech of its year (its lexicon, its grammar of names), then
//! every sound change of the namer's line after that year up to the year
//! asked for (or the namer's last year), in the order of their years
//! (`line_changes`), then spelt in the namer's spelling of that year. So
//! a compound wears down as a whole, and a new word for one of its
//! meanings does not change it (Eoforwic → York). A change that leaves a
//! word no vowel leaves the word as it was.
//!
//! THE OTHER NAMES (since TEG-142 and TEG-143, `Aliases`; given in
//! name_contact.rs): a place's later names, where another people took it
//! (an old name kept as a loan, or a new name), and the names its
//! neighbours give it (exonyms). A name's entries are read alike
//! (`Entry`): a recipe, or a loan (sounds, and the word for its kind).
//! The current name in a year is the last entry of the place's chain
//! given by then.

use crate::habitat::Habitat;
use crate::language::{
    Kind, NameRecipe, Phoneme, Slot, Word, apply_change, capitalise, changes, kit, mix,
};
use crate::languages::{Cache, Dated, Languages, Level};
use crate::name_contact::{Contact, give_aliases};
use crate::simulation::lifeway;
use casas_generator::climate::biomes::biome;
use serde_json::{Value, json};
use std::collections::HashSet;

/// A river has a name where it crosses this many land cells or more
/// (CELL_SPACING_KM each: some 100 km).
pub const RIVER_LEAST_CELLS: usize = 10;
/// A lake has a name where this many cells or more hold it.
pub const LAKE_LEAST_CELLS: usize = 3;
/// A range: neighbouring land cells this high or more, m (a cell's
/// height is the mean over its land), this many of them or more; a
/// landmass's highest so many ranges have a name.
pub const MOUNTAIN_LEAST_M: f64 = 2000.0;
pub const MOUNTAIN_LEAST_CELLS: usize = 3;
pub const MOUNTAINS_A_LANDMASS: usize = 5;
/// A landmass has a name from this size on, km².
pub const LANDMASS_LEAST_KM2: f64 = 1000.0;
/// THE CONTEXT: a hill from this slope on (m a m, over CELL_SPACING_KM:
/// 100 m between neighbours), high land from this height on, snow on a
/// mountain from this height on, m; a big river from this size on (the
/// habitat's river_size, 0 … 1); a big lake from this many cells on; a
/// big landmass from this size on, km²; a market from this town on,
/// people at the end.
pub const HILL_SLOPE: f64 = 0.01;
pub const HIGH_M: f64 = 1500.0;
pub const SNOW_M: f64 = 4000.0;
pub const BIG_RIVER_SIZE: f64 = 0.4;
pub const BIG_LAKE_CELLS: usize = 20;
pub const BIG_LANDMASS_KM2: f64 = 1.0e6;
pub const MARKET_PEOPLE: f64 = 2000.0;

/// A node gives one recipe once: a recipe it gave already is drawn again
/// with another salt, this many tries in all (the last one stands). On the
/// three v15 worlds without it (2026-10-31) only half of Thalassor's 9 888
/// names were distinct (4 866), 5 223 of Morvane's 7 224, 2 003 of
/// Zephyra's 2 826: a dialect's villages drew the same few words of their
/// context. The earth has its Newtons, not as many.
pub const NAME_TRIES: u32 = 8;

/// No meaning in a slot (`Names::meaning`).
pub const NO_MEANING: u8 = 255;

/// A place to name: its kind, what it is (a village's index, a river's
/// line, a mountain's highest cell, a lake's first cell, a landmass's id),
/// its cell, its namer (a people id, -1 for none), the year, and what is
/// there (meanings.json ids). For THE OTHER NAMES (name_contact.rs): its
/// size (a village's town at the end, people, 0 for none; a river's and a
/// lake's cells; a mountain's height, m; a landmass's km²), its last year
/// (a village's left; Infinity), its people over time (the people of the
/// cell its namer was first seen in, at each tree step it changed:
/// [year, people id]) and its people at the end (-1 for none).
#[derive(Clone, Debug)]
pub struct Place {
    pub kind: Kind,
    pub place: i32,
    pub cell: i32,
    pub people: i32,
    pub year: f64,
    pub context: Vec<&'static str>,
    pub size: f64,
    pub until: f64,
    pub held: Vec<(f32, i32)>,
    pub end_people: i32,
}

/// The names as packed (pack.rs `name…`), by name; `meaning` two a name
/// (NO_MEANING where none), `own` the sounds of the words of their own one
/// after the other, `own_length` each one's count.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Names {
    pub kind: Vec<u8>,
    pub place: Vec<i32>,
    pub cell: Vec<i32>,
    pub namer: Vec<u16>,
    pub year: Vec<f32>,
    pub pattern: Vec<u8>,
    pub meaning: Vec<u8>,
    pub own_length: Vec<u8>,
    pub own: Vec<u8>,
}

// The salt of a place's name: its kind and its place.
pub(crate) fn salt_of(kind: Kind, place: i32) -> u32 {
    mix(((kind as u32) << 28) ^ (place as u32 & 0x0fff_ffff))
}

/// By people its own language's node and its dialect's, -1 for none.
pub(crate) fn own_nodes(tree: &Languages) -> (Vec<i32>, Vec<i32>) {
    let n = tree.of_people.len();
    let (mut own, mut dialect) = (vec![-1i32; n], vec![-1i32; n]);
    for (k, node) in tree.nodes.iter().enumerate() {
        if node.people < 0 || node.people as usize >= n {
            continue;
        }
        match node.level {
            Level::Language => own[node.people as usize] = k as i32,
            Level::Dialect => dialect[node.people as usize] = k as i32,
            Level::Family => {}
        }
    }
    (own, dialect)
}

/// The node people `p` speaks in year `t` (languages.rs: before its own
/// language arises, the language it came from; then its dialect, or its
/// language). -1 for a people of no node.
pub(crate) fn speaks_at(tree: &Languages, own: &[i32], dialect: &[i32], p: usize, t: f64) -> i32 {
    if p >= tree.of_people.len() {
        return -1;
    }
    if own[p] >= 0 {
        let lang = &tree.nodes[own[p] as usize];
        if t < lang.at {
            return lang.parent;
        }
        return if dialect[p] >= 0 { dialect[p] } else { own[p] };
    }
    tree.of_people[p]
}

/// The sound changes of node `k`'s line dated after `a` and up to `b`, in
/// the order of their years (in one year, a parent's before its
/// daughter's). A language's line is its parent's up to its `from`, then
/// its own; a dialect's its language's, then its own.
pub fn line_changes(tree: &Languages, k: usize, a: f64, b: f64) -> Vec<Dated> {
    fn collect(
        tree: &Languages,
        k: usize,
        a: f64,
        b: f64,
        depth: u32,
        out: &mut Vec<(u32, Dated)>,
    ) {
        let node = &tree.nodes[k];
        match node.level {
            Level::Family => {}
            Level::Language => {
                if a < node.from {
                    let to = if b < node.from { b } else { node.from };
                    collect(tree, node.parent as usize, a, to, depth + 1, out);
                }
            }
            Level::Dialect => collect(tree, node.parent as usize, a, b, depth + 1, out),
        }
        for c in &node.changes {
            if c.year > a && c.year <= b {
                out.push((depth, c.clone()));
            }
        }
    }
    let mut out = Vec::new();
    collect(tree, k, a, b, 0, &mut out);
    // The deeper (the older line) first in one year.
    out.sort_by(|x, y| x.1.year.total_cmp(&y.1.year).then(y.0.cmp(&x.0)));
    out.into_iter().map(|(_, d)| d).collect()
}

/// A place's namer: the node its people speaks in its year (as packed, in
/// f32), and the year; None where it has no people or its people speaks
/// no node. The names are the places that have one, in their order.
pub(crate) fn namer_of(
    tree: &Languages,
    own: &[i32],
    dialect: &[i32],
    place: &Place,
) -> Option<(usize, f64)> {
    if place.people < 0 {
        return None;
    }
    let year = place.year as f32 as f64;
    let k = speaks_at(tree, own, dialect, place.people as usize, year);
    if k < 0 || k as usize >= tree.nodes.len() || k > u16::MAX as i32 {
        return None;
    }
    Some((k as usize, year))
}

/// A recipe as packed: its pattern's index in its kind's list, the
/// meanings of its slots H, A, N (NO_MEANING for none), the sounds of its
/// word of its own.
pub(crate) fn encode(recipe: &NameRecipe) -> (u8, [u8; 2], Vec<Phoneme>) {
    let patterns = &kit().patterns.patterns[recipe.kind.id()];
    let pattern = patterns
        .iter()
        .position(|p| p.id == recipe.pattern)
        .expect("the recipe's pattern");
    let mut slot_meanings = [NO_MEANING; 2];
    let mut m = 0;
    let mut own_sounds: Vec<Phoneme> = Vec::new();
    for slot in &recipe.slots {
        match slot {
            Slot::Head(id) | Slot::Adjective(id) | Slot::Noun(id) => {
                slot_meanings[m] = meaning_index(id);
                m += 1;
            }
            Slot::Own(sounds) => own_sounds = sounds.clone(),
            Slot::Ending => {}
        }
    }
    (pattern as u8, slot_meanings, own_sounds)
}

/// A meaning's index in meanings.json.
pub(crate) fn meaning_index(id: &str) -> u8 {
    kit()
        .meanings
        .meanings
        .iter()
        .position(|x| x.id == id)
        .expect("a meaning of the kit") as u8
}

/// The recipe of a packed one (`encode`).
pub(crate) fn recipe_of(kind: Kind, pattern: u8, meaning: [u8; 2], own: &[Phoneme]) -> NameRecipe {
    let pattern = &kit().patterns.patterns[kind.id()][pattern as usize];
    let meanings = &kit().meanings.meanings;
    let mut m = 0;
    let mut next = || {
        let id = meaning[m.min(1)];
        m += 1;
        if id == NO_MEANING {
            String::new()
        } else {
            meanings[id as usize].id.clone()
        }
    };
    let slots = pattern
        .form
        .chars()
        .filter(|c| c.is_ascii_uppercase())
        .map(|c| match c {
            'H' => Slot::Head(next()),
            'A' => Slot::Adjective(next()),
            'N' => Slot::Noun(next()),
            'W' => Slot::Own(own.to_vec()),
            _ => Slot::Ending,
        })
        .collect();
    NameRecipe {
        kind,
        pattern: pattern.id.clone(),
        slots,
    }
}

impl Names {
    /// The names of the places, each in the speech of its namer at its
    /// year; a place with no namer, or whose namer speaks no node, has
    /// none.
    pub fn give(tree: &Languages, places: &[Place]) -> Names {
        let (own, dialect) = own_nodes(tree);
        let mut given: Vec<(usize, usize, f64)> = Vec::new();
        for (j, place) in places.iter().enumerate() {
            if let Some((k, year)) = namer_of(tree, &own, &dialect, place) {
                given.push((j, k, year));
            }
        }
        // A node after the other, its speeches forgotten after it: a node's
        // speech at each year is a language.
        let mut order: Vec<usize> = (0..given.len()).collect();
        order.sort_by_key(|&g| given[g].1);
        let mut recipes: Vec<Option<NameRecipe>> = vec![None; given.len()];
        let mut cache = Cache::default();
        let mut last = usize::MAX;
        // The recipes a node gave: a recipe it gave already is drawn again
        // (NAME_TRIES), the context left out from the second half of the
        // tries on.
        let mut taken: HashSet<String> = HashSet::new();
        for &g in &order {
            let (j, k, year) = given[g];
            if k != last {
                cache.forget_speeches();
                taken.clear();
                last = k;
            }
            let place = &places[j];
            let sp = tree.speech(k, year, &mut cache);
            let salt = salt_of(place.kind, place.place);
            let mut recipe = sp.lang.name(place.kind, &place.context, salt);
            for t in 1..NAME_TRIES {
                if !taken.contains(&format!("{recipe:?}")) {
                    break;
                }
                let context: &[&str] = if 2 * t < NAME_TRIES {
                    &place.context
                } else {
                    &[]
                };
                recipe = sp.lang.name(place.kind, context, salt ^ mix(t));
            }
            taken.insert(format!("{recipe:?}"));
            recipes[g] = Some(recipe);
        }
        let mut names = Names::default();
        for (g, &(j, k, year)) in given.iter().enumerate() {
            let place = &places[j];
            let recipe = recipes[g].take().expect("a recipe a name");
            let (pattern, slot_meanings, own_sounds) = encode(&recipe);
            names.kind.push(place.kind as u8);
            names.place.push(place.place);
            names.cell.push(place.cell);
            names.namer.push(k as u16);
            names.year.push(year as f32);
            names.pattern.push(pattern);
            names.meaning.extend(slot_meanings);
            names.own_length.push(own_sounds.len() as u8);
            names.own.extend(own_sounds.iter().map(|p| p.0));
        }
        names
    }

    pub fn len(&self) -> usize {
        self.kind.len()
    }

    pub fn is_empty(&self) -> bool {
        self.kind.is_empty()
    }

    /// The packed names checked against a tree of `nodes` nodes and the
    /// kit: the arrays one a name (`meaning` two), every index in its list.
    pub fn check(&self, nodes: usize) -> Result<(), String> {
        let n = self.kind.len();
        if [
            self.place.len(),
            self.cell.len(),
            self.namer.len(),
            self.year.len(),
            self.pattern.len(),
            self.own_length.len(),
        ]
        .iter()
        .any(|&l| l != n)
            || self.meaning.len() != 2 * n
            || self.own_length.iter().map(|&l| l as usize).sum::<usize>() != self.own.len()
        {
            return Err("the arrays by name are not one a name".into());
        }
        let k = kit();
        for j in 0..n {
            let Some(kind) = Kind::ALL.get(self.kind[j] as usize) else {
                return Err("a name of no kind".into());
            };
            if self.pattern[j] as usize >= k.patterns.patterns[kind.id()].len()
                || self.namer[j] as usize >= nodes
                || self.meaning[2 * j..2 * j + 2]
                    .iter()
                    .any(|&m| m != NO_MEANING && m as usize >= k.meanings.meanings.len())
            {
                return Err("a pattern, a namer or a meaning out of its list".into());
            }
        }
        if self.own.iter().any(|&p| p as usize >= k.sounds.len()) {
            return Err("a sound out of the kit".into());
        }
        Ok(())
    }
}

/// How a name came (`Entry::how`; packed `aliasHow` for the others).
pub mod how {
    /// The place's first name (`Names`), not packed as a code.
    pub const FIRST: u8 = 255;
    /// THE OLD NAMES (TEG-143): the people that took the place gave it a
    /// new name, or kept the name it had as a loan.
    pub const RENAMED: u8 = 0;
    pub const KEPT: u8 = 1;
    /// THE EXONYMS (TEG-142): a neighbour borrowed the name, translated
    /// it, or gave it a name of its own.
    pub const BORROWED: u8 = 2;
    pub const TRANSLATED: u8 = 3;
    pub const OWN: u8 = 4;
    /// Kept free for a name the user sets (DEC-0054 fork 4), not built.
    pub const SET: u8 = 5;
}

/// The pattern of a loan (`aliasPattern`): not a pattern of the kit.
pub const LOAN: u8 = 255;
/// Between two words of a loan (`aliasSounds`): not a sound of the kit.
pub const WORD_BREAK: u8 = 255;
/// The speeches made that the book keeps at most; then it forgets them.
pub const BOOK_SPEECHES: usize = 2048;

/// THE OTHER NAMES as packed (pack.rs `alias…`), by entry, a name's
/// entries one after the other in the order of the names; a name's chain
/// (RENAMED, KEPT) in the order of their years, then its exonyms. `name`
/// the name (of `Names`) it is of, `how` (`how`), `namer` the node it is
/// in, `year`; `pattern` the recipe's (LOAN for a loan), `meaning` two an
/// entry (a recipe's slots; a loan's word for its kind, NO_MEANING for
/// none, and 1 where that word stands first), `length` and `sounds` (a
/// recipe's word of its own; a loan's words, WORD_BREAK between two).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Aliases {
    pub name: Vec<i32>,
    pub how: Vec<u8>,
    pub namer: Vec<u16>,
    pub year: Vec<f32>,
    pub pattern: Vec<u8>,
    pub meaning: Vec<u8>,
    pub length: Vec<u8>,
    pub sounds: Vec<u8>,
}

/// What an entry says: a recipe, or a loan (its words as sounds and the
/// word for its kind, by meaning, first or last).
#[derive(Clone, Debug, PartialEq)]
pub enum Said {
    Recipe(NameRecipe),
    Loan {
        words: Vec<Vec<Phoneme>>,
        head: Option<String>,
        head_first: bool,
    },
}

/// A name of a place: how it came, the node it is in, the year, what it
/// says.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub how: u8,
    pub namer: usize,
    pub year: f64,
    pub said: Said,
}

impl Aliases {
    pub fn len(&self) -> usize {
        self.name.len()
    }

    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
    }

    /// An entry of name `j` (of kind `kind`) put at the end; the year as
    /// packed (f32).
    pub fn push(&mut self, j: usize, e: &Entry) {
        let (pattern, meaning, sounds) = match &e.said {
            Said::Recipe(r) => {
                let (p, m, own) = encode(r);
                (p, m, own.iter().map(|x| x.0).collect::<Vec<u8>>())
            }
            Said::Loan {
                words,
                head,
                head_first,
            } => {
                let mut sounds = Vec::new();
                for (k, w) in words.iter().enumerate() {
                    if k > 0 {
                        sounds.push(WORD_BREAK);
                    }
                    sounds.extend(w.iter().map(|x| x.0));
                }
                let m = head.as_deref().map_or(NO_MEANING, meaning_index);
                (LOAN, [m, u8::from(*head_first)], sounds)
            }
        };
        self.name.push(j as i32);
        self.how.push(e.how);
        self.namer.push(e.namer as u16);
        self.year.push(e.year as f32);
        self.pattern.push(pattern);
        self.meaning.extend(meaning);
        self.length.push(sounds.len().min(255) as u8);
        self.sounds.extend(sounds.into_iter().take(255));
    }

    /// The packed entries checked against `names` and a tree of `nodes`
    /// nodes: the arrays one an entry (`meaning` two), the names rising,
    /// every index in its list.
    pub fn check(&self, names: &Names, nodes: usize) -> Result<(), String> {
        let n = self.name.len();
        if [
            self.how.len(),
            self.namer.len(),
            self.year.len(),
            self.pattern.len(),
            self.length.len(),
        ]
        .iter()
        .any(|&l| l != n)
            || self.meaning.len() != 2 * n
            || self.length.iter().map(|&l| l as usize).sum::<usize>() != self.sounds.len()
        {
            return Err("the arrays by alias are not one an alias".into());
        }
        let k = kit();
        for a in 0..n {
            let j = self.name[a];
            if j < 0 || j as usize >= names.len() || (a > 0 && j < self.name[a - 1]) {
                return Err("an alias of no name, or out of the names' order".into());
            }
            let kind = Kind::ALL[names.kind[j as usize] as usize];
            let m = &self.meaning[2 * a..2 * a + 2];
            let bad_meaning = |x: u8| x != NO_MEANING && x as usize >= k.meanings.meanings.len();
            let ok = self.how[a] <= how::SET
                && (self.namer[a] as usize) < nodes
                && if self.pattern[a] == LOAN {
                    !bad_meaning(m[0]) && m[1] <= 1
                } else {
                    (self.pattern[a] as usize) < k.patterns.patterns[kind.id()].len()
                        && !m.iter().any(|&x| bad_meaning(x))
                };
            if !ok {
                return Err("an alias's how, namer, pattern or meaning out of its list".into());
            }
        }
        if self
            .sounds
            .iter()
            .any(|&p| p != WORD_BREAK && p as usize >= k.sounds.len())
        {
            return Err("a sound out of the kit".into());
        }
        Ok(())
    }
}

/// The words of an entry as given: in its namer's speech of its year.
pub fn said_words(tree: &Languages, cache: &mut Cache, e: &Entry) -> Vec<Vec<Phoneme>> {
    let sp = tree.speech(e.namer, e.year, cache);
    match &e.said {
        Said::Recipe(r) => r.words(&sp.lang),
        Said::Loan {
            words,
            head,
            head_first,
        } => {
            let mut out = words.clone();
            if let Some(w) = head.as_deref().and_then(|m| sp.lang.word(m)) {
                if *head_first {
                    out.insert(0, w.to_vec());
                } else {
                    out.push(w.to_vec());
                }
            }
            out
        }
    }
}

// An entry's last year: its namer's last, not before its year.
fn last_year(tree: &Languages, e: &Entry) -> f64 {
    let until = tree.nodes[e.namer].until;
    if until > e.year { until } else { e.year }
}

/// An entry's words in year t (at its year before it, at its namer's last
/// year after that): as given, then through every sound change of its
/// namer's line up to then. And that year.
pub fn words_at(
    tree: &Languages,
    cache: &mut Cache,
    e: &Entry,
    t: f64,
) -> (Vec<Vec<Phoneme>>, f64) {
    let until = last_year(tree, e);
    let to = t.clamp(e.year, until);
    let mut words = said_words(tree, cache, e);
    for d in line_changes(tree, e.namer, e.year, to) {
        wear(&mut words, &d);
    }
    (words, to)
}

/// The words spelt in node k's spelling of year t.
pub fn spell_in(
    tree: &Languages,
    cache: &mut Cache,
    k: usize,
    t: f64,
    words: &[Vec<Phoneme>],
) -> String {
    let sp = tree.speech(k, t, cache);
    let spelt: Vec<String> = words.iter().map(|w| sp.lang.spell(w)).collect();
    capitalise(&spelt.join(" "))
}

/// An entry's form in year t (`words_at`), spelt.
pub fn form_of(tree: &Languages, cache: &mut Cache, e: &Entry, t: f64) -> String {
    let (words, to) = words_at(tree, cache, e, t);
    spell_in(tree, cache, e.namer, to, &words)
}

/// An entry's forms over time, from its year to before `stop`: the year
/// from which each form holds and the form, a new one after each sound
/// change of its namer's line that changes its letters.
pub fn forms_of(tree: &Languages, cache: &mut Cache, e: &Entry, stop: f64) -> Vec<(f64, String)> {
    let until = last_year(tree, e);
    let mut words = said_words(tree, cache, e);
    let mut out = vec![(e.year, spell_in(tree, cache, e.namer, e.year, &words))];
    let line = line_changes(tree, e.namer, e.year, until);
    let mut c = 0;
    while c < line.len() && line[c].year < stop {
        let at = line[c].year;
        while c < line.len() && line[c].year == at {
            wear(&mut words, &line[c]);
            c += 1;
        }
        let form = spell_in(tree, cache, e.namer, at, &words);
        if form != out[out.len() - 1].1 {
            out.push((at, form));
        }
    }
    out
}

/// The names of a tree and how they read in a year: the recipes, the
/// other names, the tree and the speeches made.
pub struct NameBook {
    pub tree: Languages,
    pub names: Names,
    pub aliases: Aliases,
    own_start: Vec<usize>,
    // By alias, where its sounds start; by name, its first alias.
    sound_start: Vec<usize>,
    alias_start: Vec<usize>,
    cache: Cache,
}

impl NameBook {
    pub fn new(tree: Languages, names: Names, aliases: Aliases) -> Result<NameBook, String> {
        names.check(tree.nodes.len())?;
        aliases.check(&names, tree.nodes.len())?;
        let mut own_start = Vec::with_capacity(names.len() + 1);
        own_start.push(0);
        for &l in &names.own_length {
            own_start.push(own_start[own_start.len() - 1] + l as usize);
        }
        let mut sound_start = Vec::with_capacity(aliases.len() + 1);
        sound_start.push(0);
        for &l in &aliases.length {
            sound_start.push(sound_start[sound_start.len() - 1] + l as usize);
        }
        let mut alias_start = vec![0usize; names.len() + 1];
        for &j in &aliases.name {
            alias_start[j as usize + 1] += 1;
        }
        for j in 0..names.len() {
            alias_start[j + 1] += alias_start[j];
        }
        Ok(NameBook {
            tree,
            names,
            aliases,
            own_start,
            sound_start,
            alias_start,
            cache: Cache::default(),
        })
    }

    /// The recipe of name `j`.
    pub fn recipe(&self, j: usize) -> NameRecipe {
        let n = &self.names;
        let own: Vec<Phoneme> = n.own[self.own_start[j]..self.own_start[j + 1]]
            .iter()
            .map(|&p| Phoneme(p))
            .collect();
        recipe_of(
            Kind::ALL[n.kind[j] as usize],
            n.pattern[j],
            [n.meaning[2 * j], n.meaning[2 * j + 1]],
            &own,
        )
    }

    /// Name j's first name.
    pub fn first(&self, j: usize) -> Entry {
        Entry {
            how: how::FIRST,
            namer: self.names.namer[j] as usize,
            year: self.names.year[j] as f64,
            said: Said::Recipe(self.recipe(j)),
        }
    }

    /// Alias a.
    pub fn alias(&self, a: usize) -> Entry {
        let x = &self.aliases;
        let sounds = &x.sounds[self.sound_start[a]..self.sound_start[a + 1]];
        let kind = Kind::ALL[self.names.kind[x.name[a] as usize] as usize];
        let meaning = [x.meaning[2 * a], x.meaning[2 * a + 1]];
        let said = if x.pattern[a] == LOAN {
            let words = sounds
                .split(|&p| p == WORD_BREAK)
                .map(|w| w.iter().map(|&p| Phoneme(p)).collect())
                .collect();
            let head = (meaning[0] != NO_MEANING)
                .then(|| kit().meanings.meanings[meaning[0] as usize].id.clone());
            Said::Loan {
                words,
                head,
                head_first: meaning[1] == 1,
            }
        } else {
            let own: Vec<Phoneme> = sounds.iter().map(|&p| Phoneme(p)).collect();
            Said::Recipe(recipe_of(kind, x.pattern[a], meaning, &own))
        };
        Entry {
            how: x.how[a],
            namer: x.namer[a] as usize,
            year: x.year[a] as f64,
            said,
        }
    }

    /// Name j's chain: its first name, then the names the peoples that
    /// took it gave (RENAMED, KEPT), in the order of their years.
    pub fn chain(&self, j: usize) -> Vec<Entry> {
        let mut out = vec![self.first(j)];
        for a in self.alias_start[j]..self.alias_start[j + 1] {
            if matches!(self.aliases.how[a], how::RENAMED | how::KEPT) {
                out.push(self.alias(a));
            }
        }
        out
    }

    /// Name j's exonyms, by their namers.
    pub fn exonyms(&self, j: usize) -> Vec<Entry> {
        (self.alias_start[j]..self.alias_start[j + 1])
            .filter(|&a| !matches!(self.aliases.how[a], how::RENAMED | how::KEPT))
            .map(|a| self.alias(a))
            .collect()
    }

    fn trim(&mut self) {
        if self.cache.speeches_len() > BOOK_SPEECHES {
            self.cache.forget_speeches();
        }
    }

    /// Name j in year t: the entry of its chain current then (the last
    /// given by then), in its form of then; None before it was given.
    pub fn form_at(&mut self, j: usize, t: f64) -> Option<String> {
        let chain = self.chain(j);
        let e = chain.iter().rev().find(|e| e.year <= t)?;
        self.trim();
        Some(form_of(&self.tree, &mut self.cache, e, t))
    }

    /// Name j's forms over time, through its chain: each entry's from its
    /// year until the next's year; the year from which a form holds and
    /// the form.
    pub fn forms(&mut self, j: usize) -> Vec<(f64, String)> {
        let chain = self.chain(j);
        let mut out: Vec<(f64, String)> = Vec::new();
        for (c, e) in chain.iter().enumerate() {
            let stop = chain.get(c + 1).map_or(f64::INFINITY, |n| n.year);
            self.trim();
            for (y, f) in forms_of(&self.tree, &mut self.cache, e, stop) {
                if out.last().is_none_or(|l| l.1 != f) {
                    out.push((y, f));
                }
            }
        }
        out
    }

    /// The names `from` .. `from + count` in year t, JSON: a list of
    /// strings, "" for a name not given by then.
    pub fn at_json(&mut self, t: f64, from: usize, count: usize) -> String {
        let to = (from + count).min(self.names.len());
        let list: Vec<Value> = (from.min(to)..to)
            .map(|j| Value::String(self.form_at(j, t).unwrap_or_default()))
            .collect();
        Value::Array(list).to_string()
    }

    /// The names `from` .. `from + count` over time (`forms`), JSON: by
    /// name a list [year, form, year, form …]. A node after the other,
    /// its speeches forgotten after it.
    pub fn forms_json(&mut self, from: usize, count: usize) -> String {
        let to = (from + count).min(self.names.len());
        let mut order: Vec<usize> = (from.min(to)..to).collect();
        order.sort_by_key(|&j| self.names.namer[j]);
        let mut out: Vec<Value> = vec![Value::Null; order.len()];
        let mut last = u16::MAX;
        for j in order {
            if self.names.namer[j] != last {
                self.cache.forget_speeches();
                last = self.names.namer[j];
            }
            let list: Vec<Value> = self
                .forms(j)
                .into_iter()
                .flat_map(|(y, f)| [json!(y), json!(f)])
                .collect();
            out[j - from] = Value::Array(list);
        }
        self.cache.forget_speeches();
        Value::Array(out).to_string()
    }

    /// The other names of names `from` .. `from + count`, JSON: by name
    /// {"chain": [[how, namer, year, form, head] …], "exonyms": [[how,
    /// namer, year, [year, form, …]] …]}: its chain from its first name
    /// (how FIRST), each entry with its form when the next one came (the
    /// last one's at its namer's last year) and the meaning of its head
    /// word (`head_of`, null for none); its exonyms with their forms over
    /// time.
    pub fn others_json(&mut self, from: usize, count: usize) -> String {
        let to = (from + count).min(self.names.len());
        let mut out = Vec::with_capacity(to.saturating_sub(from));
        for j in from.min(to)..to {
            let chain = self.chain(j);
            let mut list = Vec::with_capacity(chain.len());
            for (c, e) in chain.iter().enumerate() {
                let next = chain.get(c + 1).map_or(f64::INFINITY, |n| n.year);
                self.trim();
                let form = form_of(&self.tree, &mut self.cache, e, next);
                list.push(json!([e.how, e.namer, e.year, form, head_of(e)]));
            }
            let mut exonyms = Vec::new();
            for e in self.exonyms(j) {
                self.trim();
                let forms: Vec<Value> = forms_of(&self.tree, &mut self.cache, &e, f64::INFINITY)
                    .into_iter()
                    .flat_map(|(y, f)| [json!(y), json!(f)])
                    .collect();
                exonyms.push(json!([e.how, e.namer, e.year, forms]));
            }
            out.push(json!({ "chain": list, "exonyms": exonyms }));
        }
        self.cache.forget_speeches();
        Value::Array(out).to_string()
    }

    /// Name j in year t with its older names and its exonyms, JSON:
    /// {"name": its form then, "namer": the node of the current entry,
    /// "older": [[form, namer, year] …] (the entries before it, each in
    /// its form when the next came), "exonyms": [[form, namer, how] …]
    /// (those given by then, in their form of then)}; null before it was
    /// given.
    pub fn place_json(&mut self, j: usize, t: f64) -> String {
        if j >= self.names.len() {
            return "null".into();
        }
        let chain = self.chain(j);
        let Some(c) = chain.iter().rposition(|e| e.year <= t) else {
            return "null".into();
        };
        self.trim();
        let name = form_of(&self.tree, &mut self.cache, &chain[c], t);
        let older: Vec<Value> = (0..c)
            .map(|i| {
                let form = form_of(&self.tree, &mut self.cache, &chain[i], chain[i + 1].year);
                json!([form, chain[i].namer, chain[i].year])
            })
            .collect();
        let exonyms: Vec<Value> = self
            .exonyms(j)
            .iter()
            .filter(|e| e.year <= t)
            .map(|e| json!([form_of(&self.tree, &mut self.cache, e, t), e.namer, e.how]))
            .collect();
        json!({ "name": name, "namer": chain[c].namer, "older": older, "exonyms": exonyms })
            .to_string()
    }

    /// THE STORY of name j in year t (the languages window's names tab,
    /// TEG-141), JSON: {"namer": the node of the entry current then,
    /// "year": its year, "parts": [{"role", "meaning", "spelt"} …],
    /// "steps": [{"year", "form", "rules"} …]}; null before it was given.
    /// The parts: the recipe's slots in their order, each its role
    /// ("head", "modifier" for A and N, "own", "ending"), its meaning (the
    /// kit's id, null for none) and its word spelt alone, in the namer's
    /// speech of the entry's year; a loan's words are "own" words, the
    /// word for its kind its head. A slot the language has no word for
    /// gives no part. The steps: the entry's form as given, then a new one
    /// after each year of its namer's line, up to t, whose sound changes
    /// change its letters (`forms_of`), each with the rules of the changes
    /// that changed its words since the step before.
    pub fn story_json(&mut self, j: usize, t: f64) -> String {
        if j >= self.names.len() {
            return "null".into();
        }
        let chain = self.chain(j);
        let Some(c) = chain.iter().rposition(|e| e.year <= t) else {
            return "null".into();
        };
        let e = &chain[c];
        self.trim();
        let sp = self.tree.speech(e.namer, e.year, &mut self.cache);
        let lang = &sp.lang;
        let part = |role: &str, meaning: Option<&str>, sounds: &[Phoneme]| json!({ "role": role, "meaning": meaning, "spelt": lang.spell(sounds) });
        let parts: Vec<Value> = match &e.said {
            Said::Recipe(r) => r
                .slots
                .iter()
                .filter_map(|slot| match slot {
                    Slot::Head(m) => lang.word(m).map(|w| part("head", Some(m), w)),
                    Slot::Adjective(m) | Slot::Noun(m) => {
                        lang.word(m).map(|w| part("modifier", Some(m), w))
                    }
                    Slot::Own(w) => Some(part("own", None, w)),
                    Slot::Ending => lang
                        .grammar
                        .ending(r.kind)
                        .map(|x| part("ending", None, &x.sounds)),
                })
                .collect(),
            Said::Loan {
                words,
                head,
                head_first,
            } => {
                let mut out: Vec<Value> = words.iter().map(|w| part("own", None, w)).collect();
                if let Some(m) = head.as_deref()
                    && let Some(w) = lang.word(m)
                {
                    let p = part("head", Some(m), w);
                    if *head_first {
                        out.insert(0, p);
                    } else {
                        out.push(p);
                    }
                }
                out
            }
        };
        let until = last_year(&self.tree, e);
        let to = t.clamp(e.year, until);
        let mut words = said_words(&self.tree, &mut self.cache, e);
        let first = spell_in(&self.tree, &mut self.cache, e.namer, e.year, &words);
        let mut steps = vec![json!({ "year": e.year, "form": first, "rules": [] })];
        let mut last = first;
        let mut rules: Vec<&str> = Vec::new();
        let line = line_changes(&self.tree, e.namer, e.year, to);
        let mut i = 0;
        while i < line.len() {
            let at = line[i].year;
            while i < line.len() && line[i].year == at {
                let before = words.clone();
                wear(&mut words, &line[i]);
                let rule = kit().changes.changes[line[i].change].rule.as_str();
                if words != before && !rules.contains(&rule) {
                    rules.push(rule);
                }
                i += 1;
            }
            let form = spell_in(&self.tree, &mut self.cache, e.namer, at, &words);
            if form != last {
                steps.push(json!({ "year": at, "form": form, "rules": rules }));
                rules.clear();
                last = form;
            }
        }
        json!({ "namer": e.namer, "year": e.year, "parts": parts, "steps": steps }).to_string()
    }
}

/// The meaning of an entry's head word (the slot H of its recipe, a
/// loan's word for its kind), None for none: the names tab's "same
/// pattern nearby" (TEG-141).
pub fn head_of(e: &Entry) -> Option<&str> {
    match &e.said {
        Said::Recipe(r) => r.slots.iter().find_map(|s| match s {
            Slot::Head(m) if !m.is_empty() => Some(m.as_str()),
            _ => None,
        }),
        Said::Loan { head, .. } => head.as_deref(),
    }
}

/// The names of places over a tree of peoples given as arrays (the
/// languages harness, client/scripts/languageView.mjs, through the WASM
/// and the native builds): the place j of kind `kinds[j]` (`Kind`'s
/// index), its namer `people[j]`, its year `years[j]`, no context; its
/// people over time the rows of `held_place`, `held_year`,
/// `held_people` of it (its people at the end the last); the contacts
/// `contacts`, five numbers each (name_contact.rs `Contact`: two
/// peoples, the border, the days, the links). JSON: the packed arrays
/// (by their pack.rs names), each name at `end`, each name's forms over
/// time (`NameBook::forms_json`), the other names (`others_json`), by
/// loan its sounds, its namer's sounds in its year and whether its
/// namer's syllable rules allow each word (`loans`), and each name's story
/// at `end` (`story_json`).
#[allow(clippy::too_many_arguments)]
pub fn names_of_places_json(
    peoples: &[crate::languages::PeopleInput],
    seed: f64,
    start: f64,
    end: f64,
    kinds: &[u8],
    people: &[i32],
    years: &[f64],
    held_place: &[i32],
    held_year: &[f64],
    held_people: &[i32],
    contacts: &[f64],
) -> String {
    let (tree, _) = Languages::build(peoples, seed, start, end);
    let mut places: Vec<Place> = (0..kinds.len())
        .map(|j| Place {
            kind: Kind::ALL[kinds[j] as usize % Kind::ALL.len()],
            place: j as i32,
            cell: j as i32,
            people: people[j],
            year: years[j],
            context: Vec::new(),
            size: 1.0,
            until: f64::INFINITY,
            held: Vec::new(),
            end_people: people[j],
        })
        .collect();
    for r in 0..held_place.len().min(held_year.len()).min(held_people.len()) {
        if let Some(p) = places.get_mut(held_place[r].max(0) as usize) {
            p.held.push((held_year[r] as f32, held_people[r]));
            p.end_people = held_people[r];
        }
    }
    let contacts: Vec<Contact> = contacts
        .as_chunks::<5>()
        .0
        .iter()
        .map(|c| Contact {
            a: c[0] as i32,
            b: c[1] as i32,
            border_km: c[2],
            days: c[3],
            links: c[4],
        })
        .collect();
    let names = Names::give(&tree, &places);
    let aliases = give_aliases(&tree, &places, &names, &contacts, peoples, end);
    let count = names.len();
    let arrays = json!({
        "nameKind": names.kind,
        "namePlace": names.place,
        "nameCell": names.cell,
        "nameNamer": names.namer,
        "nameYear": names.year,
        "namePattern": names.pattern,
        "nameMeaning": names.meaning,
        "nameOwnLength": names.own_length,
        "nameOwn": names.own,
        "aliasName": aliases.name,
        "aliasHow": aliases.how,
        "aliasNamer": aliases.namer,
        "aliasYear": aliases.year,
        "aliasPattern": aliases.pattern,
        "aliasMeaning": aliases.meaning,
        "aliasLength": aliases.length,
        "aliasSounds": aliases.sounds,
    });
    let mut book = NameBook::new(tree, names, aliases).expect("the names given read");
    let mut loans = Vec::new();
    for a in 0..book.aliases.len() {
        let e = book.alias(a);
        let Said::Loan { words, .. } = &e.said else {
            continue;
        };
        let sp = book.tree.speech(e.namer, e.year, &mut book.cache);
        let inventory: Vec<u8> = sp.lang.inventory.sounds().iter().map(|p| p.0).collect();
        let fits: Vec<bool> = words.iter().map(|w| sp.lang.pronounceable(w)).collect();
        let sounds: Vec<Vec<u8>> = words
            .iter()
            .map(|w| w.iter().map(|p| p.0).collect())
            .collect();
        loans.push(json!({ "alias": a, "sounds": sounds, "inventory": inventory, "fits": fits }));
    }
    let at_end = book.at_json(end, 0, count);
    let forms = book.forms_json(0, count);
    let others = book.others_json(0, count);
    let stories: Vec<String> = (0..count).map(|j| book.story_json(j, end)).collect();
    format!(
        "{{\"arrays\":{arrays},\"atEnd\":{at_end},\"forms\":{forms},\"others\":{others},\"loans\":{},\"stories\":[{}]}}",
        Value::Array(loans),
        stories.join(",")
    )
}

/// The words through one dated change: each word the change leaves a
/// vowel.
pub(crate) fn wear(words: &mut [Vec<Phoneme>], d: &Dated) {
    let change = changes()[d.change].with_choice(d.choice);
    for w in words.iter_mut() {
        if !change.may_change(w) {
            continue;
        }
        let next = apply_change(
            &change,
            &Word {
                sounds: w.clone(),
                stress: None,
            },
        );
        if next.sounds.iter().any(|p| p.sound().vowel) {
            *w = next.sounds;
        }
    }
}

/// What the places are named from (simulation.rs, at the history's end).
pub struct PlacesInput<'a> {
    pub h: &'a Habitat,
    /// [cell, lifeway] a village or camp, when founded, its people then
    /// (-1 for none), its town at the end (people; 0 for none).
    pub villages: &'a [i32],
    pub village_from: &'a [f64],
    pub village_to: &'a [f64],
    pub village_people: &'a [i32],
    pub village_town: &'a [f64],
    /// Each cell's people at the tree steps where it changed (lived in,
    /// with a people id): [year, people id], the first its first people.
    pub held: &'a [Vec<(f32, i32)>],
    /// Each cell's people at the end, -1 for none.
    pub end_people: &'a [i32],
}

// A cell's first people and when; -1 and Infinity where none came.
fn first_people(input: &PlacesInput, c: usize) -> (i32, f32) {
    input.held[c]
        .first()
        .map_or((-1, f32::INFINITY), |&(t, p)| (p, t))
}

// The first people of some cells and the year: the earliest first people,
// at the same step the one with the most of the cells (the lowest id of
// those), and the first cell of it. None where no people came.
fn first_of(input: &PlacesInput, cells: &[usize]) -> Option<(i32, f64, usize)> {
    let mut at = f32::INFINITY;
    for &c in cells {
        let (p, t) = first_people(input, c);
        if p >= 0 && t < at {
            at = t;
        }
    }
    if at == f32::INFINITY {
        return None;
    }
    let mut counts: Vec<(i32, usize, usize)> = Vec::new();
    for &c in cells {
        let (p, t) = first_people(input, c);
        if t != at || p < 0 {
            continue;
        }
        match counts.iter_mut().find(|x| x.0 == p) {
            Some(x) => x.1 += 1,
            None => counts.push((p, 1, c)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    counts.first().map(|&(p, _, c)| (p, at as f64, c))
}

// The groups of neighbouring cells where `inside` holds, each in the order
// found from its lowest cell.
fn groups(h: &Habitat, inside: impl Fn(usize) -> bool) -> Vec<Vec<usize>> {
    let mut seen = vec![false; h.count];
    let mut out = Vec::new();
    for s in 0..h.count {
        if seen[s] || !inside(s) {
            continue;
        }
        seen[s] = true;
        let mut group = vec![s];
        let mut k = 0;
        while k < group.len() {
            let c = group[k];
            k += 1;
            for e in h.edges(c) {
                let u = h.nbr[e] as usize;
                if !seen[u] && inside(u) {
                    seen[u] = true;
                    group.push(u);
                }
            }
        }
        out.push(group);
    }
    out
}

// Some cells and the ring around them.
fn with_ring(h: &Habitat, cells: &[usize]) -> Vec<usize> {
    let mut out = cells.to_vec();
    for &c in cells {
        for e in h.edges(c) {
            let u = h.nbr[e] as usize;
            if !out.contains(&u) {
                out.push(u);
            }
        }
    }
    out
}

fn forest(b: u8) -> bool {
    matches!(
        b,
        biome::BOREAL
            | biome::WOODLAND
            | biome::TEMPERATE_FOREST
            | biome::TEMPERATE_RAINFOREST
            | biome::TROPICAL_RAINFOREST
            | biome::TROPICAL_DRY_FOREST
    )
}
fn open_land(b: u8) -> bool {
    matches!(
        b,
        biome::GRASSLAND | biome::STEPPE | biome::SAVANNA | biome::MEDITERRANEAN_SCRUB
    )
}
fn dry(b: u8) -> bool {
    matches!(b, biome::DESERT | biome::COLD_DESERT | biome::SALT_FLAT)
}
fn cold(b: u8) -> bool {
    matches!(
        b,
        biome::TUNDRA | biome::ICE | biome::GLACIER | biome::ALPINE
    )
}

// What a biome gives a place.
fn biome_context(b: u8, out: &mut Vec<&'static str>) {
    if forest(b) {
        out.extend(["forest", "tree", "dark"]);
        match b {
            biome::BOREAL => out.extend(["pine", "birch"]),
            biome::TEMPERATE_FOREST | biome::WOODLAND => out.push("oak"),
            _ => {}
        }
    } else if open_land(b) {
        out.extend(["grass", "plain", "green"]);
    } else if dry(b) {
        out.extend(["sand", "dry", "salt"]);
    } else if cold(b) {
        out.extend(["snow", "ice", "cold", "white"]);
    }
}

/// A village's context: its water, its land, its biome, its lifeway, its
/// town.
pub fn village_context(h: &Habitat, cell: usize, way: u8, town: f64) -> Vec<&'static str> {
    let mut out = Vec::new();
    if h.near_river[cell] != 0 {
        out.extend(["river", "ford", "bridge"]);
        if (h.river_size[cell] as f64) < BIG_RIVER_SIZE {
            out.push("stream");
        }
    }
    if h.near_lake[cell] != 0 {
        out.extend(["lake", "shore", "reed"]);
    }
    if h.near_sea[cell] != 0 {
        out.extend(["sea", "shore", "bay"]);
        if h.near_river[cell] != 0 {
            out.push("mouth");
        }
    }
    let height = h.height_m[cell] as f64;
    if h.slope[cell] as f64 >= HILL_SLOPE {
        out.extend(["hill", "slope", "valley"]);
    } else {
        out.extend(["field", "meadow"]);
    }
    if height >= HIGH_M {
        out.extend(["high", "mountain", "pass"]);
    }
    biome_context(h.biome[cell], &mut out);
    match way {
        lifeway::FARMERS => out.extend(["field", "grain", "home"]),
        lifeway::HERDERS => out.extend(["cattle", "sheep", "horse"]),
        lifeway::FISHERS => out.extend(["fish", "harbour"]),
        _ => out.extend(["camp", "deer", "hearth"]),
    }
    if town >= MARKET_PEOPLE {
        out.push("market");
    }
    out
}

/// A river's context: its size, the land along it.
pub fn river_context(h: &Habitat, cells: &[usize]) -> Vec<&'static str> {
    let mut out = Vec::new();
    let size = cells
        .iter()
        .map(|&c| h.river_size[c] as f64)
        .fold(0.0, f64::max);
    if size >= BIG_RIVER_SIZE {
        out.extend(["big", "wide", "deep", "long"]);
    } else {
        out.extend(["small", "fast"]);
    }
    let source = cells[0];
    if h.height_m[source] as f64 >= HIGH_M {
        out.extend(["cold", "white"]);
    }
    let mouth = cells[cells.len() - 1];
    biome_context(h.biome[mouth], &mut out);
    out
}

/// A mountain's context: its height, the land around it.
pub fn mountain_context(h: &Habitat, peak: usize, cells: &[usize]) -> Vec<&'static str> {
    let mut out = Vec::new();
    let height = h.height_m[peak] as f64;
    if height >= SNOW_M {
        out.extend(["snow", "white", "ice"]);
    }
    out.extend(["high", "stone", "rock", "grey"]);
    if cells.len() >= BIG_LAKE_CELLS {
        out.extend(["big", "long"]);
    }
    if cells.iter().any(|&c| forest(h.biome[c])) {
        out.extend(["pine", "dark", "forest"]);
    }
    out
}

/// A lake's context: its size, the land around it.
pub fn lake_context(h: &Habitat, cells: &[usize]) -> Vec<&'static str> {
    let mut out = Vec::new();
    if cells.len() >= BIG_LAKE_CELLS {
        out.extend(["big", "wide", "deep"]);
    } else {
        out.extend(["small", "still"]);
    }
    if cells.iter().any(|&c| h.height_m[c] as f64 >= HIGH_M) {
        out.extend(["high", "cold"]);
    }
    biome_context(h.biome[cells[0]], &mut out);
    if cells.iter().any(|&c| dry(h.biome[c])) {
        out.extend(["bitter", "salt"]);
    }
    out
}

/// A landmass's context: its size, its first people's land.
pub fn landmass_context(h: &Habitat, m: usize, first: usize) -> Vec<&'static str> {
    let mut out = Vec::new();
    if h.landmass_km2[m] >= BIG_LANDMASS_KM2 {
        out.extend(["big", "wide", "land", "earth"]);
    } else {
        out.extend(["island", "small", "sea", "shore"]);
    }
    biome_context(h.biome[first], &mut out);
    out
}

/// WHO NAMES WHAT (see the module's head): the places to name, the
/// villages first (in their order), then the rivers, the mountains, the
/// lakes and the landmasses.
pub fn places_of(input: &PlacesInput) -> Vec<Place> {
    let h = input.h;
    let mut out = Vec::new();
    // A place followed from `watch`: its people over time and at the end.
    let place = |kind, place, cell, people, year, context, size, until, watch: usize| Place {
        kind,
        place,
        cell,
        people,
        year,
        context,
        size,
        until,
        held: input.held[watch].clone(),
        end_people: input.end_people[watch],
    };
    // THE VILLAGES: the people of the cell when it was founded.
    for v in 0..input.village_from.len() {
        let cell = input.villages[2 * v] as usize;
        let mut people = input.village_people[v];
        if people < 0 {
            people = first_people(input, cell).0;
        }
        out.push(place(
            Kind::Village,
            v as i32,
            cell as i32,
            people,
            input.village_from[v],
            village_context(
                h,
                cell,
                input.villages[2 * v + 1] as u8,
                input.village_town[v],
            ),
            if input.village_to[v] == f64::INFINITY {
                input.village_town[v]
            } else {
                0.0
            },
            input.village_to[v],
            cell,
        ));
    }
    // THE RIVERS: the first people at the mouth, else along it.
    for river in &h.rivers {
        if river.cells.len() < RIVER_LEAST_CELLS {
            continue;
        }
        let cells: Vec<usize> = river.cells.iter().map(|&c| c as usize).collect();
        let mouth = cells[cells.len() - 1];
        let first = first_of(input, &[mouth]).or_else(|| first_of(input, &cells));
        let Some((people, year, watch)) = first else {
            continue;
        };
        out.push(place(
            Kind::River,
            river.line as i32,
            mouth as i32,
            people,
            year,
            river_context(h, &cells),
            cells.len() as f64,
            f64::INFINITY,
            watch,
        ));
    }
    // THE MOUNTAINS: a landmass's highest ranges.
    let mut ranges: Vec<(i32, f32, usize, Vec<usize>)> = groups(h, |c| {
        h.land[c] != 0 && h.height_m[c] as f64 >= MOUNTAIN_LEAST_M
    })
    .into_iter()
    .filter(|g| g.len() >= MOUNTAIN_LEAST_CELLS)
    .map(|g| {
        let peak = *g
            .iter()
            .max_by(|&&a, &&b| h.height_m[a].total_cmp(&h.height_m[b]).then(b.cmp(&a)))
            .unwrap();
        (h.landmass[peak], h.height_m[peak], peak, g)
    })
    .collect();
    ranges.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.total_cmp(&a.1)).then(a.2.cmp(&b.2)));
    let mut on_landmass = (i32::MIN, 0usize);
    for (m, _, peak, cells) in &ranges {
        if on_landmass.0 != *m {
            on_landmass = (*m, 0);
        }
        if on_landmass.1 >= MOUNTAINS_A_LANDMASS {
            continue;
        }
        on_landmass.1 += 1;
        let Some((people, year, watch)) = first_of(input, &with_ring(h, cells)) else {
            continue;
        };
        out.push(place(
            Kind::Mountain,
            *peak as i32,
            *peak as i32,
            people,
            year,
            mountain_context(h, *peak, cells),
            h.height_m[*peak] as f64,
            f64::INFINITY,
            watch,
        ));
    }
    // THE LAKES.
    for cells in groups(h, |c| h.lake[c] != 0) {
        if cells.len() < LAKE_LEAST_CELLS {
            continue;
        }
        let Some((people, year, watch)) = first_of(input, &with_ring(h, &cells)) else {
            continue;
        };
        out.push(place(
            Kind::Lake,
            cells[0] as i32,
            cells[0] as i32,
            people,
            year,
            lake_context(h, &cells),
            cells.len() as f64,
            f64::INFINITY,
            watch,
        ));
    }
    // THE LANDMASSES: the first people.
    let mut cells_of: Vec<Vec<usize>> = vec![Vec::new(); h.landmasses];
    for c in 0..h.count {
        if h.landmass[c] >= 0 && h.landmass_km2[h.landmass[c] as usize] >= LANDMASS_LEAST_KM2 {
            cells_of[h.landmass[c] as usize].push(c);
        }
    }
    for (m, cells) in cells_of.iter().enumerate() {
        if cells.is_empty() {
            continue;
        }
        let Some((people, year, cell)) = first_of(input, cells) else {
            continue;
        };
        out.push(place(
            Kind::Landmass,
            m as i32,
            cell as i32,
            people,
            year,
            landmass_context(h, m, cell),
            h.landmass_km2[m],
            f64::INFINITY,
            cell,
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::languages::PeopleInput;

    #[test]
    fn every_context_meaning_is_in_the_kit() {
        let mut all: Vec<&str> = Vec::new();
        for b in 0..18u8 {
            biome_context(b, &mut all);
        }
        all.extend([
            "river", "ford", "bridge", "stream", "lake", "shore", "reed", "sea", "bay", "mouth",
            "hill", "slope", "valley", "field", "meadow", "high", "mountain", "pass", "grain",
            "home", "cattle", "sheep", "horse", "fish", "harbour", "camp", "deer", "hearth",
            "market", "big", "wide", "deep", "long", "small", "fast", "cold", "white", "snow",
            "ice", "stone", "rock", "grey", "pine", "dark", "forest", "still", "bitter", "salt",
            "land", "earth", "island",
        ]);
        let meanings = &kit().meanings.meanings;
        for m in all {
            assert!(
                meanings.iter().any(|x| x.id == m),
                "{m} is not a meaning of the kit"
            );
        }
    }

    fn peoples() -> Vec<PeopleInput> {
        let p =
            |parent: i32, group: i32, born: f64, ended: f64, big: bool, share: f64| PeopleInput {
                parent,
                group,
                born,
                ended,
                merged_into: -1,
                big,
                share,
                replaced: false,
                heart: 0,
                heart_apart: 0,
            };
        vec![
            p(-1, 0, 0.0, f64::INFINITY, true, 0.2),
            p(0, 0, 500.0, f64::INFINITY, true, 0.05),
            p(1, 0, 3000.0, f64::INFINITY, false, 0.0),
            p(-1, 1, 0.0, 2500.0, true, 0.1),
        ]
    }

    fn places() -> Vec<Place> {
        let mut out = Vec::new();
        for (j, kind) in [
            Kind::Village,
            Kind::River,
            Kind::Mountain,
            Kind::Lake,
            Kind::Landmass,
        ]
        .into_iter()
        .enumerate()
        {
            for p in 0..4 {
                out.push(Place {
                    kind,
                    place: (10 * j + p) as i32,
                    cell: p as i32,
                    people: p as i32,
                    year: 100.0 + 700.0 * p as f64,
                    context: vec!["river", "forest", "big"],
                    size: 1.0,
                    until: f64::INFINITY,
                    held: Vec::new(),
                    end_people: p as i32,
                });
            }
        }
        out
    }

    #[test]
    fn every_place_has_a_name_that_reads_back_and_wears_down() {
        let (tree, _) = Languages::build(&peoples(), 42.0, 0.0, 6000.0);
        let list = places();
        let names = Names::give(&tree, &list);
        assert_eq!(names.len(), list.len());
        let back = Languages::unpack(&tree.pack()).unwrap();
        let mut book = NameBook::new(back, names.clone(), Aliases::default()).unwrap();
        // The same tree and places, the same names.
        assert_eq!(Names::give(&tree, &list), names);
        let mut changed = 0;
        for j in 0..names.len() {
            let year = names.year[j] as f64;
            assert_eq!(book.form_at(j, year - 1.0), None);
            let given = book.form_at(j, year).unwrap();
            assert!(!given.is_empty());
            let forms = book.forms(j);
            assert_eq!(forms[0], (year, given));
            // The form of each span is the form in its year.
            for (at, form) in &forms {
                assert_eq!(&book.form_at(j, *at).unwrap(), form);
            }
            assert_eq!(&book.form_at(j, 1e9).unwrap(), &forms[forms.len() - 1].1);
            changed += (forms.len() > 1) as usize;
        }
        assert!(changed > 0, "no name changed its form");
    }

    // TEG-141: a name's story has its recipe's parts, each spelt in the
    // name's form as given where the name is one word of them alone
    // (no joint); its steps are its forms over time, each later one with
    // rules of its namer's line.
    #[test]
    fn a_story_has_the_parts_and_the_forms_over_time() {
        let (tree, _) = Languages::build(&peoples(), 42.0, 0.0, 6000.0);
        let list = places();
        let names = Names::give(&tree, &list);
        let mut book = NameBook::new(tree, names.clone(), Aliases::default()).unwrap();
        let mut ruled = 0;
        for j in 0..names.len() {
            let year = names.year[j] as f64;
            assert_eq!(book.story_json(j, year - 1.0), "null");
            let story: Value = serde_json::from_str(&book.story_json(j, 1e9)).unwrap();
            let parts = story["parts"].as_array().unwrap();
            assert!(!parts.is_empty());
            let recipe = book.recipe(j);
            assert!(parts.len() <= recipe.slots.len());
            let first = story["steps"][0]["form"].as_str().unwrap().to_lowercase();
            for p in parts {
                let spelt = p["spelt"].as_str().unwrap();
                assert!(!spelt.is_empty());
                assert!(
                    ["head", "modifier", "own", "ending"].contains(&p["role"].as_str().unwrap())
                );
                if parts.len() == 1 && p["role"] != "ending" {
                    assert_eq!(first, spelt.to_lowercase(), "name {j}");
                }
            }
            // The steps are the forms over time.
            let steps: Vec<(f64, String)> = story["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    (
                        s["year"].as_f64().unwrap(),
                        s["form"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            assert_eq!(steps, book.forms(j));
            let line = line_changes(&book.tree, names.namer[j] as usize, year, f64::INFINITY);
            for s in &story["steps"].as_array().unwrap()[1..] {
                let rules = s["rules"].as_array().unwrap();
                assert!(!rules.is_empty());
                for r in rules {
                    assert!(
                        line.iter()
                            .any(|d| kit().changes.changes[d.change].rule == r.as_str().unwrap())
                    );
                }
                ruled += 1;
            }
        }
        assert!(ruled > 0, "no story has a step with a rule");
    }
}

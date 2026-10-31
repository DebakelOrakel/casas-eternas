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
//! Each place has its namer's name only: the old names after a
//! replacement (TEG-143) and the names of the neighbours (TEG-142) come
//! later.

use crate::habitat::Habitat;
use crate::language::{
    Kind, NameRecipe, Phoneme, Slot, Word, apply_change, capitalise, changes, kit, mix,
};
use crate::languages::{Cache, Dated, Languages, Level};
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
/// there (meanings.json ids).
#[derive(Clone, Debug)]
pub struct Place {
    pub kind: Kind,
    pub place: i32,
    pub cell: i32,
    pub people: i32,
    pub year: f64,
    pub context: Vec<&'static str>,
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
fn salt_of(kind: Kind, place: i32) -> u32 {
    mix(((kind as u32) << 28) ^ (place as u32 & 0x0fff_ffff))
}

/// By people its own language's node and its dialect's, -1 for none.
fn own_nodes(tree: &Languages) -> (Vec<i32>, Vec<i32>) {
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
fn speaks_at(tree: &Languages, own: &[i32], dialect: &[i32], p: usize, t: f64) -> i32 {
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

impl Names {
    /// The names of the places, each in the speech of its namer at its
    /// year; a place with no namer, or whose namer speaks no node, has
    /// none.
    pub fn give(tree: &Languages, places: &[Place]) -> Names {
        let (own, dialect) = own_nodes(tree);
        let meanings = &kit().meanings.meanings;
        let mut given: Vec<(usize, usize, f64)> = Vec::new();
        for (j, place) in places.iter().enumerate() {
            if place.people < 0 {
                continue;
            }
            let year = place.year as f32 as f64;
            let k = speaks_at(tree, &own, &dialect, place.people as usize, year);
            if k < 0 || k as usize >= tree.nodes.len() || k > u16::MAX as i32 {
                continue;
            }
            given.push((j, k as usize, year));
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
            let patterns = &kit().patterns.patterns[place.kind.id()];
            let pattern = patterns
                .iter()
                .position(|p| p.id == recipe.pattern)
                .expect("the recipe's pattern");
            let mut slot_meanings = [NO_MEANING; 2];
            let mut m = 0;
            let mut own_sounds: &[Phoneme] = &[];
            for slot in &recipe.slots {
                match slot {
                    Slot::Head(id) | Slot::Adjective(id) | Slot::Noun(id) => {
                        let at = meanings
                            .iter()
                            .position(|x| &x.id == id)
                            .expect("a meaning of the kit");
                        slot_meanings[m] = at as u8;
                        m += 1;
                    }
                    Slot::Own(sounds) => own_sounds = sounds,
                    Slot::Ending => {}
                }
            }
            names.kind.push(place.kind as u8);
            names.place.push(place.place);
            names.cell.push(place.cell);
            names.namer.push(k as u16);
            names.year.push(year as f32);
            names.pattern.push(pattern as u8);
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

/// The names of a tree and how they read in a year: the recipes, the
/// tree and the speeches made.
pub struct NameBook {
    pub tree: Languages,
    pub names: Names,
    own_start: Vec<usize>,
    cache: Cache,
}

impl NameBook {
    pub fn new(tree: Languages, names: Names) -> Result<NameBook, String> {
        names.check(tree.nodes.len())?;
        let mut own_start = Vec::with_capacity(names.len() + 1);
        own_start.push(0);
        for &l in &names.own_length {
            own_start.push(own_start[own_start.len() - 1] + l as usize);
        }
        Ok(NameBook {
            tree,
            names,
            own_start,
            cache: Cache::default(),
        })
    }

    /// The recipe of name `j`.
    pub fn recipe(&self, j: usize) -> NameRecipe {
        let n = &self.names;
        let kind = Kind::ALL[n.kind[j] as usize];
        let pattern = &kit().patterns.patterns[kind.id()][n.pattern[j] as usize];
        let meanings = &kit().meanings.meanings;
        let mut m = 0;
        let mut meaning = || {
            let id = n.meaning[2 * j + m];
            m += 1;
            if id == NO_MEANING {
                String::new()
            } else {
                meanings[id as usize].id.clone()
            }
        };
        let own: Vec<Phoneme> = n.own[self.own_start[j]..self.own_start[j + 1]]
            .iter()
            .map(|&p| Phoneme(p))
            .collect();
        let slots = pattern
            .form
            .chars()
            .filter(|c| c.is_ascii_uppercase())
            .map(|c| match c {
                'H' => Slot::Head(meaning()),
                'A' => Slot::Adjective(meaning()),
                'N' => Slot::Noun(meaning()),
                'W' => Slot::Own(own.clone()),
                _ => Slot::Ending,
            })
            .collect();
        NameRecipe {
            kind,
            pattern: pattern.id.clone(),
            slots,
        }
    }

    // Name j's namer, year and last year (its namer's).
    fn when(&self, j: usize) -> (usize, f64, f64) {
        let k = self.names.namer[j] as usize;
        let year = self.names.year[j] as f64;
        let until = self.tree.nodes[k].until;
        (k, year, if until > year { until } else { year })
    }

    // Name j's words as given, as sounds.
    fn given_words(&mut self, j: usize) -> Vec<Vec<Phoneme>> {
        let (k, year, _) = self.when(j);
        let recipe = self.recipe(j);
        let sp = self.tree.speech(k, year, &mut self.cache);
        recipe.words(&sp.lang)
    }

    // The words spelt in node k's spelling of year t.
    fn spell(&mut self, k: usize, t: f64, words: &[Vec<Phoneme>]) -> String {
        let sp = self.tree.speech(k, t, &mut self.cache);
        let spelt: Vec<String> = words.iter().map(|w| sp.lang.spell(w)).collect();
        capitalise(&spelt.join(" "))
    }

    /// Name j in year t: None before it was given; after its namer's last
    /// year, as it was then.
    pub fn form_at(&mut self, j: usize, t: f64) -> Option<String> {
        let (k, year, until) = self.when(j);
        if t < year {
            return None;
        }
        let to = if t < until { t } else { until };
        let mut words = self.given_words(j);
        for d in line_changes(&self.tree, k, year, to) {
            wear(&mut words, &d);
        }
        Some(self.spell(k, to, &words))
    }

    /// Name j's forms over time: from its year, and after each sound
    /// change of its namer's line that changes its letters, the year from
    /// which a form holds and the form.
    pub fn forms(&mut self, j: usize) -> Vec<(f64, String)> {
        let (k, year, until) = self.when(j);
        let mut words = self.given_words(j);
        let mut out = vec![(year, self.spell(k, year, &words))];
        let line = line_changes(&self.tree, k, year, until);
        let mut c = 0;
        while c < line.len() {
            let at = line[c].year;
            while c < line.len() && line[c].year == at {
                wear(&mut words, &line[c]);
                c += 1;
            }
            let form = self.spell(k, at, &words);
            if form != out[out.len() - 1].1 {
                out.push((at, form));
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
}

/// The names of places over a tree of peoples given as arrays (the
/// languages harness, client/scripts/languageView.mjs, through the WASM
/// and the native builds): the place j of kind `kinds[j]` (`Kind`'s
/// index), its namer `people[j]`, its year `years[j]`, no context. JSON:
/// the packed arrays (by their pack.rs names), each name at `end`, and
/// each name's forms over time (`NameBook::forms_json`).
#[allow(clippy::too_many_arguments)]
pub fn names_of_places_json(
    peoples: &[crate::languages::PeopleInput],
    seed: f64,
    start: f64,
    end: f64,
    kinds: &[u8],
    people: &[i32],
    years: &[f64],
) -> String {
    let (tree, _) = Languages::build(peoples, seed, start, end);
    let places: Vec<Place> = (0..kinds.len())
        .map(|j| Place {
            kind: Kind::ALL[kinds[j] as usize % Kind::ALL.len()],
            place: j as i32,
            cell: j as i32,
            people: people[j],
            year: years[j],
            context: Vec::new(),
        })
        .collect();
    let names = Names::give(&tree, &places);
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
    });
    let mut book = NameBook::new(tree, names).expect("the names given read");
    let at_end = book.at_json(end, 0, count);
    let forms = book.forms_json(0, count);
    format!("{{\"arrays\":{arrays},\"atEnd\":{at_end},\"forms\":{forms}}}")
}

// The words through one dated change: each word the change leaves a vowel.
fn wear(words: &mut [Vec<Phoneme>], d: &Dated) {
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
    pub village_people: &'a [i32],
    pub village_town: &'a [f64],
    /// Each cell's first people at a tree step, and when; -1 and Infinity
    /// where none came.
    pub first_people: &'a [i32],
    pub first_at: &'a [f32],
}

// The first people of some cells and the year: the earliest first people,
// at the same step the one with the most of the cells (the lowest id of
// those), and the first cell of it. None where no people came.
fn first_of(input: &PlacesInput, cells: &[usize]) -> Option<(i32, f64, usize)> {
    let mut at = f32::INFINITY;
    for &c in cells {
        if input.first_people[c] >= 0 && input.first_at[c] < at {
            at = input.first_at[c];
        }
    }
    if at == f32::INFINITY {
        return None;
    }
    let mut counts: Vec<(i32, usize, usize)> = Vec::new();
    for &c in cells {
        if input.first_at[c] != at || input.first_people[c] < 0 {
            continue;
        }
        let p = input.first_people[c];
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
    // THE VILLAGES: the people of the cell when it was founded.
    for v in 0..input.village_from.len() {
        let cell = input.villages[2 * v] as usize;
        let mut people = input.village_people[v];
        if people < 0 {
            people = input.first_people[cell];
        }
        out.push(Place {
            kind: Kind::Village,
            place: v as i32,
            cell: cell as i32,
            people,
            year: input.village_from[v],
            context: village_context(
                h,
                cell,
                input.villages[2 * v + 1] as u8,
                input.village_town[v],
            ),
        });
    }
    // THE RIVERS: the first people at the mouth, else along it.
    for river in &h.rivers {
        if river.cells.len() < RIVER_LEAST_CELLS {
            continue;
        }
        let cells: Vec<usize> = river.cells.iter().map(|&c| c as usize).collect();
        let mouth = cells[cells.len() - 1];
        let first = first_of(input, &[mouth]).or_else(|| first_of(input, &cells));
        let Some((people, year, _)) = first else {
            continue;
        };
        out.push(Place {
            kind: Kind::River,
            place: river.line as i32,
            cell: mouth as i32,
            people,
            year,
            context: river_context(h, &cells),
        });
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
        let Some((people, year, _)) = first_of(input, &with_ring(h, cells)) else {
            continue;
        };
        out.push(Place {
            kind: Kind::Mountain,
            place: *peak as i32,
            cell: *peak as i32,
            people,
            year,
            context: mountain_context(h, *peak, cells),
        });
    }
    // THE LAKES.
    for cells in groups(h, |c| h.lake[c] != 0) {
        if cells.len() < LAKE_LEAST_CELLS {
            continue;
        }
        let Some((people, year, _)) = first_of(input, &with_ring(h, &cells)) else {
            continue;
        };
        out.push(Place {
            kind: Kind::Lake,
            place: cells[0] as i32,
            cell: cells[0] as i32,
            people,
            year,
            context: lake_context(h, &cells),
        });
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
        out.push(Place {
            kind: Kind::Landmass,
            place: m as i32,
            cell: cell as i32,
            people,
            year,
            context: landmass_context(h, m, cell),
        });
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
        let mut book = NameBook::new(back, names.clone()).unwrap();
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
}

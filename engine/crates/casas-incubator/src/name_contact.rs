//! THE LANGUAGES, part 4: contact (TEG-142, TEG-143, 2026-10-31;
//! docs/design/naming-languages.md, DES-0033 "Contact"; docs/decisions/
//! made-languages.md, DEC-0054 forks 2, 4 and 5). Made at the history's
//! end, after the names (place_names.rs), into H1 (pack.rs `alias…`).
//!
//! THE OLD NAMES (TEG-143, `takings`). A place is TAKEN where its people
//! (the people of the cell its namer was first seen in, at each tree step:
//! `Place::held`) comes to speak another language (a dialect lifted to its
//! language): THE WAVES, a merge, the fields' replacement, a split part's
//! own language that spread back. A taking counts once the new language
//! holds the place TAKING_HOLD_YEARS, as a band that crosses a border for
//! a few centuries does not rename the land; a village's after it was left
//! does not count. At a taking the newcomers keep the name the place had,
//! by a chance by kind (`keep_chance`: rivers often, landmasses and towns
//! half of the time, lakes and mountains sometimes, villages seldom), as a
//! LOAN: its form at the taking's year, in its namer's line, refitted to
//! the newcomers' sounds and syllables (language/loan.rs `Language::fit`);
//! then it wears down with the newcomers' line. A loan means nothing to
//! the newcomers: by HEAD_AGAIN it takes their word for its kind ("River
//! Avon": avon is "river" in Brittonic), first where their grammar names
//! the kind first (`Grammar::article`). Else the newcomers name the place
//! in their speech of that year (a new recipe, with the place's context).
//!
//! THE EXONYMS (TEG-142, `exonyms`). Between peoples in contact at the
//! history's end (`contacts_of`: a shared border, or the far trade's links
//! between their villages), of other languages: each language names the
//! important places of the peoples of the other language it touches, at
//! most EXONYM_* of each kind a pair of languages (the landmasses, the
//! largest rivers, lakes and mountains, the largest villages standing at
//! the end, the towns and the city first). How near the contact is
//! (`closeness`: the border, the links, the ways' days between the two
//! peoples' hearts, travel.rs, by one search from all the hearts) gives
//! the chance to BORROW the name (a
//! loan, as above); else to TRANSLATE it (the same pattern and meanings
//! in the namer's words, its word of its own refitted; a loan with a word
//! for its kind keeps its loan and translates that word) where the namer
//! has the words, by TRANSLATE_SHARE; else a name of its OWN. The
//! exonym's year: when the lines of both peoples of the nearest contact
//! spoke their languages of the end (`line_born`) and the place had its
//! current name; it is given in the speech of that year of the namer's
//! people. On the three v15 worlds (2026-10-31, own origins, the rain):
//! of Morvane's 534 rivers 309 taken (386 takings: 272 kept, 114
//! renamed), of its 5 383 villages 731 (854: 116 kept, 738 renamed); 1 571
//! exonyms (773 borrowed, 219 translated, 579 own); 61 KB. Thalassor: 277
//! of 356 rivers, 3 641 of 9 360 villages taken; 1 746 exonyms; 126 KB.
//! Zephyra: 105 of 267 rivers, 451 of 2 438 villages; 1 327 exonyms; 38
//! KB. Some 0.2 to 0.4 s a world. A name the user sets (DEC-0054 fork 4,
//! `how::SET`) is not built: it would be one more entry of the chain, and
//! the exonyms would take it as they take a made name.
//!
//! LOANS OF ORDINARY WORDS (a prestige or trade language gives words to its
//! partners): not built. The lexicon of a node is replayed from its
//! description (languages.rs `speech`), and a loan from another family
//! would need the donor's speech in that replay; it waits for the trade
//! of step 3.

use crate::habitat::Habitat;
use crate::language::{Draw, Kind, Phoneme, mix};
use crate::languages::{Cache, Languages, Level, PeopleInput};
use crate::place_names::{
    Aliases, BIG_LANDMASS_KM2, Entry, Names, Place, Said, how, line_changes, namer_of, own_nodes,
    recipe_of, salt_of, speaks_at, wear, words_at,
};
use crate::travel::{travel_days, within_days};
use std::collections::{BTreeMap, BTreeSet};

/// A taking counts once the new language held the place this many years
/// (two of the tree's steps): a raid or a band at a border does not
/// rename the land.
pub const TAKING_HOLD_YEARS: f64 = 1000.0;
/// The chance that the newcomers keep a place's name, thousandths, by
/// kind. On the earth the river names are the oldest: in Europe many are
/// older than the languages along them (Old European hydronymy, Krahe
/// 1964), and the settlers of North America kept the Mississippi, the
/// Ohio, the Missouri. The large islands keep theirs too (Britain from
/// Pretanī, Ireland from Ériu, Sicily, Sardinia, Cyprus), the new
/// continents not (America, Australia). The Romano-British towns kept
/// their names (London, York from Eboracum), the villages of eastern
/// England took English ones (Gelling 1978). Lakes and mountains keep
/// theirs sometimes (Lake Michigan, Erie, Titicaca, the Alps; Mount
/// McKinley for Denali). All from memory, not checked against the
/// sources.
pub const KEEP_RIVER: u32 = 750;
pub const KEEP_LANDMASS: u32 = 600;
pub const KEEP_TOWN: u32 = 500;
pub const KEEP_LAKE: u32 = 400;
pub const KEEP_MOUNTAIN: u32 = 350;
pub const KEEP_VILLAGE: u32 = 100;
/// A village is a town for KEEP_TOWN from this town at the end, people
/// (the languages window's TOWN_PEOPLE).
pub const KEEP_TOWN_PEOPLE: f64 = 1000.0;
/// The chance that a kept name takes the newcomers' word for its kind,
/// thousandths: River Avon, the Mississippi River, Torpenhow Hill (tor,
/// pen and how are all "hill"), Lake Titicaca. A rate, not an earth
/// measure.
pub const HEAD_AGAIN: u32 = 300;
/// THE CONTACT (`closeness`, 0 to 1, the mean of three parts): a shared
/// border of CONTACT_BORDER_KM or more is the whole of its part (some 10
/// cells' sides); CONTACT_LINKS links of the far trade between their
/// villages are; hearts CONTACT_FAR_DAYS of the ways apart or more are
/// none of theirs (some 1 200 km on foot).
pub const CONTACT_BORDER_KM: f64 = 1000.0;
pub const CONTACT_LINKS: f64 = 10.0;
pub const CONTACT_FAR_DAYS: f64 = 40.0;
/// The chance to borrow a neighbour's name, thousandths: BORROW_FAR at a
/// closeness of 0, BORROW_NEAR at 1, in a line between. Else to translate
/// it by TRANSLATE_SHARE where the words are there, else a name of its
/// own. On the earth neighbours of long contact take the name as the
/// people of the place say it (Rhine from Gaulish Rēnos, Paris, Danube);
/// peoples further away translate it (Black Forest, Schwarzwald, Forêt
/// Noire; Red Sea, Mar Rojo) or give their own (Deutschland, Allemagne,
/// Niemcy, Saksa: the first people met). From memory, not checked.
pub const BORROW_NEAR: u32 = 800;
pub const BORROW_FAR: u32 = 200;
pub const TRANSLATE_SHARE: u32 = 500;
/// The exonyms a language gives a neighbour language's places, at most,
/// by kind: so the exonyms stay some tens a pair of languages.
pub const EXONYM_VILLAGES: usize = 8;
pub const EXONYM_RIVERS: usize = 6;
pub const EXONYM_MOUNTAINS: usize = 3;
pub const EXONYM_LAKES: usize = 3;
pub const EXONYM_LANDMASSES: usize = 2;

/// Two peoples in contact at the history's end: the border they share,
/// km; the ways' days between their hearts (CONTACT_FAR_DAYS where
/// further or none); the links of the far trade between their villages.
#[derive(Clone, Debug, PartialEq)]
pub struct Contact {
    pub a: i32,
    pub b: i32,
    pub border_km: f64,
    pub days: f64,
    pub links: f64,
}

/// THE CONTACT at the history's end: `end_people` each cell's people then
/// (-1 for none), `heart` each people's last heart (a cell, -1 for none),
/// `villages` [cell, lifeway] and `links` the far trade's [village,
/// village, weight] (settle.rs `Settled::links`). The pairs that share a
/// border or a link, the lower id first, in their order.
pub fn contacts_of(
    h: &Habitat,
    end_people: &[i32],
    heart: &[i32],
    villages: &[i32],
    links: &[f32],
) -> Vec<Contact> {
    let mut pairs: BTreeMap<(i32, i32), (f64, f64)> = BTreeMap::new();
    for i in 0..h.count {
        let a = end_people[i];
        if a < 0 {
            continue;
        }
        for e in h.edges(i) {
            let b = end_people[h.nbr[e] as usize];
            if b > a {
                pairs.entry((a, b)).or_default().0 += h.dist_km[e] as f64;
            }
        }
    }
    for l in links.as_chunks::<3>().0 {
        let cell = |v: f32| villages[2 * v as usize] as usize;
        let (a, b) = (end_people[cell(l[0])], end_people[cell(l[1])]);
        if a >= 0 && b >= 0 && a != b {
            pairs.entry((a.min(b), a.max(b))).or_default().1 += 1.0;
        }
    }
    // The days between two hearts: one search over the ways from every
    // heart at once, each cell to its nearest heart (to CONTACT_FAR_DAYS);
    // where the cells of two hearts meet, the days to the one, the step
    // and the days to the other, the least of them. A way between two
    // peoples that touch runs through their own land: it seldom crosses a
    // third people's.
    let heart_of = |p: i32| heart.get(p as usize).copied().unwrap_or(-1);
    let mut hearts: Vec<usize> = pairs
        .keys()
        .flat_map(|&(a, b)| [heart_of(a), heart_of(b)])
        .filter(|&c| c >= 0)
        .map(|c| c as usize)
        .collect();
    hearts.sort_unstable();
    hearts.dedup();
    let days = travel_days(h);
    let mut dist = vec![f32::INFINITY; h.count];
    let mut owner = vec![-1i32; h.count];
    let reached = within_days(
        h,
        &days,
        &hearts,
        CONTACT_FAR_DAYS,
        &mut dist,
        None,
        Some(&mut owner),
    );
    let mut between: BTreeMap<(i32, i32), f64> = BTreeMap::new();
    for &i in &reached {
        for e in h.edges(i) {
            let u = h.nbr[e] as usize;
            let (x, y) = (owner[i], owner[u]);
            if y < 0 || x >= y || !days[e].is_finite() {
                continue;
            }
            let d = dist[i] as f64 + days[e] as f64 + dist[u] as f64;
            let best = between.entry((x, y)).or_insert(f64::INFINITY);
            if d < *best {
                *best = d;
            }
        }
    }
    let source = |c: i32| {
        if c < 0 {
            -1
        } else {
            hearts.binary_search(&(c as usize)).map_or(-1, |k| k as i32)
        }
    };
    pairs
        .into_iter()
        .map(|((a, b), (border_km, links))| {
            let (x, y) = (source(heart_of(a)), source(heart_of(b)));
            let d = if x < 0 || y < 0 {
                CONTACT_FAR_DAYS
            } else if x == y {
                0.0
            } else {
                between
                    .get(&(x.min(y), x.max(y)))
                    .map_or(CONTACT_FAR_DAYS, |&d| d.min(CONTACT_FAR_DAYS))
            };
            Contact {
                a,
                b,
                border_km,
                days: d,
                links,
            }
        })
        .collect()
}

/// How near a contact is, 0 to 1: the mean of its border over
/// CONTACT_BORDER_KM, its links over CONTACT_LINKS (each to 1) and its
/// days short of CONTACT_FAR_DAYS over those.
pub fn closeness(c: &Contact) -> f64 {
    let border = (c.border_km / CONTACT_BORDER_KM).clamp(0.0, 1.0);
    let links = (c.links / CONTACT_LINKS).clamp(0.0, 1.0);
    let days = ((CONTACT_FAR_DAYS - c.days) / CONTACT_FAR_DAYS).clamp(0.0, 1.0);
    (border + links + days) / 3.0
}

/// The chance that the newcomers keep a place's name (KEEP_*).
pub fn keep_chance(place: &Place) -> u32 {
    match place.kind {
        Kind::River => KEEP_RIVER,
        Kind::Landmass => KEEP_LANDMASS,
        Kind::Lake => KEEP_LAKE,
        Kind::Mountain => KEEP_MOUNTAIN,
        _ if place.size >= KEEP_TOWN_PEOPLE => KEEP_TOWN,
        _ => KEEP_VILLAGE,
    }
}

// The word for a place's kind (meanings.json).
fn head_of(place: &Place) -> &'static str {
    match place.kind {
        Kind::River => "river",
        Kind::Lake => "lake",
        Kind::Mountain => "mountain",
        Kind::Landmass if place.size >= BIG_LANDMASS_KM2 => "land",
        Kind::Landmass => "island",
        _ => "village",
    }
}

// The language of a node: a dialect's, else itself; -1 for none.
fn language_of(tree: &Languages, node: i32) -> i32 {
    if node < 0 {
        return -1;
    }
    let n = &tree.nodes[node as usize];
    if n.level == Level::Dialect {
        n.parent
    } else {
        node
    }
}

/// THE OLD NAMES' takings of a place named in `year` (see the module's
/// head): [year, people] of each. `lang` a people's language in a year.
pub fn takings(
    place: &Place,
    year: f64,
    end: f64,
    lang: &dyn Fn(i32, f64) -> i32,
) -> Vec<(f64, i32)> {
    let mut runs: Vec<(f64, i32, i32)> = vec![(year, lang(place.people, year), place.people)];
    for &(t, p) in &place.held {
        let t = t as f64;
        if t <= year || t >= place.until {
            continue;
        }
        let l = lang(p, t);
        if l >= 0 && l != runs[runs.len() - 1].1 {
            runs.push((t, l, p));
        }
    }
    let stop = if place.until < end { place.until } else { end };
    let mut out = Vec::new();
    let mut now = runs[0].1;
    for r in 1..runs.len() {
        let next = runs.get(r + 1).map_or(stop, |x| x.0);
        if next - runs[r].0 < TAKING_HOLD_YEARS || runs[r].1 == now {
            continue;
        }
        out.push((runs[r].0, runs[r].2));
        now = runs[r].1;
    }
    out
}

// A loan of `words` in node k's speech of year t: each word fitted, none
// empty. None where none is left.
fn loan(
    tree: &Languages,
    cache: &mut Cache,
    k: usize,
    t: f64,
    words: &[Vec<Phoneme>],
) -> Option<Vec<Vec<Phoneme>>> {
    let sp = tree.speech(k, t, cache);
    let out: Vec<Vec<Phoneme>> = words
        .iter()
        .map(|w| sp.lang.fit(w))
        .filter(|w| !w.is_empty())
        .collect();
    (!out.is_empty()).then_some(out)
}

/// THE OTHER NAMES of the places (see the module's head): `places` and
/// their `names` (Names::give), `contacts` at the end (`contacts_of`),
/// the peoples (their parents and births), the history's end.
pub fn give_aliases(
    tree: &Languages,
    places: &[Place],
    names: &Names,
    contacts: &[Contact],
    peoples: &[PeopleInput],
    end: f64,
) -> Aliases {
    let (own, dialect) = own_nodes(tree);
    let speaks = |p: i32, t: f64| -> i32 {
        if p < 0 {
            -1
        } else {
            speaks_at(tree, &own, &dialect, p as usize, t)
        }
    };
    let lang = |p: i32, t: f64| language_of(tree, speaks(p, t));
    // Since when a people's line speaks its language of the end: the
    // birth of its furthest forebear that spoke it when the next one of
    // the line was born.
    let line_born = |p: i32| -> f64 {
        if p < 0 || p as usize >= peoples.len() {
            return 0.0;
        }
        let l = lang(p, end);
        let mut q = p as usize;
        loop {
            let parent = peoples[q].parent;
            if parent < 0 || lang(parent, peoples[q].born) != l {
                return peoples[q].born;
            }
            q = parent as usize;
        }
    };
    let mut cache = Cache::default();
    // THE OLD NAMES: each name's chain.
    let mut chains: Vec<Vec<Entry>> = Vec::with_capacity(names.len());
    let mut place_of: Vec<usize> = Vec::with_capacity(names.len());
    let mut own_at = 0usize;
    for (i, place) in places.iter().enumerate() {
        if namer_of(tree, &own, &dialect, place).is_none() {
            continue;
        }
        let j = chains.len();
        let length = names.own_length[j] as usize;
        let own_sounds: Vec<Phoneme> = names.own[own_at..own_at + length]
            .iter()
            .map(|&p| Phoneme(p))
            .collect();
        own_at += length;
        let first = Entry {
            how: how::FIRST,
            namer: names.namer[j] as usize,
            year: names.year[j] as f64,
            said: Said::Recipe(recipe_of(
                place.kind,
                names.pattern[j],
                [names.meaning[2 * j], names.meaning[2 * j + 1]],
                &own_sounds,
            )),
        };
        let salt = salt_of(place.kind, place.place);
        let mut chain = vec![first];
        for (n, (t, q)) in takings(place, chain[0].year, end, &lang)
            .into_iter()
            .enumerate()
        {
            let k = speaks(q, t);
            if k < 0 || k > u16::MAX as i32 {
                continue;
            }
            let (k, t) = (k as usize, t as f32 as f64);
            if cache.speeches_len() > crate::place_names::BOOK_SPEECHES {
                cache.forget_speeches();
            }
            let mut d = Draw::new(salt ^ mix(n as u32 + 1), "taking");
            let last = &chain[chain.len() - 1];
            let kept = if d.chance(keep_chance(place)) {
                let (words, _) = words_at(tree, &mut cache, last, t);
                loan(tree, &mut cache, k, t, &words)
            } else {
                None
            };
            let sp = tree.speech(k, t, &mut cache);
            let entry = match kept {
                Some(words) => {
                    let head = head_of(place);
                    let head = (d.chance(HEAD_AGAIN) && sp.lang.word(head).is_some())
                        .then(|| head.to_string());
                    Entry {
                        how: how::KEPT,
                        namer: k,
                        year: t,
                        said: Said::Loan {
                            words,
                            head,
                            head_first: sp.lang.grammar.article,
                        },
                    }
                }
                None => Entry {
                    how: how::RENAMED,
                    namer: k,
                    year: t,
                    said: Said::Recipe(sp.lang.name(
                        place.kind,
                        &place.context,
                        salt ^ mix(0x100 + n as u32),
                    )),
                },
            };
            chain.push(entry);
        }
        chains.push(chain);
        place_of.push(i);
    }
    // THE EXONYMS: the pairs of languages in contact, the nearest pair of
    // peoples of each, the peoples of the other language it touches.
    let mut pairs: BTreeMap<(i32, i32), (f64, i32, i32)> = BTreeMap::new();
    let mut touched: BTreeMap<(i32, i32), BTreeSet<i32>> = BTreeMap::new();
    for c in contacts {
        let (la, lb) = (lang(c.a, end), lang(c.b, end));
        if la < 0 || lb < 0 || la == lb {
            continue;
        }
        let near = closeness(c);
        for (x, y, lx, ly) in [(c.a, c.b, la, lb), (c.b, c.a, lb, la)] {
            let best = pairs.entry((lx, ly)).or_insert((-1.0, x, y));
            if near > best.0 {
                *best = (near, x, y);
            }
            touched.entry((lx, ly)).or_default().insert(y);
        }
    }
    let mut by_language: BTreeMap<i32, Vec<usize>> = BTreeMap::new();
    for (j, chain) in chains.iter().enumerate() {
        let now = language_of(tree, chain[chain.len() - 1].namer as i32);
        by_language.entry(now).or_default().push(j);
    }
    let mut exonyms: Vec<Vec<Entry>> = vec![Vec::new(); chains.len()];
    for (&(la, lb), &(near, a, b)) in &pairs {
        let Some(list) = by_language.get(&lb) else {
            continue;
        };
        let theirs = &touched[&(la, lb)];
        let mut chosen: Vec<usize> = Vec::new();
        for (kind, most) in [
            (Kind::Landmass, EXONYM_LANDMASSES),
            (Kind::Village, EXONYM_VILLAGES),
            (Kind::River, EXONYM_RIVERS),
            (Kind::Lake, EXONYM_LAKES),
            (Kind::Mountain, EXONYM_MOUNTAINS),
        ] {
            let mut of_kind: Vec<usize> = list
                .iter()
                .copied()
                .filter(|&j| {
                    let p = &places[place_of[j]];
                    p.kind == kind
                        && (kind != Kind::Village || p.size > 0.0)
                        && (kind == Kind::Landmass
                            || p.end_people < 0
                            || theirs.contains(&p.end_people))
                })
                .collect();
            of_kind.sort_by(|&x, &y| {
                places[place_of[y]]
                    .size
                    .total_cmp(&places[place_of[x]].size)
                    .then(x.cmp(&y))
            });
            chosen.extend(of_kind.into_iter().take(most));
        }
        for j in chosen {
            let place = &places[place_of[j]];
            let now = &chains[j][chains[j].len() - 1];
            let mut y = now.year.max(line_born(a)).max(line_born(b));
            if y > end {
                y = end;
            }
            let y = y as f32 as f64;
            let k = speaks(a, y);
            if k < 0 || k > u16::MAX as i32 {
                continue;
            }
            let k = k as usize;
            if cache.speeches_len() > crate::place_names::BOOK_SPEECHES {
                cache.forget_speeches();
            }
            let salt = salt_of(place.kind, place.place) ^ mix(la as u32 + 1);
            let mut d = Draw::new(salt, "exonym");
            let chance = BORROW_FAR + ((BORROW_NEAR - BORROW_FAR) as f64 * near).round() as u32;
            let borrow = d.chance(chance);
            let translate = !borrow && d.chance(TRANSLATE_SHARE);
            let mut entry = None;
            if borrow {
                let (words, _) = words_at(tree, &mut cache, now, y);
                entry = loan(tree, &mut cache, k, y, &words).map(|words| Said::Loan {
                    words,
                    head: None,
                    head_first: false,
                });
            } else if translate {
                entry = translation(tree, &mut cache, now, k, y);
            }
            let (how, said) = match entry {
                Some(said) if borrow => (how::BORROWED, said),
                Some(said) => (how::TRANSLATED, said),
                None => {
                    let sp = tree.speech(k, y, &mut cache);
                    (
                        how::OWN,
                        Said::Recipe(sp.lang.name(place.kind, &place.context, salt ^ mix(0x200))),
                    )
                }
            };
            exonyms[j].push(Entry {
                how,
                namer: k,
                year: y,
                said,
            });
        }
    }
    let mut out = Aliases::default();
    for j in 0..chains.len() {
        for e in chains[j].iter().skip(1).chain(&exonyms[j]) {
            out.push(j, e);
        }
    }
    out
}

// A name translated into node k's speech of year y: a recipe's pattern
// and meanings, where k's lexicon has them, its word of its own (worn
// down in its namer's line to y) refitted; a loan with a word for its
// kind, its loan refitted and the word k's. None where it cannot be
// translated (a name of no meaning, a meaning k has no word for).
fn translation(tree: &Languages, cache: &mut Cache, now: &Entry, k: usize, y: f64) -> Option<Said> {
    let until = tree.nodes[now.namer].until.max(now.year);
    let worn = |mut words: Vec<Vec<Phoneme>>| {
        for d in line_changes(tree, now.namer, now.year, y.clamp(now.year, until)) {
            wear(&mut words, &d);
        }
        words
    };
    match &now.said {
        Said::Recipe(r) => {
            let mut meanings = 0;
            let sp = tree.speech(k, y, cache);
            for slot in &r.slots {
                match slot {
                    crate::language::Slot::Head(m)
                    | crate::language::Slot::Adjective(m)
                    | crate::language::Slot::Noun(m) => {
                        sp.lang.word(m)?;
                        meanings += 1;
                    }
                    _ => {}
                }
            }
            if meanings == 0 {
                return None;
            }
            let mut out = r.clone();
            for slot in &mut out.slots {
                if let crate::language::Slot::Own(sounds) = slot {
                    let w = worn(vec![sounds.clone()]);
                    let fitted = sp.lang.fit(&w[0]);
                    if fitted.is_empty() {
                        return None;
                    }
                    *sounds = fitted;
                }
            }
            Some(Said::Recipe(out))
        }
        Said::Loan {
            words,
            head: Some(head),
            ..
        } => {
            let w = worn(words.clone());
            let words = loan(tree, cache, k, y, &w)?;
            let sp = tree.speech(k, y, cache);
            sp.lang.word(head)?;
            Some(Said::Loan {
                words,
                head: Some(head.clone()),
                head_first: sp.lang.grammar.article,
            })
        }
        Said::Loan { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::place_names::NameBook;

    fn people(parent: i32, group: i32, born: f64, ended: f64) -> PeopleInput {
        PeopleInput {
            parent,
            group,
            born,
            ended,
            merged_into: -1,
            big: true,
            share: 0.1,
            replaced: false,
            heart: 0,
            heart_apart: 0,
        }
    }

    // Two families side by side; family 1's people 1 takes family 0's
    // places at 3 000, and holds them.
    fn sample() -> (Vec<PeopleInput>, Vec<Place>) {
        let peoples = vec![
            people(-1, 0, 0.0, f64::INFINITY),
            people(-1, 1, 0.0, f64::INFINITY),
        ];
        let mut places = Vec::new();
        for (j, kind) in [
            Kind::Village,
            Kind::River,
            Kind::Mountain,
            Kind::Lake,
            Kind::Landmass,
        ]
        .into_iter()
        .cycle()
        .take(60)
        .enumerate()
        {
            places.push(Place {
                kind,
                place: j as i32,
                cell: j as i32,
                people: 0,
                year: 100.0,
                context: vec!["river", "forest", "big"],
                size: 2000.0,
                until: f64::INFINITY,
                held: vec![(100.0, 0), (3000.0, 1)],
                end_people: 1,
            });
        }
        // Places of people 0 at the end, for people 1's exonyms.
        for j in 0..20 {
            let kind = Kind::ALL[j % 5];
            places.push(Place {
                kind,
                place: 100 + j as i32,
                cell: 100 + j as i32,
                people: 0,
                year: 200.0,
                context: vec!["lake", "hill"],
                size: 5000.0,
                until: f64::INFINITY,
                held: vec![(200.0, 0)],
                end_people: 0,
            });
        }
        (peoples, places)
    }

    #[test]
    fn taken_places_keep_or_change_their_names_and_neighbours_name_them() {
        let (peoples, places) = sample();
        let (tree, _) = Languages::build(&peoples, 7.0, 0.0, 6000.0);
        let names = Names::give(&tree, &places);
        let contacts = vec![Contact {
            a: 0,
            b: 1,
            border_km: 800.0,
            days: 10.0,
            links: 4.0,
        }];
        let aliases = give_aliases(&tree, &places, &names, &contacts, &peoples, 6000.0);
        let count = |h: u8| aliases.how.iter().filter(|&&x| x == h).count();
        // Every taken place has one later name, kept or not.
        assert_eq!(count(how::KEPT) + count(how::RENAMED), 60);
        assert!(count(how::KEPT) > 0 && count(how::RENAMED) > 0);
        assert!(count(how::BORROWED) + count(how::TRANSLATED) + count(how::OWN) > 0);
        // The same input, the same aliases; they read back.
        assert_eq!(
            give_aliases(&tree, &places, &names, &contacts, &peoples, 6000.0),
            aliases
        );
        let mut book = NameBook::new(tree.clone(), names, aliases.clone()).unwrap();
        for j in 0..60 {
            let chain = book.chain(j);
            assert_eq!(chain.len(), 2);
            assert_eq!(chain[1].year, 3000.0);
            let after = book.form_at(j, 3000.0).unwrap();
            assert!(!after.is_empty());
            // The forms over time hold the later name from its year.
            let forms = book.forms(j);
            let at = forms.iter().rposition(|(y, _)| *y <= 3000.0).unwrap();
            assert_eq!(forms[at].1, after);
        }
        // A loan is in the borrower's sounds.
        let mut cache = Cache::default();
        for a in 0..aliases.len() {
            let e = book.alias(a);
            if let Said::Loan { words, .. } = &e.said {
                let sounds = tree
                    .speech(e.namer, e.year, &mut cache)
                    .lang
                    .inventory
                    .sounds();
                assert!(words.iter().flatten().all(|p| sounds.contains(p)));
            }
        }
    }

    #[test]
    fn a_short_hold_is_no_taking() {
        let (_, mut places) = sample();
        let p = &mut places[0];
        p.held = vec![(100.0, 0), (1000.0, 1), (1500.0, 0), (4000.0, 1)];
        let lang = |q: i32, _t: f64| q;
        assert_eq!(takings(p, 100.0, 6000.0, &lang), vec![(4000.0, 1)]);
        p.held = vec![(100.0, 0), (5500.0, 1)];
        assert!(takings(p, 100.0, 6000.0, &lang).is_empty());
        p.until = 2000.0;
        p.held = vec![(100.0, 0), (2500.0, 1)];
        assert!(takings(p, 100.0, 6000.0, &lang).is_empty());
    }
}

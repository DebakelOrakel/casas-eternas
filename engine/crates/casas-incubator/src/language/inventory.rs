//! The sound inventory of a proto-language (`inventories.json`, the steps
//! of the kit's README): the counts, the series, the sounds every language
//! has, the liquids and the gaps, the fill by weight, the implications and
//! the stress rule.

use super::Phoneme;
use super::draw::Draw;
use super::kit::{Implication, Kit, weight};
use super::notation::{Unit, parse_units, replace, sound_in};

/// Where a language puts the stress (`stress` of inventories.json).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stress {
    /// No fixed place: each root keeps the syllable it drew.
    Free,
    Initial,
    Second,
    Antepenultimate,
    Penultimate,
    Ultimate,
}

impl Stress {
    pub fn id(self) -> &'static str {
        match self {
            Stress::Free => "free",
            Stress::Initial => "initial",
            Stress::Second => "second",
            Stress::Antepenultimate => "antepenultimate",
            Stress::Penultimate => "penultimate",
            Stress::Ultimate => "ultimate",
        }
    }

    fn of(id: &str) -> Stress {
        match id {
            "initial" => Stress::Initial,
            "second" => Stress::Second,
            "antepenultimate" => Stress::Antepenultimate,
            "penultimate" => Stress::Penultimate,
            "ultimate" => Stress::Ultimate,
            _ => Stress::Free,
        }
    }

    /// The stressed syllable of a word of `n` syllables (0 the first);
    /// `free` is the syllable a root keeps under free stress.
    pub fn syllable(self, n: usize, free: usize) -> usize {
        let last = n.saturating_sub(1);
        match self {
            Stress::Free => free.min(last),
            Stress::Initial => 0,
            Stress::Second => 1.min(last),
            Stress::Antepenultimate => n.saturating_sub(3),
            Stress::Penultimate => n.saturating_sub(2),
            Stress::Ultimate => last,
        }
    }
}

/// What a language drew from `inventories.json`.
#[derive(Debug, Clone)]
pub struct Inventory {
    /// In the order of the kit's table.
    pub consonants: Vec<Phoneme>,
    /// The vowels with the long and the nasal ones, in the table's order.
    pub vowels: Vec<Phoneme>,
    /// Per series of the kit: true when drawn.
    pub series: Vec<bool>,
    /// Per implication of the kit: true when it holds in this language.
    pub holds: Vec<bool>,
    /// The sounds the gaps removed.
    pub removed: Vec<Phoneme>,
    pub liquids: String,
    pub stress: Stress,
}

/// The sounds an implication asks for when the inventory has `p`:
/// its `needs` resolved on `p`. Empty when none is a sound of the table.
pub fn needed(kit: &Kit, imp: &Implication, p: Phoneme) -> Vec<Phoneme> {
    imp.needs
        .iter()
        .filter_map(|n| {
            if n.starts_with('[') {
                match kit.units(n).as_slice() {
                    [Unit::Class(c)] => replace(kit, Some(p), c, &Default::default()),
                    _ => None,
                }
            } else {
                kit.sound(n)
            }
        })
        .filter(|&n| n != p)
        .collect()
}

/// True when the inventory keeps the implication for `p`: it has one of
/// the sounds asked for, or a gap removed one of them, or none is a sound
/// of the table.
pub fn keeps(
    kit: &Kit,
    imp: &Implication,
    p: Phoneme,
    have: &[Phoneme],
    removed: &[Phoneme],
) -> bool {
    let n = needed(kit, imp, p);
    n.is_empty() || n.iter().any(|x| have.contains(x) || removed.contains(x))
}

/// The rounds of the implications that may put a sound back; the rounds
/// after them only add.
pub const IMPLICATION_ROUNDS: usize = 3;

fn units(kit: &Kit, text: &str) -> Vec<Unit> {
    parse_units(kit, text).unwrap_or_else(|e| panic!("inventories.json '{text}': {e}"))
}

impl Inventory {
    pub fn draw(kit: &Kit, d: &mut Draw) -> Inventory {
        let inv = &kit.inventories;
        let sound = |p: Phoneme| &kit.sounds[p.0 as usize];
        let all: Vec<Phoneme> = (0..kit.sounds.len()).map(|k| Phoneme(k as u8)).collect();

        // 1. The counts.
        let class = |list: &[super::kit::CountClass], d: &mut Draw| {
            let k = d.pick_by(list, |c| u64::from(weight(c.weight))).unwrap();
            d.range(list[k].min, list[k].max) as usize
        };
        let consonant_count = class(&inv.consonant_count, d);
        let vowel_count = class(&inv.vowel_count, d);

        // 2. The series; a series not drawn removes its sounds.
        let series: Vec<bool> = inv
            .series
            .iter()
            .map(|s| d.chance(weight(s.weight)))
            .collect();
        let series_units: Vec<Vec<Unit>> = inv.series.iter().map(|s| units(kit, &s.adds)).collect();
        let excluded = |p: Phoneme| {
            series
                .iter()
                .zip(&series_units)
                .any(|(on, u)| !on && sound_in(kit, u, p))
        };

        // 4. The liquids and the gaps (drawn before the fill, which they
        // limit).
        let l = d
            .pick_by(&inv.liquids, |l| u64::from(weight(l.weight)))
            .unwrap();
        let liquids = inv.liquids[l].id.clone();
        let rhotic = |p: Phoneme| matches!(sound(p).id.as_str(), "ɾ" | "r" | "ɹ");
        let lateral = |p: Phoneme| sound(p).lateral;
        let liquid_out = |p: Phoneme| match liquids.as_str() {
            "none" => rhotic(p) || lateral(p),
            "lOnly" => rhotic(p),
            "rOnly" => lateral(p),
            _ => false,
        };
        let mut removed = Vec::new();
        for g in &inv.gaps {
            if d.chance(weight(g.weight))
                && let Some(p) = kit.sound(&g.removes)
            {
                removed.push(p);
            }
        }
        let candidate = |p: Phoneme| !excluded(p) && !liquid_out(p) && !removed.contains(&p);
        let quality = |p: Phoneme| sound(p).vowel && !sound(p).long && !sound(p).nasal;

        // 3. One member of each list in `always`.
        let mut have: Vec<Phoneme> = Vec::new();
        let always = |have: &mut Vec<Phoneme>, d: &mut Draw| {
            for list in inv.always.consonants.iter().chain(&inv.always.vowels) {
                let members: Vec<Phoneme> = list.iter().filter_map(|m| kit.sound(m)).collect();
                if members.iter().any(|m| have.contains(m)) {
                    continue;
                }
                let mut allowed: Vec<Phoneme> =
                    members.iter().copied().filter(|&m| candidate(m)).collect();
                if allowed.is_empty() {
                    allowed = members;
                }
                let k = d
                    .pick_by(&allowed, |&m| u64::from(sound(m).weight))
                    .unwrap();
                have.push(allowed[k]);
            }
        };
        always(&mut have, d);
        // The liquids the choice asks for.
        let take = |have: &mut Vec<Phoneme>, list: &[&str], d: &mut Draw| {
            let members: Vec<Phoneme> = list
                .iter()
                .filter_map(|m| kit.sound(m))
                .filter(|&m| candidate(m))
                .collect();
            if members.iter().any(|m| have.contains(m)) || members.is_empty() {
                return;
            }
            let k = d
                .pick_by(&members, |&m| u64::from(sound(m).weight))
                .unwrap();
            have.push(members[k]);
        };
        if liquids == "lAndR" || liquids == "lOnly" {
            take(&mut have, &["l"], d);
        }
        if liquids == "lAndR" || liquids == "rOnly" {
            take(&mut have, &["ɾ", "r", "ɹ"], d);
        }

        // 5. The fill by weight.
        let count = |have: &[Phoneme], vowel: bool| {
            have.iter()
                .filter(|&&p| if vowel { quality(p) } else { !sound(p).vowel })
                .count()
        };
        for vowel in [false, true] {
            let target = if vowel { vowel_count } else { consonant_count };
            while count(&have, vowel) < target {
                let pool: Vec<Phoneme> = all
                    .iter()
                    .copied()
                    .filter(|&p| {
                        candidate(p)
                            && !have.contains(&p)
                            && if vowel { quality(p) } else { !sound(p).vowel }
                    })
                    .collect();
                match d.pick_by(&pool, |&p| u64::from(sound(p).weight)) {
                    Some(k) => have.push(pool[k]),
                    None => break,
                }
            }
        }
        // The long and the nasal vowels of the series: one for each
        // quality the inventory has.
        for p in all.iter().copied() {
            let s = sound(p);
            if s.vowel && (s.long || s.nasal) && candidate(p) {
                let base = all.iter().copied().find(|&q| {
                    let t = sound(q);
                    quality(q)
                        && t.height == s.height
                        && t.backness == s.backness
                        && t.rounded == s.rounded
                });
                if base.is_some_and(|b| have.contains(&b)) {
                    have.push(p);
                }
            }
        }

        // 6. The implications: add the missing sound, or put the drawn
        // sound back when its count is full. Then `always` again, which
        // a sound put back can break. After IMPLICATION_ROUNDS rounds, the
        // rounds only add, until nothing changes: an added sound can need
        // another (g needs d, d needs t).
        let holds: Vec<bool> = inv
            .implications
            .iter()
            .map(|i| d.chance(weight(i.strength)))
            .collect();
        let tests: Vec<Vec<Unit>> = inv
            .implications
            .iter()
            .map(|i| units(kit, &i.if_))
            .collect();
        let mut round = 0;
        loop {
            let only_add = round >= IMPLICATION_ROUNDS;
            let mut changed = false;
            for ((imp, test), &on) in inv.implications.iter().zip(&tests).zip(&holds) {
                if !on {
                    continue;
                }
                let mut k = 0;
                while k < have.len() {
                    let p = have[k];
                    if !sound_in(kit, test, p) || keeps(kit, imp, p, &have, &removed) {
                        k += 1;
                        continue;
                    }
                    changed = true;
                    let n = needed(kit, imp, p)[0];
                    let vowel = sound(n).vowel;
                    let target = if vowel { vowel_count } else { consonant_count };
                    let full = !(vowel && !quality(n)) && count(&have, vowel) >= target;
                    if full && !only_add {
                        have.remove(k);
                    } else {
                        have.push(n);
                        k += 1;
                    }
                }
            }
            let before = have.len();
            always(&mut have, d);
            changed |= have.len() != before;
            round += 1;
            if only_add && !changed {
                break;
            }
        }
        have.sort();
        have.dedup();

        // 7. The stress.
        let st = d
            .pick_by(&inv.stress, |s| u64::from(weight(s.weight)))
            .unwrap();
        Inventory {
            consonants: have.iter().copied().filter(|&p| !sound(p).vowel).collect(),
            vowels: have.iter().copied().filter(|&p| sound(p).vowel).collect(),
            series,
            holds,
            removed,
            liquids,
            stress: Stress::of(&inv.stress[st].id),
        }
    }

    /// Every sound, the consonants first.
    pub fn sounds(&self) -> Vec<Phoneme> {
        self.consonants
            .iter()
            .chain(&self.vowels)
            .copied()
            .collect()
    }
}

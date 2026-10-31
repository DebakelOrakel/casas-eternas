//! A LOAN (TEG-142, TEG-143; docs/design/naming-languages.md, DES-0033
//! "Contact"): a word of another language as this language says it. Each
//! sound the language does not have becomes its nearest sound of the
//! language by its features (`nearest`); then what the syllable rules of
//! the language do not allow is dropped (`Language::fit`). So Latin
//! Londinium became Old English Lunden, and Algonquian
//! Mishi-maskinong became Michilimackinac in French (from memory, not
//! checked against a source).

use super::kit::{Sound, kit};
use super::syllable::glide_same_vowel;
use super::{Language, Phoneme};

/// The changes a loan may take to fit the syllable rules: this many a
/// sound of the word at most. Each drops a sound or puts a vowel in; the
/// last resort after them makes it again a syllable at a time.
pub const FIT_STEPS: usize = 2;

// The place of a consonant, from the lips back.
fn place(s: &Sound) -> i32 {
    match s.place.as_str() {
        "bilabial" => 0,
        "labiodental" => 1,
        "dental" => 2,
        "alveolar" => 3,
        "postalveolar" => 4,
        "retroflex" => 5,
        "palatal" => 6,
        "velar" | "labiovelar" => 7,
        "uvular" => 8,
        "pharyngeal" => 9,
        _ => 10,
    }
}

// The manner of a consonant, from the stops to the glides.
fn manner(s: &Sound) -> i32 {
    match s.manner.as_str() {
        "stop" => 0,
        "affricate" => 1,
        "fricative" => 2,
        "nasal" => 4,
        "tap" | "trill" => 5,
        "lateralApproximant" => 6,
        _ => 7,
    }
}

fn height(s: &Sound) -> i32 {
    match s.height.as_str() {
        "close" => 0,
        "nearClose" => 1,
        "closeMid" => 2,
        "mid" => 3,
        "openMid" => 4,
        "nearOpen" => 5,
        _ => 6,
    }
}

fn backness(s: &Sound) -> i32 {
    match s.backness.as_str() {
        "front" => 0,
        "central" => 1,
        _ => 2,
    }
}

/// How far apart two sounds are by their features: a vowel and a
/// consonant are not compared (None). Consonants: the manner weighs most,
/// then the voice, the series and the lateral, then the place. Vowels:
/// the backness, then the roundness and the nasal, then the height and
/// the length.
pub fn distance(a: &Sound, b: &Sound) -> Option<i32> {
    if a.vowel != b.vowel {
        return None;
    }
    let differ = |x: bool, y: bool| i32::from(x != y);
    Some(if a.vowel {
        3 * (backness(a) - backness(b)).abs()
            + (height(a) - height(b)).abs()
            + 2 * differ(a.rounded, b.rounded)
            + 2 * differ(a.nasal, b.nasal)
            + differ(a.long, b.long)
    } else {
        3 * (manner(a) - manner(b)).abs()
            + i32::from(a.manner != b.manner)
            + 2 * differ(a.voice, b.voice)
            + 2 * differ(a.series.is_some(), b.series.is_some())
            + 2 * differ(a.lateral, b.lateral)
            + (place(a) - place(b)).abs()
    })
}

/// The sound of `sounds` nearest `p` (`distance`; the first of the list
/// where two are as near); `p` itself where the list has it. None where
/// the list has no sound of its class (a vowel, a consonant).
pub fn nearest(p: Phoneme, sounds: &[Phoneme]) -> Option<Phoneme> {
    if sounds.contains(&p) {
        return Some(p);
    }
    let s = p.sound();
    let mut best: Option<(i32, Phoneme)> = None;
    for &q in sounds {
        if let Some(d) = distance(s, q.sound())
            && best.is_none_or(|(b, _)| d < b)
        {
            best = Some((d, q));
        }
    }
    best.map(|(_, q)| q)
}

impl Language {
    /// A word of another language as this one says it: each sound its
    /// nearest of the inventory, then, while the syllable rules do not
    /// allow it, a change at the first place it stops fitting (the
    /// furthest whole syllables, `Phonotactics::reach`): a ŋ at the start,
    /// a vowel after a vowel, a glide before its own vowel dropped; else
    /// the consonant of the next few that lets the most of it fit
    /// dropped, else the link vowel (`Grammar::link_vowel`, its nearest
    /// sound of the inventory) put in after the first of them. At most
    /// FIT_STEPS changes a sound; a word they do not fit is made again a
    /// syllable at a time (its vowels, each with the consonant before it
    /// where the rules allow it). Never a word without a vowel: the empty
    /// word stays empty.
    pub fn fit(&self, word: &[Phoneme]) -> Vec<Phoneme> {
        let k = kit();
        let sounds = self.inventory.sounds();
        let mut w: Vec<Phoneme> = word.iter().filter_map(|&p| nearest(p, &sounds)).collect();
        let vowel = |p: &Phoneme| p.sound().vowel;
        let syl = &self.syllables;
        // The link vowel as the language has it now (its sound changes may
        // have changed it).
        let link = nearest(self.grammar.link_vowel, &sounds).unwrap_or(self.grammar.link_vowel);
        for _ in 0..FIT_STEPS * word.len().max(1) {
            if w.is_empty() || syl.pronounceable(k, &w) {
                break;
            }
            let vowels = w.iter().filter(|p| vowel(p)).count();
            // A rule of `pronounceable` other than the forms.
            let rule = (0..w.len()).find(|&i| {
                (i == 0 && syl.rules.no_initial_ng && w[0].id() == "ŋ")
                    || (i > 0
                        && syl.rules.no_vowel_hiatus
                        && vowel(&w[i - 1])
                        && vowel(&w[i])
                        && vowels > 1)
                    || (i + 1 < w.len()
                        && syl.rules.no_glide_same_vowel
                        && w[i].sound().glide()
                        && vowel(&w[i + 1])
                        && glide_same_vowel(k, w[i], w[i + 1]))
            });
            if let Some(i) = rule {
                w.remove(i);
                continue;
            }
            let at = syl.reach(k, &w);
            let score = |c: &[Phoneme]| (syl.pronounceable(k, c), syl.reach(k, c));
            let mut best: Option<((bool, usize), Vec<Phoneme>)> = None;
            let mut consider = |c: Vec<Phoneme>| {
                let s = score(&c);
                if best.as_ref().is_none_or(|(b, _)| s > *b) {
                    best = Some((s, c));
                }
            };
            let window = (at.saturating_sub(1)..(at + 4).min(w.len())).filter(|&i| !vowel(&w[i]));
            for i in window.clone() {
                let mut c = w.clone();
                c.remove(i);
                consider(c);
            }
            if let Some(i) = window.clone().next() {
                let mut c = w.clone();
                c.insert(i + 1, link);
                consider(c);
            }
            match best {
                Some((s, c)) if s > score(&w) => w = c,
                _ => break,
            }
        }
        if w.is_empty() {
            return w;
        }
        if !w.iter().any(vowel) {
            // A word of consonants alone: the link vowel after its first.
            w.insert(1, link);
        }
        if syl.pronounceable(k, &w) {
            return w;
        }
        // The last resort, a syllable at a time: each vowel with the
        // consonant before it, alone, or after the link consonant, the
        // first the rules allow after what stands; then the last
        // consonant, where they allow it.
        let consonant =
            nearest(self.grammar.link_consonant, &sounds).unwrap_or(self.grammar.link_consonant);
        let mut out: Vec<Phoneme> = Vec::new();
        for i in 0..w.len() {
            if !vowel(&w[i]) {
                continue;
            }
            let mut tries = Vec::new();
            if i > 0 && !vowel(&w[i - 1]) {
                tries.push(vec![w[i - 1], w[i]]);
            }
            tries.push(vec![w[i]]);
            tries.push(vec![consonant, w[i]]);
            for t in tries {
                let mut c = out.clone();
                c.extend(t);
                if syl.pronounceable(k, &c) {
                    out = c;
                    break;
                }
            }
        }
        if let Some(&last) = w.last()
            && !vowel(&last)
        {
            let mut c = out.clone();
            c.push(last);
            if syl.pronounceable(k, &c) {
                out = c;
            }
        }
        if out.is_empty() { w } else { out }
    }
}

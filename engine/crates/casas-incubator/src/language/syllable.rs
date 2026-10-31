//! The syllables of a language (`syllables.json`): the forms it has, the
//! onsets and codas each form allows by sonority and the other rules, the
//! roots it makes, and the test that a word can be split into them.

use super::Phoneme;
use super::change::holds;
use super::draw::Draw;
use super::kit::{Kit, Sound, weight};
use std::collections::BTreeSet;

/// The shift of the root lengths a language draws ("wordLength" of
/// syllables.json): this many thousandths of the weight move from three
/// syllables to one (short words) or from one to three (long words).
pub const WORD_LENGTH_SHIFT: u32 = 150;

/// The chance of a short and of a long word length, in thousandths; the
/// rest is the kit's weights unchanged.
pub const WORD_LENGTH_SHORT: u32 = 250;
pub const WORD_LENGTH_LONG: u32 = 250;

/// A consonant that stands in a root already is drawn again for an onset
/// or a coda of that root with its weight divided by this (TEG-146: a
/// language of few consonants repeated its commonest ones, "Pimpapim",
/// "mumom"; 18.4 % of the roots on 300 seeds had a consonant twice, with
/// this 12.8 %).
pub const REPEAT_DAMP: u64 = 3;

/// True when a word has two like syllables side by side: the same
/// consonant before the same vowel twice in a row ("Qamqamdle",
/// "Papa"). The names and the roots (`Phonotactics::root`) avoid them.
pub fn echoes(word: &[Phoneme]) -> bool {
    // By vowel, the consonant just before it (None at a vowel after a
    // vowel or at the start).
    let mut last: Option<(Option<Phoneme>, Phoneme)> = None;
    for (i, &p) in word.iter().enumerate() {
        if !p.sound().vowel {
            continue;
        }
        let before = i
            .checked_sub(1)
            .map(|j| word[j])
            .filter(|q| !q.sound().vowel);
        if before.is_some() && last == Some((before, p)) {
            return true;
        }
        last = Some((before, p));
    }
    false
}

/// One syllable form of a language, with every onset and coda it allows.
#[derive(Debug, Clone)]
pub struct Form {
    pub id: String,
    pub weight: u32,
    /// The nucleus is a vowel and a glide (form CVV).
    pub glide_nucleus: bool,
    pub onsets: Vec<(Vec<Phoneme>, u64)>,
    pub codas: Vec<(Vec<Phoneme>, u64)>,
    onset_set: BTreeSet<Vec<Phoneme>>,
    coda_set: BTreeSet<Vec<Phoneme>>,
}

/// Which consonants may end a syllable (`codaSubset`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codas {
    All,
    Sonorants,
    Nasals,
}

/// The rules of `constraints` with a `strength`: true when the language
/// has the rule.
#[derive(Debug, Clone, Copy)]
pub struct Rules {
    pub no_homorgan_onset: bool,
    pub no_initial_ng: bool,
    pub no_coda_h: bool,
    pub no_glide_same_vowel: bool,
    pub no_vowel_hiatus: bool,
}

/// What a language draws from `syllables.json`.
#[derive(Debug, Clone)]
pub struct Phonotactics {
    pub complexity: String,
    pub forms: Vec<Form>,
    /// Two times the sonority distance (the scale of `Sound::sonority`).
    pub min_distance: u32,
    pub rules: Rules,
    pub codas: Codas,
    /// The weights of a root of 1, 2, 3 syllables.
    pub root_length: [u32; 3],
    /// The vowels of the inventory and their weights, for the nuclei.
    vowels: Vec<(Phoneme, u64)>,
    /// The glides of the inventory, for a nucleus of form CVV.
    glides: Vec<Phoneme>,
}

/// How often a sound of the inventory stands in a root: the square root of
/// its weight (times 1 000, as an integer). The weight of sounds.json is
/// the share of the languages that HAVE the sound, not how often a
/// language uses it; as it is, m (0.96) would stand in most roots and a
/// rare sound (0.05) almost never.
pub fn frequency(sound: &Sound) -> u64 {
    (u64::from(sound.weight) * 1000).isqrt()
}

fn s(kit: &Kit, p: Phoneme) -> &Sound {
    &kit.sounds[p.0 as usize]
}

// True when j stands before an i, or w before a u (by quality).
pub(super) fn glide_same_vowel(kit: &Kit, glide: Phoneme, vowel: Phoneme) -> bool {
    let (g, v) = (s(kit, glide), s(kit, vowel));
    (g.id == "j" && v.height == "close" && v.backness == "front" && !v.rounded)
        || (g.id == "w" && v.height == "close" && v.backness == "back" && v.rounded)
}

impl Phonotactics {
    /// Draws the syllables of a language with this inventory.
    pub fn draw(kit: &Kit, d: &mut Draw, consonants: &[Phoneme], vowels: &[Phoneme]) -> Self {
        let sy = &kit.syllables;
        let c = d
            .pick_by(&sy.complexity, |c| u64::from(weight(c.weight)))
            .unwrap();
        let class = &sy.complexity[c];
        let keep_share = d.range(600, 1000);
        let mut kept: Vec<&str> = Vec::new();
        for id in &class.forms {
            if id == "V" || id == "CV" || d.chance(keep_share) {
                kept.push(id);
            }
        }
        let m = d
            .pick_by(&sy.sonority.min_distance, |m| u64::from(weight(m.weight)))
            .unwrap();
        let min_distance = 2 * sy.sonority.min_distance[m].value;
        let mut rules = Rules {
            no_homorgan_onset: false,
            no_initial_ng: false,
            no_coda_h: false,
            no_glide_same_vowel: false,
            no_vowel_hiatus: false,
        };
        let mut codas = Codas::All;
        for k in &sy.constraints {
            if !k.choices.is_empty() {
                let pick = d
                    .pick_by(&k.choices, |c| u64::from(weight(c.weight)))
                    .unwrap();
                codas = match k.choices[pick].id.as_str() {
                    "sonorants" => Codas::Sonorants,
                    "nasals" => Codas::Nasals,
                    _ => Codas::All,
                };
                continue;
            }
            let on = match k.strength {
                Some(x) => d.chance(weight(x)),
                None => true,
            };
            match k.id.as_str() {
                "noHomorganOnset" => rules.no_homorgan_onset = on,
                "noInitialNg" => rules.no_initial_ng = on,
                "noCodaH" => rules.no_coda_h = on,
                "noGlideSameVowel" => rules.no_glide_same_vowel = on,
                "noVowelHiatus" => rules.no_vowel_hiatus = on,
                // noGeminateCluster and noCodaGlide hold in every language.
                _ => {}
            }
        }
        let mut root_length = [0u32; 3];
        for r in &sy.root_length {
            root_length[r.syllables - 1] = weight(r.weight);
        }
        let shift = d.below(1000);
        if shift < WORD_LENGTH_SHORT {
            let moved = WORD_LENGTH_SHIFT.min(root_length[2]);
            root_length[2] -= moved;
            root_length[0] += moved;
        } else if shift < WORD_LENGTH_SHORT + WORD_LENGTH_LONG {
            let moved = WORD_LENGTH_SHIFT.min(root_length[0]);
            root_length[0] -= moved;
            root_length[2] += moved;
        }
        let mut p = Phonotactics {
            complexity: class.id.clone(),
            forms: Vec::new(),
            min_distance,
            rules,
            codas,
            root_length,
            vowels: vowels.iter().map(|&v| (v, frequency(s(kit, v)))).collect(),
            glides: consonants
                .iter()
                .copied()
                .filter(|&c| s(kit, c).glide())
                .collect(),
        };
        let exceptions = &sy.sonority.exceptions;
        for f in &sy.forms {
            if !kept.contains(&f.id.as_str()) {
                continue;
            }
            let onset_exempt = f.onset.as_ref().is_some_and(|o| exceptions.contains(o));
            let onsets = p.onsets(
                kit,
                consonants,
                f.onset_max,
                f.onset.as_deref(),
                onset_exempt,
            );
            let codas = p.codas_of(kit, consonants, f.coda_max, f.coda.as_deref());
            let glide_nucleus = f.nucleus.as_deref() == Some("VV");
            if onsets.is_empty() || codas.is_empty() || (glide_nucleus && p.glides.is_empty()) {
                continue;
            }
            p.forms.push(Form {
                id: f.id.clone(),
                weight: weight(f.weight),
                glide_nucleus,
                onset_set: onsets.iter().map(|(o, _)| o.clone()).collect(),
                coda_set: codas.iter().map(|(c, _)| c.clone()).collect(),
                onsets,
                codas,
            });
        }
        p
    }

    // A rise (onset) or a fall (coda) of at least the distance.
    fn rises(&self, kit: &Kit, a: Phoneme, b: Phoneme) -> bool {
        s(kit, b).sonority >= s(kit, a).sonority + self.min_distance
    }

    fn onset_pair_ok(&self, kit: &Kit, a: Phoneme, b: Phoneme, exempt: bool) -> bool {
        if a == b {
            return false;
        }
        if exempt {
            return true;
        }
        let (sa, sb) = (s(kit, a), s(kit, b));
        let homorgan =
            sa.place == sb.place && !(sa.manner == "stop" && sb.liquid() && sa.place == "alveolar");
        self.rises(kit, a, b) && !(self.rules.no_homorgan_onset && homorgan)
    }

    // Every onset of `len` consonants the form allows, with its weight.
    fn onsets(
        &self,
        kit: &Kit,
        cs: &[Phoneme],
        len: usize,
        spec: Option<&str>,
        exempt: bool,
    ) -> Vec<(Vec<Phoneme>, u64)> {
        let w = |p: Phoneme| frequency(s(kit, p));
        let mut out = Vec::new();
        match (len, spec) {
            (0, _) => out.push((vec![], 1)),
            (1, _) => out.extend(cs.iter().map(|&c| (vec![c], w(c)))),
            (2, Some("sP")) | (3, Some("sPL")) => {
                let Some(sp) = cs.iter().copied().find(|&c| s(kit, c).id == "s") else {
                    return out;
                };
                for &p in cs.iter().filter(|&&c| s(kit, c).manner == "stop") {
                    if len == 2 {
                        out.push((vec![sp, p], w(sp) * w(p)));
                        continue;
                    }
                    for &l in cs
                        .iter()
                        .filter(|&&c| s(kit, c).liquid() || s(kit, c).glide())
                    {
                        if self.onset_pair_ok(kit, p, l, false) {
                            out.push((vec![sp, p, l], w(sp) * w(p) * w(l)));
                        }
                    }
                }
            }
            (2, spec) => {
                for &a in cs {
                    for &b in cs {
                        let fits = match spec {
                            Some("CG") => s(kit, b).glide(),
                            Some("OL") => s(kit, a).obstruent() && s(kit, b).liquid(),
                            _ => true,
                        };
                        if fits && self.onset_pair_ok(kit, a, b, exempt) {
                            out.push((vec![a, b], w(a) * w(b)));
                        }
                    }
                }
            }
            _ => {}
        }
        out
    }

    /// True when a consonant may end a syllable in this language.
    pub fn coda_ok(&self, kit: &Kit, p: Phoneme) -> bool {
        let c = s(kit, p);
        if c.glide() || (self.rules.no_coda_h && (c.id == "h" || c.id == "ʔ")) {
            return false;
        }
        match self.codas {
            Codas::All => true,
            Codas::Sonorants => !c.obstruent(),
            Codas::Nasals => c.manner == "nasal",
        }
    }

    // Every coda of `len` consonants the form allows, with its weight.
    fn codas_of(
        &self,
        kit: &Kit,
        cs: &[Phoneme],
        len: usize,
        spec: Option<&str>,
    ) -> Vec<(Vec<Phoneme>, u64)> {
        let w = |p: Phoneme| frequency(s(kit, p));
        let allowed: Vec<Phoneme> = cs
            .iter()
            .copied()
            .filter(|&c| self.coda_ok(kit, c))
            .filter(|&c| spec != Some("N") || s(kit, c).manner == "nasal")
            .collect();
        let mut out: Vec<(Vec<Phoneme>, u64)> = vec![(vec![], 1)];
        for _ in 0..len {
            let mut next = Vec::new();
            for (coda, cw) in &out {
                for &c in &allowed {
                    if let Some(&last) = coda.last()
                        && (last == c || !self.rises(kit, c, last))
                    {
                        continue;
                    }
                    let mut longer = coda.clone();
                    longer.push(c);
                    next.push((longer, cw * w(c)));
                }
            }
            out = next;
        }
        out
    }

    fn vowel(&self, kit: &Kit, p: Phoneme) -> bool {
        s(kit, p).vowel
    }

    /// True when the word can be split into syllables of the language's
    /// forms and keeps its other rules: a nucleus in each syllable, no ŋ
    /// at the start (if the language has the rule), no two vowels next to
    /// each other (if it has the rule), no j before i or w before u (if it
    /// has the rule).
    pub fn pronounceable(&self, kit: &Kit, word: &[Phoneme]) -> bool {
        if word.is_empty() || !word.iter().any(|&p| self.vowel(kit, p)) {
            return false;
        }
        if self.rules.no_initial_ng && s(kit, word[0]).id == "ŋ" {
            return false;
        }
        for pair in word.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if self.rules.no_vowel_hiatus && self.vowel(kit, a) && self.vowel(kit, b) {
                return false;
            }
            if self.rules.no_glide_same_vowel
                && s(kit, a).glide()
                && self.vowel(kit, b)
                && glide_same_vowel(kit, a, b)
            {
                return false;
            }
        }
        self.reached(kit, word)[word.len()]
    }

    /// The most sounds from the word's start that are whole syllables of
    /// the language's forms (the other rules of `pronounceable` not
    /// tested): where a word stops fitting (a loan, language/loan.rs).
    pub fn reach(&self, kit: &Kit, word: &[Phoneme]) -> usize {
        let reach = self.reached(kit, word);
        (0..reach.len()).rev().find(|&k| reach[k]).unwrap_or(0)
    }

    // reach[k]: the first k sounds are whole syllables.
    fn reached(&self, kit: &Kit, word: &[Phoneme]) -> Vec<bool> {
        let n = word.len();
        let mut reach = vec![false; n + 1];
        reach[0] = true;
        for pos in 0..n {
            if !reach[pos] {
                continue;
            }
            for f in &self.forms {
                if let Some(end) = self.syllable_at(kit, f, word, pos) {
                    reach[end] = true;
                }
            }
        }
        reach
    }

    // The end of a syllable of form f from pos, if one fits there.
    fn syllable_at(&self, kit: &Kit, f: &Form, word: &[Phoneme], pos: usize) -> Option<usize> {
        let onset_len = f.onsets.first().map_or(0, |(o, _)| o.len());
        let coda_len = f.codas.first().map_or(0, |(c, _)| c.len());
        let mut at = pos + onset_len;
        if at > word.len() || !f.onset_set.contains(&word[pos..at]) {
            return None;
        }
        if at >= word.len() || !self.vowel(kit, word[at]) {
            return None;
        }
        at += 1;
        if f.glide_nucleus {
            if at >= word.len()
                || !s(kit, word[at]).glide()
                || glide_same_vowel(kit, word[at], word[at - 1])
            {
                return None;
            }
            at += 1;
        }
        let end = at + coda_len;
        if end > word.len() || !f.coda_set.contains(&word[at..end]) {
            return None;
        }
        Some(end)
    }

    /// A root of the language: its syllables drawn by the forms' weights,
    /// and its length by `root_length` (or `syllables` when given). It
    /// holds as a word (`change::holds`: two sounds or more, TEG-146), a
    /// root of one syllable begins with a consonant ("marsh = a" before),
    /// and it has no two like syllables side by side (`echoes`).
    pub fn root(&self, kit: &Kit, d: &mut Draw, syllables: Option<usize>) -> Vec<Phoneme> {
        let n =
            syllables.unwrap_or_else(|| 1 + d.pick(&self.root_length.map(u64::from)).unwrap_or(1));
        for _ in 0..64 {
            let mut word: Vec<Phoneme> = Vec::new();
            for _ in 0..n {
                let syl = self.syllable(kit, d, &word);
                word.extend(syl);
            }
            let onset = word.first().is_some_and(|&p| !self.vowel(kit, p));
            if self.pronounceable(kit, &word) && holds(&word) && (n > 1 || onset) && !echoes(&word)
            {
                return word;
            }
        }
        // Not reached with the kit's forms: CV is always there.
        let f = self
            .forms
            .iter()
            .find(|f| f.id == "CV")
            .unwrap_or(&self.forms[0]);
        let mut word = f.onsets[0].0.clone();
        word.push(self.vowels[0].0);
        word
    }

    // A syllable after `word` (the root so far).
    fn syllable(&self, kit: &Kit, d: &mut Draw, word: &[Phoneme]) -> Vec<Phoneme> {
        let first = word.is_empty();
        let after_vowel = word.last().is_some_and(|&p| self.vowel(kit, p));
        // A consonant the root has already weighs less (REPEAT_DAMP).
        let damped = |part: &[Phoneme], w: u64| {
            if part.iter().any(|p| word.contains(p)) {
                (w / REPEAT_DAMP).max(1)
            } else {
                w
            }
        };
        for _ in 0..32 {
            let k = d.pick_by(&self.forms, |f| u64::from(f.weight)).unwrap();
            let f = &self.forms[k];
            let o = d.pick_by(&f.onsets, |o| damped(&o.0, o.1)).unwrap();
            let onset = &f.onsets[o].0;
            if onset.is_empty() && after_vowel && self.rules.no_vowel_hiatus {
                continue;
            }
            if first
                && self.rules.no_initial_ng
                && onset.first().is_some_and(|&p| s(kit, p).id == "ŋ")
            {
                continue;
            }
            let v = self.vowels[d.pick_by(&self.vowels, |v| v.1).unwrap()].0;
            if self.rules.no_glide_same_vowel
                && onset
                    .last()
                    .is_some_and(|&g| s(kit, g).glide() && glide_same_vowel(kit, g, v))
            {
                continue;
            }
            let mut syl = onset.clone();
            syl.push(v);
            if f.glide_nucleus {
                let glides: Vec<Phoneme> = self
                    .glides
                    .iter()
                    .copied()
                    .filter(|&g| !glide_same_vowel(kit, g, v))
                    .collect();
                if glides.is_empty() || s(kit, v).long {
                    continue;
                }
                syl.push(glides[d.below(glides.len() as u32) as usize]);
            }
            let c = d.pick_by(&f.codas, |c| damped(&c.0, c.1)).unwrap();
            syl.extend_from_slice(&f.codas[c].0);
            return syl;
        }
        // The fallback: the commonest CV.
        let cv = self
            .forms
            .iter()
            .find(|f| f.id == "CV")
            .unwrap_or(&self.forms[0]);
        let mut syl = cv.onsets[0].0.clone();
        syl.push(self.vowels[0].0);
        syl
    }
}

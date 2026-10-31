//! The spelling of a language (`spelling.json`): a style, the letters of
//! each sound with the collisions resolved, and the letters of a word.

use super::Phoneme;
use super::kit::{Kit, Sound, Style};

/// A language's spelling: its style and the letters of every sound of the
/// table (also of the sounds it does not have: a sound change can make
/// them).
#[derive(Debug, Clone)]
pub struct Spelling {
    pub style: usize,
    letters: Vec<String>,
}

const MACRON: [(char, char); 6] = [
    ('a', 'ā'),
    ('e', 'ē'),
    ('i', 'ī'),
    ('o', 'ō'),
    ('u', 'ū'),
    ('y', 'ȳ'),
];
const ACUTE: [(char, char); 9] = [
    ('a', 'á'),
    ('e', 'é'),
    ('i', 'í'),
    ('o', 'ó'),
    ('u', 'ú'),
    ('y', 'ý'),
    ('ö', 'ő'),
    ('ü', 'ű'),
    ('ø', 'ǿ'),
];
const CIRCUMFLEX: [(char, char); 6] = [
    ('a', 'â'),
    ('e', 'ê'),
    ('i', 'î'),
    ('o', 'ô'),
    ('u', 'û'),
    ('y', 'ŷ'),
];
const TILDE: [(char, char); 6] = [
    ('a', 'ã'),
    ('e', 'ẽ'),
    ('i', 'ĩ'),
    ('o', 'õ'),
    ('u', 'ũ'),
    ('y', 'ỹ'),
];

// The letters with the last letter marked by the table, or None when the
// table has no mark for it.
fn mark(letters: &str, table: &[(char, char)]) -> Option<String> {
    let mut chars: Vec<char> = letters.chars().collect();
    let last = chars.last_mut()?;
    let (_, marked) = table.iter().find(|(c, _)| c == last)?;
    *last = *marked;
    Some(chars.into_iter().collect())
}

fn ascii(text: &str) -> bool {
    text.chars().all(|c| c.is_ascii_lowercase() || c == '\'')
}

// The short oral vowel of the same quality as a long or a nasal vowel.
fn quality_of(kit: &Kit, s: &Sound) -> Option<usize> {
    kit.sounds.iter().position(|t| {
        t.vowel
            && !t.long
            && !t.nasal
            && t.height == s.height
            && t.backness == s.backness
            && t.rounded == s.rounded
    })
}

impl Spelling {
    /// The spelling in style `style` for an inventory.
    pub fn new(kit: &Kit, style: usize, inventory: &[Phoneme]) -> Spelling {
        let st = &kit.spelling.styles[style];
        let allowed = |t: &str| st.diacritics || ascii(t);
        // The base letters: the style's map, else `roman`.
        let mut letters: Vec<String> = kit
            .sounds
            .iter()
            .map(|s| {
                st.map
                    .get(&s.id)
                    .cloned()
                    .unwrap_or_else(|| s.roman.clone())
            })
            .collect();
        let derived = |s: &Sound| (s.long || s.nasal) && s.vowel;
        // The collisions among the sounds of the inventory that are not
        // derived: the rarer sound takes its `alt`, if that is allowed and
        // free.
        let resolve = |letters: &mut Vec<String>, only: &dyn Fn(&Sound) -> bool| {
            let mut members: Vec<usize> = inventory
                .iter()
                .map(|p| p.0 as usize)
                .filter(|&k| only(&kit.sounds[k]))
                .collect();
            // The commonest first: it keeps its letters.
            members.sort_by(|&a, &b| {
                kit.sounds[b]
                    .weight
                    .cmp(&kit.sounds[a].weight)
                    .then(a.cmp(&b))
            });
            for (n, &k) in members.iter().enumerate() {
                let taken =
                    |t: &str, letters: &Vec<String>| members[..n].iter().any(|&j| letters[j] == t);
                if !taken(&letters[k], letters) {
                    continue;
                }
                let s = &kit.sounds[k];
                if let Some(alt) = &s.alt
                    && allowed(alt)
                    && !taken(alt, letters)
                    && !st.map.contains_key(&s.id)
                {
                    letters[k] = alt.clone();
                }
            }
        };
        resolve(&mut letters, &|s| !derived(s));
        // The long and the nasal vowels from their quality's letters.
        for (k, s) in kit.sounds.iter().enumerate() {
            if !derived(s) || st.map.contains_key(&s.id) {
                continue;
            }
            let Some(q) = quality_of(kit, s) else {
                continue;
            };
            let base = letters[q].clone();
            letters[k] = if s.long {
                long_vowel(st, &base)
            } else {
                match st.nasal_vowel.as_str() {
                    "tilde" => mark(&base, &TILDE).unwrap_or_else(|| format!("{base}n")),
                    _ => format!("{base}n"),
                }
            };
        }
        Spelling { style, letters }
    }

    /// The style's id.
    pub fn style_id(&self, kit: &Kit) -> String {
        kit.spelling.styles[self.style].id.clone()
    }

    /// The letters of a word, in small letters. A sound's letters follow
    /// its neighbours where the style says so (`context`); two equal
    /// consonants are written by the style's `geminate`: "double" writes
    /// the first letter of the second's letters for the first (tt, ssh),
    /// "single" writes the second only.
    pub fn spell(&self, kit: &Kit, word: &[Phoneme]) -> String {
        let st = &kit.spelling.styles[self.style];
        let mut out = String::new();
        for (i, &p) in word.iter().enumerate() {
            let consonant = !kit.sounds[p.0 as usize].vowel;
            if consonant && word.get(i + 1) == Some(&p) {
                if st.geminate != "single" {
                    out.extend(self.spell_one(kit, word, i + 1).chars().next());
                }
                continue;
            }
            out.push_str(&self.spell_one(kit, word, i));
        }
        out
    }

    // The letters of the sound at i, by its neighbours.
    fn spell_one(&self, kit: &Kit, word: &[Phoneme], i: usize) -> String {
        let st = &kit.spelling.styles[self.style];
        let p = word[i];
        let s = &kit.sounds[p.0 as usize];
        let before = word.get(i + 1).map(|q| &kit.sounds[q.0 as usize]);
        let after = i.checked_sub(1).map(|j| &kit.sounds[word[j].0 as usize]);
        for rule in &st.context {
            if rule.sound == s.id
                && rule.before.as_deref().is_none_or(|c| fits(c, before))
                && rule.after.as_deref().is_none_or(|c| fits(c, after))
            {
                return rule.letters.clone();
            }
        }
        self.letters[p.0 as usize].clone()
    }
}

fn long_vowel(st: &Style, base: &str) -> String {
    let marked = match st.long_vowel.as_str() {
        "macron" => mark(base, &MACRON),
        "acute" => mark(base, &ACUTE),
        "circumflex" => mark(base, &CIRCUMFLEX),
        "h" => return format!("{base}h"),
        "single" => return base.to_string(),
        _ => None,
    };
    // "double", and a mark the letter has no form for: the last letter twice.
    marked.unwrap_or_else(|| {
        let last = base.chars().last().unwrap_or_default();
        format!("{base}{last}")
    })
}

// A context of spelling.json: V, C, frontV, backV, or # (a word edge).
fn fits(context: &str, sound: Option<&Sound>) -> bool {
    match (context, sound) {
        ("#", None) => true,
        ("V", Some(s)) => s.vowel,
        ("C", Some(s)) => !s.vowel,
        ("frontV", Some(s)) => s.vowel && s.backness == "front",
        ("backV", Some(s)) => s.vowel && s.backness != "front",
        _ => false,
    }
}

/// The name's capitals: the first letter of each word.
pub fn capitalise(text: &str) -> String {
    text.split(' ')
        .map(|w| {
            let mut out = String::new();
            let mut done = false;
            for c in w.chars() {
                if !done && c.is_alphabetic() {
                    out.extend(c.to_uppercase());
                    done = true;
                } else {
                    out.push(c);
                }
            }
            out
        })
        .collect::<Vec<_>>()
        .join(" ")
}

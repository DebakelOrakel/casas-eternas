//! The hand-made kit (`data/language/`, its README.md), read once. The
//! weights of the kit are decimals; this module makes them integers
//! (`weight`), so that every draw after it uses integers only.

use super::Phoneme;
use super::notation::{Unit, parse_units};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// A weight of the kit as an integer: the decimal times 1 000, rounded.
/// The product and the rounding are exact IEEE operations, so the native
/// and the WASM builds get the same integer.
pub fn weight(x: f64) -> u32 {
    (x * 1000.0).round() as u32
}

/// One sound of `sounds.json`. A consonant has `place` and `manner`; a
/// vowel has `height` and `backness`, and its `manner` is "vowel".
#[derive(Debug, Clone)]
pub struct Sound {
    pub id: String,
    pub vowel: bool,
    pub manner: String,
    pub place: String,
    pub height: String,
    pub backness: String,
    pub voice: bool,
    pub series: Option<String>,
    pub lateral: bool,
    pub rounded: bool,
    pub long: bool,
    pub nasal: bool,
    pub weight: u32,
    pub roman: String,
    pub alt: Option<String>,
    /// Two times the sonority of `sounds.json`, plus 1 for a voiced
    /// obstruent (the "+0.5" of syllables.json).
    pub sonority: u32,
}

impl Sound {
    /// True for a stop, an affricate or a fricative.
    pub fn obstruent(&self) -> bool {
        matches!(self.manner.as_str(), "stop" | "affricate" | "fricative")
    }
    /// True for l, ʎ, ɾ, r, ɹ (the class L of changes.json).
    pub fn liquid(&self) -> bool {
        matches!(self.id.as_str(), "l" | "ʎ" | "ɾ" | "r" | "ɹ")
    }
    /// True for j and w (the class G).
    pub fn glide(&self) -> bool {
        matches!(self.id.as_str(), "j" | "w")
    }
}

#[derive(Deserialize)]
struct RawSound {
    id: String,
    #[serde(default)]
    place: String,
    #[serde(default)]
    manner: String,
    #[serde(default)]
    height: String,
    #[serde(default)]
    backness: String,
    #[serde(default)]
    voice: bool,
    series: Option<String>,
    #[serde(default)]
    lateral: bool,
    #[serde(default)]
    rounded: bool,
    #[serde(default)]
    long: bool,
    #[serde(default)]
    nasal: bool,
    weight: f64,
    roman: String,
    alt: Option<String>,
}

#[derive(Deserialize)]
struct RawSounds {
    sonority: BTreeMap<String, u32>,
    consonants: Vec<RawSound>,
    vowels: Vec<RawSound>,
}

/// A class of a count (inventories.json `consonantCount`, `vowelCount`).
#[derive(Deserialize, Debug)]
pub struct CountClass {
    pub id: String,
    pub min: u32,
    pub max: u32,
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
pub struct Weighted {
    pub id: String,
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
pub struct Series {
    pub id: String,
    pub weight: f64,
    pub adds: String,
}

#[derive(Deserialize, Debug)]
pub struct Always {
    pub consonants: Vec<Vec<String>>,
    pub vowels: Vec<Vec<String>>,
}

#[derive(Deserialize, Debug)]
pub struct Implication {
    #[serde(rename = "if")]
    pub if_: String,
    pub needs: Vec<String>,
    pub strength: f64,
}

#[derive(Deserialize, Debug)]
pub struct Gap {
    pub id: String,
    pub removes: String,
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Inventories {
    pub consonant_count: Vec<CountClass>,
    pub vowel_count: Vec<CountClass>,
    pub series: Vec<Series>,
    pub always: Always,
    pub implications: Vec<Implication>,
    pub gaps: Vec<Gap>,
    pub liquids: Vec<Weighted>,
    pub stress: Vec<Weighted>,
}

#[derive(Deserialize, Debug)]
pub struct Complexity {
    pub id: String,
    pub weight: f64,
    pub forms: Vec<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    pub id: String,
    pub weight: f64,
    pub onset_max: usize,
    pub coda_max: usize,
    pub onset: Option<String>,
    pub coda: Option<String>,
    pub nucleus: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct Distance {
    pub id: String,
    pub weight: f64,
    pub value: u32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sonority {
    pub min_distance: Vec<Distance>,
    pub exceptions: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct Constraint {
    pub id: String,
    pub strength: Option<f64>,
    #[serde(default)]
    pub choices: Vec<Weighted>,
}

#[derive(Deserialize, Debug)]
pub struct RootLength {
    pub syllables: usize,
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Syllables {
    pub complexity: Vec<Complexity>,
    pub forms: Vec<Form>,
    pub sonority: Sonority,
    pub constraints: Vec<Constraint>,
    pub root_length: Vec<RootLength>,
}

#[derive(Deserialize, Debug)]
pub struct ChangeTemplate {
    pub id: String,
    pub family: String,
    pub rule: String,
    #[serde(default)]
    pub requires: Vec<String>,
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
pub struct Notation {
    pub classes: BTreeMap<String, String>,
}

#[derive(Deserialize, Debug)]
pub struct Changes {
    pub notation: Notation,
    pub changes: Vec<ChangeTemplate>,
}

#[derive(Deserialize, Debug)]
pub struct Meaning {
    pub id: String,
    pub cat: String,
    pub pos: String,
    pub core: bool,
    pub head: Vec<String>,
    pub modifier: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct Meanings {
    pub kinds: Vec<String>,
    pub meanings: Vec<Meaning>,
}

#[derive(Deserialize, Debug)]
pub struct ContextRule {
    pub sound: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub letters: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub id: String,
    pub weight: f64,
    pub diacritics: bool,
    pub long_vowel: String,
    pub nasal_vowel: String,
    pub geminate: String,
    pub map: BTreeMap<String, String>,
    pub context: Vec<ContextRule>,
}

#[derive(Deserialize, Debug)]
pub struct Spelling {
    pub styles: Vec<Style>,
}

#[derive(Deserialize, Debug)]
pub struct Joiner {
    pub id: String,
    pub weight: f64,
    pub form: String,
}

#[derive(Deserialize, Debug)]
pub struct Endings {
    pub chance: BTreeMap<String, f64>,
    pub form: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct Article {
    pub weight: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Grammar {
    pub adj_order: Vec<Weighted>,
    pub gen_order: Vec<Weighted>,
    pub compounding: Vec<Weighted>,
    pub joiners: Vec<Joiner>,
    pub endings: Endings,
    pub article_with_kind: Article,
}

#[derive(Deserialize, Debug)]
pub struct Pattern {
    pub id: String,
    pub form: String,
    pub weight: f64,
    pub head: Option<Vec<String>>,
    pub a: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
pub struct Patterns {
    pub grammar: Grammar,
    pub patterns: BTreeMap<String, Vec<Pattern>>,
}

/// The kit: the sounds as one table (the consonants, then the vowels; a
/// `Phoneme` is an index into it), and the other files as they are.
pub struct Kit {
    pub sounds: Vec<Sound>,
    by_id: BTreeMap<String, Phoneme>,
    pub inventories: Inventories,
    pub syllables: Syllables,
    pub changes: Changes,
    pub meanings: Meanings,
    pub spelling: Spelling,
    pub patterns: Patterns,
}

impl Kit {
    /// The sound with this IPA id, if the table has it.
    pub fn sound(&self, id: &str) -> Option<Phoneme> {
        self.by_id.get(id).copied()
    }

    /// The ids of the sounds, the longest first (the parser of the
    /// notation reads the longest id that fits).
    pub fn ids_longest_first(&self) -> Vec<(&str, Phoneme)> {
        let mut ids: Vec<(&str, Phoneme)> =
            self.by_id.iter().map(|(k, &v)| (k.as_str(), v)).collect();
        ids.sort_by(|a, b| {
            b.0.chars()
                .count()
                .cmp(&a.0.chars().count())
                .then(a.0.cmp(b.0))
        });
        ids
    }

    /// A class or sound of the notation (`[stop +voice]`, `F`, `h`) as units.
    pub fn units(&self, text: &str) -> Vec<Unit> {
        parse_units(self, text).unwrap_or_else(|e| panic!("kit notation '{text}': {e}"))
    }
}

fn read<T: for<'a> Deserialize<'a>>(name: &str, text: &str) -> T {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("data/language/{name}: {e}"))
}

/// The kit, read once.
pub fn kit() -> &'static Kit {
    static KIT: OnceLock<Kit> = OnceLock::new();
    KIT.get_or_init(|| {
        let raw: RawSounds = read(
            "sounds.json",
            include_str!("../../data/language/sounds.json"),
        );
        let mut sounds = Vec::new();
        for (vowel, list) in [(false, raw.consonants), (true, raw.vowels)] {
            for s in list {
                let manner = if vowel { "vowel".to_string() } else { s.manner };
                let base = *raw
                    .sonority
                    .get(&manner)
                    .unwrap_or_else(|| panic!("sounds.json: no sonority for {manner}"));
                let obstruent = matches!(manner.as_str(), "stop" | "affricate" | "fricative");
                sounds.push(Sound {
                    id: s.id,
                    vowel,
                    sonority: 2 * base + u32::from(obstruent && s.voice),
                    manner,
                    place: s.place,
                    height: s.height,
                    backness: s.backness,
                    voice: s.voice || vowel,
                    series: s.series,
                    lateral: s.lateral,
                    rounded: s.rounded,
                    long: s.long,
                    nasal: s.nasal,
                    weight: weight(s.weight),
                    roman: s.roman,
                    alt: s.alt,
                });
            }
        }
        assert!(sounds.len() < 256, "a Phoneme is a u8");
        let by_id = sounds
            .iter()
            .enumerate()
            .map(|(k, s)| (s.id.clone(), Phoneme(k as u8)))
            .collect();
        Kit {
            sounds,
            by_id,
            inventories: read(
                "inventories.json",
                include_str!("../../data/language/inventories.json"),
            ),
            syllables: read(
                "syllables.json",
                include_str!("../../data/language/syllables.json"),
            ),
            changes: read(
                "changes.json",
                include_str!("../../data/language/changes.json"),
            ),
            meanings: read(
                "meanings.json",
                include_str!("../../data/language/meanings.json"),
            ),
            spelling: read(
                "spelling.json",
                include_str!("../../data/language/spelling.json"),
            ),
            patterns: read(
                "patterns.json",
                include_str!("../../data/language/patterns.json"),
            ),
        }
    })
}

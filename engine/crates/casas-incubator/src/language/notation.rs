//! The notation of `changes.json` ("notation"): the units of a rule, how
//! they match a word, and the feature replacement. The inventories
//! (`series`, `implications`) and the `requires` of a change use it too.
//!
//! A word is matched as a list of sounds with the index of its stressed
//! sound. The matcher goes forward (right of the target) or back (left of
//! the target), and gives every way a unit can match, so that `…`, `C₀`
//! and `(X)` can take back what they took.

use super::Phoneme;
use super::kit::{Kit, Sound};

/// A feature value: a field's text value or a boolean.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Val {
    Text(String),
    Bool(bool),
}

/// The value after `=` in `place=α` or `place=velar`.
#[derive(Debug, Clone)]
pub enum KeyVal {
    Alpha(char),
    Literal(String),
}

/// One term of a feature class.
#[derive(Debug, Clone)]
pub enum Term {
    /// A bare value: `stop`, `velar`, `front` …; `field` is the field it
    /// is a value of.
    Value { field: &'static str, value: String },
    /// `-value`: not this value (`[palatal -approximant]`).
    NotValue { field: &'static str, value: String },
    /// `+name` or `-name`.
    Bool { name: String, on: bool },
    /// `field=α` or `field=value`.
    Key { field: String, value: KeyVal },
}

/// Vowels, consonants or both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Any,
    Vowel,
    Consonant,
}

/// A feature class `[...]`.
#[derive(Debug, Clone)]
pub struct Class {
    pub kind: Kind,
    pub terms: Vec<Term>,
}

/// A unit of a rule.
#[derive(Debug, Clone)]
pub enum Unit {
    Sound(Phoneme),
    Class(Class),
    /// `{a,b}`: each member a sequence.
    Set(Vec<Vec<Unit>>),
    /// `#`: a word edge.
    Edge,
    /// `∅`: nothing.
    Zero,
    /// `…`: any material.
    Any,
    /// `(X)`: X or nothing.
    Optional(Vec<Unit>),
    /// `X₀`: zero or more X.
    Star(Box<Unit>),
    /// `X₁`: X, bound by its number.
    Indexed(Box<Unit>, u8),
    /// `X[...]`: X, only where it also has these features.
    Restrict(Box<Unit>, Class),
}

/// The values a match binds: α and β, and the numbered units.
#[derive(Debug, Clone, Default)]
pub struct Bindings {
    pub alpha: Vec<(char, Val)>,
    pub index: [Option<Phoneme>; 10],
}

impl Bindings {
    pub fn alpha(&self, c: char) -> Option<&Val> {
        self.alpha.iter().find(|(k, _)| *k == c).map(|(_, v)| v)
    }
}

/// Matching goes forward (to the right) or back (to the left).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Forward,
    Back,
}

/// A word to match: its sounds and the index of its stressed sound.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub sounds: &'a [Phoneme],
    pub stress: Option<usize>,
}

// ---------------------------------------------------------------- fields

const TEXT_FIELDS: [&str; 4] = ["manner", "place", "height", "backness"];
const SERIES: [&str; 3] = ["aspirated", "ejective", "labialised"];
const BOOLS: [&str; 9] = [
    "voice",
    "lateral",
    "long",
    "nasal",
    "rounded",
    "aspirated",
    "ejective",
    "labialised",
    "stress",
];

fn text_field<'a>(s: &'a Sound, field: &str) -> &'a str {
    match field {
        "manner" => &s.manner,
        "place" => &s.place,
        "height" => &s.height,
        _ => &s.backness,
    }
}

// A boolean field of a sound. `nasal` is true for a nasal consonant too.
fn bool_field(s: &Sound, name: &str) -> bool {
    match name {
        "voice" => s.voice,
        "lateral" => s.lateral,
        "long" => s.long,
        "nasal" => s.nasal || s.manner == "nasal",
        "rounded" => s.rounded,
        _ => s.series.as_deref() == Some(name),
    }
}

fn value_of(s: &Sound, field: &str) -> Val {
    if TEXT_FIELDS.contains(&field) {
        Val::Text(text_field(s, field).to_string())
    } else {
        Val::Bool(bool_field(s, field))
    }
}

// The field a bare value belongs to, by the values of the table.
fn field_of(kit: &Kit, value: &str) -> Option<&'static str> {
    TEXT_FIELDS
        .into_iter()
        .find(|&f| kit.sounds.iter().any(|s| text_field(s, f) == value))
}

// ---------------------------------------------------------------- parser

struct Parser<'a> {
    kit: &'a Kit,
    chars: Vec<char>,
    at: usize,
    ids: Vec<(Vec<char>, Phoneme)>,
}

/// The units of a text in the notation (`{t j,d j}`, `[stop -voice] l`,
/// `VC`), with each top-level unit's own text.
pub fn parse_with_text(kit: &Kit, text: &str) -> Result<Vec<(Unit, String)>, String> {
    let mut p = Parser {
        kit,
        chars: text.trim().chars().collect(),
        at: 0,
        ids: kit
            .ids_longest_first()
            .into_iter()
            .map(|(id, ph)| (id.chars().collect(), ph))
            .collect(),
    };
    let units = p.sequence(&[])?;
    if p.at < p.chars.len() {
        return Err(format!("unexpected '{}'", p.chars[p.at]));
    }
    Ok(units)
}

/// The units of a text in the notation.
pub fn parse_units(kit: &Kit, text: &str) -> Result<Vec<Unit>, String> {
    Ok(parse_with_text(kit, text)?
        .into_iter()
        .map(|(u, _)| u)
        .collect())
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    // Units up to the end or to one of `stop` (not taken).
    fn sequence(&mut self, stop: &[char]) -> Result<Vec<(Unit, String)>, String> {
        let mut out = Vec::new();
        loop {
            while self.peek() == Some(' ') {
                self.at += 1;
            }
            match self.peek() {
                None => break,
                Some(c) if stop.contains(&c) => break,
                _ => {}
            }
            let start = self.at;
            let unit = self.unit()?;
            let text: String = self.chars[start..self.at].iter().collect();
            out.push((unit, text));
        }
        Ok(out)
    }

    fn unit(&mut self) -> Result<Unit, String> {
        let c = self.peek().ok_or("a unit is missing")?;
        let mut unit = match c {
            '[' => match self.class()? {
                (class, None) => Unit::Class(class),
                // `[O +voice]`: the class letter, with these features.
                (class, Some(letter)) => Unit::Restrict(Box::new(self.letter(letter)?), class),
            },
            '{' => {
                self.at += 1;
                let mut members = Vec::new();
                loop {
                    let member = self.sequence(&[',', '}'])?;
                    members.push(member.into_iter().map(|(u, _)| u).collect());
                    match self.peek() {
                        Some(',') => self.at += 1,
                        Some('}') => {
                            self.at += 1;
                            break;
                        }
                        _ => return Err("a set is not closed".into()),
                    }
                }
                Unit::Set(members)
            }
            '(' => {
                self.at += 1;
                let inner = self.sequence(&[')'])?;
                if self.peek() != Some(')') {
                    return Err("'(' is not closed".into());
                }
                self.at += 1;
                Unit::Optional(inner.into_iter().map(|(u, _)| u).collect())
            }
            '#' => {
                self.at += 1;
                Unit::Edge
            }
            '∅' => {
                self.at += 1;
                Unit::Zero
            }
            '…' => {
                self.at += 1;
                Unit::Any
            }
            c if c.is_ascii_uppercase() => {
                self.at += 1;
                self.letter(c)?
            }
            _ => {
                let rest = &self.chars[self.at..];
                let (len, ph) = self
                    .ids
                    .iter()
                    .find(|(id, _)| rest.starts_with(id))
                    .map(|(id, ph)| (id.len(), *ph))
                    .ok_or_else(|| format!("no sound at '{}'", rest.iter().collect::<String>()))?;
                self.at += len;
                Unit::Sound(ph)
            }
        };
        // The postfixes: ₀, ₁…₉, and [...] right after the unit.
        loop {
            match self.peek() {
                Some('₀') => {
                    self.at += 1;
                    unit = Unit::Star(Box::new(unit));
                }
                Some(c @ '₁'..='₉') => {
                    self.at += 1;
                    unit = Unit::Indexed(Box::new(unit), (c as u32 - '₀' as u32) as u8);
                }
                Some('[') => match self.class()? {
                    (class, None) => unit = Unit::Restrict(Box::new(unit), class),
                    (_, Some(l)) => return Err(format!("a class letter {l} in a restriction")),
                },
                _ => break,
            }
        }
        Ok(unit)
    }

    // A class letter (`notation.classes`) as its unit.
    fn letter(&self, c: char) -> Result<Unit, String> {
        let def = self
            .kit
            .changes
            .notation
            .classes
            .get(&c.to_string())
            .ok_or_else(|| format!("no class letter {c}"))?;
        // A definition with commas at the top is a set.
        let text = if def.starts_with('{') || !def.contains(',') {
            def.clone()
        } else {
            format!("{{{def}}}")
        };
        let mut units = parse_units(self.kit, &text)?;
        if units.len() != 1 {
            return Err(format!("class {c} is not one unit"));
        }
        Ok(units.remove(0))
    }

    // A feature class `[...]`, and the class letter in it other than V
    // and C (`[O +voice]`), if there is one.
    fn class(&mut self) -> Result<(Class, Option<char>), String> {
        self.at += 1;
        let start = self.at;
        while self.peek().is_some_and(|c| c != ']') {
            self.at += 1;
        }
        if self.peek() != Some(']') {
            return Err("'[' is not closed".into());
        }
        let body: String = self.chars[start..self.at].iter().collect();
        self.at += 1;
        let mut class = Class {
            kind: Kind::Any,
            terms: Vec::new(),
        };
        let mut letter = None;
        for token in body.split_whitespace() {
            let mut chars = token.chars();
            let single = match (chars.next(), chars.next()) {
                (Some(c), None) if c.is_ascii_uppercase() => Some(c),
                _ => None,
            };
            if token == "V" {
                class.kind = Kind::Vowel;
            } else if token == "C" {
                class.kind = Kind::Consonant;
            } else if let Some(c) = single {
                letter = Some(c);
            } else if let Some(name) = token.strip_prefix('+').or_else(|| token.strip_prefix('-')) {
                if !BOOLS.contains(&name) {
                    // `-approximant`: not this value of a field.
                    let field =
                        field_of(self.kit, name).ok_or_else(|| format!("no feature {name}"))?;
                    class.terms.push(if token.starts_with('+') {
                        Term::Value {
                            field,
                            value: name.to_string(),
                        }
                    } else {
                        Term::NotValue {
                            field,
                            value: name.to_string(),
                        }
                    });
                    continue;
                }
                class.terms.push(Term::Bool {
                    name: name.to_string(),
                    on: token.starts_with('+'),
                });
            } else if let Some((field, value)) = token.split_once('=') {
                if !TEXT_FIELDS.contains(&field) && !BOOLS.contains(&field) {
                    return Err(format!("no feature {field}"));
                }
                let mut v = value.chars();
                let value = match (v.next(), v.next()) {
                    (Some(c @ ('α' | 'β' | 'γ')), None) => KeyVal::Alpha(c),
                    _ => KeyVal::Literal(value.to_string()),
                };
                class.terms.push(Term::Key {
                    field: field.to_string(),
                    value,
                });
            } else {
                let field =
                    field_of(self.kit, token).ok_or_else(|| format!("no feature value {token}"))?;
                class.terms.push(Term::Value {
                    field,
                    value: token.to_string(),
                });
            }
        }
        Ok((class, letter))
    }
}

// ---------------------------------------------------------------- match

/// True when the sound at `at` of the word is in the class; binds α.
pub fn class_matches(kit: &Kit, class: &Class, ctx: Ctx, at: usize, b: &mut Bindings) -> bool {
    let s = &kit.sounds[ctx.sounds[at].0 as usize];
    match class.kind {
        Kind::Vowel if !s.vowel => return false,
        Kind::Consonant if s.vowel => return false,
        _ => {}
    }
    for term in &class.terms {
        let ok = match term {
            Term::Value { field, value } => text_field(s, field) == value,
            Term::NotValue { field, value } => text_field(s, field) != value,
            Term::Bool { name, on } if name == "stress" => (ctx.stress == Some(at)) == *on,
            Term::Bool { name, on } => bool_field(s, name) == *on,
            Term::Key { field, value } => {
                let have = if field == "stress" {
                    Val::Bool(ctx.stress == Some(at))
                } else {
                    value_of(s, field)
                };
                match value {
                    KeyVal::Literal(v) => match &have {
                        Val::Text(t) => t == v,
                        Val::Bool(x) => (v == "true") == *x,
                    },
                    KeyVal::Alpha(c) => match b.alpha(*c) {
                        Some(bound) => *bound == have,
                        None => {
                            b.alpha.push((*c, have));
                            true
                        }
                    },
                }
            }
        };
        if !ok {
            return false;
        }
    }
    true
}

/// True when the sound alone is in the units' first unit (for the
/// `requires` of a change and the classes of the inventories).
pub fn sound_in(kit: &Kit, units: &[Unit], p: Phoneme) -> bool {
    let word = [p];
    let ctx = Ctx {
        sounds: &word,
        stress: None,
    };
    ends(kit, units, ctx, 0, Dir::Forward, &Bindings::default())
        .iter()
        .any(|(end, _)| *end == 1)
}

/// Every way one unit matches from `pos`: the position after it, the
/// bindings, and the member of a set it took (0 for others).
pub fn options(
    kit: &Kit,
    unit: &Unit,
    ctx: Ctx,
    pos: usize,
    dir: Dir,
    b: &Bindings,
) -> Vec<(usize, Bindings, usize)> {
    let len = ctx.sounds.len();
    // The index of the next sound, if there is one.
    let next = match dir {
        Dir::Forward => (pos < len).then_some(pos),
        Dir::Back => (pos > 0).then(|| pos - 1),
    };
    let step = |p: usize| match dir {
        Dir::Forward => p + 1,
        Dir::Back => p - 1,
    };
    match unit {
        Unit::Sound(ph) => match next {
            Some(i) if ctx.sounds[i] == *ph => vec![(step(pos), b.clone(), 0)],
            _ => vec![],
        },
        Unit::Class(class) => match next {
            Some(i) => {
                let mut b2 = b.clone();
                if class_matches(kit, class, ctx, i, &mut b2) {
                    vec![(step(pos), b2, 0)]
                } else {
                    vec![]
                }
            }
            None => vec![],
        },
        Unit::Set(members) => {
            let mut out = Vec::new();
            for (k, member) in members.iter().enumerate() {
                for (end, b2) in ends(kit, member, ctx, pos, dir, b) {
                    out.push((end, b2, k));
                }
            }
            out
        }
        Unit::Edge => {
            let edge = match dir {
                Dir::Forward => pos == len,
                Dir::Back => pos == 0,
            };
            if edge {
                vec![(pos, b.clone(), 0)]
            } else {
                vec![]
            }
        }
        Unit::Zero => vec![(pos, b.clone(), 0)],
        Unit::Any => match dir {
            Dir::Forward => (pos..=len).map(|p| (p, b.clone(), 0)).collect(),
            Dir::Back => (0..=pos).rev().map(|p| (p, b.clone(), 0)).collect(),
        },
        Unit::Optional(inner) => {
            let mut out: Vec<_> = ends(kit, inner, ctx, pos, dir, b)
                .into_iter()
                .map(|(p, b2)| (p, b2, 0))
                .collect();
            out.push((pos, b.clone(), 0));
            out
        }
        Unit::Star(inner) => {
            // Zero or more: the longest first.
            let mut out = vec![(pos, b.clone(), 0)];
            let mut frontier = vec![(pos, b.clone())];
            while let Some((p, b2)) = frontier.pop() {
                for (q, b3, _) in options(kit, inner, ctx, p, dir, &b2) {
                    if q != p && !out.iter().any(|(o, _, _)| *o == q) {
                        out.push((q, b3.clone(), 0));
                        frontier.push((q, b3));
                    }
                }
            }
            out.reverse();
            out
        }
        Unit::Indexed(inner, n) => {
            let mut out = Vec::new();
            for (q, mut b2, k) in options(kit, inner, ctx, pos, dir, b) {
                let (lo, hi) = if q >= pos { (pos, q) } else { (q, pos) };
                if hi - lo != 1 {
                    continue;
                }
                let ph = ctx.sounds[lo];
                match b2.index[*n as usize] {
                    Some(bound) if bound != ph => continue,
                    Some(_) => {}
                    None => b2.index[*n as usize] = Some(ph),
                }
                out.push((q, b2, k));
            }
            out
        }
        Unit::Restrict(inner, class) => {
            let mut out = Vec::new();
            for (q, mut b2, k) in options(kit, inner, ctx, pos, dir, b) {
                let (lo, hi) = if q >= pos { (pos, q) } else { (q, pos) };
                if hi - lo == 1 && class_matches(kit, class, ctx, lo, &mut b2) {
                    out.push((q, b2, k));
                }
            }
            out
        }
    }
}

/// Every way a sequence of units matches from `pos`: the position after
/// it and the bindings. Going back, the units are taken from the last.
pub fn ends(
    kit: &Kit,
    units: &[Unit],
    ctx: Ctx,
    pos: usize,
    dir: Dir,
    b: &Bindings,
) -> Vec<(usize, Bindings)> {
    let mut states = vec![(pos, b.clone())];
    let order: Vec<&Unit> = match dir {
        Dir::Forward => units.iter().collect(),
        Dir::Back => units.iter().rev().collect(),
    };
    for unit in order {
        let mut next = Vec::new();
        for (p, b2) in &states {
            for (q, b3, _) in options(kit, unit, ctx, *p, dir, b2) {
                next.push((q, b3));
            }
        }
        if next.is_empty() {
            return next;
        }
        states = next;
    }
    states
}

// ---------------------------------------------------------- replacement

/// The feature replacement `[...]` on a sound: the sound of the table
/// that has the class's values and keeps the others. Without a sound
/// (an insertion), the most common sound that has the class's values
/// and no series, no length, no nasality. None when the table has no
/// such sound.
pub fn replace(kit: &Kit, base: Option<Phoneme>, class: &Class, b: &Bindings) -> Option<Phoneme> {
    // The values the class sets, with α resolved.
    let mut text: Vec<(&str, String)> = Vec::new();
    let mut bools: Vec<(&str, bool)> = Vec::new();
    let mut nots: Vec<(&str, &str)> = Vec::new();
    for term in &class.terms {
        match term {
            Term::Value { field, value } => text.push((field, value.clone())),
            Term::NotValue { field, value } => nots.push((field, value)),
            Term::Bool { name, on } => bools.push((name.as_str(), *on)),
            Term::Key { field, value } => {
                let v = match value {
                    KeyVal::Literal(v) => {
                        if TEXT_FIELDS.contains(&field.as_str()) {
                            Val::Text(v.clone())
                        } else {
                            Val::Bool(v == "true")
                        }
                    }
                    KeyVal::Alpha(c) => b.alpha(*c)?.clone(),
                };
                let f = TEXT_FIELDS
                    .iter()
                    .chain(BOOLS.iter())
                    .find(|f| **f == field)
                    .copied()?;
                match v {
                    Val::Text(t) => text.push((f, t)),
                    Val::Bool(x) => bools.push((f, x)),
                }
            }
        }
    }
    let wants = |s: &Sound| -> bool {
        match class.kind {
            Kind::Vowel if !s.vowel => return false,
            Kind::Consonant if s.vowel => return false,
            _ => {}
        }
        text.iter().all(|(f, v)| text_field(s, f) == v)
            && nots.iter().all(|(f, v)| text_field(s, f) != *v)
            && bools.iter().all(|(n, on)| {
                if *n == "nasal" && !s.vowel {
                    // A consonant is nasal by its manner, set by a value.
                    true
                } else {
                    bool_field(s, n) == *on
                }
            })
    };
    match base {
        Some(p) => {
            let s0 = &kit.sounds[p.0 as usize];
            // The fields that stay: all but those the class sets. A series
            // set to on replaces the other series; set to off, removes it.
            let series_set = bools.iter().any(|(n, _)| SERIES.contains(n));
            let keeps = |s: &Sound| -> bool {
                if s.vowel != s0.vowel {
                    return false;
                }
                let text_ok = TEXT_FIELDS.iter().all(|f| {
                    text.iter().any(|(g, _)| g == f) || text_field(s, f) == text_field(s0, f)
                });
                let bools_ok = ["voice", "lateral", "long", "nasal", "rounded"]
                    .iter()
                    .all(|f| {
                        bools.iter().any(|(g, _)| g == f)
                            || (*f == "nasal" && !s.vowel)
                            || bool_field(s, f) == bool_field(s0, f)
                    });
                let series_ok = if series_set {
                    // The series the class names on, or none when it names
                    // only offs; the series it does not name stays.
                    match bools.iter().find(|(n, on)| SERIES.contains(n) && *on) {
                        Some((n, _)) => s.series.as_deref() == Some(*n),
                        None => {
                            let off = |n: &str| bools.iter().any(|(m, on)| *m == n && !*on);
                            match s0.series.as_deref() {
                                Some(n0) if off(n0) => s.series.is_none(),
                                other => s.series.as_deref() == other,
                            }
                        }
                    }
                } else {
                    s.series == s0.series
                };
                text_ok && bools_ok && series_ok
            };
            kit.sounds
                .iter()
                .position(|s| wants(s) && keeps(s))
                .map(|k| Phoneme(k as u8))
        }
        None => kit
            .sounds
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                wants(s)
                    && s.series.is_none()
                    && !s.long
                    && !(s.vowel && s.nasal)
                    && (bools.iter().any(|(n, _)| *n == "lateral") || !s.lateral)
            })
            .max_by(|(ka, a), (kb, b)| a.weight.cmp(&b.weight).then(kb.cmp(ka)))
            .map(|(k, _)| Phoneme(k as u8)),
    }
}

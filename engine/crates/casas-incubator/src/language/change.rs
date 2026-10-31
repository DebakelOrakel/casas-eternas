//! One sound change: a template of `changes.json` parsed, and applied to
//! a word. The tree of the languages (TEG-138) chains the changes; this
//! module applies one.
//!
//! The change applies at the same time at every place of the word: the
//! targets and the environments are found in the word before the change,
//! from left to right; a target that matched is not matched again. An
//! insertion (`∅ > …`) applies once at each place between two sounds.

use super::kit::{ChangeTemplate, Kit, kit};
use super::notation::{
    Bindings, Class, Ctx, Dir, Unit, ends, options, parse_units, parse_with_text, replace, sound_in,
};
use super::{Phoneme, Word};
use std::sync::OnceLock;

// What one unit of REPLACEMENT gives.
#[derive(Debug, Clone)]
enum Out {
    Sound(Phoneme),
    Zero,
    /// A set: by the member the target's set took, or by `choice`.
    Set(Vec<Vec<Out>>),
    /// A feature replacement on the target unit's sound.
    Feature(Class),
    /// The sounds that target unit k matched (`V L > L V`).
    Copy(usize),
    /// The sound bound to a number (`C₁`).
    Index(u8),
}

/// A sound change, parsed from its template.
#[derive(Debug, Clone)]
pub struct Change {
    pub id: String,
    pub family: String,
    /// The weight of the template, times 1 000.
    pub weight: u32,
    target: Vec<Unit>,
    out: Vec<Out>,
    left: Vec<Unit>,
    right: Vec<Unit>,
    except: Option<(Vec<Unit>, Vec<Unit>)>,
    requires: Vec<Vec<Unit>>,
    /// The member of a set in REPLACEMENT that has no set of the same
    /// size in TARGET (`∅ > {u,e}`).
    choice: usize,
}

fn environment(kit: &Kit, text: &str) -> Result<(Vec<Unit>, Vec<Unit>), String> {
    let (l, r) = text
        .split_once('_')
        .ok_or_else(|| format!("no '_' in the environment '{text}'"))?;
    Ok((parse_units(kit, l)?, parse_units(kit, r)?))
}

// The set inside a unit, also under a restriction.
fn set_of(unit: &Unit) -> Option<&Vec<Vec<Unit>>> {
    match unit {
        Unit::Set(m) => Some(m),
        Unit::Restrict(inner, _) => set_of(inner),
        _ => None,
    }
}

fn plain_out(unit: &Unit) -> Result<Out, String> {
    match unit {
        Unit::Sound(p) => Ok(Out::Sound(*p)),
        Unit::Zero => Ok(Out::Zero),
        other => Err(format!(
            "a set member of REPLACEMENT must be sounds: {other:?}"
        )),
    }
}

impl Change {
    /// Parses a template. The error names what the notation does not allow.
    pub fn parse(t: &ChangeTemplate) -> Result<Change, String> {
        let kit = kit();
        let (main, except) = match t.rule.split_once("//") {
            Some((m, e)) => (m, Some(environment(kit, e.trim())?)),
            None => (t.rule.as_str(), None),
        };
        let (change, env) = match main.split_once('/') {
            Some((c, e)) => (c, Some(environment(kit, e.trim())?)),
            None => (main, None),
        };
        let (target, replacement) = change
            .split_once('>')
            .ok_or_else(|| format!("no '>' in '{}'", t.rule))?;
        let target = parse_with_text(kit, target)?;
        let replacement = parse_with_text(kit, replacement)?;
        if target.len() != replacement.len() {
            return Err(format!(
                "TARGET has {} units, REPLACEMENT {}",
                target.len(),
                replacement.len()
            ));
        }
        let mut out = Vec::new();
        for (unit, text) in &replacement {
            let o = if text.starts_with('[') {
                match unit {
                    Unit::Class(c) => Out::Feature(c.clone()),
                    _ => return Err(format!("'{text}' is not a feature replacement")),
                }
            } else if let Unit::Indexed(_, n) = unit {
                if !target
                    .iter()
                    .any(|(u, _)| matches!(u, Unit::Indexed(_, m) if m == n))
                {
                    return Err(format!("'{text}' is bound nowhere in TARGET"));
                }
                Out::Index(*n)
            } else if let (false, Some(k)) = (
                matches!(unit, Unit::Sound(_) | Unit::Zero),
                target.iter().position(|(_, tt)| tt == text),
            ) {
                Out::Copy(k)
            } else {
                match unit {
                    Unit::Sound(p) => Out::Sound(*p),
                    Unit::Zero => Out::Zero,
                    Unit::Set(members) => Out::Set(
                        members
                            .iter()
                            .map(|m| m.iter().map(plain_out).collect::<Result<Vec<_>, _>>())
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                    _ => return Err(format!("'{text}' in REPLACEMENT has no meaning")),
                }
            };
            out.push(o);
        }
        if target.iter().all(|(u, _)| matches!(u, Unit::Zero)) && target.len() != 1 {
            return Err("an insertion has one unit".into());
        }
        let (left, right) = env.unwrap_or_default();
        let requires = t
            .requires
            .iter()
            .map(|r| parse_units(kit, r))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Change {
            id: t.id.clone(),
            family: t.family.clone(),
            weight: super::kit::weight(t.weight),
            target: target.into_iter().map(|(u, _)| u).collect(),
            out,
            left,
            right,
            except,
            requires,
            choice: 0,
        })
    }

    /// How many choices the change has (`∅ > {u,e}` has 2); 1 for most.
    pub fn choices(&self) -> usize {
        self.out
            .iter()
            .enumerate()
            .filter_map(|(j, o)| match o {
                Out::Set(m) if set_of(&self.target[j]).map(|t| t.len()) != Some(m.len()) => {
                    Some(m.len())
                }
                _ => None,
            })
            .max()
            .unwrap_or(1)
    }

    /// The same change with choice `k` (see `choices`).
    pub fn with_choice(&self, k: usize) -> Change {
        Change {
            choice: k,
            ..self.clone()
        }
    }

    /// True when the inventory has what the change needs (`requires`).
    pub fn fits(&self, inventory: &[Phoneme]) -> bool {
        let kit = kit();
        self.requires
            .iter()
            .all(|r| inventory.iter().any(|&p| sound_in(kit, r, p)))
    }

    fn insertion(&self) -> bool {
        matches!(self.target.as_slice(), [Unit::Zero])
    }

    fn excepted(&self, kit: &Kit, ctx: Ctx, start: usize, end: usize, b: &Bindings) -> bool {
        let Some((l, r)) = &self.except else {
            return false;
        };
        ends(kit, r, ctx, end, Dir::Forward, b)
            .iter()
            .any(|(_, b2)| !ends(kit, l, ctx, start, Dir::Back, b2).is_empty())
    }

    // The first match of TARGET from `start` with its environment: the
    // span of each unit, the member of a set it took, and the bindings.
    #[allow(clippy::too_many_arguments)]
    fn search(
        &self,
        kit: &Kit,
        ctx: Ctx,
        start: usize,
        j: usize,
        pos: usize,
        b: &Bindings,
        caps: &mut Vec<(usize, usize, usize)>,
    ) -> Option<Bindings> {
        if j == self.target.len() {
            for (_, b2) in ends(kit, &self.right, ctx, pos, Dir::Forward, b) {
                for (_, b3) in ends(kit, &self.left, ctx, start, Dir::Back, &b2) {
                    if !self.excepted(kit, ctx, start, pos, &b3) {
                        return Some(b3);
                    }
                }
            }
            return None;
        }
        for (q, b2, k) in options(kit, &self.target[j], ctx, pos, Dir::Forward, b) {
            caps.push((pos, q, k));
            if let Some(found) = self.search(kit, ctx, start, j + 1, q, &b2, caps) {
                return Some(found);
            }
            caps.pop();
        }
        None
    }

    // What each unit of REPLACEMENT gives; None when a feature
    // replacement has no sound in the table (the change does not apply).
    fn emit(
        &self,
        kit: &Kit,
        ctx: Ctx,
        caps: &[(usize, usize, usize)],
        b: &Bindings,
    ) -> Option<Vec<Vec<Phoneme>>> {
        let mut pieces = Vec::new();
        for (j, o) in self.out.iter().enumerate() {
            let (s, e, member) = caps[j];
            let piece = match o {
                Out::Sound(p) => vec![*p],
                Out::Zero => vec![],
                Out::Set(members) => {
                    let k = match set_of(&self.target[j]) {
                        Some(t) if t.len() == members.len() => member,
                        _ => self.choice % members.len(),
                    };
                    members[k]
                        .iter()
                        .filter_map(|o| match o {
                            Out::Sound(p) => Some(*p),
                            _ => None,
                        })
                        .collect()
                }
                Out::Feature(class) => {
                    let base = match e - s {
                        0 => None,
                        1 => Some(ctx.sounds[s]),
                        _ => return None,
                    };
                    vec![replace(kit, base, class, b)?]
                }
                Out::Copy(k) => ctx.sounds[caps[*k].0..caps[*k].1].to_vec(),
                Out::Index(n) => vec![b.index[*n as usize]?],
            };
            pieces.push(piece);
        }
        Some(pieces)
    }
}

/// The templates of `changes.json`, parsed once, in the file's order.
pub fn changes() -> &'static [Change] {
    static CHANGES: OnceLock<Vec<Change>> = OnceLock::new();
    CHANGES.get_or_init(|| {
        kit()
            .changes
            .changes
            .iter()
            .map(|t| Change::parse(t).unwrap_or_else(|e| panic!("changes.json {}: {e}", t.id)))
            .collect()
    })
}

/// The template with this id.
pub fn change(id: &str) -> Option<&'static Change> {
    changes().iter().find(|c| c.id == id)
}

/// Applies one sound change to a word. The result keeps the stress on
/// the vowel that the stressed vowel became; when that vowel went, on
/// the next vowel after it, else on the last vowel. The function is
/// pure: the same change and word give the same word.
pub fn apply_change(change: &Change, word: &Word) -> Word {
    let kit = kit();
    let ctx = Ctx {
        sounds: &word.sounds,
        stress: word.stress,
    };
    let len = word.sounds.len();
    let mut out: Vec<Phoneme> = Vec::with_capacity(len + 2);
    let mut stress = None;
    let mut pending = false;
    let vowel = |p: Phoneme| kit.sounds[p.0 as usize].vowel;
    // Puts a piece out; `stressed` when it holds what the stressed sound became.
    let mut put = |piece: &[Phoneme], stressed: bool, out: &mut Vec<Phoneme>| {
        if stressed {
            match piece.iter().position(|&p| vowel(p)) {
                Some(v) => stress = Some(out.len() + v),
                None => pending = true,
            }
        } else if pending && let Some(v) = piece.iter().position(|&p| vowel(p)) {
            stress = Some(out.len() + v);
            pending = false;
        }
        out.extend_from_slice(piece);
    };
    let mut i = 0;
    while i <= len {
        let mut caps = Vec::new();
        let found = first_match(change, kit, ctx, i, &mut caps);
        if change.insertion() {
            if let Some(b) = found
                && let Some(pieces) = change.emit(kit, ctx, &caps, &b)
            {
                for piece in &pieces {
                    put(piece, false, &mut out);
                }
            }
            if i < len {
                put(&word.sounds[i..i + 1], word.stress == Some(i), &mut out);
            }
            i += 1;
            continue;
        }
        if i == len {
            break;
        }
        let end = caps.last().map_or(i, |c| c.1);
        let pieces = match found {
            Some(b) if end > i => change.emit(kit, ctx, &caps, &b),
            _ => None,
        };
        match pieces {
            Some(pieces) => {
                for (j, piece) in pieces.iter().enumerate() {
                    let (s, e, _) = caps[j];
                    let stressed = word.stress.is_some_and(|t| t >= s && t < e);
                    put(piece, stressed, &mut out);
                }
                i = end;
            }
            None => {
                put(&word.sounds[i..i + 1], word.stress == Some(i), &mut out);
                i += 1;
            }
        }
    }
    if pending {
        stress = out.iter().rposition(|&p| vowel(p));
    }
    Word {
        sounds: out,
        stress,
    }
}

fn first_match(
    change: &Change,
    kit: &Kit,
    ctx: Ctx,
    i: usize,
    caps: &mut Vec<(usize, usize, usize)>,
) -> Option<Bindings> {
    change.search(kit, ctx, i, 0, i, &Bindings::default(), caps)
}

use super::inventory::{keeps, needed};
use super::notation::{Unit, sound_in};
use super::*;

// The seeds the tests draw languages from.
const SEEDS: std::ops::Range<u32> = 0..300;

fn word(ids: &[&str]) -> Vec<Phoneme> {
    ids.iter()
        .map(|id| kit().sound(id).unwrap_or_else(|| panic!("no sound {id}")))
        .collect()
}

// A fixed seed's language as lines: the inventory, ten core words and
// five village and three river names, spelt.
fn lines(seed: u32) -> Vec<String> {
    let lang = Language::proto(seed);
    let mut out = vec![ipa(&lang.inventory.sounds())];
    for m in core_meanings().into_iter().take(10) {
        out.push(format!("{m}={}", lang.spell(lang.word(m).unwrap())));
    }
    for s in 0..5 {
        out.push(lang.name(Kind::Village, &[], s).form(&lang));
    }
    for s in 0..3 {
        out.push(lang.name(Kind::River, &[], s).form(&lang));
    }
    out
}

#[test]
fn the_same_seed_gives_the_same_language() {
    for seed in [0, 1, 7, 99, 123_456_789, u32::MAX] {
        assert_eq!(sample(seed), sample(seed));
        let (a, b) = (Language::proto(seed), Language::proto(seed));
        for kind in Kind::ALL {
            for salt in 0..8 {
                assert_eq!(
                    a.name(kind, &["river"], salt),
                    b.name(kind, &["river"], salt)
                );
            }
        }
    }
}

// The bits of a fixed seed. A change here is a change of the languages:
// check that it is meant, then write the new lines.
#[test]
fn a_fixed_seed_gives_its_golden_lines() {
    let golden: &[&str] = &[
        "pbtdkgʔfsʃxɣhmnŋɾrwieoəɛaĩã",
        "water=mewehi",
        "river=mi",
        "spring=teperre",
        "lake=rrinda",
        "marsh=rro",
        "sea=wiga",
        "ford=shadan",
        "snow=raboho",
        "land=wekhan",
        "mountain=datanho",
        "Imipa Eni",
        "Kewome Dikha",
        "Sa Dikha",
        "Ginrran Pokhanfa",
        "E Eni",
        "Ngeme",
        "Teperre 'Angipa",
        "'A",
    ];
    let got = lines(20_261_031);
    if got != golden {
        panic!("the golden lines changed:\n{got:#?}");
    }
}

#[test]
fn the_kit_reads() {
    let k = kit();
    assert_eq!(k.sounds.len(), 82);
    assert_eq!(core_meanings().len(), 48);
    assert_eq!(changes().len(), 80);
}

#[test]
fn every_inventory_keeps_the_kit_rules() {
    let k = kit();
    let inv = &k.inventories;
    for seed in SEEDS {
        let lang = Language::proto(seed);
        let i = &lang.inventory;
        let have = i.sounds();
        // The lists of `always`.
        for list in inv.always.consonants.iter().chain(&inv.always.vowels) {
            assert!(
                list.iter().any(|m| have.contains(&k.sound(m).unwrap())),
                "seed {seed}: none of {list:?}"
            );
        }
        // The implications that hold in the language.
        for (imp, &on) in inv.implications.iter().zip(&i.holds) {
            let test = k.units(&imp.if_);
            for &p in &have {
                if on && sound_in(k, &test, p) {
                    assert!(
                        keeps(k, imp, p, &have, &i.removed),
                        "seed {seed}: {} without {:?} ({})",
                        p.id(),
                        needed(k, imp, p).iter().map(|n| n.id()).collect::<Vec<_>>(),
                        imp.if_
                    );
                }
            }
        }
        // A long or a nasal vowel only beside its short oral vowel.
        for &v in &i.vowels {
            let s = v.sound();
            if s.long || s.nasal {
                assert!(
                    i.vowels.iter().any(|&w| {
                        let t = w.sound();
                        !t.long && !t.nasal && t.height == s.height && t.backness == s.backness
                    }),
                    "seed {seed}: {} alone",
                    s.id
                );
            }
        }
        // The gaps' sounds are out.
        for p in &i.removed {
            assert!(!have.contains(p), "seed {seed}: the gap's {} is in", p.id());
        }
    }
}

#[test]
fn every_onset_and_coda_keeps_the_sonority() {
    let k = kit();
    for seed in SEEDS {
        let lang = Language::proto(seed);
        let sy = &lang.syllables;
        assert!(sy.forms.iter().any(|f| f.id == "CV"), "seed {seed}: no CV");
        for f in &sy.forms {
            let exempt = matches!(f.id.as_str(), "sCV" | "sCVC" | "CCCV" | "CCCVC");
            for (onset, _) in &f.onsets {
                for (n, pair) in onset.windows(2).enumerate() {
                    if exempt && n == 0 {
                        continue;
                    }
                    let (a, b) = (pair[0].sound(), pair[1].sound());
                    assert!(
                        b.sonority >= a.sonority + sy.min_distance,
                        "seed {seed}: onset {} of {}",
                        ipa(onset),
                        f.id
                    );
                }
            }
            for (coda, _) in &f.codas {
                for pair in coda.windows(2) {
                    let (a, b) = (pair[0].sound(), pair[1].sound());
                    assert!(
                        a.sonority >= b.sonority + sy.min_distance,
                        "seed {seed}: coda {} of {}",
                        ipa(coda),
                        f.id
                    );
                }
                assert!(
                    coda.iter().all(|&c| sy.coda_ok(k, c)),
                    "seed {seed}: coda {}",
                    ipa(coda)
                );
            }
        }
    }
}

#[test]
fn every_root_and_name_is_pronounceable() {
    for seed in SEEDS {
        let lang = Language::proto(seed);
        let core = core_meanings();
        for m in &core {
            let w = lang
                .word(m)
                .unwrap_or_else(|| panic!("seed {seed}: no word for {m}"));
            assert!(lang.pronounceable(w), "seed {seed}: {m} = {}", ipa(w));
        }
        for m in lang.meanings() {
            let root = lang.root(m).unwrap();
            assert!(root.stress.is_some_and(|s| root.sounds[s].sound().vowel));
        }
        for kind in Kind::ALL {
            for salt in 0..6 {
                let recipe = lang.name(kind, &[], salt);
                let form = recipe.form(&lang);
                assert!(!form.trim().is_empty(), "seed {seed}: an empty {kind:?}");
                for w in recipe.words(&lang) {
                    assert!(
                        lang.pronounceable(&w),
                        "seed {seed}: {kind:?} {} ({form}, {})",
                        ipa(&w),
                        recipe.pattern
                    );
                }
            }
        }
    }
}

#[test]
fn the_context_fills_the_slots_first() {
    let lang = Language::proto(5);
    let mut seen = false;
    for salt in 0..40 {
        let r = lang.name(Kind::Village, &["ford", "red"], salt);
        for s in &r.slots {
            match s {
                Slot::Noun(m) | Slot::Head(m) | Slot::Adjective(m) => {
                    seen |= m == "ford" || m == "red";
                }
                _ => {}
            }
        }
    }
    assert!(seen);
}

#[test]
fn every_change_parses_and_applies() {
    let k = kit();
    for t in &k.changes.changes {
        Change::parse(t).unwrap_or_else(|e| panic!("{}: {e}", t.id));
    }
    // Every change on every root of some languages, each stress.
    for seed in 0..40 {
        let lang = Language::proto(seed);
        for m in lang.meanings() {
            let root = lang.root(m).unwrap();
            for c in changes() {
                for choice in 0..c.choices() {
                    let out = apply_change(&c.with_choice(choice), root);
                    if let Some(s) = out.stress {
                        assert!(
                            out.sounds[s].sound().vowel,
                            "{}: stress on {}",
                            c.id,
                            ipa(&out.sounds)
                        );
                    }
                    // Pure: the same change gives the same word.
                    assert_eq!(out, apply_change(&c.with_choice(choice), root));
                }
            }
        }
    }
    // The requires parse into units that the table has.
    for c in changes() {
        let all: Vec<Phoneme> = (0..k.sounds.len()).map(|n| Phoneme(n as u8)).collect();
        assert!(c.fits(&all), "{}: requires what no sound is", c.id);
    }
}

// Applies the change to a word given as ids, the stress on sound `stress`.
fn run(id: &str, ids: &[&str], stress: usize) -> String {
    let c = change(id).unwrap_or_else(|| panic!("no change {id}"));
    let out = apply_change(
        c,
        &Word {
            sounds: word(ids),
            stress: Some(stress),
        },
    );
    out.sounds
        .iter()
        .map(|p| p.id())
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn the_changes_do_what_their_examples_say() {
    // lupum > lubum (V_V).
    assert_eq!(
        run("voicingIntervocalic", &["l", "u", "p", "u", "m"], 1),
        "l u b u m"
    );
    // latus > laðus.
    assert_eq!(
        run("spirantizationIntervocalic", &["l", "a", "d", "u", "s"], 1),
        "l a ð u s"
    );
    // pods > fots: not after s.
    assert_eq!(
        run("grimmSpirantization", &["s", "p", "a", "t"], 2),
        "s p a θ"
    );
    // gutta > guta.
    assert_eq!(
        run("degemination", &["g", "u", "t", "t", "a"], 1),
        "g u t a"
    );
    // in-pos > impos (α).
    assert_eq!(
        run("nasalPlaceAssimilation", &["i", "n", "p", "o", "s"], 0),
        "i m p o s"
    );
    // scrib-tus > scriptus (α on voice).
    assert_eq!(
        run(
            "voicingAssimilation",
            &["s", "k", "r", "i", "b", "t", "u", "s"],
            3
        ),
        "s k r i p t u s"
    );
    // natjur > natʃur (a set of sequences).
    assert_eq!(
        run("yodCoalescence", &["n", "a", "t", "j", "u", "r"], 1),
        "n a tʃ u r"
    );
    // pane > pan (unstressed final vowel).
    assert_eq!(run("apocope", &["p", "a", "n", "e"], 1), "p a n");
    // A stressed final vowel stays.
    assert_eq!(run("apocope", &["p", "a", "n", "e"], 3), "p a n e");
    // calidum > caldum.
    assert_eq!(
        run("syncope", &["k", "a", "l", "i", "d", "u", "m"], 1),
        "k a l d u m"
    );
    // skala > eskala (insertion at the edge).
    assert_eq!(
        run("prothesis", &["s", "k", "a", "l", "a"], 2),
        "e s k a l a"
    );
    // petra > pjetra (breaking under stress).
    assert_eq!(
        run("breaking", &["p", "ɛ", "t", "r", "a"], 1),
        "p j e t r a"
    );
    assert_eq!(run("breaking", &["p", "ɛ", "t", "r", "a"], 4), "p ɛ t r a");
    // gord > grod (metathesis by class).
    assert_eq!(run("liquidMetathesis", &["g", "o", "r", "d"], 1), "g r o d");
    // fotiz > føtiz (umlaut, C₀).
    assert_eq!(run("umlaut", &["f", "o", "t", "i", "z"], 1), "f ø t i z");
    // huːs > hajs ({iː,uː} > {a j,a w}).
    assert_eq!(
        run("highVowelDiphthongization", &["h", "uː", "s"], 1),
        "h a w s"
    );
    // bonum > bõu ... the nasal before a consonant or the edge.
    assert_eq!(
        run("vowelNasalization", &["b", "o", "n", "t", "a"], 1),
        "b o n t a"
    );
    assert_eq!(
        run("vowelNasalization", &["k", "a", "n", "t", "a"], 1),
        "k ã t a"
    );
    // werra > gwerra.
    assert_eq!(run("wToGw", &["w", "e", "r", "a"], 1), "g w e r a");
    // þunor > þundor (an inserted stop at the nasal's place).
    assert_eq!(run("stopEpenthesis", &["θ", "u", "n", "r"], 1), "θ u n d r");
    // peregrinus > pelegrinus (… any material).
    assert_eq!(
        run(
            "liquidDissimilation",
            &["p", "e", "r", "e", "g", "r", "i"],
            1
        ),
        "p e l e g r i"
    );
    // The stress follows the vowel: nama > naːma.
    let c = change("openSyllableLengthening").unwrap();
    let out = apply_change(
        c,
        &Word {
            sounds: word(&["n", "a", "m", "a"]),
            stress: Some(1),
        },
    );
    assert_eq!(
        (ipa(&out.sounds), out.stress),
        ("naːma".to_string(), Some(1))
    );
    // The paragoge's two choices.
    let c = change("paragoge").unwrap();
    assert_eq!(c.choices(), 2);
    let bus = Word {
        sounds: word(&["b", "a", "s"]),
        stress: Some(1),
    };
    assert_eq!(ipa(&apply_change(c, &bus).sounds), "basu");
    assert_eq!(ipa(&apply_change(&c.with_choice(1), &bus).sounds), "base");
}

#[test]
fn the_notation_reads_the_class_letters() {
    let k = kit();
    let o = k.units("O");
    assert!(matches!(o.as_slice(), [Unit::Set(m)] if m.len() == 3));
    assert!(sound_in(k, &o, k.sound("tʃ").unwrap()));
    assert!(!sound_in(k, &o, k.sound("m").unwrap()));
    let s = k.units("S");
    assert!(sound_in(k, &s, k.sound("w").unwrap()));
    assert!(sound_in(k, &s, k.sound("ɲ").unwrap()));
}

#[test]
#[ignore]
fn print_samples() {
    for seed in [1u32, 2, 3, 42, 1234] {
        println!("{}", serde_json::to_string_pretty(&sample(seed)).unwrap());
    }
}

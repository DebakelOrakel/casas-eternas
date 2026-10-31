//! The history's log, each event as the simulation writes it; and the JSON
//! the packed history's header holds, written as JavaScript's
//! `JSON.stringify` writes it — the keys in their order, the numbers as
//! JavaScript prints them — so the bytes are the client's.

/// The people's marks the log notes.
pub const POPULATION_MARKS: [f64; 3] = [100_000.0, 1_000_000.0, 10_000_000.0];

#[derive(Clone, Debug)]
pub enum LogEvent {
    Departure {
        at: f64,
        cell: f64,
    },
    Crossing {
        at: f64,
        cell: f64,
        landmass: f64,
        km: f64,
        first: bool,
    },
    Centre {
        at: f64,
        cell: f64,
        lifeway: f64,
    },
    Domesticated {
        at: f64,
        cell: f64,
        id: String,
        plant: bool,
    },
    Extinct {
        at: f64,
        cell: f64,
        landmass: f64,
        id: String,
    },
    Famine {
        at: f64,
        to: f64,
        cell: f64,
        landmass: f64,
        before: f64,
        lost: f64,
        left: f64,
        villages: f64,
    },
    Village {
        at: f64,
        cell: f64,
        village: f64,
        lifeway: f64,
    },
    VillageLeft {
        at: f64,
        cell: f64,
        village: f64,
    },
    Camp {
        at: f64,
        cell: f64,
        village: f64,
        lifeway: f64,
    },
    CampLeft {
        at: f64,
        cell: f64,
        village: f64,
    },
    Trade {
        at: f64,
        cell: f64,
        a: f64,
        b: f64,
    },
    Population {
        at: f64,
        cell: f64,
        count: f64,
        villages: f64,
        centres: f64,
    },
    /// The copper found and hammered, or smelted, where it was not passed on.
    Copper {
        at: f64,
        cell: f64,
        smelted: bool,
    },
    /// The first city, the history's end: the people within a day of it.
    City {
        at: f64,
        cell: f64,
        people: f64,
    },
    /// The sea took `km2` of a landmass's shelf in one CLIMATE_YEARS
    /// (simulation.rs THE RISING SEA), `people` moved away from it; at its
    /// cell of the most people.
    Drowned {
        at: f64,
        cell: f64,
        landmass: f64,
        km2: f64,
        people: f64,
    },
    /// The cells of a landmass that lost the last of the humid period's
    /// gain in one CLIMATE_YEARS came to `km2` (simulation.rs THE LAND
    /// DRYING), `people` moved away from its drying cells; at its cell of
    /// the most people moved.
    Drying {
        at: f64,
        cell: f64,
        landmass: f64,
        km2: f64,
        people: f64,
    },
    /// The sea came into `km2` of a landmass's land that the ice left
    /// and pushed down, in one CLIMATE_YEARS (simulation.rs THE REBOUND'S
    /// COASTS); at its deepest cell.
    SeaFloodsIce {
        at: f64,
        cell: f64,
        landmass: f64,
        km2: f64,
    },
    /// `km2` of a landmass's land the ice pushed down came up out of the
    /// sea in one CLIMATE_YEARS (simulation.rs THE REBOUND'S COASTS); at
    /// its deepest cell.
    LandRises {
        at: f64,
        cell: f64,
        landmass: f64,
        km2: f64,
    },
    /// A cold spell begins (climate_history.rs THE COLD SPELLS), `years`
    /// long.
    ColdSpell {
        at: f64,
        years: f64,
    },
    /// A large explosive eruption of VEI `vei` (eruptions.rs, simulation.rs
    /// THE ERUPTIONS) at the vent's cell, on the landmass nearest it: its
    /// ash over `km2` of the land, `people` dead, `left` fled.
    Eruption {
        at: f64,
        cell: f64,
        landmass: f64,
        vei: f64,
        km2: f64,
        people: f64,
        left: f64,
    },
    /// A fissure eruption (eruptions.rs), as Eruption: its gas over `km2`.
    Fissure {
        at: f64,
        cell: f64,
        landmass: f64,
        km2: f64,
        people: f64,
        left: f64,
    },
    /// THE PEOPLES' CHRONICLE (peoples.rs `Tree::tell`, since 2026-10-29),
    /// for the big peoples; `people` a people's id (pack.rs), `count` its
    /// people. People `new` parted from `people`; `new`'s measure, at its
    /// heart.
    PeopleSplit {
        at: f64,
        cell: f64,
        people: f64,
        new: f64,
        count: f64,
        km2: f64,
    },
    /// People `people` went into `into`; its measure before.
    PeopleMerged {
        at: f64,
        cell: f64,
        people: f64,
        into: f64,
        count: f64,
        km2: f64,
    },
    /// People `people` ended as at a merge, but THE WAVES took most of it
    /// (peoples.rs `Tree::tell`): it was displaced by `into`, the
    /// newcomers' people. Its measure before. Since 2026-10-31 (TEG-14).
    PeopleReplaced {
        at: f64,
        cell: f64,
        people: f64,
        into: f64,
        count: f64,
        km2: f64,
    },
    /// People `people` died out or fell under big for good; its last big
    /// measure.
    PeopleGone {
        at: f64,
        cell: f64,
        people: f64,
        count: f64,
        km2: f64,
    },
    /// People `people`'s farmers' share went to FARMERS_TOLD or more.
    PeopleFarmers {
        at: f64,
        cell: f64,
        people: f64,
        count: f64,
        km2: f64,
        farmers: f64,
    },
    /// THE LANGUAGES (languages.rs, TEG-138, since 2026-10-31): `language`
    /// a node of the languages' tree (pack.rs `languageParent` …), `people`
    /// a people's id. Language `language` arises from `from`: people
    /// `people` lived LANGUAGE_APART_YEARS apart; at its heart then.
    LanguageArises {
        at: f64,
        cell: f64,
        language: f64,
        from: f64,
        people: f64,
    },
    /// Language `language` is spoken no more: its last people `people`
    /// ended, into a people that speaks `into` (-1 where it died out);
    /// `replaced` where THE WAVES displaced it (as `PeopleReplaced`), so
    /// `into` is the newcomers' language. At its heart at its last step.
    LanguageGone {
        at: f64,
        cell: f64,
        language: f64,
        people: f64,
        into: f64,
        replaced: bool,
    },
    /// Family `family` (a node of the tree) is spoken no more: its last
    /// people `people` ended. At its heart at its last step.
    FamilyGone {
        at: f64,
        cell: f64,
        family: f64,
        people: f64,
    },
}

impl LogEvent {
    pub fn at(&self) -> f64 {
        match self {
            LogEvent::Departure { at, .. }
            | LogEvent::Crossing { at, .. }
            | LogEvent::Centre { at, .. }
            | LogEvent::Domesticated { at, .. }
            | LogEvent::Extinct { at, .. }
            | LogEvent::Famine { at, .. }
            | LogEvent::Village { at, .. }
            | LogEvent::VillageLeft { at, .. }
            | LogEvent::Camp { at, .. }
            | LogEvent::CampLeft { at, .. }
            | LogEvent::Trade { at, .. }
            | LogEvent::Population { at, .. }
            | LogEvent::Copper { at, .. }
            | LogEvent::City { at, .. }
            | LogEvent::Drowned { at, .. }
            | LogEvent::Drying { at, .. }
            | LogEvent::SeaFloodsIce { at, .. }
            | LogEvent::LandRises { at, .. }
            | LogEvent::ColdSpell { at, .. }
            | LogEvent::Eruption { at, .. }
            | LogEvent::Fissure { at, .. }
            | LogEvent::PeopleSplit { at, .. }
            | LogEvent::PeopleMerged { at, .. }
            | LogEvent::PeopleReplaced { at, .. }
            | LogEvent::PeopleGone { at, .. }
            | LogEvent::PeopleFarmers { at, .. }
            | LogEvent::LanguageArises { at, .. }
            | LogEvent::LanguageGone { at, .. }
            | LogEvent::FamilyGone { at, .. } => *at,
        }
    }

    pub fn write(&self, j: &mut Json) {
        j.open_object();
        let kind = |j: &mut Json, k: &str| {
            j.key("kind").string(k);
        };
        match self {
            LogEvent::Departure { at, cell } => {
                kind(j, "departure");
                j.key("at").number(*at).key("cell").number(*cell);
            }
            LogEvent::Crossing {
                at,
                cell,
                landmass,
                km,
                first,
            } => {
                kind(j, "crossing");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("km")
                    .number(*km)
                    .key("first")
                    .boolean(*first);
            }
            LogEvent::Centre { at, cell, lifeway } => {
                kind(j, "centre");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("lifeway")
                    .number(*lifeway);
            }
            LogEvent::Domesticated {
                at,
                cell,
                id,
                plant,
            } => {
                kind(j, "domesticated");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("id")
                    .string(id)
                    .key("plant")
                    .boolean(*plant);
            }
            LogEvent::Extinct {
                at,
                cell,
                landmass,
                id,
            } => {
                kind(j, "extinct");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("id")
                    .string(id);
            }
            LogEvent::Famine {
                at,
                to,
                cell,
                landmass,
                before,
                lost,
                left,
                villages,
            } => {
                kind(j, "famine");
                j.key("at")
                    .number(*at)
                    .key("to")
                    .number(*to)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass);
                j.key("before")
                    .number(*before)
                    .key("lost")
                    .number(*lost)
                    .key("left")
                    .number(*left)
                    .key("villages")
                    .number(*villages);
            }
            LogEvent::Village {
                at,
                cell,
                village,
                lifeway,
            } => {
                kind(j, "village");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("village")
                    .number(*village)
                    .key("lifeway")
                    .number(*lifeway);
            }
            LogEvent::VillageLeft { at, cell, village } => {
                kind(j, "villageLeft");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("village")
                    .number(*village);
            }
            LogEvent::Camp {
                at,
                cell,
                village,
                lifeway,
            } => {
                kind(j, "camp");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("village")
                    .number(*village)
                    .key("lifeway")
                    .number(*lifeway);
            }
            LogEvent::CampLeft { at, cell, village } => {
                kind(j, "campLeft");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("village")
                    .number(*village);
            }
            LogEvent::Trade { at, cell, a, b } => {
                kind(j, "trade");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("a")
                    .number(*a)
                    .key("b")
                    .number(*b);
            }
            LogEvent::Population {
                at,
                cell,
                count,
                villages,
                centres,
            } => {
                kind(j, "population");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("count")
                    .number(*count)
                    .key("villages")
                    .number(*villages)
                    .key("centres")
                    .number(*centres);
            }
            LogEvent::Copper { at, cell, smelted } => {
                kind(j, "copper");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("smelted")
                    .boolean(*smelted);
            }
            LogEvent::City { at, cell, people } => {
                kind(j, "city");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("people")
                    .number(*people);
            }
            LogEvent::Drowned {
                at,
                cell,
                landmass,
                km2,
                people,
            } => {
                kind(j, "drowned");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("km2")
                    .number(*km2)
                    .key("people")
                    .number(*people);
            }
            LogEvent::Drying {
                at,
                cell,
                landmass,
                km2,
                people,
            } => {
                kind(j, "drying");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("km2")
                    .number(*km2)
                    .key("people")
                    .number(*people);
            }
            LogEvent::SeaFloodsIce {
                at,
                cell,
                landmass,
                km2,
            }
            | LogEvent::LandRises {
                at,
                cell,
                landmass,
                km2,
            } => {
                kind(
                    j,
                    if matches!(self, LogEvent::SeaFloodsIce { .. }) {
                        "seaFloodsIce"
                    } else {
                        "landRises"
                    },
                );
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("km2")
                    .number(*km2);
            }
            LogEvent::ColdSpell { at, years } => {
                kind(j, "coldSpell");
                j.key("at").number(*at).key("years").number(*years);
            }
            LogEvent::Eruption {
                at,
                cell,
                landmass,
                vei,
                km2,
                people,
                left,
            } => {
                kind(j, "eruption");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass)
                    .key("vei")
                    .number(*vei);
                j.key("km2")
                    .number(*km2)
                    .key("people")
                    .number(*people)
                    .key("left")
                    .number(*left);
            }
            LogEvent::Fissure {
                at,
                cell,
                landmass,
                km2,
                people,
                left,
            } => {
                kind(j, "fissure");
                j.key("at")
                    .number(*at)
                    .key("cell")
                    .number(*cell)
                    .key("landmass")
                    .number(*landmass);
                j.key("km2")
                    .number(*km2)
                    .key("people")
                    .number(*people)
                    .key("left")
                    .number(*left);
            }
            LogEvent::PeopleSplit {
                at,
                cell,
                people,
                new,
                count,
                km2,
            } => {
                kind(j, "peopleSplit");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("people")
                    .number(*people)
                    .key("new")
                    .number(*new)
                    .key("count")
                    .number(*count)
                    .key("km2")
                    .number(*km2);
            }
            LogEvent::PeopleMerged {
                at,
                cell,
                people,
                into,
                count,
                km2,
            }
            | LogEvent::PeopleReplaced {
                at,
                cell,
                people,
                into,
                count,
                km2,
            } => {
                let replaced = matches!(self, LogEvent::PeopleReplaced { .. });
                kind(
                    j,
                    if replaced {
                        "peopleReplaced"
                    } else {
                        "peopleMerged"
                    },
                );
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("people")
                    .number(*people)
                    .key("into")
                    .number(*into)
                    .key("count")
                    .number(*count)
                    .key("km2")
                    .number(*km2);
            }
            LogEvent::PeopleGone {
                at,
                cell,
                people,
                count,
                km2,
            } => {
                kind(j, "peopleGone");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("people")
                    .number(*people)
                    .key("count")
                    .number(*count)
                    .key("km2")
                    .number(*km2);
            }
            LogEvent::PeopleFarmers {
                at,
                cell,
                people,
                count,
                km2,
                farmers,
            } => {
                kind(j, "peopleFarmers");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("people")
                    .number(*people)
                    .key("count")
                    .number(*count)
                    .key("km2")
                    .number(*km2)
                    .key("farmers")
                    .number(*farmers);
            }
            LogEvent::LanguageArises {
                at,
                cell,
                language,
                from,
                people,
            } => {
                kind(j, "languageArises");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("language")
                    .number(*language)
                    .key("from")
                    .number(*from)
                    .key("people")
                    .number(*people);
            }
            LogEvent::LanguageGone {
                at,
                cell,
                language,
                people,
                into,
                replaced,
            } => {
                kind(j, "languageGone");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("language")
                    .number(*language)
                    .key("people")
                    .number(*people)
                    .key("into")
                    .number(*into)
                    .key("replaced")
                    .boolean(*replaced);
            }
            LogEvent::FamilyGone {
                at,
                cell,
                family,
                people,
            } => {
                kind(j, "familyGone");
                j.key("at").number(*at).key("cell").number(*cell);
                j.key("family")
                    .number(*family)
                    .key("people")
                    .number(*people);
            }
        }
        j.close_object();
    }
}

/// A JSON writer as `JSON.stringify` writes: no spaces, the keys in the
/// order written, a number as JavaScript prints it (`null` for NaN and the
/// infinities, `0` for −0).
#[derive(Default)]
pub struct Json {
    pub out: String,
    // Whether the next value in the innermost container needs a comma.
    first: Vec<bool>,
}

impl Json {
    fn separate(&mut self) {
        if let Some(first) = self.first.last_mut() {
            if !*first {
                self.out.push(',');
            }
            *first = false;
        }
    }

    pub fn open_object(&mut self) -> &mut Self {
        self.separate();
        self.out.push('{');
        self.first.push(true);
        self
    }

    pub fn close_object(&mut self) -> &mut Self {
        self.first.pop();
        self.out.push('}');
        self
    }

    pub fn open_array(&mut self) -> &mut Self {
        self.separate();
        self.out.push('[');
        self.first.push(true);
        self
    }

    pub fn close_array(&mut self) -> &mut Self {
        self.first.pop();
        self.out.push(']');
        self
    }

    /// A key; the value follows, without a comma of its own.
    pub fn key(&mut self, k: &str) -> &mut Self {
        self.separate();
        write_string(&mut self.out, k);
        self.out.push(':');
        if let Some(first) = self.first.last_mut() {
            *first = true;
        }
        self
    }

    pub fn number(&mut self, x: f64) -> &mut Self {
        self.separate();
        if !x.is_finite() {
            self.out.push_str("null");
        } else if x == 0.0 {
            self.out.push('0');
        } else {
            let mut buffer = ryu_js::Buffer::new();
            self.out.push_str(buffer.format_finite(x));
        }
        self.after_value();
        self
    }

    pub fn string(&mut self, s: &str) -> &mut Self {
        self.separate();
        write_string(&mut self.out, s);
        self.after_value();
        self
    }

    pub fn boolean(&mut self, b: bool) -> &mut Self {
        self.separate();
        self.out.push_str(if b { "true" } else { "false" });
        self.after_value();
        self
    }

    // A value after a key: the next key needs its comma.
    fn after_value(&mut self) {
        if let Some(first) = self.first.last_mut() {
            *first = false;
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::Json;

    #[test]
    fn it_writes_as_javascript_does() {
        let mut j = Json::default();
        j.open_object().key("a").number(1.0).key("b").open_array();
        j.number(0.1)
            .number(-0.0)
            .number(1e21)
            .number(f64::INFINITY)
            .number(2500.0);
        j.close_array()
            .key("c")
            .string("x\"y")
            .key("d")
            .boolean(true)
            .close_object();
        assert_eq!(
            j.out,
            r#"{"a":1,"b":[0.1,0,1e+21,null,2500],"c":"x\"y","d":true}"#
        );
    }
}

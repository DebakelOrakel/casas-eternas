//! THE LARGE ERUPTIONS (2026-10-31, TEG-131; docs/decisions/
//! volcanic-islands.md, Status; docs/design/prehistory-in-three-steps.md,
//! open item 9): the eruptions of step 2, drawn once from the world's
//! seed over level 1's active volcanoes (habitat.rs `Volcano`).
//! simulation.rs THE ERUPTIONS applies them.
//!
//! THE STYLE, by the volcano's setting (DEC-0051's rule, from the earth's
//! VEI scale): an active continental arc erupts VEI 6 to 8 (Toba,
//! Pinatubo); an active island arc VEI 4 to 7 (Krakatoa, Tambora); an
//! active continental hotspot VEI 8, a caldera (Yellowstone); an active
//! oceanic hotspot and an active flood basalt are effusive (Hawaii,
//! Laki); an inactive volcano does not erupt. Only VEI 6 and more is
//! computed: a smaller eruption changes nothing a cell of 10 km and a
//! step of 25 years can show.
//!
//! HOW OFTEN: the earth's rates, each times the world's active explosive
//! volcanoes over the earth's (EARTH_EXPLOSIVE). Every STEP_YEARS each VEI
//! comes by a chance of its rate × the step; it falls on one of the
//! volcanoes that can give it, the thicker the likelier. The effusive
//! eruptions alike, over the effusive volcanoes (EARTH_EFFUSIVE).
//!
//! WHAT AN EXPLOSIVE ERUPTION DOES: its ash covers the land within
//! `ash_km` of the vent; there the land carries ASH_LOSS less at the vent,
//! down to nothing less at the ash's edge, and the loss fades over
//! `ash_years`. VEI 7 and more also cools the world as a cold spell does
//! (climate_history.rs THE COLD SPELLS), `cold` more for `cold_years`.
//! WHAT A FISSURE DOES (Laki 1783): its gas poisons the pasture and the
//! herds within FISSURE_KM, the land carries FISSURE_LOSS less at the
//! vent, down to nothing less at the edge, for FISSURE_YEARS; the lava
//! covers little.

use crate::habitat::{Habitat, Volcano, km_between};
use casas_generator::core::js;
use casas_generator::core::rng::Mulberry32;

// HOW OFTEN, on the earth (from memory, not verified): VEI 6 (Pinatubo
// 1991, Krakatoa 1883) some once a century; VEI 7 (Tambora 1815) some
// once a millennium (Newhall, Self and Robock 2018 give one or two a
// millennium); VEI 8 (Toba 74 ka, Taupō's Oruanui 26.5 ka) some once in
// 50 000 years (Mason, Pyle and Oppenheimer 2004: 1.4 to 22 a million
// years). The volcanoes: the Smithsonian's Global Volcanism Program lists
// some 1 350 active in the Holocene (the USGS: some 1 350 potentially
// active), most on the subduction arcs; some 1 000 of them explosive. The
// hotspots: some 45 (Courtillot et al. 2003 list 49). A fissure eruption
// as Laki (some 15 km³ of lava, its gas over Iceland) or Eldgjá (934):
// Iceland had two in the last 1 100 years, Þjórsárhraun some 8 600 years
// ago; on the whole earth some once a millennium.
// On Morvane (v15, level 1, 2026-10-30): 220 active explosive volcanoes
// (38 continental arcs, 180 island arcs, 2 continental hotspots) and 5
// effusive (4 oceanic hotspots, a flood basalt): a VEI 6 every 455 years,
// a VEI 7 every 4 550, a VEI 8 every 230 000, a fissure every 9 000.
pub(crate) const EARTH_VEI6_YEARS: f64 = 100.0;
pub(crate) const EARTH_VEI7_YEARS: f64 = 1000.0;
pub(crate) const EARTH_VEI8_YEARS: f64 = 50_000.0;
pub(crate) const EARTH_EXPLOSIVE: f64 = 1000.0;
pub(crate) const EARTH_FISSURE_YEARS: f64 = 1000.0;
pub(crate) const EARTH_EFFUSIVE: f64 = 45.0;
// THE ASH (from memory, not verified): Pinatubo's ash fell some 100 km
// round, its land farmed again in some 10 years; Tambora's some 400 km
// (Lombok, Bali), Sumbawa hungry for decades; Toba's lies over South Asia
// to some 2 500 km, deep within some 1 000 km. Near the vent nothing
// grows (ASH_LOSS 1).
pub(crate) const ASH_LOSS: f64 = 1.0;
pub(crate) const ASH_KM_VEI6: f64 = 100.0;
pub(crate) const ASH_KM_VEI7: f64 = 400.0;
pub(crate) const ASH_KM_VEI8: f64 = 1000.0;
pub(crate) const ASH_YEARS_VEI6: f64 = 10.0;
pub(crate) const ASH_YEARS_VEI7: f64 = 50.0;
pub(crate) const ASH_YEARS_VEI8: f64 = 300.0;
// THE COLD (from memory, not verified): after Tambora the world was some
// 0.5 °C colder for some three years ("the year without a summer");
// after Toba some 2 °C or more, for some years to a decade or more. A
// cold spell's 0.1 is some −1 °C (climate_history.rs COLD_SPELL_COLD).
// The steps are 25 years: a VEI 7's cold is one step.
pub(crate) const COLD_VEI7: f64 = 0.05;
pub(crate) const COLD_YEARS_VEI7: f64 = 25.0;
pub(crate) const COLD_VEI8: f64 = 0.2;
pub(crate) const COLD_YEARS_VEI8: f64 = 100.0;
// THE FISSURE (Laki 1783, Thordarson and Self 2003, from memory, not
// verified): its fluorine and sulphur killed some half of Iceland's
// livestock, and some 20 % of its people died in the famine after. Iceland
// is some 100 000 km²: some 250 km round the fissure.
pub(crate) const FISSURE_KM: f64 = 250.0;
pub(crate) const FISSURE_LOSS: f64 = 0.8;
pub(crate) const FISSURE_YEARS: f64 = 5.0;
// WHAT THE CHRONICLE TELLS: a VEI 7 or 8 always; a VEI 6 where its ash
// killed or drove away ERUPTION_TOLD_PEOPLE or more; a fissure where it
// killed or drove away ERUPTION_TOLD_PEOPLE or more and FISSURE_TOLD_SHARE
// or more of the people within its reach (Laki's 20 %).
pub(crate) const ERUPTION_TOLD_PEOPLE: f64 = 500.0;
pub(crate) const FISSURE_TOLD_SHARE: f64 = 0.2;

/// What a volcano can do: the VEIs of its explosive eruptions, or
/// effusive, or nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    None,
    Explosive { least: u8, most: u8 },
    Effusive,
}

/// A volcano's style by its setting (THE STYLE).
pub fn style_of(v: &Volcano) -> Style {
    if !v.active {
        return Style::None;
    }
    match (v.kind, v.continental) {
        (2, true) => Style::Explosive { least: 6, most: 8 },
        (2, false) => Style::Explosive { least: 4, most: 7 },
        (0, true) => Style::Explosive { least: 8, most: 8 },
        (0, false) | (1, _) => Style::Effusive,
        _ => Style::None,
    }
}

/// An eruption: when, the volcano (an index into the habitat's), its VEI;
/// VEI 0 for a fissure.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Eruption {
    pub at: f64,
    pub volcano: usize,
    pub vei: u8,
}

/// The ash's reach, km, its years, the cold it adds and for how long, by
/// VEI (6 … 8); a fissure's (0) reach and years, no cold.
pub fn ash_km(vei: u8) -> f64 {
    match vei {
        6 => ASH_KM_VEI6,
        7 => ASH_KM_VEI7,
        8 => ASH_KM_VEI8,
        _ => FISSURE_KM,
    }
}

pub fn ash_years(vei: u8) -> f64 {
    match vei {
        6 => ASH_YEARS_VEI6,
        7 => ASH_YEARS_VEI7,
        8 => ASH_YEARS_VEI8,
        _ => FISSURE_YEARS,
    }
}

pub fn ash_loss(vei: u8) -> f64 {
    if vei == 0 { FISSURE_LOSS } else { ASH_LOSS }
}

fn cold_of(vei: u8) -> (f64, f64) {
    match vei {
        7 => (COLD_VEI7, COLD_YEARS_VEI7),
        8 => (COLD_VEI8, COLD_YEARS_VEI8),
        _ => (0.0, 0.0),
    }
}

/// The eruptions from `t0` (step 2's start) to `end`, years, on whole
/// `step`s, in time (HOW OFTEN); drawn from the seed apart from all else.
pub fn eruptions_of(
    seed: f64,
    volcanoes: &[Volcano],
    t0: f64,
    end: f64,
    step: f64,
) -> Vec<Eruption> {
    let styles: Vec<Style> = volcanoes.iter().map(style_of).collect();
    let explosive = styles
        .iter()
        .filter(|s| matches!(s, Style::Explosive { .. }))
        .count() as f64;
    let effusive = styles.iter().filter(|&&s| s == Style::Effusive).count() as f64;
    // Per VEI (and the fissures, VEI 0): its chance a step, the volcanoes
    // that can give it, their weights summed.
    let kinds: Vec<(u8, f64, Vec<usize>, f64)> = [
        (6, EARTH_VEI6_YEARS),
        (7, EARTH_VEI7_YEARS),
        (8, EARTH_VEI8_YEARS),
        (0, EARTH_FISSURE_YEARS),
    ]
    .into_iter()
    .map(|(vei, years)| {
        let can: Vec<usize> = (0..volcanoes.len())
            .filter(|&k| match styles[k] {
                Style::Explosive { least, most } => vei != 0 && (least..=most).contains(&vei),
                Style::Effusive => vei == 0,
                Style::None => false,
            })
            .collect();
        let share = if vei == 0 {
            effusive / EARTH_EFFUSIVE
        } else {
            explosive / EARTH_EXPLOSIVE
        };
        let total = can.iter().map(|&k| weight(&volcanoes[k])).sum();
        (vei, share * step / years, can, total)
    })
    .filter(|(_, _, can, _)| !can.is_empty())
    .collect();
    let mut out = Vec::new();
    if kinds.is_empty() {
        return out;
    }
    let mut random = Mulberry32::new(js::to_uint32(seed) ^ 0x0e2a_7710);
    for s in (t0 / step).ceil() as usize..(end / step).ceil() as usize {
        let at = s as f64 * step;
        for (vei, chance, can, total) in &kinds {
            if random.next() >= *chance {
                continue;
            }
            let mut r = random.next() * total;
            let mut pick = can[can.len() - 1];
            for &k in can {
                r -= weight(&volcanoes[k]);
                if r < 0.0 {
                    pick = k;
                    break;
                }
            }
            out.push(Eruption {
                at,
                volcano: pick,
                vei: *vei,
            });
        }
    }
    out
}

// A volcano's weight in the draw: its thickness, its size.
fn weight(v: &Volcano) -> f64 {
    js::max(1e-9, v.thickness)
}

/// The cold the eruptions of VEI 7 and more add at `t`.
pub fn eruption_cold(eruptions: &[Eruption], t: f64) -> f64 {
    let mut cold = 0.0;
    for e in eruptions {
        let (c, years) = cold_of(e.vei);
        if c > 0.0 && t >= e.at && t < e.at + years {
            cold += c;
        }
    }
    cold
}

/// The cells within an eruption's reach (`ash_km`) of the cell `vent`,
/// each with the share of what it carries the ash or the gas takes at
/// first (`ash_loss` at the vent, down to 0 at the edge).
pub fn ash_of(h: &Habitat, vent: usize, vei: u8) -> Vec<(usize, f32)> {
    let km = ash_km(vei);
    let loss = ash_loss(vei);
    let mut seen = vec![0u8; h.count];
    let mut out = vec![(vent, loss as f32)];
    seen[vent] = 1;
    let mut k = 0;
    while k < out.len() {
        let c = out[k].0;
        k += 1;
        for e in h.edges(c) {
            let u = h.nbr[e] as usize;
            if seen[u] != 0 {
                continue;
            }
            seen[u] = 1;
            let d = km_between(h, vent, u);
            if d > km {
                continue;
            }
            out.push((u, (loss * (1.0 - d / km)) as f32));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volcano(kind: u8, continental: bool, active: bool, thickness: f64) -> Volcano {
        Volcano {
            cell: 0,
            thickness,
            kind,
            continental,
            active,
        }
    }

    #[test]
    fn level_1s_list_is_read_in_its_form_alone() {
        use crate::habitat::volcanoes_of;
        let list = [
            10.5, 20.0, 0.3, 2.0, 1.0, 1.0, 400.0, 80.0, 0.1, 0.0, 0.0, 1.0,
        ];
        let read = volcanoes_of(&list);
        assert_eq!(read.len(), 2);
        assert_eq!((read[0].0, read[0].1), (10.5, 20.0));
        assert_eq!(style_of(&read[0].2), Style::Explosive { least: 6, most: 8 });
        assert_eq!(style_of(&read[1].2), Style::Effusive);
        // The form before 2026-10-30, four numbers a volcano: none.
        let old = [
            10.5, 20.0, 0.3, 2.0, 400.0, 80.0, 0.1, 0.0, 12.0, 30.0, 0.2, 3.0,
        ];
        assert!(volcanoes_of(&old).is_empty());
        assert!(volcanoes_of(&old[..8]).is_empty());
        assert!(volcanoes_of(&[]).is_empty());
    }

    #[test]
    fn the_style_is_the_settings() {
        assert_eq!(
            style_of(&volcano(2, true, true, 1.0)),
            Style::Explosive { least: 6, most: 8 }
        );
        assert_eq!(
            style_of(&volcano(2, false, true, 1.0)),
            Style::Explosive { least: 4, most: 7 }
        );
        assert_eq!(
            style_of(&volcano(0, true, true, 1.0)),
            Style::Explosive { least: 8, most: 8 }
        );
        assert_eq!(style_of(&volcano(0, false, true, 1.0)), Style::Effusive);
        assert_eq!(style_of(&volcano(1, true, true, 1.0)), Style::Effusive);
        assert_eq!(style_of(&volcano(2, true, false, 1.0)), Style::None);
        assert_eq!(style_of(&volcano(3, true, true, 1.0)), Style::None);
    }

    #[test]
    fn the_eruptions_come_as_often_as_on_the_earth() {
        // 1 000 island arcs: the earth's count. Over 1 M years some 10 000
        // VEI 6, 1 000 VEI 7, no VEI 8 (an island arc gives none).
        let arcs: Vec<Volcano> = (0..1000)
            .map(|k| volcano(2, false, true, 1.0 + (k % 3) as f64))
            .collect();
        let list = eruptions_of(7.0, &arcs, 0.0, 1_000_000.0, 25.0);
        assert_eq!(list, eruptions_of(7.0, &arcs, 0.0, 1_000_000.0, 25.0));
        let count = |vei: u8| list.iter().filter(|e| e.vei == vei).count() as f64;
        assert!((count(6) / 10_000.0 - 1.0).abs() < 0.05, "{}", count(6));
        assert!((count(7) / 1000.0 - 1.0).abs() < 0.15, "{}", count(7));
        assert_eq!(count(8), 0.0);
        assert_eq!(count(0), 0.0);
        // The thicker the likelier.
        let on = |t: f64| {
            list.iter()
                .filter(|e| arcs[e.volcano].thickness == t)
                .count() as f64
        };
        assert!(on(3.0) > 2.5 * on(1.0));
        // In time, on whole steps.
        for w in list.windows(2) {
            assert!(w[0].at <= w[1].at);
        }
        assert!(list.iter().all(|e| e.at % 25.0 == 0.0));
        // None without volcanoes, or without active ones.
        assert!(eruptions_of(7.0, &[], 0.0, 1e6, 25.0).is_empty());
        let extinct = [volcano(3, true, false, 1.0)];
        assert!(eruptions_of(7.0, &extinct, 0.0, 1e6, 25.0).is_empty());
    }

    #[test]
    fn the_large_eruptions_cool_the_world() {
        let list = [
            Eruption {
                at: 100.0,
                volcano: 0,
                vei: 6,
            },
            Eruption {
                at: 200.0,
                volcano: 0,
                vei: 7,
            },
            Eruption {
                at: 200.0,
                volcano: 0,
                vei: 8,
            },
        ];
        assert_eq!(eruption_cold(&list, 100.0), 0.0);
        assert_eq!(eruption_cold(&list, 200.0), COLD_VEI7 + COLD_VEI8);
        assert_eq!(eruption_cold(&list, 225.0), COLD_VEI8);
        assert_eq!(eruption_cold(&list, 300.0), 0.0);
    }
}

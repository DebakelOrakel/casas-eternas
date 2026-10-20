//! `climate/koppen.ts`: the Köppen–Geiger class of a place from its twelve
//! months (Peel, Finlayson and McMahon 2007), and twelve months synthesized
//! from the annual figures. Ids are stable: the save stores them; 0 is no
//! class (the sea). Not ported, because they are presentation: the
//! colours and the label keys.

use super::climate_field::top_summer_cos;

pub const KOPPEN_CODES: [&str; 32] = [
    "", "Af", "Am", "Aw", "As", "BWh", "BWk", "BSh", "BSk", "Csa", "Csb", "Csc", "Cwa", "Cwb",
    "Cwc", "Cfa", "Cfb", "Cfc", "Dsa", "Dsb", "Dsc", "Dsd", "Dwa", "Dwb", "Dwc", "Dwd", "Dfa",
    "Dfb", "Dfc", "Dfd", "ET", "EF",
];

/// The id of a class's code; panics on an unknown code.
pub fn koppen_id(code: &str) -> u8 {
    KOPPEN_CODES
        .iter()
        .position(|&c| c == code && !c.is_empty())
        .unwrap_or_else(|| panic!("no Köppen class {code}")) as u8
}

/// The code of an id, None for 0 and out of range.
pub fn koppen_code(id: u8) -> Option<&'static str> {
    (id > 0 && (id as usize) < KOPPEN_CODES.len()).then(|| KOPPEN_CODES[id as usize])
}

/// The class from twelve months: °C and mm per month, January first.
pub fn classify_koppen(t: &[f64], p: &[f64]) -> u8 {
    let (mut mat, mut map) = (0.0, 0.0);
    let (mut thot, mut tcold) = (f64::NEG_INFINITY, f64::INFINITY);
    let mut tmon10 = 0;
    let mut pdry = f64::INFINITY;
    for m in 0..12 {
        mat += t[m] / 12.0;
        map += p[m];
        if t[m] > thot {
            thot = t[m];
        }
        if t[m] < tcold {
            tcold = t[m];
        }
        if t[m] > 10.0 {
            tmon10 += 1;
        }
        if p[m] < pdry {
            pdry = p[m];
        }
    }
    let apr_sep: f64 = (3..9).map(|m| t[m]).fold(0.0, |a, b| a + b);
    let summer_apr_sep = apr_sep >= mat * 6.0;
    let mut psum = 0.0;
    let (mut psdry, mut pswet) = (f64::INFINITY, 0.0);
    let (mut pwdry, mut pwwet) = (f64::INFINITY, 0.0);
    for m in 0..12 {
        let summer = (3..9).contains(&m) == summer_apr_sep;
        if summer {
            psum += p[m];
            psdry = crate::core::js::min(psdry, p[m]);
            pswet = crate::core::js::max(pswet, p[m]);
        } else {
            pwdry = crate::core::js::min(pwdry, p[m]);
            pwwet = crate::core::js::max(pwwet, p[m]);
        }
    }
    if thot < 10.0 {
        return koppen_id(if thot > 0.0 { "ET" } else { "EF" });
    }
    let threshold = if psum >= 0.7 * map {
        2.0 * mat + 28.0
    } else if map - psum >= 0.7 * map {
        2.0 * mat
    } else {
        2.0 * mat + 14.0
    };
    if map < 10.0 * threshold {
        let desert = map < 5.0 * threshold;
        let hot = mat >= 18.0;
        return koppen_id(match (desert, hot) {
            (true, true) => "BWh",
            (true, false) => "BWk",
            (false, true) => "BSh",
            (false, false) => "BSk",
        });
    }
    if tcold >= 18.0 {
        if pdry >= 60.0 {
            return koppen_id("Af");
        }
        if pdry >= 100.0 - map / 25.0 {
            return koppen_id("Am");
        }
        return koppen_id(if psdry < pwdry { "As" } else { "Aw" });
    }
    let group = if tcold > 0.0 { 'C' } else { 'D' };
    let season = if psdry < 40.0 && psdry < pwwet / 3.0 {
        's'
    } else if pwdry < pswet / 10.0 {
        'w'
    } else {
        'f'
    };
    let heat = if thot >= 22.0 {
        'a'
    } else if tmon10 >= 4 {
        'b'
    } else if group == 'D' && tcold < -38.0 {
        'd'
    } else {
        'c'
    };
    koppen_id(&format!("{group}{season}{heat}"))
}

/// Twelve months from the annual figures: a cosine of half the range around
/// the mean, warmest in the top hemisphere's summer month; the rain the two
/// seasons of the monsoon index. Writes `t` (°C) and `p` (mm per month).
#[allow(clippy::too_many_arguments)]
pub fn synthesize_months(
    mean_c: f64,
    range_c: f64,
    annual_mm: f64,
    monsoon_index: f64,
    north: bool,
    floor_mm: f64,
    t: &mut [f64],
    p: &mut [f64],
) {
    let sign = if north { 1.0 } else { -1.0 };
    let half = (monsoon_index * (2.0 * annual_mm + floor_mm)) / 2.0;
    for m in 0..12 {
        let c = top_summer_cos(m as f64);
        t[m] = mean_c + sign * (range_c / 2.0) * c;
        p[m] = crate::core::js::max(0.0, (annual_mm + half * c) / 12.0);
    }
}

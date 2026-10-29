//! THE HISTORY PACKED (2026-10-26): a simulated history as one file, the
//! H1 artifact's (world/historyArtifacts.ts), so a world opened again with
//! the same origin loads it instead of running it — the spread, the kept
//! states, the species' cells, the lifeways, the villages, the people's
//! count, the extinctions, the log. This module writes it (since
//! 2026-10-27; `screens/incubator/historyPack.ts` wrote it before, and now
//! reads it), and the settlement of it too.
//!
//! The layout, the client's bytes: a u32 with the header's length, the
//! header (JSON, as `JSON.stringify` writes it: the plain values, and each
//! array's name, type, offset and length), padding to 8, the arrays'
//! bytes, each at an offset a multiple of 8.
//!
//! The kept states hold the cells people ever reached alone (`reached`):
//! elsewhere the people are none and the game whole, at every state. Whole,
//! they were 301 MB on Morvane, and Safari took minutes to store them; now
//! 168 MB.
//!
//! THE PEOPLES (since v3, 2026-10-29; peoples.rs Tree), after the arrays
//! above, which keep their bytes:
//! - `peopleIds{k}` u16, kept state k's people id of each cell of
//!   `reached` whose `people{k}` is over 0, in `reached`'s order (a cell with
//!   no people has no entry).
//! - By people id: `peopleParent` i32 (-1 for one of step 2's start),
//!   `peopleGroup` i32 (step 1's group), `peopleBorn` f32 and
//!   `peopleEnded` f32 (years; Infinity while it lives),
//!   `peopleMergedInto` i32 (-1 where it died out), `peopleBig` u8 (1
//!   where it had PEOPLE_LEAST people and PEOPLE_LEAST_KM2 at one kept
//!   state or more; 0 for an isolated small band, an island's, which the
//!   tree keeps as a people of its own: the chronicle tells the big ones
//!   alone).
//! - By (people, kept state it is seen at), as CSR: `peopleFrameStart`
//!   i32, one more than the peoples, the start of each one's rows; then
//!   `peopleFrame` u16 (the kept state), `peoplePeople` f32,
//!   `peopleKm2` f32, `peopleFarmers` u8 (the share in 255ths),
//!   `peopleCentre` i32 (its heart's cell).

use crate::log::Json;
use crate::simulation::SimulationResult;

/// An array of the pack, its bytes and its type's name.
pub enum Array<'a> {
    F32(&'a [f32]),
    I32(&'a [i32]),
    U8(&'a [u8]),
    U16(&'a [u16]),
    F32Owned(Vec<f32>),
    I32Owned(Vec<i32>),
    U8Owned(Vec<u8>),
    U16Owned(Vec<u16>),
}

impl Array<'_> {
    fn type_name(&self) -> &'static str {
        match self {
            Array::F32(_) | Array::F32Owned(_) => "f32",
            Array::I32(_) | Array::I32Owned(_) => "i32",
            Array::U8(_) | Array::U8Owned(_) => "u8",
            Array::U16(_) | Array::U16Owned(_) => "u16",
        }
    }

    fn len(&self) -> usize {
        match self {
            Array::F32(a) => a.len(),
            Array::I32(a) => a.len(),
            Array::U8(a) => a.len(),
            Array::U16(a) => a.len(),
            Array::F32Owned(a) => a.len(),
            Array::I32Owned(a) => a.len(),
            Array::U8Owned(a) => a.len(),
            Array::U16Owned(a) => a.len(),
        }
    }

    fn write(&self, out: &mut Vec<u8>) {
        match self {
            Array::F32(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Array::I32(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Array::F32Owned(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Array::I32Owned(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Array::U8(a) => out.extend_from_slice(a),
            Array::U8Owned(a) => out.extend_from_slice(a),
            Array::U16(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
            Array::U16Owned(a) => a
                .iter()
                .for_each(|x| out.extend_from_slice(&x.to_le_bytes())),
        }
    }

    fn byte_len(&self) -> usize {
        self.len()
            * match self {
                Array::F32(_) | Array::F32Owned(_) | Array::I32(_) | Array::I32Owned(_) => 4,
                Array::U16(_) | Array::U16Owned(_) => 2,
                Array::U8(_) | Array::U8Owned(_) => 1,
            }
    }
}

const fn pad8(n: usize) -> usize {
    (n + 7) & !7
}

/// The pack of a header's plain values (written by `plain`) and named
/// arrays (historyPack.ts pack).
pub fn pack(plain: impl FnOnce(&mut Json), arrays: &[(String, Array)]) -> Vec<u8> {
    let mut offset = 0;
    let mut placed = Vec::with_capacity(arrays.len());
    for (name, a) in arrays {
        placed.push((name, a.type_name(), offset, a.len()));
        offset = pad8(offset + a.byte_len());
    }
    let mut j = Json::default();
    j.open_object().key("json");
    plain(&mut j);
    j.key("arrays").open_array();
    for (name, type_name, at, length) in &placed {
        j.open_object()
            .key("name")
            .string(name)
            .key("type")
            .string(type_name)
            .key("offset")
            .number(*at as f64)
            .key("length")
            .number(*length as f64)
            .close_object();
    }
    j.close_array().close_object();
    let head = j.out.into_bytes();
    let start = pad8(4 + head.len());
    let mut out = Vec::with_capacity(start + offset);
    out.extend_from_slice(&(head.len() as u32).to_le_bytes());
    out.extend_from_slice(&head);
    out.resize(start, 0);
    for ((_, a), (_, _, at, _)) in arrays.iter().zip(&placed) {
        out.resize(start + at, 0);
        a.write(&mut out);
    }
    out.resize(start + offset, 0);
    out
}

/// A history packed (historyPack.ts packHistory).
pub fn pack_history(r: &SimulationResult) -> Vec<u8> {
    let mut arrays: Vec<(String, Array)> = vec![
        ("arrival".into(), Array::F32(&r.arrival)),
        ("land".into(), Array::U8(&r.land)),
        ("from".into(), Array::I32(&r.from)),
        ("crossings".into(), Array::F32(&r.crossings)),
        ("crossingWays".into(), Array::I32(&r.crossing_ways)),
        ("centres".into(), Array::F32(&r.centres)),
        ("farmAt".into(), Array::F32(&r.farm_at)),
        ("herdAt".into(), Array::F32(&r.herd_at)),
        ("villages".into(), Array::I32(&r.villages)),
        ("villageFrom".into(), Array::F32(&r.village_from)),
        ("villageTo".into(), Array::F32(&r.village_to)),
        ("population".into(), Array::F32(&r.population)),
        ("villageTown".into(), Array::F32(&r.village_town)),
        ("copperAt".into(), Array::F32(&r.copper_at)),
        ("smeltAt".into(), Array::F32(&r.smelt_at)),
    ];
    for (k, d) in r.domestications.iter().enumerate() {
        arrays.push((format!("came{k}"), Array::U16(&d.came)));
    }
    for (k, (_, cells)) in r.species.iter().enumerate() {
        arrays.push((format!("species{k}"), Array::I32(cells)));
    }
    let reached: Vec<i32> = (0..r.arrival.len())
        .filter(|&i| r.arrival[i] < f32::INFINITY)
        .map(|i| i as i32)
        .collect();
    let species_reached: Vec<Vec<i32>> = r
        .species
        .iter()
        .map(|(_, cells)| {
            cells
                .iter()
                .enumerate()
                .filter(|(_, c)| r.arrival[**c as usize] < f32::INFINITY)
                .map(|(k, _)| k as i32)
                .collect()
        })
        .collect();
    arrays.push(("reached".into(), Array::I32Owned(reached.clone())));
    for (j, at) in species_reached.iter().enumerate() {
        arrays.push((format!("speciesReached{j}"), Array::I32Owned(at.clone())));
    }
    for (k, f) in r.kept.iter().enumerate() {
        arrays.push((
            format!("people{k}"),
            Array::U16Owned(reached.iter().map(|&c| f.people[c as usize]).collect()),
        ));
        arrays.push((
            format!("small{k}"),
            Array::U8Owned(reached.iter().map(|&c| f.small[c as usize]).collect()),
        ));
        for (j, b) in f.big.iter().enumerate() {
            arrays.push((
                format!("big{k}.{j}"),
                Array::U8Owned(
                    species_reached[j]
                        .iter()
                        .map(|&at| b[at as usize])
                        .collect(),
                ),
            ));
        }
    }
    push_peoples(r, &reached, &mut arrays);
    pack(
        |j| {
            j.open_object();
            j.key("origin").number(r.origin as f64);
            j.key("start").number(r.start);
            j.key("end").number(r.end);
            j.key("climate")
                .open_object()
                .key("maxAt")
                .number(r.climate.0)
                .key("depth")
                .number(r.climate.1)
                .key("deglaciation")
                .number(r.climate.2)
                .close_object();
            j.key("extinctions").open_array();
            for e in &r.extinctions {
                j.open_object()
                    .key("id")
                    .string(&e.id)
                    .key("landmass")
                    .number(e.landmass)
                    .key("areaKm2")
                    .number(e.area_km2)
                    .key("at")
                    .number(e.at)
                    .key("cell")
                    .number(e.cell)
                    .close_object();
            }
            j.close_array();
            j.key("log").open_array();
            for e in &r.log {
                e.write(j);
            }
            j.close_array();
            j.key("species").open_array();
            for (id, _) in &r.species {
                j.string(id);
            }
            j.close_array();
            j.key("frames").number(r.kept.len() as f64);
            j.key("domestications").open_array();
            for d in &r.domestications {
                j.open_object()
                    .key("kind")
                    .string(if d.plant { "plant" } else { "animal" })
                    .key("id")
                    .string(&d.id)
                    .key("cell")
                    .number(d.cell)
                    .key("at")
                    .number(d.at)
                    .close_object();
            }
            j.close_array();
            j.close_object();
        },
        &arrays,
    )
}

// THE PEOPLES' arrays (see the module's head), after the others.
fn push_peoples<'a>(
    r: &'a SimulationResult,
    reached: &[i32],
    arrays: &mut Vec<(String, Array<'a>)>,
) {
    let tree = &r.tree;
    assert_eq!(
        tree.ids.len(),
        r.kept.len(),
        "the tree's states are the kept states"
    );
    for (k, ids) in tree.ids.iter().enumerate() {
        let lived = reached
            .iter()
            .filter(|&&c| r.kept[k].people[c as usize] > 0)
            .count();
        assert_eq!(
            ids.len(),
            lived,
            "a kept state's ids are its reached cells with people"
        );
        arrays.push((format!("peopleIds{k}"), Array::U16(ids)));
    }
    let p = &tree.peoples;
    let mut start = Vec::with_capacity(p.len() + 1);
    start.push(0i32);
    for q in p {
        start.push(start[start.len() - 1] + q.frames.len() as i32);
    }
    let frames = || p.iter().flat_map(|q| q.frames.iter());
    arrays.extend([
        (
            "peopleParent".into(),
            Array::I32Owned(p.iter().map(|q| q.parent).collect()),
        ),
        (
            "peopleGroup".into(),
            Array::I32Owned(p.iter().map(|q| q.group).collect()),
        ),
        (
            "peopleBorn".into(),
            Array::F32Owned(p.iter().map(|q| q.born as f32).collect()),
        ),
        (
            "peopleEnded".into(),
            Array::F32Owned(p.iter().map(|q| q.ended as f32).collect()),
        ),
        (
            "peopleMergedInto".into(),
            Array::I32Owned(p.iter().map(|q| q.merged_into).collect()),
        ),
        (
            "peopleBig".into(),
            Array::U8Owned(p.iter().map(|q| q.big() as u8).collect()),
        ),
        ("peopleFrameStart".into(), Array::I32Owned(start)),
        (
            "peopleFrame".into(),
            Array::U16Owned(frames().map(|f| f.frame as u16).collect()),
        ),
        (
            "peoplePeople".into(),
            Array::F32Owned(frames().map(|f| f.people).collect()),
        ),
        (
            "peopleKm2".into(),
            Array::F32Owned(frames().map(|f| f.km2).collect()),
        ),
        (
            "peopleFarmers".into(),
            Array::U8Owned(
                frames()
                    .map(|f| (f.farmers as f64 * 255.0 + 0.5) as u8)
                    .collect(),
            ),
        ),
        (
            "peopleCentre".into(),
            Array::I32Owned(frames().map(|f| f.centre).collect()),
        ),
    ]);
}

/// A history's settlement packed (settle.rs settle_history), for the
/// client's worker to read as it reads a history: the arrays by their
/// TypeScript names, the first trade in the header (`{"trade":…}` or
/// `{"trade":null}`).
pub fn pack_settled(s: &crate::settle::Settled) -> Vec<u8> {
    let arrays: Vec<(String, Array)> = vec![
        ("lifeway".into(), Array::U8(&s.lifeway)),
        ("density".into(), Array::F32(&s.density)),
        ("fishOk".into(), Array::U8(&s.fish_ok)),
        ("farmSuit".into(), Array::F32(&s.farm_suit)),
        ("herdSuit".into(), Array::F32(&s.herd_suit)),
        ("fishSuit".into(), Array::F32(&s.fish_suit)),
        ("carrying".into(), Array::F32(&s.carrying)),
        ("sources".into(), Array::I32(&s.sources)),
        ("links".into(), Array::F32(&s.links)),
    ];
    pack(
        |j| {
            j.open_object().key("trade");
            match &s.trade {
                Some(e) => e.write(j),
                None => {
                    j.number(f64::NAN);
                }
            }
            j.close_object();
        },
        &arrays,
    )
}

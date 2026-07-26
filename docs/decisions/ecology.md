---
summary: The Ecology panel — a derived resource/suitability layer after Hydrology, before the (later) Anthropology layer. Computes named resource fields (subsistence, material, prestige) from the existing physical world, aggregated into a carrying-capacity suitability field. Design decided across four themes; not built.
date: 2026-07-26
status: designed (all 4 themes decided) — not built
---

# Ecology panel

Follows tectonics → erosion → climate → hydrology in the world-gen pipeline, and
feeds the (later) **Anthropology** layer that seeds human settlements (see
`anthropology.md`). Turns the finished physical/biotic world into a **resource /
suitability** layer: where the food, materials, and prestige goods are, and how
habitable each place is.

**Panel name: "Ecology" — tentative** (also on the table: Resources, Biosphere).

**Key principle: a function, not a simulation.** No simulated flora/fauna — most
of it is a weighted combination of fields that already exist (climate, biomes,
rivers/lakes, ocean currents/SST, elevation/relief, volcanic & tectonic
markers). It's the same shape as the climate step (many derived fields → biomes).

## Guiding split (with Anthropology)

**Ecology = *what is on the land*** (how much of each resource exists, how it's
distributed). **Anthropology = *how people respond*** (what they value, where
they settle). This decides where every knob lives and prevents duplicate
sliders. Consequences:

- The **settle threshold** ("how marginal a place people will still settle")
  lives in Anthropology, not here — so Ecology's carrying-capacity knob only
  scales the *level* of the field, and the "more marginal land becomes
  settle-able" effect emerges downstream.
- **Marine ↔ terrestrial bias** and **Wild ↔ cultivated (domestication)** are
  human-response axes → they live in the Anthropology panel, not Ecology.

## Resources by *role*

Three distinct roles feed different downstream effects:

1. **Subsistence — sets *how many* people (carrying capacity).** Arable land,
   fresh water, fish, wild game/forage, pasture. Gold is worth *zero* here.
2. **Material — sets *what they can do* (tech + building).** Timber/charcoal,
   salt, tool-stone, metals. A **separate channel** from carrying capacity
   (Anthropology consumes it for tech/trade) — *except salt* (see Theme 3).
3. **Prestige — sets *social complexity*** (elites, hoarding, long-distance
   contact). Gold, silver, gems. No survival value; its **own channel** feeding
   inequality/centre formation.

## Derivable from existing fields

| Signal | Derived from | New work |
|---|---|---|
| Arable land / soil fertility | biome + precip + slope (elevation) + floodplain (rivers) + **volcanic soils** (volcanic markers) | weighting fn |
| Fresh water | rivers / lakes | free |
| Fish stocks | ocean currents + SST → **upwelling** = fisheries; + shelf; + freshwater (rivers/lakes) | weighting fn |
| Wild game / forage | biome productivity (NPP-ish) | weighting fn |
| Pasture | grassland biomes | free-ish |
| Timber | forest biomes | free-ish |
| Salt | arid coasts (evaporation) + rock salt (geology) | weighting fn |
| Metals / ore | tectonic history (arcs, sutures, cratons, wetlands) | see Theme 3 |
| Transport / mobility | coast + river = cheap; mountain/desert = costly | cost fn |
| Defensibility | relief / steepness | free-ish |

---

# Decisions (four themes)

## Theme 1 — carrying capacity & concentration (the two top-level sliders)

- **Carrying capacity — reiner Gain.** A single global multiplier on the
  aggregate suitability field (%-slider, ~50–200 %, default 100 %). Scales the
  *level* only; the settle threshold lives in Anthropology (no duplicate
  threshold logic).
- **Orthogonality convention.** Apply as **normalise → gamma (shape) → gain
  (level)**, gamma stage **mean-preserving**, so Carrying-capacity changes
  *only* level and Concentration *only* shape.
- **Concentration — HYBRID.** Two layers:
  - **L1 — contrast/gamma on the physics-derived field** (mean-preserving), so
    clumping follows geography (river+coast+climate coincidences stand out).
    This is the single **top-level "Concentration" slider**.
  - **L2 — a "province" layer** adding beyond-climate richness: **feature-driven
    + light noise** — mainly **volcanic-soil fertility provinces from the
    existing volcano markers** (`collectVolcanoes`), plus a light low-frequency
    seeded noise texture for organic variation not covered by a feature. L2
    modulates the **organic/subsistence** aggregate only (metals/salt cluster
    geologically, Theme 3). Controlled in the **fold-out** — no second top-level
    slider.
  - **Combine:** `normalise → L1 gamma → L2 province (mean-1 multiplicative) →
    gain`; everything mean-preserving except the gain.

## Theme 2 — subsistence (fish · game · pasture)

The organic food sources that, with arable land (in carrying capacity), make up
the **subsistence aggregate**:

- **Fish** — coastal upwelling (currents + SST) + shelf (shallow coastal) +
  freshwater (rivers/lakes). *High density but narrow* → coasts & river mouths
  are hotspots.
- **Game / forage** — biome productivity (NPP-ish). *Broad but low.*
- **Pasture** — grassland/savanna grazing. *Low density but extends habitability
  into marginal steppe* farming can't use.

- **Combination — saturating.** Sources complement with diminishing returns (not
  linear sum, not max). Coasts-with-farmland rich but not absurd; variety
  rewarded, stacking saturates.
- **Ecotone bonus for game — yes.** Biome boundaries (forest↔grassland,
  land↔wetland) get a game bonus; ecologically correct, rewards varied terrain.
- Fold-out ± weight nudges per fish/game/pasture (simple multipliers).

## Theme 3 — material (timber · salt · tool-stone · metals)

**Structural:** material resources feed a **separate channel** (tech/building/
trade, consumed by Anthropology), **not** carrying capacity — *except salt*.

- **Timber** — forest biomes. Construction + fuel + **charcoal for smelting**.
  (Deforestation dynamic = runtime, parked.)
- **Salt** — arid coasts (evaporation salt-pans) + rock salt (geology). **Dual
  role:** trade good **and** a small local **carrying-capacity multiplier**
  (preservation → more effective food → denser settlement). The one sanctioned
  material→subsistence bleed.
- **Tool-stone** — kept in v1. Flint (sedimentary) + obsidian (volcanic, from
  the markers). Early traded good, Neolithic texture.
- **Metals** — copper, tin, iron (gold/silver/gems are Prestige, Theme 4).
  Bronze = copper **+** tin; iron separate. Do **not** feed carrying capacity
  (tech input). Fold-out: ore richness (global) + tin/bottleneck rarity.

**Metals grounding — full geological association.** Each metal keyed to its own
tectonic provenance:

- **Copper** → subduction arcs / volcanic boundaries (arc-volcano markers).
- **Tin** → granite roots of collision belts (raft-merge sutures). **Rare &
  clustered — the feature:** few deposits → drives long-distance trade.
- **Iron** → old craton interiors (old rafts) + **bog iron** in wetlands.
  **Common — the point:** iron's ubiquity is *why* it democratised metal.

> **Recon result (2026-07-26 — resolved, full-geological confirmed feasible).**
> The Ecology step runs in the worker with full access to `sim` (like
> `computeClimate`/`computeHydrology`). Data status per source:
>
> - 🟢 **Copper (arcs):** available — `sim.features` with `volcanic===true` +
>   `sim.hotspots`; `collectVolcanoes()` already extracts them.
> - 🟡 **Tin / gold-lode / gems-metamorphic (collision sutures):** the suture
>   geometry (`RaftMergeEvent`: x, y, tangent) is computed every epoch in
>   `mergeOverlappingRafts` but **thrown away** (only forwarded as a fading
>   overlay marker); fold-mountain *features* persist but get pruned after ~150
>   idle epochs, so deep-time orogens are lost. **Fix (PREREQ P1): cache them** —
>   a persistent `sim.sutures` list, appended each merge (+ epoch stamp), added
>   to the save snapshot. Cheap.
> - 🔴→✅ **Iron (old cratons):** no crust age was tracked. **DECIDED (PREREQ
>   P2): per-blob `birthEpoch`** on `RaftBlob` — initial craton blobs = 0
>   (oldest), accreted margin blobs = `sim.epoch` (young). Gives the real
>   old-interior/young-margin gradient; static (no per-epoch cost); rides the
>   existing raft serialization. (Rejected a continental-age raster: same
>   *information*, but per-epoch advection cost + desync risk for a provenance
>   field — no realism gain.)
> - 🟢 **Iron bog / wetlands, and rock salt basins:** not an explicit sim type,
>   but **derivable** in Ecology from hydrology (low slope + high water-strength/
>   near-lake + poor drainage + moisture > evaporation). A weighting fn, not
>   missing data.
> - 🟢 **Placer gold, salt evaporation, gems arid-weathering:** rivers +
>   climate aridity (`evaporationPotential`, existing salt-lake logic) + coast.

## Theme 4 — prestige (gold · silver · gems)

**No survival value, no carrying capacity, no tech input.** Prestige feeds its
**own channel** for social complexity (elites, hoarding, inequality, long
contact) that Anthropology consumes. Ecology only places the goods.

- **Gold** — placer in rivers (cheap, reuses the river network) + lode gold at
  orogenic sutures.
- **Silver** — hydrothermal / volcanic (arc markers); historically with lead
  (galena), but lead isn't modelled separately.
- **Gems** — metamorphic / orogenic zones (collision belts) + arid weathering
  (turquoise near copper). Big long-distance prestige trade (lapis, etc.).
- **Character — rare & clustered** by default: *that's the prestige point*.
- **Fold-out — per-good knobs** (gold / silver / gems separately).

---

# Final control layout

**Top-level (always visible), 2 sliders:**

- **Carrying capacity** (barren ↔ lush) — global gain on the subsistence
  aggregate.
- **Concentration** (even ↔ clumped) — L1 contrast/gamma on the physics field.

**Fold-out (behind a button), grouped by role:**

- **Spatial (advanced):** province strength (+ maybe province size) for the L2
  hybrid layer.
- **Subsistence:** fish · game · pasture (± weight).
- **Material:** timber · salt · tool-stone · **Metals** submenu (ore richness +
  tin/bottleneck rarity).
- **Prestige:** gold · silver · gems (± richness/rarity each).

**Specialisation** (generalist ↔ specialist) — a real 4th spatial axis
(per-location diversity, de-correlating the fields), but subtle → **back-pocket /
future fold-out**, not in v1.

# Implementation plan

Phase 0 (recon) done — see the recon result under Theme 3. Then:

**Prereqs (small sim-data plumbing) — ✅ DONE + verified 2026-07-26:**

- **P1 — suture cache.** ✅ `sim.sutures: Suture[]` (`{x, y, tangentX,
  tangentY, epoch}`, type in rafts.ts), appended in `stepEpoch` where
  `raftMerges` is produced; in the snapshot + serialize/deserialize
  (`?? []` for old saves). (Tin / gold-lode / gems provenance.)
- **P2 — blob `birthEpoch`.** ✅ Optional field on `RaftBlob`; set in
  `generateInitialRafts` (0 = oldest craton) and `accreteToNearestRaft`
  (`sim.epoch` = young margin). Rides raft serialization; missing = 0 for old
  saves. (Iron / craton age.)
- Verified headless: birthEpoch gradient populates (craton 0 / accreted margins
  up to near current epoch), sutures accumulate + persist, determinism
  unchanged (no RNG touched), save round-trip + legacy fallback both OK.

**Ecology feature:**

1. **Vertical slice** — ✅ BUILT 2026-07-26 (pending visual check). New
   `ecology/ecologyField.ts` (`computeEcology`) + `ecology/ecologyColors.ts`;
   worker `computeEcology` message + handler; Ecology **panel** (index 5) with
   the **2 top sliders** (carrying capacity 50–200 %, concentration −100…+100);
   carrying-capacity **overlay** (auto-on in the panel) + gradient legend + hover
   readout. Phase-1 base = terrestrial productivity (Miami-model NPP); the full
   concentration pipeline (`normalise → L1 gamma → L2 volcanic-province+noise →
   gain`) is in and headless-verified (mean-preserving level, gain-linear,
   concentration reshapes). Icon = placeholder `crown.png` (swap later).
   *(Fish/game/pasture split + material + prestige + fold-out = Phase 2.)*
2. **Resource fields** — fill in the named fields, presented via a **panel
   selector** (DECIDED: one Ecology overlay in the toolbar; a `<select>` in the
   panel, grouped by role, picks which field it paints — resolves the
   aggregate-vs-per-resource-overlay provocation). Sub-steps:
   - **2a — subsistence split** ✅ BUILT 2026-07-26 (pending visual check):
     arable (NPP × flatness) / game (NPP + ecotone) / pasture (biome) → the
     saturating carrying-capacity aggregate. Field-registry architecture
     (`ecologyField` returns named fields; `ecologyColors` holds per-field
     label/role/ramp; message carries `fields[]`); selector + dynamic legend +
     per-field hover; worker caches biomes. Headless-verified (fields
     ocean-consistent, pipeline still mean-preserving/gain-linear).
   - **2b — fish** ✅ BUILT 2026-07-26 (pending visual check): marine (coastalness
     × shelf-base + upwelling from adjacent-ocean current strength) + freshwater
     (big rivers via discharge + lake presence), saturating; a 4th subsistence
     source in the carrying-capacity combine. Worker caches currents; ecology now
     also reads hydrology (discharge/lakeDepth, optional → marine-only fallback);
     ecology panel ensures hydrology + re-triggers ecology when it lands.
     `computeEcology` refactored to an inputs object. Headless-verified (coastal
     ≫ interior fish, freshwater adds interior, marine-only fallback).
   - **2c — material** ✅ BUILT 2026-07-26 (pending visual check): timber (biome),
     salt (arid coasts/interior; + small carrying-cap preservation bonus — the
     one sanctioned material→subsistence bleed), tool-stone (obsidian from
     volcanoes + flint baseline), and full-geological metals — **copper** (arc
     volcanoes), **tin** (collision sutures = `sim.sutures`, tight radius →
     rare/clustered), **iron** (old-craton oldness from blob `birthEpoch` via new
     `rafts.computeCratonOldnessField`, + bog iron in derived wetlands). Material
     is a separate channel (doesn't feed carrying capacity, except salt). Worker
     passes sutures + a coarse craton-age field. Distinct per-metal colour ramps.
     Headless-verified (copper@arc, tin@suture, iron@old-craton + bog, all 11
     fields ocean-consistent, carrying capacity still mean-preserving).
   - **2c fixes (visual review):** (1) **iron** read as a flat 100% (craton is
     old ~everywhere → uniform); added seeded *deposit noise* so it stays common
     but fluctuates (banded-iron style). (2) **tin** was invisible — sutures are
     stored at FIXED world coords but the crust drifts (~3–4px/epoch), so old
     sutures end up offshore and get masked out. Fixed two ways: sutures now
     **advect with the plate they sit on** each epoch (stepEpoch), and tin is
     now sourced from **current fold-mountain features (`collectOrogens`,
     on-crust) + the advected sutures** (`orogenPoints`), not fixed sutures
     alone. (Suture advection only helps going forward; existing saves' sutures
     stay stale, but tin still shows via the on-crust fold-mountains.)
   - **2d — prestige** ✅ BUILT 2026-07-26 (pending visual check): gold (placer
     from rivers + lode at orogens), silver (hydrothermal at volcanic arcs), gems
     (metamorphic at orogens + arid weathering / turquoise near copper). Separate
     channel — none feed carrying capacity. Rare & clustered. 14 fields total;
     headless-verified (gold@river+orogen, silver@arc, gems@orogen, ocean-
     consistent).
   - **2e — fold-out** ✅ BUILT 2026-07-26 (pending visual check): a "Details"
     toggle reveals a full-width wrapping sub-row of per-role nudge sliders
     (config-generated): **Spatial** (province strength), **Subsistence** (fish/
     game/pasture weights), **Material** (timber/salt/tool-stone weights + ore
     richness → copper/tin/iron + tin rarity → tightens tin radius), **Prestige**
     (gold/silver/gems weights). Weights scale each field (subsistence + salt
     flow into carrying capacity). `EcologyParams` gained `weights`/`tinRarity`;
     worker message carries them. Headless-verified (weights scale fields, tin
     rarity tightens, province mean-preserving).

**Phase 2 COMPLETE** — all 14 fields + selector + fold-out built.

**Tuning (2026-07-26, visual review):**
- **All ecology overlays now ABSOLUTE** (not self-normalised) — a uniform weight/
  gain/strength change was invisible under max-normalisation, so the fold-out
  knobs "did nothing." Fixed by dropping the per-field normalisation.
- **Carrying-capacity recalibration:** the saturating weights were too high →
  carrying capacity sat near 1 everywhere (all lush green), hiding both the level
  knob and the province mottling. Halved-ish (W_ARABLE 2.6→1.1, FISH 1.4→0.6,
  GAME 1.0→0.45, PASTURE 0.8→0.35, SALT_CC 0.35→0.15) → mean ~0.4, spans the
  whole ramp (desert ~0.1 … rich coast ~0.8).
- **Province layer strengthened:** smooth value-noise has low variance, so it was
  a ~8% effect. Noise/volcanic weights raised (→ ~20% mean cell change at the
  default 0.45 strength, ~45% at 1.0), freq 11×6, default strength 0.35→0.45.

**Fold-out UI rework (2026-07-26, user request):** replaced the single "Details"
fold-out + "Show" dropdown with **category icon-buttons** (Subsistence=wheat.png,
Material=ecology.png, Prestige=crown.png) in the base row. Clicking one reveals
that category's **per-field abundance sliders** (each with its resource icon —
fish/deer/copper_ore/…) in the sub-row, radio-style. **Hover a slider (or its
icon) → the overlay previews that field** (replaces the dropdown; sticky). Province
strength promoted to a main slider (with carrying capacity + concentration; all
three preview the aggregate on hover). Per-metal weights replaced the shared
"ore richness"; tin-rarity radius knob dropped (per-field weights instead).

Remaining: Phase 3 polish (world.yaml save/load of ecology params) + the parked
overlay-bar-categories rework.
3. **Polish** — legends, colours, world.yaml fields, save/load, wetlands
   derivation, title-screen mission bullet.

# Provocations to resolve later

- **Fertility is tech-dependent.** Neolithic farmers favour light, easily-worked
  soils (loess, riverbanks); heavy floodplain clay and dense forest only
  "unlock" with later tech (iron plough, clearing). If Anthropology's dispersal
  has a time axis, the suitability field should **evolve with the tech epoch** —
  a genuine link between Ecology and the Anthropology time axis.
- **Aggregate vs per-resource overlays.** ✅ RESOLVED 2026-07-26: compute all
  named fields; present via a **panel selector** (one Ecology overlay icon, a
  `<select>` grouped by role picks the displayed field) rather than many toolbar
  icons. Anthropology still consumes the aggregate carrying capacity.
- **Charcoal / deforestation depletion** (iron smelting strips forests) is a
  *dynamic* — probably runtime, not generation.

# Open

- Panel name: "Ecology" vs "Resources" vs "Biosphere" (UI is English).

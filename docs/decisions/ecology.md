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

> **Feasibility note (implementation):** full-geological needs the ecology step
> to see more than the current render exposes. Arc volcanoes/hotspots and
> boundary masks exist; but **tin (collision sutures)** and **iron (craton age)**
> need the sim to surface **raft-merge/suture zones** and **raft/crust age**, and
> iron/salt need **wetland** flags. Confirm these are derivable (raft merge
> history + raft age + hydrology wetlands) or plan to expose them. If any is
> impractical, fall back to the simplified coupling (cluster near boundaries +
> per-metal rarity) for *that* metal only. **Check this first when building.**

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

# Provocations to resolve later

- **Fertility is tech-dependent.** Neolithic farmers favour light, easily-worked
  soils (loess, riverbanks); heavy floodplain clay and dense forest only
  "unlock" with later tech (iron plough, clearing). If Anthropology's dispersal
  has a time axis, the suitability field should **evolve with the tech epoch** —
  a genuine link between Ecology and the Anthropology time axis.
- **Aggregate vs per-resource overlays.** Anthropology consumes a weighted
  *aggregate* suitability, but the game (and visual interest) wants individual
  named resource fields (ore, salt, fish) as overlays. Likely: compute a handful
  of named fields (cheap), show as overlays, aggregate for dispersal — mirrors
  climate. **(Resolve when we hit it.)**
- **Charcoal / deforestation depletion** (iron smelting strips forests) is a
  *dynamic* — probably runtime, not generation.

# Open

- Panel name: "Ecology" vs "Resources" vs "Biosphere" (UI is English).

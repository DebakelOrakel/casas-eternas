---
summary: A categorized, human changelog under docs/changelog/ — NOT the git commit log. One file per area (worldgen, ui, mechanics, concepts, decisions, platform), each listing roughly when a feature was added / changed / dropped / fixed, with dates. Seeded retroactively from the 79 commits of 2026-07-20..28 and the decision docs, then grown by hand. Distinct from the title screen's mission list, which is a "what it can do now" snapshot.
date: 2026-07-28
status: decided — not built
---

# Changelog (categorized)

A changelog that answers "**when** did this arrive", organized by area — not the commit log,
and not a snapshot of current capability. Decided alongside the localization work (see
[localization.md](./localization.md)); it shares that work's area namespace and, later, the
documentation pipeline's anchors (see [documentation-architecture.md](./documentation-architecture.md)).

## Layout

One file per area, descending by date. The areas pick up the four i18n areas and add the axes
those don't have (decisions, setting, platform):

```
docs/changelog/
  README.md      format, categories, upkeep rule
  worldgen.md    simulation layers: tectonics, erosion, climate, hydrology, ecology
  ui.md          controls, overlays, rendering, save/load
  mechanics.md   game mechanics — empty for now, grows from the game screen on
  concepts.md    setting & world concepts (species, factions, docs/ideas)
  decisions.md   when a decision was taken — and when it was revised
  platform.md    build, worker pool, deploy, performance
```

## Entry format

Date, kind of change, one sentence, optional area-key back-reference into the same namespace
as the i18n keys / doc anchors:

```md
## 2026-07-28
- **new** Archean core — the genesis sliders start a short Archean simulation; crust nuclei
  form only where it is hot *and* ocean. `worldgen.panel.genesis`
- **changed** Crust sink — land is now conserved instead of growing unbounded; rafts run
  real cycles. `world.event`
- **dropped** Braun-Willett routing — too subtle against the existing clamp.
```

Four kinds: **new**, **changed**, **dropped**, **fixed**. "dropped" is deliberately included —
the abandoned attempts (Braun-Willett incision, the erosion deposition budget) are exactly
what one goes looking for months later.

## Retroactive seeding

Filled from the 79 commits (2026-07-20..28) plus the 11 documents in
[docs/decisions/](.). The commit titles are unusually clean ("Implement whittaker biomes",
"Rework continents as rafts not as plates") and transfer almost directly; date = commit date,
which satisfies the "roughly when" bar. Rough distribution: worldgen ~40, ui ~20, decisions
~11, platform ~6, concepts ~2.

## Relation to the title-screen mission list

The mission/backlog list on the title screen stays what it is — a snapshot of "what it can do
now". The changelog answers "when did that arrive". Two questions, two places; the mission
list is kept current as before (and is localized EN-only via `common.title.mission.*`, see
[localization.md](./localization.md)).

## Forward hook (not a dependency)

The later documentation pipeline reads these files as one more Markdown source — same area
IDs, same anchors. No dependency on that pipeline is created here; the changelog is useful
standalone from day one.

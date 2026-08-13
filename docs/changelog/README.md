# Changelog

A **categorized, human** changelog — not the git log, and not a snapshot of current
capability. It answers "*when* did this arrive", grouped by area. See the decision behind it:
[docs/decisions/grouped-changelog.md](../decisions/grouped-changelog.md).

## Files (one per category)

| File | Covers |
|---|---|
| [worldgen.md](./worldgen.md) | Simulation layers: tectonics, crust, erosion, climate, hydrology, volcanism, ecology, elevation |
| [ui.md](./ui.md) | Controls, overlays, rendering, save/load, notifications |
| [mechanics.md](./mechanics.md) | Game mechanics — empty for now, grows from the game screen on |
| [concepts.md](./concepts.md) | Setting & world concepts (species, factions) |
| [platform.md](./platform.md) | Build, worker pool, deploy, performance, code structure |

> There is no `decisions` file here. Decisions are self-dating — every doc in
> [`docs/decisions/`](../decisions/) carries its own `date`/`summary`/`status` — so a
> date-ordered decisions overview is *generated* from that front matter, not hand-maintained.

## Entry format

Newest date first. Each entry: a **kind**, an optional concept/panel **label** + colon, one
sentence, and an optional area-key back-reference into the same namespace as the i18n keys /
doc anchors (see [localization.md](../decisions/localization.md)).

```md
## 2026-07-28
- **new** Genesis: Archean core — the genesis sliders start a short Archean simulation. `worldgen.panel.genesis`
- **changed** Crust: the crust sink — land is now conserved instead of growing unbounded. `world.event`
- **dropped** Erosion: Braun-Willett routing — too subtle against the existing clamp.
```

The **label** is the pipeline concept or panel the entry belongs to — `Genesis`, `Tectonics`,
`Crust`, `Volcanism`, `Erosion`, `Climate`, `Biomes`, `Hydrology`, `Ecology`, `Migration`,
`Elevation`, `Topology` (worldgen); `Overlays`, `Rendering`, `Save/Load`, `Notifications`,
`Layout`, `Title screen` (ui); `Workers`, `Deploy`, `Performance`, `Structure`, `Build`
(platform). Omit it only when an entry belongs to no single one.

Four kinds:

- **new** — a capability that did not exist before.
- **changed** — reworked, tuned, or recalibrated.
- **dropped** — tried and removed. Kept on purpose: the abandoned attempts are what one goes
  looking for months later.
- **fixed** — a bug.

## Upkeep

Add an entry when a feature lands, changes, is dropped, or is fixed — the same moment you'd
update the title-screen mission list (which is a "what it can do *now*" snapshot; this is
"*when* it arrived"). Dates are "roughly when"; commit-date precision is fine. Seeded
retroactively on 2026-07-28 from the project's first 84 commits and the decision docs.

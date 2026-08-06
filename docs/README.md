# docs/

Internal developer documentation — English, never shipped. The layout (and the
one *planned* player-facing addition) is decided in
[decisions/documentation-architecture.md](./decisions/documentation-architecture.md).

## Folders

| Path | What it holds |
|---|---|
| [vision.md](./vision.md) | The Vision™ — a **human document**, not maintained by tooling or agents. |
| [decisions/](./decisions/) | One doc per decided fork: the options, the chosen answer, and why. Self-dating via front matter. |
| [design/](./design/) | How pieces fit together, and directions from design discussions — architecture notes and idea sketches that may precede any decision. Docs grow over time. |
| [changelog/](./changelog/) | Categorized human changelog ("*when* did this arrive"), one file per area — see its own [README](./changelog/README.md). |
| `content/` | *Planned, not yet created:* player-facing manual source, multilingual (`en/`, `de/`), anchor IDs shared with the i18n key namespace. |

## decisions/ vs. design/

A **decision** records a specific fork with options and a chosen answer — it has a
`status` and is mostly done when written. A **design** doc is the living
counterpart: architectural overviews (how worldgen splits across client/server)
or the essence of a design discussion whose status may still be "idea, nothing
decided". When a design direction hardens into a real fork, the choice gets its
own doc in `decisions/`.

## Front matter convention

Every doc in `decisions/` and `design/` starts with:

```yaml
---
summary: One or two sentences — enough to decide whether to open the doc.
date: 2026-07-28
status: decided | direction agreed, not yet implemented | idea — nothing decided or built | …
---
```

`status` is free-form but honest. This front matter is data: a date-ordered
decisions overview is a *generated view* over it, never a hand-maintained list
(see [decisions/grouped-changelog.md](./decisions/grouped-changelog.md)).

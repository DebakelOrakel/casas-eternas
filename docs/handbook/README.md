# docs/handbook/

The player's handbook — the source the generator's handbook panel shows
(and, later, the doc site). Decided in
[decisions/documentation-architecture.md](../decisions/documentation-architecture.md),
addendum (4). Built by `client/scripts/handbook.ts` into the client bundle.

## Layout

One directory per locale, identical paths = translations of each other. A
page missing in `de/` falls back to `en/`. Below the locale, one directory
per KIND of page — the panel's three bookmarks:

- `steps/` — one page per generator step, anchor `generator.step.<id>`.
- `concepts/` — what the steps share, one page each, anchor
  `generator.concept.<file>` (or the catalog key, where the concept has
  one: `resource.carryingCapacity`). A concept stands on its own page and
  is INCLUDED in the steps that need it, never copied into them.
- `overlays/` — optional. A layer's page is made from the overlay catalog
  (`overlay.<id>.label` and `.help`, the words of the layer's hover card);
  a file `overlays/<id>.md` with anchor `overlay.<id>` adds text below
  that sentence where one sentence is not enough.

## A page

```markdown
---
title: World
anchor: generator.step.world
order: 0
---

Intro: two or three sentences.

## What this step does {#does}

## Concepts {#concepts}

### Seed {#generator.world.seed}
```

- `anchor` is the page's address: the catalog base of what it explains
  (for a step, `generator.step.<id>`).
- `order` sorts the steps; concepts and layers sort by title.
- A heading may end in `{#id}`, which becomes its id.
- A paragraph that is only `{{concept <file>}}` includes `concepts/<file>.md`
  as a card whose title leads to the concept's page. A concept's text must
  therefore read on its own: no "this step".

## Anchors

A concept's heading carries **its catalog key** — the same string as the
control's `data-help`. That is the whole mapping: a help card for
`generator.world.seed` finds its section by looking the key up, with no
second table.

- One concept, one anchor, in one page per locale; the build fails on a
  key used twice.
- A plain id without a dot (`does`, `concepts`) is local to its page.
- **Anchors are a public interface.** Renaming one breaks every link into
  it; a rename goes through a redirect, not search-and-replace.
- The overlays of a step are not written here. The panel lists them from
  the step table (`client/src/screens/generator/steps.ts`) and the overlay
  catalog, each leading to the layer's page.

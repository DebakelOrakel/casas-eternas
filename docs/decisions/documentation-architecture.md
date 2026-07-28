---
summary: The docs pipeline sketched in notes.md bundles two separable deliverables — an in-game manual (the valuable one) and a public website (deferrable marketing chrome). Starlight only ever serves the website, and it is NOT embeddable in the Vanilla-TS/Babylon Vite client anyway (it's an Astro integration owning its own build). Decision: DEFER the public site entirely; build the in-game manual in-project on unified/remark (which you need regardless); do NOT adopt a second framework for a not-yet-needed artifact. Starlight-vs-homegrown is re-decided only if/when a public site becomes real. What IS decided now: the source layout and the anchor IDs (which reuse the i18n key namespace).
date: 2026-07-28
status: decided (source layout + anchors; defer both site AND manual) — no toolchain adopted
---

# Documentation architecture (source layout & anchors)

`notes.md` sketches a documentation pipeline: one Markdown tree feeding both an **in-game
manual** (via a remark→JSON build step) and a **public website** (Astro Starlight), plus
player **notes / suggestions** against the later Go server. This records what is decided now
and, deliberately, what is not.

## Reframe: two separable deliverables, not one "docs site"

The Starlight question is mostly a distraction. There are two deliverables that keep getting
bundled:

1. **In-game manual** — Markdown → the game's own Babylon/DOM components, rendered inside the
   client. This is the part with value while development is local.
2. **Public website** — Markdown → static HTML for SEO / sharing. This is marketing chrome for
   a game that does not exist yet.

Starlight can only ever be (2); it contributes **nothing** to (1). So the real question is not
"which SSG" but **"do I need a public docs website at all right now?"** — and for an
unreleased, locally-developed game the honest answer is *not yet*.

## Starlight only shares your *source*, not your *rendering*

Even granting a future public site, Starlight is not embeddable in the client: it is an Astro
*integration* presupposing an Astro project that owns routing and the build. Astro uses Vite
internally, but the wrong way round — Astro owns the Vite config, not the reverse — so a
plain-TS/Babylon Vite app cannot mount it. The most it can be is a **separate build that
shares the Markdown source** (Astro 5's `glob()` loader reads straight from the repo — no copy,
no sync).

But "shares the source" is the ceiling, and that is the decisive point. Starlight re-parses the
same Markdown its own way, in a parallel universe; it shares nothing with the in-game manual's
renderer. A custom directive like `:tooltip[stamina]` would have to be implemented twice.

A homegrown emitter inverts that. The `unified` → `remark` → `hast` pipeline is needed for the
manual **regardless** — no SSG helps there. A static-site emitter is then just a *second thin
consumer of the same hast tree*: one emitter walks it into DOM components (game), the other into
HTML strings (site). Same transform, same directives, same anchor logic → manual and site stay
consistent **by construction**. That is more unified than Starlight, not less.

```
docs/content/**/*.md ──▶ unified/remark ──▶ hast ──┬──▶ DOM-component emitter ──▶ in-game manual
                                                   └──▶ HTML emitter (+ Pagefind) ──▶ static site
```

## What Starlight would give — and why it is not worth it yet

Its value is real but is **all website chrome**, none of it touching the manual: file-tree
sidebar, prev/next, TOC; Pagefind search; i18n routing with a "not yet translated" fallback
(matching [localization.md](./localization.md)); SEO scaffolding (sitemap, canonical,
OpenGraph, `hreflang`/`x-default`); responsive theme, dark mode, a11y, syntax highlighting.
Adopting it means a whole second toolchain — its own `node_modules`, dev server, build, deploy
target, and mental model (islands, content collections, `.astro`) — to obtain chrome for the
deliverable that matters least right now.

Crucially, the pieces of that chrome that are actually load-bearing are available **standalone**,
without adopting the framework:

- **`unified` / `remark` / `rehype`** — the core, used regardless. `remark-directive` for
  `:tooltip[...]`, `rehype-slug` + `rehype-autolink-headings` for the anchor IDs.
- **Pagefind is standalone** — it indexes any static HTML, Starlight or not. Starlight's search
  *without* Starlight.
- **Shiki** — standalone syntax highlighting.

A homegrown static site is then a ~150-line build script (walk `docs/content/`, remark→HTML,
one template, emit files; Vite serves them as static assets). What you give up vs. Starlight:
the auto-sidebar, the polished theme, i18n routing, and the SEO tags — rebuilt piecemeal only
if a public site ever justifies it. For a solo dev, building those now is pure yak-shaving.

## Decision

**Defer the public website entirely** — with a stronger reason than "later": the whole
public-site question is premature, so there is no framework decision to make this year. When a
site becomes real (a launch, someone to share with), re-decide Starlight-vs-homegrown *then*,
by which point the in-game hast renderer will already exist and the homegrown option will be
cheaper than it looks today.

**Build the in-game manual in-project on `unified`/`remark`** when it is wanted — not via any
SSG. And note the manual itself may also be deferrable: the Part I help tooltips (label + one
sentence, see [localization.md](./localization.md)) already answer "what is this?" in-game, so
for a long while the only things carrying weight are the Markdown source + anchors (cheap,
decided below), the tooltips, and the [changelog](./grouped-changelog.md).

Alternatives, if a public site is ever built: **homegrown emitter** (recommended — shares the
manual's transform); **Starlight** (most polish for the site itself, at the cost of a second
framework); **VitePress** (Vite-native but still its own Vue app, weaker fallback);
**Docusaurus** (React, heavier).

## What is decided now: layout + anchors (the expensive part)

Only the source layout and the anchor IDs are fixed now, because they are what is costly to
change later. No Astro, no remark pipeline, no website.

### Two separate Markdown trees, split by audience

```
docs/
  decisions/  design/  vision.md  changelog/     ← internal, English, stays put
  content/                                        ← NEW: player-facing, multilingual
    en/ …
    de/ …
```

The existing internal docs are **not moved** — they are developer documents, never shipped,
need no German, and several notes/memories link them by path. Starlight's `glob()` loader will
later point only at `docs/content/`; everything else is simply not part of the collection.
(The changelog in `docs/changelog/` likewise stays internal; if it is ever made public it
becomes one more collection entry — one line of loader config.)

### Layout inside `docs/content/`

Starlight convention, adopted now without Starlight: **one directory per language, identical
filenames = translations of each other.** A missing `de/` file falls back to `en/` — the same
mechanic as the catalog fallback in [localization.md](./localization.md). Directory levels
mirror the four i18n areas (`common`, `world`, `worldgen`, `game`); `game/` arrives with game
mechanics.

```
docs/content/en/
  index.md                     anchor: common
  world/biomes.md              anchor: world.biome
  world/resources.md           anchor: world.resource
  world/species.md             anchor: world.species
  worldgen/tectonics.md        anchor: worldgen.panel.tectonics
  worldgen/erosion.md          anchor: worldgen.panel.erosion
  …
docs/content/de/
  index.md                     (rest follows later → falls back to EN)
```

Each page is created with a real 1–3-sentence intro (pulled from the existing decision docs
and code comments) plus a `<!-- TODO -->` — a scaffold that already says something, not an
empty file.

### Front matter

Building on the fields the repo already uses (`summary`, `date`, `status`), plus the standard
docs fields any consumer (a homegrown emitter or, if ever, Starlight) will want:

```yaml
---
title: Biomes                  # page title + sidebar
description: …                 # SEO / card subtitle; == the repo's existing `summary`
anchor: world.biome            # our stable ID — the expensive part
date: 2026-07-28
status: stub
sidebar:
  order: 20
---
```

`anchor` is an own field; whichever consumer is eventually built reads it directly (a Starlight
install would declare it via `docsSchema({ extend: … })`). Until then it is just a YAML field
that costs nothing. The `title`/`description`/`sidebar` fields are conventional enough that
they cost nothing to write now and fit any later consumer.

## The anchor IDs — the actual deliverable

An anchor is the **same string** as the i18n area key. That is the point of the whole
exercise:

```
data-help="world.resource.arable"  →  tooltip: label + help sentence from en/world.json
anchor:   world.resource           →  manual page for the same concept
#arable   (heading anchor)         →  the section within it
```

A tooltip can later gain a "learn more" that lands in the docs with no second mapping table,
and a player note attaches to the *entity*, not the page — so it surfaces everywhere the term
appears. Rules, recorded in `docs/content/ANCHORS.md`:

- First segment is always one of the four areas.
- One concept, one anchor — even where it appears in several places in the UI.
- **Anchors are a public interface.** Renaming one later orphans player notes; changes go
  through a redirect list, not search-and-replace.
- Page anchor = prefix; heading anchor = prefix + segment.

## Deliberately not built yet

In rough order of when they might matter: the `unified`/`remark` → hast pipeline · the in-game
manual panel (the DOM-component emitter) · the `DocsSource` seam (bundled vs. fetched) ·
notes/suggestions against the Go server. And only *if a public site is ever justified*: the
HTML emitter + Pagefind, or Starlight. All of it hangs off the layout + anchors above and is
made *cheaper* by fixing those now, not costlier. `notes.md` records the reasoning for each
(anchor IDs expensive, delivery mechanism cheap to defer, notes API worth a real Go+SQLite
backend rather than a `localStorage` fake).

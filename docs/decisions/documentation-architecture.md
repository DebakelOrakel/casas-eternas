---
summary: The docs pipeline sketched in notes.md bundles two separable deliverables — an in-game manual (the valuable one) and a public website (deferrable marketing chrome). Starlight only ever serves the website, and it is NOT embeddable in the Vanilla-TS/Babylon Vite client anyway (it's an Astro integration owning its own build). Decision: DEFER the public site entirely; build the in-game manual in-project on unified/remark (which you need regardless); do NOT adopt a second framework for a not-yet-needed artifact. Starlight-vs-homegrown is re-decided only if/when a public site becomes real. What IS decided now: the source layout and the anchor IDs (which reuse the i18n key namespace).
date: 2026-07-28
updated: 2026-09-20
area: platform
stage: decided
status: decided (source layout + anchors; the manual stays deferred) — ADDENDUM 2026-08-13: the public site is BUILT the same day (homegrown, the re-decision the doc reserved): npm run build:docs renders docs/ to a static site the `docs` module serves under /docs/. ADDENDUM (2), same day, decided and BUILT: top levels of the site are AUDIENCES — Development (the existing tree) beside a new Operations top level (docs/operations/: per-environment guides plus CLI/config reference pages rendered from a clidump-generated, lint-guarded JSON — never hand-written); the player top level stays the reserved content/ manual. ADDENDUM (3) 2026-09-20, decided and BUILT: the site wears the generator's design canvas (its type, its palette, a header bar, a right-hand "on this page" column), and it gained SEARCH — not Pagefind, which this doc reserved: a build-time JSON of titles, summaries, section headings and changelog lines (~127 KB, no full text) plus ~120 lines of plain browser JS. Pagefind would index the rendered HTML, which for forty documents means shipping a WASM runtime and its full-text shards to answer questions the headings already answer. The same script drives the area pages' status filter; with JS off the site is the site with everything shown
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

This front-matter-as-data pattern is also why the internal decision docs need no separate
changelog file: a date-ordered decisions overview is a **generated view** over each decision
doc's own `date`/`summary`/`status`, not a hand-maintained list that would drift (see
[grouped-changelog.md](./grouped-changelog.md)).

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

## Addendum 2026-08-13: the site becomes real (planned, not yet built)

The premise moved twice since the original call: `docs/` is now public in
principle (stated 2026-08-12, see docs/README.md; game design material lives
outside the repository), and the
changelog left the title screen — so the site is no longer deferrable
marketing chrome, it is where the changelog and the docs LIVE. The reserved
re-decision falls as reserved: **homegrown, not Starlight** — the site's job
is to look like Casas Eternas, and Starlight's value is exactly the chrome
we would fight; Pagefind (Starlight's own search) works standalone over any
static HTML if search is ever wanted.

**Scope**: render `vision.md`, `decisions/`, `design/`, `changelog/`.
`content/` stays reserved for the manual (its
own pipeline, unchanged by this addendum). Site language: English — the
docs' language; deliberately not localized.

**Display axes** (decided in discussion 2026-08-12/13): navigate by `area`
— the five values that are already the changelog's vocabulary — never by
folder. Genre (decision/design, derived from the folder) and `stage` (front
matter) are BADGES, not navigation. Layout:

- **Sidebar, two levels**: Vision on top; the five areas as collapsible
  groups (native `details`/`summary`, active area open) holding
  `Changelog` as first fixed sub-item, then the doc titles.
- **Area index page** (clicking the area itself): a changelog TEASER — the
  newest 3–5 entries, linking to the full per-area changelog page — then
  the doc list: title + front-matter `summary` + badges
  [genre|stage|last-updated], grouped by liveliness: "In progress"
  (idea/decided/building) above "Reference" (built); `superseded` hidden
  by default, shown with a banner + `superseded-by` link on its own page.
- **Doc page**: rendered Markdown with the front matter as a header block
  (summary, badges, free-form `status` as prose).

**Pipeline**: a build script on unified/remark (the toolchain the manual
needs anyway): walk the tree, parse front matter, Markdown→HTML with
relative `.md` links rewritten to site routes (links to code paths render
as plain code, no target), `last-updated` from `git log -1`, one shared
template + one CSS file speaking the title screen's design (Cinzel, paper
tones, the changelog kind-badge colors). Zero client-side JS in v1
(details/summary carries the sidebar); Pagefind deferred until wanted. The
changelog Markdown parser is EXTRACTED from ui/changelog into a pure
parse step shared by the client viewer and the site emitter — same format,
one parser. (The client viewer was removed 2026-09-20 without ever being
shown, which left the parser as the site's alone; it now sits in `scripts/`
beside it. The sharing was the right shape while there were two readers.)

**Serving**: a `docs` module (client-shaped: serve a directory, nothing
else) under the path prefix `/docs/`, its own target, config key
`docs.storage.dir.path` — version lockstep for self-hosting; any static
host works identically. Public by construction (only `/v1/*` is gated).
The client links to it (`/docs/`, vite dev-proxy added alongside `/v1`) —
the title screen's stub button becomes that link, labeled Documentation.

**Build order**: ① generator + template/CSS (verified by a link-check pass
in the script itself) → ② changelog-parser extraction (was already done —
parseChangelog.ts existed) → ③ docs module + target + composition → ④
build wiring (npm script, Makefile, Dockerfile) → ⑤ title-screen link +
localization of the title nav. ALL BUILT 2026-08-13; `-t docs` runs alone,
proving the target rule. Front matter turned out looser than strict YAML
(colons in summaries), so the generator parses the flat convention itself
— no YAML dependency.

## Addendum 2026-08-13 (2): top levels are AUDIENCES — Operations arrives

The deployment matured the same day (auth store, admin socket, cluster
bakes), which makes it worth documenting — and that surfaces the axis the
site was missing: everything it renders today serves ONE audience, the
project itself. Decided in discussion:

**Top levels of the site are audiences.** `Development` (the existing
tree: vision, decisions, design, changelog — area navigation unchanged;
the "navigate by area, never by folder" rule is hereby SCOPED to this top
level), `Operations` (whoever runs a server: today the operator of one,
later any self-hoster), and — when the game earns it — the reserved
player top level, which is exactly what `docs/content/` and the anchor
IDs above have been waiting for. Nothing is moved; Operations is a new
sibling:

```
docs/operations/          one FLAT directory; grouping is front matter
  concepts.md             group: overview — targets, auth modes, one vocabulary
  local.md                group: installation — the binary on a machine
  docker.md               group: installation — the container without a cluster
  kubernetes.md           group: installation — manifests, Secret, bootstrap, bakes
  cli-reference.json      GENERATED — see below
```

Inside Operations the pages sit in GROUPS, and the groups are genre
(refined in the same discussion, after the first cut put pages directly
under the section and the sidebar's levels stopped meaning one thing
each): `overview` (orientation, quickstart-sized), `installation` (setup
per environment — split there because the steps genuinely differ),
`guides` (topical explanations; reserved — an empty group is not
rendered), `reference` (the generated pages). Every group gets a
GENERATED index page over its pages' front matter, exactly like the area
indexes. The group is a front-matter field, never a filename prefix or a
subdirectory — the same "front matter is data" rule that keeps
Development's navigation off the folders. Front matter: `summary` +
`date` + `group` + a flat `order:` (the generator's convention is flat;
the nested `sidebar: order:` reserved above stays a content/-only,
Starlight-compatible shape); NO stage/status badges — an operations
manual is always "current", a lifecycle badge there is noise.
deploy/README.md thins to a pointer once the guides carry its content.

**The CLI and configuration references are not written at all — they are
views.** The vocabulary (key = flag = env, every description text) lives
once, in the cobra tree; hand-written reference pages would be the second
copy the one-vocabulary rule forbids. So: a small Go tool (`tools/clidump`)
walks the command tree and emits JSON — per key: key, flag, computed env
name, default, help text; per command: Use/Short/Example — into
`docs/operations/cli-reference.json`, COMMITTED and guarded by `make lint`
regenerating and diffing it (machine-maintained with a drift gate, the
go.sum category — not a hand-maintained list). The docsite build stays
pure Node: docsite.ts renders the two reference pages straight from the
JSON, no intermediate Markdown, one HTML producer as before. The
alternative — dumping through Docker stages at build time, nothing
committed — was weighed and declined: it buys purity at the price of a
Go-dependent docs dev loop and cross-stage build plumbing.

**No mode switch in the UI** (refined in the same discussion): the top
levels are SECTION HEADINGS in the one sidebar — Operations first, then
Development — not two site modes. One navigation, one page tree, and one
SHAPE per level on both sides: section heading → collapsible group with
an index page (areas and operations groups share the same classes and
markup) → page links. The styling lives in shared classes on purpose, so
the two sections cannot drift apart.

**Build order**: ① `tools/clidump` + committed JSON + lint guard →
② the four guides, distilled from deploy/README.md and the 2026-08-13
operational knowledge; deploy/README becomes a pointer → ③ docsite.ts:
the section headings, the operations collection (Markdown pages plus the
two JSON-fed reference pages), generated overview page → ④ docs/README.md
taxonomy row + changelog entry. ALL FOUR BUILT the same day; the drift
gate was proven by mutating a help text and watching the lint fail.

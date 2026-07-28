---
summary: Client UI text moves out of the code into JSON catalogs, EN + DE first. Keys are split into four AREAS by what the text NAMES, not which screen shows it — common / world / worldgen / game — so the durable "world vocabulary" the game will inherit is separated from the generator's throwaway operating chrome. Type-checked keys (a typo or a missing DE string breaks tsc). Adds a custom hover HELP tooltip (label + one-sentence explanation) on every icon/slider. Language switch lives on the title screen only.
date: 2026-07-28
status: decided — not built
---

# Localization (i18n) & icon help

Today the client's visible text is hard-wired: `innerHTML` templates in
[WorldGenScreen.ts](../../client/src/screens/worldgen/WorldGenScreen.ts) and
[TitleScreen.ts](../../client/src/screens/title/TitleScreen.ts), `aria-label`s on ~35 icon
buttons, label fields in registries (`OVERLAY_DEFS`, `ECOLOGY_FIELD_META`, `BIOME_LABELS`,
`MIGRATION_RACES`), toast messages, and the map hover readouts. All English, all inline.

Three goals: (1) make it multilingual, EN + DE first; (2) let every icon explain itself on
hover with a short help sentence, not just its bare name; (3) a categorized changelog —
recorded separately in [grouped-changelog.md](./grouped-changelog.md).

The expensive part is **not** the translation — it is the **key namespace**. Once keys are in
use, renaming them is costly (and they double as documentation anchors, see
[documentation-architecture.md](./documentation-architecture.md)). So the namespace is the
real decision here.

## The organizing principle: split by what the text NAMES

The keys are **not** grouped by which screen displays them. They are grouped by *what the
string names*. A biome name is world vocabulary — it shows in the generator today and in the
game's tile inspector tomorrow. An erosion slider belongs to the generator forever. This is
the same expensive-vs-cheap logic used elsewhere in the project: the durable, shared anchors
go in `world.*`; the generator's own interpreting/operating chrome goes in `worldgen.*`,
where it may freely diverge from whatever the game later invents.

| Area | Principle | Catalog file (per language) |
|---|---|---|
| `common` | App frame, screen-independent | `locales/<lang>/common.json` |
| `world` | **What the world *is*** — shared vocabulary the game inherits | `locales/<lang>/world.json` |
| `worldgen` | **How the generator *operates & buckets* it** — generator-only lens | `locales/<lang>/worldgen.json` |
| `game` | Game screen & mechanics (nearly empty today) | `locales/<lang>/game.json` |

One-line litmus: does the term exist in the *game* just as in the generator (copper, tundra,
human, "temperature view") → `world.*`; is it a tool or a grouping *of the generator*
(erosion slider, resource-role filter, panel gating) → `worldgen.*`.

### Final key namespace

```
common.action.<id>.label / .help      back, next, loadWorld, saveWorld
common.unit.<id>                       celsius, metres, mmPerYear, percent, …
common.notify.<id>                     invalidWorldFile, dismiss
common.title.mission.<id>              title-screen mission list (EN only, see below)

world.biome.<slug>                     tundra, borealForest, ocean, …            (11)
world.resource.<slug>                  arable, copper, gold, …                   (13)
world.resource.carryingCapacity        aggregate suitability (a real world quantity)
world.species.<slug>                   human, dwarf, beaver                      (3)
world.overlay.<slug>.label / .help     14 map overlays
world.overlay.<slug>.legend.*          that overlay's legend (only mantle swatches are new)
world.readout.<id>                     compass.*, warm, cold, deep
world.event.<slug>                     continentsCollided, continentBreakup, …   (4)

worldgen.panel.<panel>.title           genesis, tectonics, erosion, climate, …
worldgen.panel.<panel>.<field>.label / .help    every slider
worldgen.action.<id>.label / .help     randomizeSeed, run/stop Tectonics|Erosion, reset… (×5)
worldgen.ecology.cat.<id>              subsistence / material / metals / prestige filters
worldgen.notify.<id>                   needsTectonics, needsErosion

game.action.<id>.label / .help         backToTitle (grows with mechanics)
```

`.label` is the short UI word; `.help` is one sentence saying what the thing *does*. Every
icon and slider gets both.

### Namespace calls worth recording (the forks)

- **Map overlays, legends, readouts → `world.*`, not `worldgen.*`.** They live in the
  reusable map UI (`MapOverlayCompositor` / `MapHoverTooltip`) that the game screen inherits,
  and they name world state, not generator tools. A legend is nested under its overlay
  (`world.overlay.mantle.legend.upwelling`), so it travels with the overlay it explains;
  gradient/biome/species legends reuse existing keys and mint nothing new. The hover readout
  is assembled from `world.overlay.*` prefixes + `world.biome.*` + `world.resource.*` +
  `common.unit.*`, leaving only a few genuine tokens (`world.readout.compass.*`, `warm`,
  `cold`, `deep`). The 3 generation-only overlays (`boundaries`, `mantle`, `names`) that the
  game never shows still live in `world.overlay.*` — one namespace for the whole bar is
  simpler than a split down the middle.
- **Resource NAMES → `world.resource.*` (singular)**, matching `world.biome.*` /
  `world.species.*`. Resource **groupings do not** go in `world.*`: only the ecology panel's
  four category-filter buttons are ever rendered (`worldgen.ecology.cat.*`). `ECOLOGY_ROLE_LABELS`
  (aggregate/subsistence/material/prestige) is currently dead code — defined, never displayed —
  so it mints no keys. Groupings are a consumer-specific lens; the game will regroup and add
  variations, so they stay in `worldgen.*`.
- **`world.species.*`, not `race`.** "Species" matches the game design vocabulary (three
  species). The key `world.species.human` names the thing, not the asset — the icon file
  stays `caveman.png`. The code identifiers (`MIGRATION_RACES`, the `race` field, the
  `'caveman'` id, related comments) remain to be renamed in a **separate** mechanical
  refactor; key strings are independent of variable names and can be used now.

## Catalog format & type safety

Flat JSON, dot-separated keys, **one file per area per language**. Chosen over a single
TS-`as const` module and over YAML: JSON stays plain configuration (later trivially read by a
server or translation tooling) yet still gives compile-time safety, and needs no extra
toolchain (the client has no YAML parser). One file *per area* (rather than one big file per
language) keeps each catalog scannable and lets the game later ship its own catalog without
dragging the generator's ~230 strings along.

Type safety without a build step:

- `tsconfig.json` gets `"resolveJsonModule": true`; `TKey = keyof typeof enCatalog` is derived
  from the English JSONs, so `t('world.biom.ocean')` is a **compile error**.
- `de` is typed `Record<TKey, string>`, so a **missing German key breaks `tsc`**. A dev-only
  startup check reports *extra* keys (which the type cannot catch).
- At runtime a missing key falls back to English + a one-time `console.warn` per key.

Locale selection at start: `localStorage['ce.locale']` → `navigator.language` → `en`.
i18n has **no module-import side effects** (no `localStorage`/`document` at top level);
initialization is explicit in `main.ts`.

### Open question — does any worker-imported module touch i18n?

`biomeLabel()` currently lives in `biomes.ts`, which workers import. The likely-correct cut
is that a simulation module has no business knowing display text at all: `biomes.ts` keeps
only the slug table, and the slug→catalog-key mapping sits on the UI side. Then no worker
touches i18n and the import-safety concern dissolves. Same for `ECOLOGY_FIELD_META`. Confirm
against the real import graph before converting the domain tables.

## Wiring the text in

Because `AppStateManager.goTo()` rebuilds a screen from scratch and the language switches only
on the title screen, `t()` calls are **interpolated directly into the template literals** —
no second labeling pass, no `data-i18n` attributes, no second source of truth:

```ts
<span class="field-label">${t('worldgen.panel.genesis.plateCount.label')}: …</span>
```

Inventory: ~276 existing translatable strings (concentrated in `WorldGenScreen.ts`, ~54% of
all UI text), plus ~65 newly written `.help` sentences. Deliberately **not** translated:
`continentNames.ts` (59 proper nouns — world flair), `worldLayers.ts` `unit:` fields (they go
into the save file, not the screen — translating would make saves language-dependent),
`index.html` `<title>` and decorative CSS.

## Icon help — a custom hover card, not native `title`

New `ui/help/HelpTooltip.ts` + CSS, parallel to `MapHoverTooltip.ts` (fixed positioning, host
element, `dispose()`) but keyed to DOM elements. **Declarative, not wired**: elements carry
`data-help="world.overlay.temperature"`; one delegated `pointerover` listener on the screen
root resolves the key and shows `<key>.label` bold over `<key>.help`. That covers both the
`innerHTML` templates and later dynamically-built buttons without per-element registration.

Native `title=` was rejected: ~1 s delay, unstyled/OS-themed, ugly multi-line, unreliable over
the Babylon canvas. The card appears after ~250 ms (and on keyboard focus), clamps to the
viewport, and hides on leave/click/scroll. `aria-label` stays (set from `<key>.label`); the
native `title` attribute is dropped to avoid a double tooltip.

~65 controls get help text (16 overlays, ~8 panel actions, 2 file buttons, 4 ecology
categories, 3 species, ~32 sliders). Help sentences say *what the control does to the world*,
not what it is named ("Drainage: how often the river network is recomputed during erosion —
higher = sharper valleys, slower"); the existing simulation code comments already supply that.

## Language switch — title screen only

An `EN | DE` pair in `.title-nav`: click → `setLocale()` → `ctx.goTo('title')`, and the screen
rebuilds in the new language. Two deliberate carve-outs so the catalogs don't fill with
ballast:

- **Proper names stay untranslated** — "Casas Eternas", "Hacedor del Mundo", "Sphere",
  "Mars" (flair, and consistent with the existing German-kept title menus).
- **The mission/backlog list** goes to `common.title.mission.*` in `en/common.json` but gets
  **no German** at first; the built-in fallback shows it in English under DE. It is a
  developer changelog kept continuously current — double-maintaining it costs more than it
  returns. The `tsc` completeness check therefore exempts `common.title.mission.*`.

## Numbers & units

German writes `1.234,5`, English `1,234.5`. A `formatNumber()` wraps `Intl.NumberFormat` for
the readouts. Unit glyphs (`°C`, `m`, `mm/yr` → `mm/Jahr`) are their own `common.unit.*` keys
because they translate.

## Scope (v1)

`screens/worldgen`, `screens/title`, `screens/game`, `ui/`, `map/`, and the domain tables.
The legacy `worldgen-sphere` and `mars` screens are out.

## Not done / later

- Building any of the above (this is a design decision, nothing is implemented yet).
- The `race` → `species` identifier refactor (separate mechanical change, noted above).
- Confirming/removing i18n from the worker import graph (open question above).
- Full German for `common.title.mission.*` (fallback covers it until then).

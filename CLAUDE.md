# Casas Eternas

A world generator and the game it is being built for. The client (TypeScript,
Babylon.js, Vite, no framework) generates a world; a Go server stores worlds,
caches derived artifacts, and runs bake jobs. The world is a **flat torus** —
wraps in both X and Y — not a sphere.

This file is an index, not a manual. The reasoning lives in `docs/`; read the
doc rather than trusting a summary here.

## Layout

```
client/src/
  worldgen/       the generator — has its own CLAUDE.md, read it before working there
  world/          a world's identity, spec, save format and artifacts — the layer that
                  knows WHICH world; everything below it does not
  screens/        worldgen (the editor), worldmap, title
  storage/        artifact stores (OPFS / HTTP / tiered), bytes at paths
  server/         client-side HTTP clients for the Go server
  map/ ui/ camera/ app/ i18n/
  worldgen-sphere/ + screens/worldgen-sphere/, screens/mars/   ← see "parallel approaches"
client/scripts/   the four harnesses (golden, pipeline, amplify, roundtrip) and
                  bake.ts → baker.mjs, the server-side bake bundle
internal/ cmd/    the Go server
docs/             see docs/README.md for the taxonomy
```

**Parallel approaches.** The repo holds more than one world-generation attempt at
once, which is why it looks confusing. `client/src/worldgen/` (flat torus) is the
live one. `client/src/worldgen-sphere/`, `screens/worldgen-sphere/` and
`screens/mars/` are the user's separate concerns — do not edit them, and do not
treat their problems as the current task's problems.

**Module layering — keep it acyclic.** `worldgen/` computes (params in, fields
out), `storage/` moves bytes at paths, `server/` talks HTTP, `map/` draws. Those
four are PEERS and should not import each other. Above them sits `world/`, which
owns identity, the spec, the save format and the artifact keys, and may depend on
all four. `screens/` sits above everything.

`worldgen ↔ storage ↔ server` used to be a cycle; extracting `world/` resolved it
(2026-08-09, see docs/design/architecture-unification.md part C). Do not
reintroduce it. If something needs both a generator and a store, that is
`world/`'s job, not a new edge.

Two peer edges are knowingly left.

`storage → server`, because `HttpArtifactStore` asks the server module for the
API base. Giving the store its base URL as configuration would remove it.

`map → worldgen`, with a boundary that is meant to be checkable: **`map/` may
read worldgen's units, its vocabulary and its pure field functions — it may not
drive a simulation.** Reading `ELEVATION_METERS`, the `Biome` enum or
`computeBiomesFine` is fine; importing anything that advances state is the
violation. The edge is not a cycle (nothing in `worldgen/` imports `map/`) and
it predates the rule being written down — `mapSceneSettings` cannot express a
metre without it. Legitimised rather than broken 2026-08-11, when
`mapPresentation` made it conspicuous: the alternative was a units-and-vocabulary
module existing only to satisfy the rule, plus moving the map's re-classification
into `world/`, which the test below excludes.

The test for where a thing belongs: **if a function does not need to know *which*
world is meant, it is not world-layer code.** `runErosionPass` does not;
`deriveWorldId` does.

**Go server modules — the target is the boundary.** Vocabulary first, because
the words are NOT interchangeable: a PACKAGE is a Go unit under `internal/`
(the leaves `auth`/`identity`/`config` are packages, not modules); a MODULE
implements `server.Module` (routes + lifecycle — session is a module with no
target, chosen by auth mode); a TARGET is the deployment unit `-t` selects,
wired explicitly in `cmd/start.go` (no registry — the composition root is the
one place that knows every module); a SERVICE is a running process with a set
of targets — always the same binary. Package layout follows the DOMAIN,
targets follow the DEPLOYMENT unit; a subsystem that must straddle processes
gains a sub-target, not a new package (server-storage.md). **A target must be
able to run alone — otherwise it is not a target** (stated 2026-08-12; bake is
the one violator, fix planned: cross-module needs become co-resident closures
OR URL-backed variants, chosen by `cmd/` at composition). The rules, audited
and written down 2026-08-12:

- Dependencies flow one way: `cmd` → modules → leaves. **Nothing imports
  `internal/server`** — it knows the modules structurally, they do not know
  it. cobra/viper exist only in `cmd/`; modules receive the full typed
  `config.Config` tree and read ONLY `Global` plus their own section — a
  review-enforced discipline, see docs/decisions/server-config.md. **One
  vocabulary:** a setting's dotted key IS its flag name IS its CASAS_*
  variable; never invent a second name for one.
- **A module's routes live under its own namespace** (`/v1/<module>…`), and
  no module registers into another's. (The one violation — bake's
  `POST /v1/worlds/{uid}/bake` — moved to `POST /v1/bakes` on 2026-08-12.)
- **A module's disk layout and JSON formats are private.** Cross-module needs
  are injected functions composed in `cmd/` — the same pattern that
  distributes `identity.Resolver`. Never duplicate another module's paths or
  tags. (Known violation to fix: bake re-implements the world store's layout
  and Meta struct, tests included.)
- **One process per store directory.** In-process locks and in-memory indexes
  ARE the concurrency model; scaling means splitting targets by module, never
  replicating a store module against one directory.
- Identity travels in the token (verifiable in every process via the shared
  key); rights live with the resource. That is what lets any target split
  run without runtime calls between modules —
  [docs/design/access-control.md](docs/design/access-control.md).


**widgets** (`tooltip`, `panel`, `notifications`, `help`, `chrome`) which are DOM
only and import nothing outside `ui/`, so anything may use them; and **connected
panels** (`storagePanel`, `serverIndicator`, `worldPanels`, `signInPanel`) which
talk to `server/` and `storage/` and are really screen fragments sitting above
the peers. Nothing that computes pixels or fields belongs there at all —
`paperBase` and `biomeIds` moved to `map/` on 2026-08-11 for exactly that
reason.

## Commands

```
make lint      # tsc --noEmit, gofmt, go vet
make test      # go test plus all four harnesses (~14 min, nearly all of it golden)
make run       # build baker + client, then start the server locally
cd client && npm run dev   # the usual loop

# The four harnesses, cheapest first — each guards what the others cannot.
cd client && npm run harness:roundtrip   # the save format; 0.2 s, run it freely
cd client && npm run harness:pipeline    # the generator pipeline's behaviour; ~50 s
cd client && npm run harness:amplify     # the amplification bake; ~13 s
cd client && npm run harness:golden      # the generator's fields; ~13 min

```

## Standing rules

**Never run `git commit`.** Not even when a plan I wrote lists a commit sequence
and it was approved — approving a plan's structure is not authorization to
commit. Leave changes in the working tree. Read-only git (status, diff, log) is
fine. Do proactively *say* when a coherent, verified batch looks like a good
checkpoint, and suggest how to split it if the tree spans several concerns; the
user shapes the history themselves.

**All user-facing text goes through i18n** — a catalog key plus `t()`, never a
hardcoded string. **Propose new catalog keys and wait for agreement** before
adding them: keys double as documentation anchors, the namespace was deliberated,
and renaming later is expensive. Both catalogs (EN + DE) are `tsc`-gated and must
stay complete.

**Propose new Go CLI flags and subcommands before writing them**, same reasoning —
the CLI is a public surface the user owns. Non-surface plumbing that changes no
name the user types does not need asking.

**Verify against data, not screenshots.** Prefer a small script that calls the
real functions and inspects numbers or buffers over spinning up a browser. The
user judges visuals themselves; do not chain browser checks to "double-check" a
fix.

**Changelog entries are one short sentence** (`docs/changelog/`, see its own
README for the format). Measurements and reasoning belong in the code comment
next to the constant and in the decision doc — not here. Debug-only UI gets no
entry at all; the changelog is for player-facing change.

## Writing code here

**Search before writing a helper** — grep for the *operation*, not the name. This
is unconditional; it can only produce information. **Merging duplicates is
conditional:** merge only when the call sites would want to change together, and
only where a behaviour check exists. Two near-identical samplers in this repo
differed in cell-centre convention and in key precision; merging either would
have been a silent bug.

**Never trade a durable property for writing convenience**, and treat every alias
as that trade until proven otherwise. Destructuring a params object back into
local `SCREAMING_CASE` names keeps a diff small, and leaves two names per
constant plus a second place to edit when one is added. Importing it `as TUNE`
shortens lines, and hides sixty-odd usages from a grep for the name it actually
has — which breaks the rule directly above. Both were written here, both were
removed within the hour. The test is whether the shortcut still pays a week
later, when the diff is history and only the code is left.

**Split a module on a trigger**, not by default — when a file holds concerns that
change for different reasons, or a function outgrows a screen. A module boundary
fixes an abstraction before the model is proven, which has a real cost:
erosion/deposition were once split because they looked separable, and that
separation *was* the bug.

**Decide by consequence when a change reaches outside the task:**

| Situation | Do |
|---|---|
| Mechanical consequence (a move, a signature, an import) | Just do it, mention it in the report |
| Changes visible behaviour | Ask first |
| Pre-existing bug found on the way | Report it, do **not** fix it |
| Refactor needed for the feature to land cleanly | Ask first, with the reason |

## Documentation

`docs/README.md` has the taxonomy and the front-matter convention. In short:
`decisions/` records one decided fork each (options, answer, why); `design/` holds
living architecture notes that may precede any decision; `changelog/` answers
*when did this arrive*. Docs are English and internal — never shipped.

When a design direction hardens into a real fork, it earns its own doc in
`decisions/`. Do not hand-maintain overview lists: the front matter is data and
overviews are generated from it.

Current direction for the generator's architecture:
[docs/design/architecture-unification.md](docs/design/architecture-unification.md).

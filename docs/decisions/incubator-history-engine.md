---
id: DEC-0048
title.en: The incubator's history engine
title.de: Die Engine der Geschichte des Inkubators
summary.en: The incubator's history is simulated, not computed on demand,
  and kept as an artifact, H1, keyed by the terrain, level 1's and the
  incubator's versions and the origin. It moves to a crate of its own in
  the Rust workspace, casas-incubator, beside the generator's engine and
  not in it, with its own version and releases. It runs as WASM in the
  browser, which only shows it; saved, a job runs it natively on the
  server and puts H1 there, on a route of the incubator's own version.
summary.de: Die Geschichte des Inkubators wird simuliert, nicht auf Abruf
  gerechnet, und als Artefakt H1 gehalten, geschlüsselt nach Gelände, den
  Versionen von Stufe 1 und des Inkubators und dem Ursprung. Sie zieht in
  eine eigene Crate im Rust-Workspace, casas-incubator, neben die Engine
  des Generators und nicht in sie, mit eigener Version und eigenen
  Releases. Sie läuft als WASM im Browser, der sie nur zeigt; gespeichert,
  rechnet ein Job sie nativ auf dem Server und legt H1 dort ab, auf einer
  Route der eigenen Version des Inkubators.
area: platform
stage: built
createdAt: 2026-10-26
related: [DES-0033, DEC-0044, DEC-0045, DEC-0039, DEC-0047]
---

## Where this starts

The incubator's history ([DES-0033](../design/incubator-simulation.md)) runs
in TypeScript in the incubator's worker: some 25 s on Morvane, every time a
world is opened or an origin set, with the rules' preview shown meanwhile.
A run is a fixed result of its inputs — the simulation is seeded; two runs
gave the same numbers — so it can be made once and kept.

## Fork 1 — run or keep: DECIDED — keep, as the artifact H1

- **A. Run on every open.** Nothing stored; 25 s each time, the preview
  needed for the wait.
- **B. Keep the result as an artifact** (chosen). A world opened again with
  the same origin loads it (168 MB on Morvane: the kept states every 2 500
  years make most of it; acceptable for now).

Its key is content, as every artifact's ([DEC-0039](./artifacts-by-content.md)):
the terrain (worldId); level 1's pipeline version and the incubator's,
`+`-joined (`world/historyArtifacts.ts`); the stage `H1:<origin cell>`.
The incubator's version is made as the pipeline's (2026-10-27, after a
string raised by hand): `v<INCUBATOR_ALGO_VERSION>-<hash>`, the hash over
the crate's tuning (`casas-incubator` `tuning.rs`, a table of its
constants by module, as `casas_engine_api::pipeline::constants`, and the
catalog without its notes; `make engine` writes it to
`engine/dist/incubator/constants.json`). A test keeps the table whole: each
constant of the crate is in it or named as format. The number is raised by
hand on a change to the code that changes what a run gives, or to the
packed form. Its badge is
**H1** — the history's first stage, as L1 … L3 are the levels'; a later
stage of the history (to the game's start) would be H2. "SA" (stone age)
was considered and left: in German it names the Sturmabteilung.

## Fork 2 — where its code lives: DECIDED — a crate of its own

- **A. In `casas-engine`.** Shares the mesh, detMath and the heap without a
  seam. But the generator's engine is frozen, and its releases are tied to
  the pipeline a save records ([DEC-0045](./engine-releases.md)): an engine
  under a pipeline's tag must not change. The history changes all the time;
  each change would force a new generator engine.
- **B. A crate of its own in the same workspace** (chosen), `casas-incubator`:
  it uses the engine's shared parts (the mesh, detMath, the heap), has its
  own version — a world has one pipeline and many histories (origins,
  incubator versions) — and its own release tag, `incubator-<version>`.
  Named `casas-incubator` (2026-10-27, first `casas-history`): it holds the
  whole incubator — the cells, the flora, the fauna, the settlement — and
  "history" names the generator's history already (`tuning.history`, the
  replay).
- **C. A workspace of its own.** Nothing shared; the mesh and detMath twice.

## Fork 3 — where it runs: DECIDED — WASM to show, a job to keep

- **A. In the browser, as WASM, kept there.** The history runs where it is
  looked at; the result is kept in the browser's store. Built first
  (2026-10-26), and left on 2026-10-27: storing 170 MB took minutes in
  Safari, and a history kept in one browser serves nobody else.
- **B. In the browser to show it, as a job on the server to keep it**
  (chosen, 2026-10-27). The browser runs the history and only shows it; it
  writes no H1. Saving it (the people step's button) orders a job: the job
  worker runs the native build on the same input and puts H1 in the
  artifact store, for every reader of the world. A world opens with the
  history saved last on the server, and runs one only where the server has
  none for the origin. The browser reads H1 past its cache, which would
  keep the 170 MB too.
- **C. The browser uploads its H1.** Would need DEC-0039 changed and the
  server to trust what a browser made. Not chosen.

The job gives the browser's bits because both make their input with the
same functions (`screens/incubator/historyInput.ts`: the chart's node map
of level 1, the cells' input, the rain) and the crate's two builds agree
(`engine/scripts/incubatorSmoke.mjs`). On Morvane the job's H1 is the
browser's, byte for byte, 168 MB; the job takes some 24 s (the cells 12 s
with the node map, the run 11 s).

## Fork 4 — the job's route: DECIDED — the incubator's own

A task goes to the workers of its pipeline ([DEC-0045](./engine-releases.md)):
the subject names it, and a worker serves one pipeline's module.

- **A. The world's pipeline.** The incubator's code in each pipeline's
  module (pipeline.mjs). Only a pipeline released after it could run a
  history, and a new incubator version would need a new engine release.
- **B. The incubator's version as the route** (chosen). A history's task
  names the incubator's version (`v1-…`) as its pipeline;
  its module is `incubator.mjs` (`client/scripts/incubatorPipeline.ts`), with
  the incubator's native build (`casas-incubator.node`) and the engine's,
  which reads the save and level 1. The launcher serves it where it was
  shipped beside the host, else from the incubator's release,
  `incubator-<version>` (`.github/workflows/incubator-release.yml`; the jobs
  module's `releaseTags`). The order names the scope `history`, the origin
  as its id, and the pipeline of the level 1 it runs on (`level`):
  `{"worldUid": "…", "stage": 1, "scope": {"kind": "history", "id": 678764}, "level": "v13-…", "pipeline": "v1-7744e9f7c599f615"}`.
  The version has a pipeline's form, so the server says which pipelines
  are the incubator's (`GET /v1/jobs/pipelines`, `incubators`: those of
  open history jobs), and a file of a pipeline comes from `engine-<version>`,
  else from `incubator-<version>`.

H1 is keyed by the level read (its pipeline version, `+`,
INCUBATOR_VERSION), not by the client's own level pipeline: a world shown on
an older level 1 keeps its histories under that one.

## The way there

1. **Done (2026-10-26), in TypeScript:** H1 kept in the browser after a run
   (`historyPack.ts`, `world/historyArtifacts.ts`) and loaded when a world is
   shown with a kept history for its origin; the badge in the world list and
   the artifact window.
2. **Done (2026-10-27): the crate** (`engine/crates/casas-incubator`): the
   habitat's cells, the flora, the fauna, the climate history, the ways'
   days, the simulation, the history's settlement and the H1 bytes, ported
   from `client/src/screens/incubator/` after the TypeScript went to
   detMath (Math.exp, Math.log, Math.sin and the like differ between
   JavaScript's engines in the last bit). The catalogs — the plants, the
   trees, the animals, the big game, the herd animals — are one data file,
   the crate's `data/catalog.json`, which the client reads too. Checked
   against the TypeScript on two synthetic worlds (a torus and a sphere)
   and on Morvane: the same bits throughout, the whole H1 (168 MB on
   Morvane) byte for byte. On Morvane the WASM build takes some 18 s where
   the TypeScript took 37 (the history 13 s against some 25).
3. **Done (2026-10-27): the WASM build in the incubator's worker** in the
   TypeScript's place (`casas-incubator-wasm`, `engine/dist/incubator`); the
   TypeScript modules it was ported from went, and the rules' preview with
   them (`people.ts`, `settle.ts`, `rulesLog`): a world shows its history at
   once — the one kept last, or one run from the origin the crate chooses;
   an origin clicked loads its kept history or runs one. The button to
   start a history went too: a run gives the same history every time. The
   check is `engine/scripts/incubatorSmoke.mjs` (`make test`): the WASM build
   on the two synthetic worlds against a reference recorded while the
   TypeScript still stood beside it, and the worlds must reach every kind of
   event (a crossing, both centres, a village, a camp, a famine, an
   extinction, the first trade, the ice coming and going).
4. **Done (2026-10-27): the job** (fork 4). The native build
   (`casas-incubator-node`, `engine/dist/casas-incubator.node`; the check runs
   it beside the WASM on the same worlds), the incubator's module
   `incubator.mjs` with the launcher's route to it, its release, the image
   building it from the tree; the browser's keeping of H1 went (fork 3),
   the people step saves a history by its job. The artifact window and the
   world list show the server's histories (the levels summary's `history`
   rows).

## Not decided

- What the kept states hold, and how often: the state between two is mixed
  now, not run again; running it again needs the whole state kept and the
  run deterministic across builds.
- The game's end state as an artifact of its own, apart from the playback.
- The habitat's cells, the flora and the fauna as artifacts too, so a world
  with its H1 opens without computing them (2026-10-26, left as it is):
  some 340 MB on Morvane beside H1, the cells' mesh alone some 110 MB;
  their times in Safari ranged widely (the cells 7 … 36 s, the flora
  1.5 … 16 s; in Node 9 and 2 s). Ported into the crate, they may be quick
  enough not to keep.

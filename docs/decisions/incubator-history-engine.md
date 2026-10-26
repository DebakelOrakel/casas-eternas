---
id: DEC-0048
title.en: The incubator's history engine
title.de: Die Engine der Geschichte des Inkubators
summary.en: The incubator's history is simulated, not computed on demand,
  and kept as an artifact, H1, keyed by the terrain, level 1's and the
  history's versions and the origin. It moves to a crate of its own in the
  Rust workspace, beside the generator's engine and not in it, with its own
  version and releases; it runs as WASM in the browser, and later as a job
  that puts H1 on the server. The browser keeps its H1 to itself, as
  DEC-0039 has it.
summary.de: Die Geschichte des Inkubators wird simuliert, nicht auf Abruf
  gerechnet, und als Artefakt H1 gehalten, geschlüsselt nach Gelände, den
  Versionen von Stufe 1 und der Geschichte und dem Ursprung. Sie zieht in
  eine eigene Crate im Rust-Workspace, neben die Engine des Generators und
  nicht in sie, mit eigener Version und eigenen Releases; sie läuft als WASM
  im Browser und später als Job, der H1 auf den Server legt. Der Browser
  behält sein H1 für sich, wie DEC-0039 es will.
area: platform
stage: building
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
the terrain (worldId); level 1's pipeline version and the history's own,
`+`-joined (`world/historyArtifacts.ts`, HISTORY_VERSION, raised by hand on
any change to what a run gives); the stage `H1:<origin cell>`. Its badge is
**H1** — the history's first stage, as L1 … L3 are the levels'; a later
stage of the history (to the game's start) would be H2. "SA" (stone age)
was considered and left: in German it names the Sturmabteilung.

## Fork 2 — where its code lives: DECIDED — a crate of its own

- **A. In `casas-engine`.** Shares the mesh, detMath and the heap without a
  seam. But the generator's engine is frozen, and its releases are tied to
  the pipeline a save records ([DEC-0045](./engine-releases.md)): an engine
  under a pipeline's tag must not change. The history changes all the time;
  each change would force a new generator engine.
- **B. A crate of its own in the same workspace** (chosen), `casas-history`:
  it uses the engine's shared parts (the mesh, detMath, the heap), has its
  own version — a world has one pipeline and many histories (origins,
  history versions) — and its own release tag, `history-<version>`.
- **C. A workspace of its own.** Nothing shared; the mesh and detMath twice.

## Fork 3 — where it runs: DECIDED — WASM in the browser, later a job

- **A. In the browser, as WASM** (chosen, first). The history runs where it
  is looked at; the result is kept in the browser's store. The browser does
  not upload ([DEC-0039](./artifacts-by-content.md)): H1 stays on the
  machine that made it.
- **B. As a job on the server.** The job worker runs the native build and
  puts H1 in the artifact store for every reader of the world. Chosen as
  the second step, once the crate builds natively; the browser then runs a
  history only where the server has none.
- **C. The browser uploads its H1.** Would need DEC-0039 changed and the
  server to trust what a browser made. Not chosen.

## The way there

1. **Done (2026-10-26), in TypeScript:** H1 kept in the browser after a run
   (`historyPack.ts`, `world/historyArtifacts.ts`) and loaded when a world is
   shown with a kept history for its origin; the badge in the world list and
   the artifact window.
2. The crate: the simulation ported from `simulation.ts`, checked against
   it on the log and the people's count (as the engine's smoke test checks
   native against WASM); detMath in place of Math.exp and Math.log.
3. The WASM build in the incubator's worker in the TypeScript's place.
4. The job: the native build on the job worker, H1 on the server.
5. Then the rules' preview can go (`people.ts`, the rules' part of
   `settle.ts`, `rulesLog`).

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

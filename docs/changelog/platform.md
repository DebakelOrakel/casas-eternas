# Changelog — Platform

Build, worker pool, deploy, performance, and code structure. See [README](./README.md) for
the format.

## 2026-07-28
- **changed** Structure: worldgen restructured into modules (core / elevation / tectonics / crust / surface / render); a golden-hash harness now gates any refactor there.
- **changed** Structure: the golden-hash harness moved into the repo (`npm run golden`) and builds its worlds through the Archean — it used to construct them from the four retired Genesis sliders, guarding a path nothing reached while the live one went unguarded.
- **dropped** Structure: the pre-Archean world builder (`createPlateSimulation`, the initial raft generator, the worker's `init` path) — it took the four Genesis sliders the Archean replaced, and nothing had called it since.
- **changed** Performance: the craton-age field scatters each blob over the cells it reaches instead of asking every cell about every blob — 92 ms down to 1 ms per epoch, which is what made it affordable as a live overlay.

## 2026-07-25
- **new** Deploy: Dockerfile + Kubernetes manifests.

## 2026-07-24
- **changed** Workers: Firefox nested-worker fix regressed — still open; workaround is to develop on Safari, real fix is to un-nest the render pool.

## 2026-07-23
- **new** Workers: multi-worker simulation — a CPU worker pool (no GPU compute).
- **changed** Performance: tectonics performance improved.
- **fixed** Workers: Firefox nested-worker bug (later regressed — see 2026-07-24).

## 2026-07-20
- **new** Build: project set up — deterministic, seeded generation from the start.

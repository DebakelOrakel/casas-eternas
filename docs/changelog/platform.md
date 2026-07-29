# Changelog — Platform

Build, worker pool, deploy, performance, and code structure. See [README](./README.md) for
the format.

## 2026-07-28
- **changed** Structure: worldgen restructured into modules (core / elevation / tectonics / crust / surface / render); golden-hash harness gates refactors.
- **changed** Structure: golden-hash harness moved into the repo (`npm run golden`), now building worlds through the Archean.
- **dropped** Structure: the pre-Archean world builder (`createPlateSimulation`, initial raft generator, worker `init`) — replaced by the Archean.
- **changed** Performance: craton-age field scatters per blob instead of per cell — 92 ms → 1 ms per epoch.

## 2026-07-25
- **new** Deploy: Dockerfile + Kubernetes manifests.

## 2026-07-24
- **changed** Workers: Firefox nested-worker fix regressed — open; workaround: dev on Safari (real fix: un-nest the render pool).

## 2026-07-23
- **new** Workers: multi-worker simulation — a CPU worker pool (no GPU compute).
- **changed** Performance: tectonics performance improved.
- **fixed** Workers: Firefox nested-worker bug (later regressed — see 2026-07-24).

## 2026-07-20
- **new** Build: project set up — deterministic, seeded generation from the start.

# Changelog — Platform

Build, worker pool, deploy, performance, and code structure. See [README](./README.md) for
the format.

## 2026-07-28
- **changed** Structure: worldgen restructured into modules (core / elevation / tectonics / crust / surface / render); a golden-hash harness now gates any refactor there.

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

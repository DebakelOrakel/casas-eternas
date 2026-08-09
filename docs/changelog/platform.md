# Changelog — Platform

Build, worker pool, deploy, performance, and code structure. See [README](./README.md) for
the format.

## 2026-08-09
- **fixed** Bake: a cluster bake always pulls the server's current image — a node that already held one kept running an older baker, which files its artifact under a key nobody looks for and reports success.
- **new** Bake: a bake running in the cluster reports its phase and percentage back, so the progress bar moves for a server-side bake instead of sitting at "working".
- **fixed** Bake: a bake running as a Kubernetes Job now carries its own credential, scoped to that one job — without it a server that requires a sign-in refused the Job the world it was created to bake.
- **fixed** Build: the server-side baker is type-checked — it shares code with the browser and was outside every check, so a changed signature compiled cleanly and would have run the bake without credentials.
- **new** Server: with `--auth-mode password` the API requires a login — `POST /v1/session` exchanges a user and password for a token, and everything under `/v1/` refuses without one.
- **new** Server: `--auth-mode none|password|oidc` chooses how the server establishes who is asking; an unknown value refuses to start rather than starting one that rejects everybody.
- **fixed** Storage: the artifact key now covers the bake's channel criterion, so retuning river density no longer serves the old network under an unchanged key.
- **changed** Structure: the biome classifier's fourteen thresholds are named constants instead of literals buried in its branches.
- **new** Structure: a world's fields, recipe and identity are read through one facade instead of each consumer opening the save its own way.
- **changed** Structure: world identity, the save format and the artifact keys moved into their own `world/` module, ending the worldgen/storage cycle.
- **changed** Structure: an artifact store no longer knows where the server is — it is told.
- **changed** Structure: a world field's grid, unit and land-only flag are stated once, separately from how any one format stores it.
- **changed** Structure: "is this cell land" is one function instead of six inlined copies in two polarities.
- **new** Structure: a save-format round-trip check guards quantisation, the recipe layout and the identity hashes.
- **changed** Structure: every generator slider's range and default is declared once instead of retyped in the markup, the label and the load path.
- **changed** Structure: the worldgen modules keep their tuning constants in one hashable object each.
- **new** Structure: migration declares its tuning constants and its slider ranges in one place each, as the pattern for the other modules.
- **changed** Structure: the amplification pipeline version is derived in one place instead of at eight hand-assembled call sites.
- **changed** Structure: the mantle field and the shared raft constants left `tectonics/`, so only the handover file still crosses that boundary.
- **new** Structure: the golden harness can freeze per-stage byte hashes for the length of a refactor.
- **fixed** Structure: the harness guarded only the coarse biome field, and its land-classification check could never fire.

## 2026-08-08
- **fixed** Storage: changing the river density no longer throws away a world's baked terrain — rivers are cached per density beside one shared elevation. `common.panel.storage`
- **changed** Save/Load: rivers are stored as a discharge field (m³/s per cell) instead of drawing polylines — smaller, and answerable by sampling. `worldgen.panel.hydrology`
- **new** World map: a resolution the browser cannot bake can now be ordered from the server, and its progress is shown as a notification. `world`
- **new** Server: bakes amplified terrain itself — 8192×4096 finishes in under six minutes where a browser tab runs out of memory and dies. `world`
- **new** Server: bake jobs are queued and their progress can be followed while they run.
- **changed** Deploy: one image, one binary — it serves the client, stores worlds and artifacts and bakes, replacing the nginx-only image. `common`

## 2026-08-07
- **changed** Performance: the erosion pass stores its flow-routing edges as direction bytes and reuses its elevation buffers — same results, noticeably less memory.

## 2026-07-31
- **fixed** Structure: the golden harness ran the ecology on empty volcanoes and NaN parameters, so six resources and all three migration stages guarded nothing.
- **changed** Structure: `collectVolcanoes` moved out of the worker, so program and harness share one copy.

## 2026-07-28
- **changed** Structure: worldgen restructured into modules (core / elevation / tectonics / crust / surface / render); golden-hash harness gates refactors.
- **changed** Structure: golden-hash harness moved into the repo (`npm run harness:golden`), now building worlds through the Archean.
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

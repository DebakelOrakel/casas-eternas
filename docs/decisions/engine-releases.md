---
id: DEC-0045
title.en: Engine releases
title.de: Engine-Releases
summary.en: Each pipeline is a GitHub release of its own, tagged with the
  pipeline a save records. Every mode keeps its shipped engine for the
  current pipeline. A worker that gets a task of another pipeline loads
  that pipeline's worker bundle and native engine through the server,
  which keeps them in the artifact store.
summary.de: Jede Pipeline ist ein eigenes GitHub-Release, getaggt mit der
  Pipeline, die ein Save festhält. Jeder Modus behält seine mitgelieferte
  Engine für die aktuelle Pipeline. Ein Worker, der eine Aufgabe einer
  anderen Pipeline bekommt, lädt Worker-Bundle und native Engine dieser
  Pipeline über den Server, der sie im Artefaktspeicher hält.
area: platform
stage: idea
createdAt: 2026-10-22
updatedAt: 2026-10-22
related: [DEC-0044, DEC-0039, DEC-0043, DEC-0038]
---

## Where this starts

[DEC-0044](./rust-engine.md) left "versioned pipelines" open. Its direction
was a worker image per pipeline. Two facts since then change the frame:

- The engine has a release action (`.github/workflows/engine-release.yml`,
  2026-10-22). A tag that starts with `engine` builds the native engine for
  darwin/arm64, linux/amd64 and windows/amd64 and the WASM build, checks
  each build on its own platform, and makes a GitHub release.
- The read side is still TypeScript, in the job worker's bundle (DEC-0044,
  fork 7). An engine alone cannot run a pipeline: the worker for a
  pipeline is its bundle **and** its engine.

Today each mode takes the engine from one place:

| Mode | The engine |
|---|---|
| Development (`npm run dev`, `make run`) | `engine/dist`, built from the source |
| Release archive (`make release`) | `casas-engine.node` beside `job-worker.mjs`, from `make engines` |
| Container image (Helm) | built in the image, stage 0, for musl |
| External workers (Helm, `workers` only) | the same image |
| Browser (the generator) | WASM, in the client bundle |

A worker of another pipeline takes a level task, refuses the replay, and
the job fails (DEC-0044, "Not decided — versioned pipelines").

## Fork 1 — the version that names a release

**Decided 2026-10-22: the tag is `engine-` and `status.pipeline`.**

`status.pipeline` is what world.yaml records (`WORLD_PIPELINE`,
world/worldPipeline.ts), so a save names the release of the engine that
made it. It is level 1's mesh pipeline version: the bake constants,
`tuning.history` and `AMPLIFICATION_ALGO_VERSION`.

It does not hash the tile levels' constants. A change to those only gives
another engine under the same tag. The release carries `pipeline.json`, the
versions of every stage (`job-worker.mjs --version`), and the action stops
when the tag is released already, with a message for each case: no
`pipeline.json`, the same versions, other versions (increase
`AMPLIFICATION_ALGO_VERSION`). It also stops when the tag is not this
commit's pipeline. The release notes show the versions.

Not chosen: a hash of all of `constants.json` as `status.pipeline`. Then a
change to a tile constant makes every world "made by another pipeline",
also when its history is the same.

## Fork 2 — shipped or loaded

**Decided 2026-10-22: every mode ships the engine of its own pipeline.**

A load is only for a pipeline that is not the shipped one. Without a
network, everything works as before. Development never loads: a load
would replace a change to the source without a sign.

## Fork 3 — the image's engine

**Decided 2026-10-22: the image takes the release's linux/amd64 build.**

Stage 0 (the musl build) goes. The image base changes from
`node:22-alpine` to a glibc base (`node:26-bookworm-slim`). The image then
holds the build the action checked, and Node 22 goes with it: on
linux/amd64 its WASI run of the bake test stops with SIGSEGV (measured
2026-10-22).

Open: see fork 8 (an image without a release).

## Fork 4 — what a release holds

**Decided 2026-10-22: the bundle and the engines.**

`job-worker.mjs` (one file for every platform), `casas-engine-<os>-<arch>.node`
for each platform, `casas-engine-wasm.tar.gz`, `constants.json`,
`pipeline.json`, `SHA256SUMS`. When the read side moves into the engine
(DEC-0044, fork 7b), the bundle stays in the release; it is then thin.

## Fork 5 — tasks of another pipeline

**Decided 2026-10-22: a worker computes them; it loads what it needs.**

The pipeline of a task is the world's `status.pipeline`. A worker for a
pipeline that is not its shipped one gets the bundle and the engine for
its platform through the server. The server takes them from the artifact
store, or on a miss from the GitHub release, checks them against
`SHA256SUMS`, and keeps them in the store. A worker never talks to GitHub.

Not chosen: workers refuse other pipelines (old worlds then get no tiles);
loads only on the local server (the cluster then cannot refine old
worlds).

## Fork 6 — who starts the worker of a pipeline (open)

The process that runs is always `node job-worker.mjs --serve` of one
pipeline. Something must find the right bundle first. Three places start
workers today: the local pool (`internal/modules/jobs/workerpool.go`), the
cluster's Deployment (`deploy/helm/templates/workers.yaml`, the image's
`/app/job-worker.mjs`), and a person on an external machine.

Recommended: one way for all three. A subcommand of the binary takes the
pipeline, uses the shipped bundle when it is that pipeline, else loads
bundle and engine through the server into a cache directory, and then runs
Node on them. The local pool calls it, the Deployment's command is it, and
the release archive has it. The name is the user's to give (a CLI surface).

Other option: the bundle loads the other bundle itself and runs it as a
child. No new subcommand, but code that loads code in TypeScript, and the
local pool still needs to know which pipelines to start.

## Fork 7 — which worker sees which task (open)

Recommended, as DEC-0044 sketched: the subject carries the pipeline
(`jobs.task.<pool>.<pipeline>.*`), a worker subscribes only to its own,
and the scaler counts per pipeline: one pool of local processes, or one
Deployment, per pipeline with work. Without this a worker of the current
pipeline still takes an old task and fails it.

## Fork 8 — an image without a release (open)

With fork 3 an image needs the release of its pipeline first: tag, action,
then the image. `make image` from a working tree with a new pipeline has
no release. Options: the Dockerfile builds from the source when a build
argument says so (two ways to the same file), or `make image` refuses
until the release is there (slow for a test image).

## Fork 9 — how long a pipeline stays (open)

GitHub keeps the releases until someone deletes them. The artifact store
evicts by its cap (least recently used). A rule for deleting old releases
is not needed until there are many.

## Not in this decision

- The browser. It keeps the WASM of the current pipeline only. A world of
  another pipeline asks the player: make it again with this engine (a
  different world: the simulation is chaotic), or not. A browser that
  loads an old client is a step of its own.
- Signing the builds (attestations): wait until it is needed.

## Status

IDEA 2026-10-22. Forks 1–5 are decided; forks 6–9 are open. Built: the
release action with the checks of fork 1 and the assets of fork 4. The new
names (the subcommand, the server route for a pipeline's files, the config
key for the release source) are proposed before they are written.

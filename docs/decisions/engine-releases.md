---
id: DEC-0045
title.en: Engine releases
title.de: Engine-Releases
summary.en: Each pipeline is a GitHub release of its own, tagged with the
  pipeline a save records. Every mode keeps its shipped engine for the
  current pipeline. A worker that gets a task of another pipeline loads
  that pipeline's module and native engine through the server,
  which keeps them in the artifact store.
summary.de: Jede Pipeline ist ein eigenes GitHub-Release, getaggt mit der
  Pipeline, die ein Save festhält. Jeder Modus behält seine mitgelieferte
  Engine für die aktuelle Pipeline. Ein Worker, der eine Aufgabe einer
  anderen Pipeline bekommt, lädt Pipeline-Modul und native Engine dieser
  Pipeline über den Server, der sie im Artefaktspeicher hält.
area: platform
stage: built
createdAt: 2026-10-22
updatedAt: 2026-10-27
related: [DEC-0044, DEC-0039, DEC-0043, DEC-0038]
---

## Where this starts

[DEC-0044](./rust-engine.md) left "versioned pipelines" open. Its direction
was a worker image per pipeline. Two facts since then change the frame:

- The engine has a release action (`.github/workflows/generator-release.yml`,
  2026-10-22). A tag that starts with `engine` builds the native engine for
  darwin/arm64, linux/amd64 and windows/amd64 and the WASM build, and
  makes a GitHub release. It runs no tests since 2026-10-22: `make test`
  runs them before a tag.
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

**Decided 2026-10-22: the image takes the release's linux/amd64 build.
Changed 2026-10-27: the image builds the engine from the tree.**

Stage 0 (the musl build) goes. The image base changes from
`node:22-alpine` to a glibc base (`node:26-bookworm-slim`). Node 22 goes
with it: on linux/amd64 its WASI run of the bake test stops with SIGSEGV
(measured 2026-10-22).

First built (2026-10-22): stage 0 downloaded the release of the tree's
pipeline, checked every file with `sha256sum -c`, and kept the files with
their `SHA256SUMS` in `/app/engine`. At its start the jobs module put them
into the artifact store. An image then needed the release of its
pipeline first: tag, action, then the image. On 2026-10-27 `make image`
stopped because no one had tagged the release of v13.

Now (2026-10-27): stage 0 builds the engine from the tree, as the
incubator (DEC-0048), in Rust's Debian image (glibc, as the release's
linux build). The image needs no release. The store gets the files of a
pipeline when a worker asks for them (fork 5): the server downloads them
from the release then and keeps them. Its own pipeline the image ships
beside the bundle, so its workers ask for none.

## Fork 4 — what a release holds

**Decided 2026-10-22: the pipeline module and the engines.**

`pipeline.mjs`, the job worker's pipeline module (one file for every
platform; see "The host and the pipeline"), `casas-engine-<os>-<arch>.node`
for each platform, `casas-engine-wasm.tar.gz`, `constants.json`,
`pipeline.json`, `SHA256SUMS`. When the read side moves into the engine
(DEC-0044, fork 7b), the module stays in the release; it is then thin.
Until 2026-10-22 the release held the whole bundle, `job-worker.mjs`.

## Fork 5 — tasks of another pipeline

**Decided 2026-10-22: a worker computes them; it loads what it needs.**

The pipeline of a task is the world's `status.pipeline`. A worker for a
pipeline that is not its shipped one gets the pipeline module and the
engine for its platform through the server. The server takes them from the artifact
store, or on a miss from the GitHub release, checks them against
`SHA256SUMS`, and keeps them in the store. A worker never talks to GitHub.

How (built 2026-10-22): `GET /v1/jobs/engines/{pipeline}/{file}`, in the
jobs module, `{file}` a release file's name. It answers 302 to a read link
of the artifact store; on a miss it first downloads the file from
`jobs.engine-source` (default the GitHub releases), checks it, and stores
it. In the store a release file is one artifact: `worldId` `pipeline`
(`artifacts.PipelineWorld`), `pipelineVersion` the pipeline, `stage` the
file's name. Such an artifact belongs to no world, so it has rules of its
own: everyone reads it, the anonymous caller too; only the jobs module
writes it — in its own process, or, where the artifacts target runs in
another one (the split of a cluster), over HTTP with a credential of its
own (`token.AudiencePipelineFiles`, subject `module:jobs`; built
2026-10-22), which writes nothing else; not a job and not the admin; only
the operator removes it; every listing shows it. The route's link then
names the artifacts module as the server reaches it; a worker outside the
cluster asks its own `api` instead, as it does with a task's URLs.

Not chosen: workers refuse other pipelines (old worlds then get no tiles);
loads only on the local server (the cluster then cannot refine old
worlds); a cache of the jobs module's own (all artifacts are in one place).

## Fork 6 — who starts the worker of a pipeline

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

**Decided and built 2026-10-22: `casas-eternas worker '<serving JSON>'`**
(`--cache-dir`, `--heap-mb`; internal/modules/jobs/launcher.go). The
serving JSON has a field `jobs`, the API base (`…/v1`) of the jobs module.
The launcher asks `GET /v1/jobs/pipelines` (no caller needed: pipeline
versions and numbers only) and takes its own pipeline while it has work
or nobody has any, else the one with the most work. It gets that one's
pipeline module and engine through `GET /v1/jobs/engines` into the cache,
checks that the module is that pipeline, and runs Node on it. A worker that had
no task for 10 s, while its pipeline has no work and another has, ends
with code 75 (EX_TEMPFAIL); the launcher then chooses again. Any other end
ends the launcher with the worker's code, for its supervisor. The local
pool starts the launcher (this binary, with jobs.worker's bundle by
`CASAS_JOBS_WORKER`), and so does the chart's worker Deployment (cache in
`/tmp/pipelines`). One Deployment, as before: the scaler counts the tasks
of every pipeline.

Since the split of the bundle (next section) the launcher runs the
shipped host on the other pipeline's module: `node job-worker.mjs --serve
… --pipeline <cache>/<pipeline>/pipeline.mjs`. Only releases with a
`pipeline.mjs` can be another pipeline's.

The incubator's histories have a route of their own (2026-10-27,
[DEC-0048](./incubator-history-engine.md) fork 4): their tasks name the
incubator's version (`v<n>-<hash>`, a pipeline's form) as their pipeline,
and `GET /v1/jobs/pipelines` names them (`incubators`). The launcher serves
one after its own pipeline, by `incubator.mjs` beside the host, else from
the release `incubator-<version>` (`releaseTags`: a file is looked for in
`engine-<version>` first), which holds the incubator's native build
(`casas-incubator-<os>-<arch>.node`) beside the engine's.

## The host and the pipeline

**Decided and built 2026-10-22.** The bundle held two things that change
for different reasons: what a task computes (the save's decoding, the
replay, the tile plan and bakes, the artifact formats and their keys —
the pipeline) and how a worker works (the relay, the tokens, the presence,
the artifact store and the world over HTTP, the compute thread, the switch
of the launcher — the host). A release with the whole bundle gave another
pipeline's worker that release's host, with its old subject and without
the switch; a host fix reached no older pipeline. And an image's bundle,
built from a later commit with the same pipeline, was not the release's,
so its checksum was not in the release's `SHA256SUMS`.

So the bundle is two (client/scripts/workerContract.ts):

- `job-worker.mjs`, the HOST (jobWorker.ts): always the installation's
  own, the newest. It loads a pipeline module in its compute thread, the
  one beside it or the one `--pipeline` names, and gives each task its io:
  the world's archive, the artifact store, the progress, whether to cache.
- `pipeline.mjs`, the PIPELINE MODULE (workerPipeline.ts), its engine
  `casas-engine.node` beside it: what a task computes, for one pipeline.
  It exports `contract`, `version` and `runTask(task, io)`. It talks to no
  relay and no server itself, and the host imports nothing of it.
- The CONTRACT between them, `WORKER_CONTRACT` (1): the types of
  workerContract.ts, the artifact store's interface among them. A host
  refuses a module of another contract, with a message.

Measured: a level-2 tile of a real world (L2:147,28) baked by the split
worker is byte-identical in every file to the one the whole bundle bakes.

Not chosen: the read side into the engine first (DEC-0044, fork 7b). It
is about 25 000 lines of the generator in the worker's bundle, interwoven
with the refinement, to be ported bit for bit; the contract is the seam
7b needs anyway, and each part that moves into the engine makes the
module thinner without changing it.

## Fork 7 — which worker sees which task

Recommended, as DEC-0044 sketched: the subject carries the pipeline
(`jobs.task.<pool>.<pipeline>.*`), a worker subscribes only to its own,
and the scaler counts per pipeline: one pool of local processes, or one
Deployment, per pipeline with work. Without this a worker of the current
pipeline still takes an old task and fails it.

## Fork 8 — an image without a release

With fork 3 as first built, an image needed the release of its pipeline
first. Decided and built 2026-10-22: a build argument, `make image
ENGINE=source`, built the engine in the image instead. Gone 2026-10-27
with fork 3's change: every image builds from the tree.

## Fork 9 — how long a pipeline stays

GitHub keeps the releases until someone deletes them. The artifact store
evicts by its cap (least recently used). The launcher keeps each pipeline
it loaded in its cache directory.

Decided 2026-10-22: no rule for now. The admin deletes the builds of a
pipeline by hand, in the engines group of the artifact window
(`DELETE /v1/artifacts?pipeline=`), as the other artifacts. A pipeline
takes approximately 9 MB, so a rule is not needed until there are many.

## Not in this decision

- The browser. It keeps the WASM of the current pipeline only. A world of
  another pipeline opens as it is, and its refinement goes to the workers
  of its own pipeline: the job names the world's pipeline, and the client
  reads that pipeline's versions from the release's pipeline.json
  (2026-10-22). Its load asks first: make it again with this engine (a
  different world: the simulation is chaotic), or open it as it is
  (2026-10-27; before, only a run asked). A run on a world opened as it
  is asks again: make it again, or not run. A browser that loads an old
  client is a step of its own.
- Signing the builds (attestations): wait until it is needed.

## Status

BUILT 2026-10-22. All forks are decided; fork 9 needs no code. Built:

- the release action with the check of fork 1 and the assets of fork 4;
- fork 7: the job's `pipeline` (the client sends its `WORLD_PIPELINE`) and
  the task subject `jobs.task.<pool>.<pipeline>.<jobId>`, with a consumer
  per pipeline (`workers-<pipeline>`, deleted by the relay after 24 h
  without a worker);
- fork 5: the route for a release's files, in one process and split;
- fork 6: the launcher;
- the host and the pipeline module, with their contract;
- fork 3: the image builds the engine from the tree (2026-10-27; first on
  the release, with the store filled at the start); fork 8 went with it.

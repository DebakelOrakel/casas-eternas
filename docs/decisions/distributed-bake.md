---
id: DEC-0018
title.en: Bakes as Kubernetes Jobs
title.de: Bakes als Kubernetes-Jobs
summary.en: Server-side amplification bakes become Kubernetes Jobs when — and only when
  — the server is running in a cluster. A job is already a value with a
  scope behind a Runner interface, so this is an added implementation rather
  than a rebuild. Decided: only a world's owner may commission one, the
  runner is chosen by detecting the cluster rather than by a flag,
  anti-affinity is hard so two 2.6 GB bakes never share a node, and each Job
  gets a one-shot token scoped to the artifact key it may write. Everything
  in that list exists ONLY in a cluster; a local server keeps the plain
  subprocess with no checks at all.
summary.de: Amplifikations-Bakes auf dem Server werden zu Kubernetes-Jobs, wenn — und
  nur wenn — der Server in einem Cluster läuft. Entschieden: nur der
  Besitzer einer Welt darf einen beauftragen, der Runner wird über die
  Erkennung des Clusters gewählt statt über ein Flag, harte Anti-Affinität,
  und jeder Job bekommt ein Einmal-Token für den Artefakt-Schlüssel, den er
  schreiben darf. Ein lokaler Server behält den einfachen Subprozess ohne
  Prüfungen.
area: platform
stage: building
createdAt: 2026-08-08
updatedAt: 2026-10-03
concepts: [generator.concept.jobs]
related: [DES-0009, DEC-0032]
---

The amplification bake runs on the server because an 8192² pass peaks near
2.6 GB — unremarkable for a process, fatal for a browser tab. Today one
in-process queue spawns one Node subprocess at a time
([server-storage.md](./server-storage.md)). In a cluster that is the wrong
shape: the server pod would have to be sized for the worst bake permanently,
and a bake would compete with serving requests.

## Why Jobs, and why this is not a rebuild

A bake is a **batch task with a definite end**, which is what a Job is for. It
is **bursty and rare** — once per world per pipeline version, then never again,
so long-lived workers would idle holding gigabytes. Its memory profile is
**spiky**: 2.6 GB for six minutes. A Deployment reserves that permanently; a
Job requests it only while it runs.

And retries are free *and safe*, which is unusual enough to be worth stating:
the bake is deterministic and the artifact store's writes are idempotent
temp-then-rename, so a retried Job produces the same bytes. Nothing needs
cleaning up between attempts.

None of this requires reshaping what exists. `Runner` is an interface, a job is
a value with an id, a lifecycle and a `Scope` — the three things that were put
in deliberately so distribution would be an added implementation. The queue,
the routes and the job registry do not change.

## The rule that governs all of it: cluster only

Every mechanism below — owner checks, job tokens, anti-affinity, Job objects —
exists **only when the server is running in a cluster**. A local server keeps
the subprocess runner with no authorisation, no token and no scheduling
concerns, because a local server is a person on their own machine and
protecting them from themselves buys nothing.

That is one rule with four consequences:

- The runner is chosen by **detecting the cluster**, and by nothing else: a
  service account token under `/var/run/secrets/kubernetes.io/serviceaccount`
  exists only inside a pod. There is no switch to forget in a manifest, and no
  way to accidentally enable cluster behaviour on a laptop.
- **There is deliberately no override flag.** Both of its settings would be a
  behaviour this document rules out: forcing `kubernetes` outside a cluster
  contradicts the rule above, and forcing `local` inside one runs bakes in the
  server pod under the server's own memory limit — the exact failure the split
  exists to avoid. A switch whose every position is wrong is not a switch.
- Detection is strictly the **in-cluster token**, not "can a Kubernetes client
  be built" — the latter would succeed on any developer machine holding a
  kubeconfig, and a laptop that starts creating Job objects is a worse outcome
  than an inconvenient one. Developing the runner therefore means deploying it
  and testing there, which is the right discipline for code whose job is to
  create cluster resources.
- Authorisation follows `authMode`. In `none` — the local mode by definition —
  every check passes. The code path still runs, so it cannot rot.

## 1. Who may commission a bake

**The world's owner, and nobody else** once identities are real. This matches
the staging [server-storage.md](./server-storage.md) already sets out for
writing artifacts, it is the natural rule (it is your world), and `owner` is
already recorded in every world's `meta.json`.

```
authMode none          every request passes — this IS the local case
authMode token | oidc  meta.owner must equal the caller
```

A refusal is **403 and not 404**: the world exists, and pretending otherwise
would make a permission problem look like a missing save.

The check lives in one function, `canBake(identity, world)`, called from the
handler before anything is queued — a request that will be refused should be
refused in milliseconds, not at the far end of a queue.

## 2. How the Job gets the world, and writes back

Over HTTP, not over a shared volume. This is **forced rather than chosen**: the
data PVC is ReadWriteOnce, and a Job kept off the server's node by anti-affinity
cannot mount it. So the Job downloads the world from `/v1/worlds/{uid}` and PUTs
its results to `/v1/artifacts/…`.

That costs almost nothing to build, because the baker already writes through the
bytes-at-a-path interface: `createFsArtifactStore` gives way to the existing
`HttpArtifactStore`. It also means the Job needs no volume at all and can be
scheduled anywhere — which is the property that makes anti-affinity workable.

### The token

Each Job gets a **one-shot token, scoped to the artifact key it was created
for** and valid only while the job is alive:

```
PUT /v1/artifacts/{worldId}/{pipelineVersion}/{stage}/*      allowed
anything else                                                 refused
```

Minted by the server when it creates the Job, passed as an environment
variable. A shared cluster secret would have been less machinery, but it lets
any Job overwrite anything and rotating it means restarting everything. Leaving
artifact writes open is what the design doc names as the poisoning vector the
moment a client is not your own build.

## 3. Scheduling

**Hard anti-affinity** on `kubernetes.io/hostname` against other bake pods:
never two 2.6 GB bakes on one node.

The consequence has to be designed for rather than discovered: effective
concurrency becomes `min(cap, nodes)`, and Jobs beyond that sit **Pending**.
That is honest backpressure — better than two bakes fighting over one node's
memory — but the server must report Pending as its own state. Showing
"running" for a pod that has not been scheduled would have someone watching a
progress readout that cannot move.

Also required: `ttlSecondsAfterFinished` so Job objects do not accumulate, and
resource requests sized for the real peak (~3 GB) with **no CPU limit** — CFS
throttling is precisely wrong for a six-minute burst that should take whatever
is free.

RBAC: `create`, `get`, `list`, `watch` and `delete` on `batch/jobs` in the
server's own namespace. Nothing cluster-wide.

## 4. The image

The same one. The Job runs `node /app/baker.mjs` out of the image the server
came from, so the bake pipeline is the same commit as the server that
commissioned it.

That is not tidiness. The artifact key includes a pipeline version hashed from
the pipeline's own constants, and a mismatch fails **silently**: bakes succeed,
artifacts appear, and no client ever looks for them. That exact failure
happened once already (the baker omitted `rounds` from the version hash), which
is why two images are not an option.

## Sequencing

Each step is verifiable before the next, and the first two need no cluster.

1. **Authorisation and the cap**, with the local runner. `canBake` and a
   concurrency limit, testable today. **BUILT.** `internal/identity` now
   answers "who is asking" for the whole process — the world store records an
   owner and the bake module compares against it, and two modules resolving
   that independently would eventually disagree in a way that reads as a
   permission bug. `internal/config.AuthMode` is shared with the client module
   too, so what the browser is TOLD and what the server ENFORCES cannot differ.
2. **The baker works entirely over HTTP** — reads the world from
   `/v1/worlds/{uid}`, writes artifacts to `/v1/artifacts/…`. **BUILT.** Both
   shapes live in one `Spec` and the baker picks its store by which fields are
   present; the bake itself knows nothing about the difference. **Measured: the
   two produce byte-identical artifacts** under the identical key, which is
   what makes running on a volumeless node a non-event for everyone
   downstream.
3. **The `kubernetesRunner`** — **BUILT, cluster-untested.** Talks to the API
   over plain REST rather than through client-go: the surface needed is three
   verbs on one resource, and client-go would turn a module with two
   dependencies into one with dozens. It POLLS rather than watches, since a
   watch stream's reconnect and resource-version handling is the fiddliest
   part of the API and a job running for minutes cannot tell the difference.
   The Job manifest is `internal/modules/bake/bake-job.yaml` — an editable file, not
   Go strings, so what a reader sees is what the cluster is asked for. It sits
   beside the code only because `go:embed` cannot reach out of its package.

   Two things a cluster bake does NOT do, both deliberate: it reports no
   per-phase progress (a Job's output is its pod's log, and streaming that back
   would be a second connection and a second failure mode for a number nobody
   acts on), and it returns no `Result` beyond the stage — the artifact IS the
   result, and every client finds it by key.

   **Verified on a real cluster** (APPUiO/OpenShift): the API server accepts
   the rendered manifest, and — the separate question that Job creation does
   not answer — its POD is admitted by `restricted-v2` and scheduled. Two
   fixes came out of that run: an empty CA now means the system trust store
   (a cluster with a public API certificate has none to hand out), and a Job
   that starts no pod within ten minutes is given up on, because admission
   failures do NOT increment the `failed` counter and the runner would
   otherwise poll a stuck object forever.

   Verified without a cluster: the template renders to a valid Job, the payload
   survives as exactly one argument, the anti-affinity is required rather than
   preferred, there is no CPU limit, the Job claims no PVC, and detection
   refuses to call a machine a cluster on the strength of environment variables
   alone.
4. **Commissioning from the client** — **BUILT 2026-08-08.** The world map
   offers a bake when a stage is missing and the server says it can make one.

   The gap that had to be closed first was an IDENTITY one. The bake endpoint
   addresses worlds by `metadata.uid` — the name that does not move when the
   terrain does — while the worldmap knew only `worldId`, the content hash the
   artifact store is keyed by. Both are read from the save now, and
   `loadWorldInputs` deliberately does NOT fall back to deriving a uid the way
   the generator does when restoring a legacy world: there the derivation seeds
   an identity that is then written down, while here it would be used to
   address a stranger's server, where a guess points at another world or at
   nothing. A save too old to name itself is told to be saved again.

   **Explicit, never automatic**, and that is the load-bearing decision. The
   tempting version orders a bake whenever a showable stage is absent; it
   spends minutes of a shared machine on behalf of someone who only opened a
   map, and — worse — a bake that fails, or that lands under a key this client
   does not read, would be re-ordered on every single load.

   The client checks the module list rather than mere reachability, because
   `start -t client,world` answers `/v1/capabilities` while running no baker,
   and it sends `erosionRounds` EXPLICITLY rather than letting the server
   default: the client's artifact key is derived from its own constants
   including that one.

   The failure worth naming is `mismatch`. If the finished job reports a
   different `pipelineVersion` than the client reads, the bake **succeeded** —
   real bytes, real world — but under a key nobody will ever ask for. Calling
   that a failure would be a lie and calling it success would leave someone
   staring at an unchanged map, so it is its own outcome, it says which two
   versions disagree, and the button does not come back. This is not
   hypothetical: it happened once already, when the baker hashed
   `AMPLIFY_CONSTANTS` and the worldmap hashed `{...AMPLIFY_CONSTANTS, rounds}`.

   A stage the browser TRIED and died on is offered too — the failure is
   usually memory, which is exactly what the server has more of.

   Verified end to end against a local server: upload → order → poll
   (`erosion 9% … hydrology 100%`) → artifact fetched at the path the client
   builds. The client reads `worldUid` 7c9e6679-… and derives worldId
   `alpha-8a2f4e5d9c3909b9` — the same id the server baked under, so the two
   halves of the identity meet where they must.

## Who triggers a bake (2026-08-11 — supersedes step 4's client half)

**The server, on a read it cannot fulfil.** A client asks for tier N of world
X; if the server does not have it, the server produces it and the client
waits. No client ever commissions anything.

This came out of two premises about the screens, which are worth stating
because everything below follows from them:

- **The workbench must be usable with no server at all**, local or remote,
  with a ceiling on which tiers exist.
- **The world map IS the game**, and the game does not run without at least a
  local server anyway.

So local baking stops being a client capability and becomes a *workbench*
capability. `AMPLIFY_BAKE_STAGES = [2]` against `AMPLIFY_FETCH_STAGES = [2, 4]`
already encoded exactly this split; it just had no owner.

| | Workbench | World map (the game) |
|---|---|---|
| usable serverless | yes, up to 4k | no — a server is a precondition |
| bakes locally | yes (`bakeStageInBrowser`) | never |
| commissions | no longer | never |
| reads | store: local → server | store: local → server |

### Why this is not a reversal of "explicit, never automatic"

Step 4's rule was load-bearing and its two reasons were right. Both, read
again, say *the client is the wrong place to decide* — not *nobody may decide
automatically*:

- *It spends minutes of a shared machine for someone who only opened a map.*
  The server applies that policy where the resources actually are, and
  `canBake` (§1) is already the door: the same ownership check, at the read
  handler instead of the order handler.
- *A bake that fails, or that lands under a key this client does not read,
  would be re-ordered on every single load.* The server can REMEMBER a
  failure — a negative entry per artifact key and pipeline version. A client
  cannot do that reliably, which is precisely why the rule had to exist.

Two further problems dissolve rather than move:

- **Deduplication becomes structural.** `findActiveBake` exists on the client
  only because the server does not deduplicate orders. When the server owns
  triggering, one key is one job by construction.
- **The silent mismatch shrinks.** The request carries the pipeline version it
  wants, so "I do not produce that" is an ANSWER. Step 4's worst failure was a
  successful bake under a key nobody would ever ask for.

### What this does not remove

A read that takes six minutes is not a GET. The shape stays 202 + job handle +
poll — which is what `followBake` already does. The client still waits; it
stops *deciding*. And the ownership and rate policy does not disappear, it
lands where it belongs.

### What survives from step 4, and what does not

Survives: the identity work (a world is addressed by `metadata.uid`, the
artifact by content hash — both read from the save, neither guessed), and the
reasoning about the mismatch outcome, which becomes a server-side answer.

Superseded: "explicit, never automatic" as a CLIENT rule, the world map's order
button, and the capability probe that decided whether to offer it. The
generator's own commissioning goes the same way eventually — not because it is
wrong there, but because nothing in a client needs the verb once the server
owns it. That is a later step and out of the current scope.

**Nothing of this is built.** The world map is being reduced to a read-only
consumer first (miss = the macro raster, no fallback bake); speculative 202/
polling support against a server API that does not exist yet is deliberately
NOT being written. The seam is named, not built.

## Flags this needs

One, and only one:

- `--bake-max-concurrent`, default 1 — an in-server cap so a burst cannot fill
  the cluster. Note it interacts with the hard anti-affinity above: the
  effective figure is `min(this, nodes)`, and setting it higher only produces
  Pending Jobs.

No runner flag, for the reason given under the cluster-only rule.

## The Job must pull, not reuse

Fixed 2026-08-09, found because a cluster bake reported no progress after the
feature that reports it had shipped.

The template said `imagePullPolicy: IfNotPresent` directly beneath the comment
explaining that the baker must be the SAME COMMIT as the server, "because the
artifact key includes a pipeline version and a mismatch fails SILENTLY". With a
moving tag like `:latest`, IfNotPresent is what makes that mismatch likely: a
node already holding some `:latest` never fetches another, so the server updates
and the baker does not. The Job then writes its artifact under a key nobody looks
for, reports success, and nothing appears.

`Always` now, and a test asserts it. The cost is a registry check per bake — a
job that runs for minutes, with cached layers not re-fetched — and the failure it
trades for, an unreachable registry stopping a bake that would have worked, is
loud. Loud beats an artifact filed under the wrong key.

With an immutable tag or a digest this becomes free, and pinning one is the
better answer whenever a deployment can name it.

## Saying where it runs

Added 2026-08-09, with progress reporting.

A bake takes minutes, and where it is happening is worth seeing: a Job on another
node is a different thing to wait for than a subprocess beside the server. The
client cannot infer it — the same API answers either way — so the bake module
says so in `/v1/capabilities` (`bakeRunner: kubernetes | subprocess`) through an
optional `Describe()` that the server merges. Optional and structural, like
`Module` itself, so the server package still knows about no module in particular.

**Two notifications, not one with a changing icon.** Waiting wears the server's
mark whatever the deployment is, because that is what is true — the server holds
the request until something is free to take it, and where it will run is not yet
a fact. When it starts, the first notification is dismissed and a second appears
carrying the cluster's mark or the server's.

That is the rule rather than a way around it: `NotificationPatch` allows only the
message and the bar to change, on the stated grounds that a moved icon "would
read as a second event". Here it IS one.

The icon is resolved BEFORE the poll loop, so the swap is synchronous. Awaiting
inside the loop reassigned the notification after that same tick had already
written to the old one — a race whose only symptom is a progress bar that skips.

## Related

- [server-storage.md](./server-storage.md) — the two stores, the artifact key,
  and the "who may write" staging this extends.
- [worldmap-amplification.md](./worldmap-amplification.md) — the determinism
  rule that makes a bake safely retryable in the first place.
- [design/server-storage.md](../design/server-storage.md) — the longer
  argument, including the speculation about a worker that this decides.

## Addendum 2026-09-29 — jobs are their world's, and can be cancelled

`GET /v1/bakes` and `GET /v1/bakes/{id}` answered every caller with every
job, world uid and error text included; they now show a job to whoever may
read its world (the operator sees all), each with the caller's level on it
(`callerLevel`). `DELETE /v1/bakes/{id}` cancels, for an editor of the
world: a queued job is marked `cancelled` and never starts, a running one has
its own context cancelled — the same path a shutdown takes, which aborts its
subprocess or Kubernetes Job. No pausing. The client orders level 1 from the
Finishing step and lists and cancels jobs in a full-screen window ("Jobs" in
the title bar); the artifact window rebuilds an outdated level.

## Addendum 2026-09-29 — renamed to jobs

The module is `jobs` (internal/modules/jobs): target `-t jobs`, keys
`jobs.worker` (the Node bundle, `job-worker.mjs`, `make worker`) and
`jobs.max-concurrent`, environment `CASAS_JOBS_*` and `CASAS_JOBS_IMAGE`,
routes `/v1/jobs…`, the capability name `jobs`, the token audience `job:{id}`
with subject `job`, the Kubernetes ServiceAccount `casas-eternas-jobs`, Job
names `casas-job-{id}` and the label `casas-eternas/component=job`. A hard
break: no old name is accepted. What a job computes keeps its name, the level
bake.

## Status

The jobs now bake mesh level 1 (stage 1 only); the raster amplification bake
was removed on 2026-09-29; detail comes from the mesh levels and their tile
jobs (decisions/adaptive-mesh.md, fork 3). Before that: decided —
architecture and the four forks below. STEPS 1–3 BUILT 2026-08-08 and
verified against a real OpenShift cluster: the Job is accepted, its pod is
admitted by restricted-v2 and scheduled. A real image runs as a Job and
completes (pending → running → succeeded in 54 s, mostly image pull). Not
yet run end to end as a BAKE, which needs the server deployed so a Job can
reach it. STEP 4 BUILT 2026-08-08: the world map orders a bake for a stage
it cannot make itself, verified end to end against a local server — but its
CLIENT half is SUPERSEDED 2026-08-11 (see "Who triggers a bake"): the server
triggers its own bakes on a read it cannot fulfil, and the world map becomes
a read-only consumer. Nothing of that new shape is built yet. 2026-08-13 —
the HARD ANTI-AFFINITY fork is REVERSED: replaced by a soft topology spread
(maxSkew 1, ScheduleAnyway); the honest 3Gi memory request, which this doc
already demanded, turned out to be the real per-node limit, and the hard
rule only forbade safe co-location on big nodes while making even terminated
pods block their node. Also new the same day: failed Jobs are RETAINED (last
3, 6h TTL backstop) for their pod logs, successful ones still deleted on the
spot. SUPERSEDED 2026-10-03 for the cluster: the Kubernetes Job runner is
gone; the workers are a Deployment the jobs server scales
(decisions/detail-ladder.md, addendum 2026-10-03).

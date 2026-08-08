---
summary: Server-side amplification bakes become Kubernetes Jobs when — and only when — the server is running in a cluster. A job is already a value with a scope behind a Runner interface, so this is an added implementation rather than a rebuild. Decided: only a world's owner may commission one, the runner is chosen by detecting the cluster rather than by a flag, anti-affinity is hard so two 2.6 GB bakes never share a node, and each Job gets a one-shot token scoped to the artifact key it may write. Everything in that list exists ONLY in a cluster; a local server keeps the plain subprocess with no checks at all.
date: 2026-08-08
status: decided — architecture and the four forks below. STEPS 1 AND 2 BUILT 2026-08-08 (authorisation, the concurrency cap, and a baker that works entirely over HTTP — measured byte-identical to the file-based one). Steps 3–4 not started.
---

# Bakes as Kubernetes Jobs

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
3. **The `kubernetesRunner`** — create, watch, clean up; anti-affinity, TTL,
   RBAC, requests, the Pending state.
4. **Commissioning from the client** — the world map asks for a bake when a
   stage is missing and the server says it can bake.

## Flags this needs

One, and only one:

- `--bake-max-concurrent`, default 1 — an in-server cap so a burst cannot fill
  the cluster. Note it interacts with the hard anti-affinity above: the
  effective figure is `min(this, nodes)`, and setting it higher only produces
  Pending Jobs.

No runner flag, for the reason given under the cluster-only rule.

## Related

- [server-storage.md](./server-storage.md) — the two stores, the artifact key,
  and the "who may write" staging this extends.
- [worldmap-amplification.md](./worldmap-amplification.md) — the determinism
  rule that makes a bake safely retryable in the first place.
- [design/server-storage.md](../design/server-storage.md) — the longer
  argument, including the speculation about a worker that this decides.

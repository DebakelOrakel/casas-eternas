---
id: DES-0015
title.en: NATS as a transport variant
title.de: NATS als Transportvariante
summary.en: Findings from a hypothetical discussion of NATS as a message bus — where it
  would slot into the architecture, what it would buy, and why it does not
  make split bakes attractive.
summary.de: Ergebnisse einer hypothetischen Diskussion über NATS als Message-Bus — wo es
  in die Architektur passen würde, was es brächte, und warum es verteilte
  Bakes nicht attraktiv macht.
area: platform
stage: idea
createdAt: 2026-08-16
updatedAt: 2026-09-30
concepts: [generator.concept.jobs]
related: [DEC-0032, DES-0022]
---

Notes from a deliberately hypothetical discussion (2026-08-16). The question
was: is NATS a fit for hex-tile streaming, service discovery, or service
communication — and could multiple processes cooperate on one bake?

## Not a parallel system — a third variant in an existing seam

A second, togglable discovery system would be two vocabularies for one thing.
The seam for this already exists (2026-08-12): cross-module needs are
**co-resident closures OR URL-backed variants, chosen by `cmd/` at
composition**. NATS is a third variant of that same seam — closure | HTTP |
subject — not a parallel system. Modules do not change; `cmd/` learns one more
wiring, and the toggle is the existing config key
(`global.services.worlds = http://… | nats://…` — one name, one key).

## Tokens: no rewrite needed

NATS auth callout (2.10+) hands the connect credential to a service we name.
The existing HMAC token goes in unchanged; the callout handler verifies it the
way every process already does and translates claims into subject permissions.
The rights model is already subject-shaped: the bake job token scoped to its
world becomes *publish only on `bake.{worldUid}.>`*; the `adm` claim becomes
`$SYS.>`. Identity-in-the-token stays the model; the callout is an adapter,
not a second identity system.

## What it would buy

- **Leaf nodes — the real argument.** A leaf node connects *outbound* to the
  main cluster and bridges subjects transparently: a home machine (or a second
  Kubernetes cluster, via gateway) joins with one outgoing connection — no
  ingress, no VPN, nothing exposed — and is a full bake worker. Cross-cluster
  control plane; the bytes stay HTTP (the `bakeUrl` spec field already points
  at multi-cluster artifact fetch).
- **Queue groups: the worker fleet becomes pluggable.** Bake dispatch is
  Kubernetes-specific today. As a JetStream work queue, a worker is anything
  holding a NATS credential subscribed to `bake.request` — k8s Job, home box,
  other cluster. At-least-once, retry on worker death, load balancing for free.
- **Event fan-out later** — the multiplayer trigger (a world's state spanning
  more than one process). Until then, a world's live state has exactly one home
  process (one process per store directory; per-world DB), so clients connect
  there directly — SSE/WebSocket, no bus.

## What stays HTTP

Bulk bytes. Tiles and artifacts are immutable content-addressed blobs —
browser cache, OPFS tier, server tier, eventually CDN all work over HTTP and
none over a bus. NATS payloads want to stay well under the 1 MiB default; a
queue carrying tile *pointers* is HTTP with extra steps. "Streaming tiles" in
[amplification-artifacts.md](amplification-artifacts.md) means fetch-and-cache
near the camera, which is not a pub/sub problem.

## Split bakes: boundary exchange does not rescue what isolation lost

The split design deliberately exchanges nothing — halo 8 + drowning exists so
jobs never talk. Measured verdict: chaotic divergence; the mechanism is dead,
and deposition compaction (2.6–3× on every bake) won instead. Communication
does not change that verdict:

- **Erosion/thermal**: technically decomposable — halo width H buys H local
  iterations, then exchange boundary strips (~0.5 MB per edge at 16K), barrier,
  repeat. Lockstep MPI-style computation; the transport was never the problem.
- **Hydrology is global.** The priority flood is seeded from the world ocean;
  a catchment depends on cells thousands of km away, re-derived per round ×
  networkRefreshes. Boundary strips cannot carry that. A published solution
  exists (Barnes' parallel priority-flood: flood tiles locally, then solve a
  spill graph across tile edges in a few synchronized rounds) — possible, but a
  new algorithm in the heart of the pipeline.
- **Two killers independent of transport.** (1) Byte determinism: the artifact
  cache depends absolutely on two machines baking identical bytes; distributed
  decomposition means fixing every reduction order across tile boundaries, in a
  system measured to amplify small differences rather than damp them. (2)
  Scale-up beats scale-out: 16K peaked at 8.5 GB (measured 2026-08-15); 32K
  ≈ 34 GB — still one ordinary machine. Distribution pays when the field stops
  fitting a machine, which at plausible world sizes may be never.

## Latency

Not the deciding axis. NATS core pub/sub in-cluster ~0.1–0.5 ms per hop
(direct HTTP ~1 ms); JetStream persisted ~1–5 ms depending on fsync policy;
anything browser-facing is dominated by internet RTT (20–100 ms). The real
costs are operational surface and a second addressing vocabulary — both
contained if it enters through the seam above.

## Triggers

1. **Fleet/cross-cluster becomes real** → NATS as third `services.*` variant +
   leaf nodes for out-of-cluster workers + auth callout over existing tokens.
   Small change, real gain; a home machine as bake worker is the first use case.
2. **A world outgrows one machine's RAM** → distributed bake with boundary
   exchange; the hurdle is determinism + the global flood (Barnes spill graph),
   not transport.
3. **A world's live state must span processes** (multiplayer fan-out) → the bus
   earns its place; embedded (`nats-server` as a Go library inside a target)
   rather than as a new service, keeping the one-binary-with-targets model.

None of the triggers has fired.

2026-09-30: [tile-coordinator.md](tile-coordinator.md) names a case for
trigger 1 — a coordinator that gives tile computations to a pool of
workers.

## Status

unfinished discussion notes — nothing decided, nothing built; triggers named at the end

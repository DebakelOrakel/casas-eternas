---
id: DEC-0043
title.en: The Helm chart — components of targets, workers beside them
title.de: Das Helm-Chart — Komponenten aus Targets, Worker daneben
summary.en: One chart deploys every shape from the monolith to a full
  split. A component is one Deployment that runs a list of targets; the
  default is one component with `all`. The chart derives what follows from
  the targets: replicas, volumes, the wiring between processes, the paths
  of the one Ingress, and the scaler's rights. The workers are a block of
  their own that can be on, off, or the only thing deployed. Secrets are
  referenced by role and mounted where the config expects them; the
  manifests are customised through named hooks, not a free spec; one
  value says whether the cluster is OpenShift.
summary.de: Ein Chart deployt jede Form vom Monolithen bis zur vollen
  Aufteilung. Eine Komponente ist ein Deployment, das eine Liste von
  Targets ausführt; Standard ist eine Komponente mit `all`. Was daraus
  folgt, leitet das Chart aus den Targets ab: Replicas, Volumes, die
  Verdrahtung zwischen den Prozessen, die Pfade des einen Ingress und die
  Rechte des Scalers. Die Worker sind ein eigener Block, der an, aus oder
  das Einzige sein kann, was deployt wird. Secrets werden nach Rolle
  referenziert und dort eingehängt, wo die Config sie erwartet; die
  Manifeste werden über benannte Haken angepasst, nicht über eine freie
  Spec; ein Wert sagt, ob der Cluster OpenShift ist.
area: platform
stage: built
createdAt: 2026-10-18
related: [DEC-0021, DEC-0023, DEC-0032, DEC-0038]
---

## Where this starts

A Helm chart was written on 2026-08-13 (`deploy/helm/`, branch
`feat/helm-chart`): one flat template per target (`all`, `client`,
`world`, `artifacts`, `bake`, `docs`, `auth`), one ConfigMap holding the
`casas.yaml`, the session key as a referenced Secret, a volume per store
target, and hardened containers. Its frame holds. Its contents are two
months old:

- the targets changed: `bake` is `jobs`, and `relay` is new;
- bakes are no longer Kubernetes Jobs: the workers are a Deployment the
  server scales (DEC-0032, addendum 2026-10-03), found by the label
  `casas-eternas/component: worker`, with a service account's credential;
- the storage keys changed in a hard break (DEC-0038): `state-dir` for
  auth, jobs and relay, `storage.type: dir|s3` for world and artifacts,
  `content-dir` for client and docs; the old chart would not start;
- the relay listens on 4222 for the workers inside and on 4223 for
  WebSockets behind the Ingress at `/relay` (DEC-0032, 2026-10-18);
- with s3, world and artifacts need no volume.

The question was not only how to bring it up to date, but whether one
template per target is the right shape: a deployment may want something
between the monolith and one process per target.

## Fork 1 — The unit of the chart: a component of targets

- **A.** One template per target (the old chart). A mix is not
  expressible except by `all` plus hand-wired extras.
- **B.** A few fixed schemes (`monolith`, `split`, `full`) chosen by one
  value.
- **C.** Components: each one Deployment running a list of targets
  (`start -t a -t b`), named by the user.

**Answer: C**, with the monolith as the default and the schemes of B as
example values files (`examples/*.yaml`). The binary already runs
any set of targets in one process; a scheme is only one assignment of
components, so building schemes into the chart would fix choices the
binary leaves open.

```yaml
components:
  server:              # the default: the monolith
    targets: [all]
    resources: {}
    persistence: { size: 5Gi }
```

A split as the target shape (once the server allows it, see Status):

```yaml
components:
  server: null           # Helm merges maps: the default goes only as null
  edge:    { targets: [client, docs], replicas: 2 }
  stores:  { targets: [world, artifacts, auth], persistence: { size: 2Gi } }
  compute: { targets: [jobs, relay], persistence: { size: 5Gi } }
```

The natural cuts are by what a target is, not by reading and writing
(`jobs` writes artifacts): the edge is stateless and scales; the stores
hold the only data that cannot be made again; compute is the coordinator
and its bus, which talk all the time, and JetStream wants a disk. What
today's server allows is less (Status); `examples/split.yaml` is
that.

Honestly: the server targets are light, and the load is the workers',
which are apart anyway. A split buys a scalable edge, stores that a
compute update does not touch, and smaller failures. For today's size the
monolith and the workers are enough; C costs the user nothing for that and
leaves the mix open.

## Fork 2 — What the chart derives, and refuses

The chart derives from the targets what a user would otherwise have to
know, and refuses at `helm install` (`fail`) what cannot run:

- **Every target exactly once** over all components (`all` counts as every
  module). A doubled target would put two processes on one store; a
  missing one leaves a module nobody serves.
- **`replicas` only for a stateless component**: one whose targets are
  only `client` and `docs`. Every other component is pinned to 1 with
  `strategy: Recreate`, one process per store (DEC-0021); `jobs` holds its
  coordinator's state in the process too.
- **A volume where a target needs one**: `auth`, `jobs` and `relay` always
  (their `state-dir`), `world` and `artifacts` only with `storage.type:
  dir`.
- **The wiring**: where a module is not in a component's process, the
  chart sets that component's `global.services.worlds`, `.artifacts` and
  `.relay` to the component that runs it (`http://<release>-<component>:8080`,
  `nats://<release>-<component>:4222`). Nobody writes these by hand.
- **The scaler's side** goes with the component that runs `jobs`: the Role
  (`list` on Deployments, `get`/`update` on `deployments/scale`) when the
  workers are on, and `CASAS_POD_IP`.
- **The admin socket** is pod-local; NOTES.txt names the component that
  runs `auth` for `kubectl exec`.

- **A start that never comes** is refused too: every process checks at
  start that the peers it names in `global.services` answer
  (`requireCapability`); `artifacts` needs `world` and `jobs` needs
  `artifacts`, so `world` and `jobs` in one component and `artifacts` in
  another wait for each other forever (measured, Status).

Not checked, by decision (2026-10-18): that `client` shares its component
with `auth`. The server is to lift that limit (Status), and the chart does
not encode it meanwhile.

## Fork 3 — The workers: on, off, or alone

The workers are not a component: they are the Node worker, not `start -t`,
and the server scales them. Their block decides three cases with whether
a component runs `jobs`:

| a component runs `jobs` | `workers.enabled` | result |
|---|---|---|
| yes | true | The usual case. The chart wires the relay's Service and the scaler's Role; the server scales from 0 to `jobs.max-concurrent`. |
| yes | false | A server without workers of its own; only workers from outside, over `/relay`. No worker Deployment, no Role, and the server's scaler is off (`jobs.scale-workers: false`, set by the chart). |
| no | true | **Workers alone**, e.g. in another cluster for a server elsewhere. That server cannot scale them: a fixed `replicas`, and the addresses are required. |

```yaml
workers:
  enabled: true
  # Only when no component runs jobs (workers for a server elsewhere):
  replicas: 2
  server:
    relay: wss://casas-eternas.ahoi.sh/relay
    api: https://casas-eternas.ahoi.sh      # also where the token is traded
  resources: { limits: { memory: 6Gi } }
```

- **The upper bound is configuration, not the chart's**: it is
  `jobs.max-concurrent` in the `casas.yaml`, which the server enforces.
  The chart invents no second name for it; the worker Deployment ships at
  `replicas: 0` and the scaler owns the number.
- With a component that runs `jobs`, the chart derives `server.*` itself
  (the relay's Service, the server's address inside); `replicas` is
  ignored.
- Without one, the chart requires `server.relay` and `server.api` and
  refuses without them.
- Scaling workers alone by the remote server's demand is the controller
  idea of 2026-10-18 (not decided); until then a fixed count.

**The server needs a switch for the second case**: `jobs.scale-workers`
(boolean, default true; key, flag and `CASAS_JOBS_SCALE_WORKERS`, agreed
2026-10-18). Off, the jobs module starts no scaler in a cluster. Without
it the scaler would look for a Deployment every 10 s and, with no Role,
be refused every time. To build with the chart.

## Fork 4 — Secrets by role

There are more secrets now than the session key: the s3 keys of the
worlds and the artifacts stores, the link keys of the dir backend, and the
workers' service account. Every one of them is a FILE the config names
(`global.auth.session-key`, `<store>.storage.s3.access-key-file` /
`secret-key-file`, `<store>.link-key`, the worker's `RELAY_CREDENTIALS`).

**Answer: a `secrets` block keyed by role.** Each role names an existing
Secret; the chart mounts it under `/etc/casas-eternas/secrets/<role>/`
into the components that need it and sets the config key to the file. The
user never writes a path.

```yaml
secrets:
  sessionKey:        { name: casas-eternas-auth }     # key: session.key
  worldsS3:          { name: casas-eternas-worlds-s3 } # access-key, secret-key
  artifactsS3:       { name: casas-eternas-artifacts-s3 }
  worldsLinkKey:     { name: "" }                      # dir backend only
  artifactsLinkKey:  { name: "" }
  workerCredentials: { name: casas-eternas-worker }   # key: credentials
```

- **Referenced, not templated**, by default: a value in a values file is a
  secret in Git or in Helm's release history. `create: true` with `data`
  is allowed for a throwaway install, documented as such.
- An empty name leaves the role out; the server then does what it does
  without that file (an ephemeral key with its warning, or no s3).
- A role only goes where its target runs: `worldsS3` to the component with
  `world`, `workerCredentials` to the workers.

## Fork 5 — One Ingress

**Answer: a global `ingress` block, one host, one Ingress object**; its
paths are derived from the components: `/` to the component with
`client`, `/v1/<module>` to the component with that module, `/relay` to
the one with `relay`. In the monolith that is `/` and `/relay`.

```yaml
ingress:
  enabled: true
  className: ""
  host: casas-eternas.ahoi.sh
  annotations: {}        # e.g. route.openshift.io/termination: edge
  tls: { secretName: casas-eternas-tls }
```

No relay annotation: the relay pings every 30 s, under the routers'
default timeouts (DEC-0032, 2026-10-18), so the Ingress keeps its
defaults for every path.

## Fork 6 — Customising the manifests: named hooks, not a free spec

- **A.** A free `spec` per component, merged into the Deployment.
- **B.** Named hooks, as common charts have them.
- **C.** Nothing in the chart; a post-renderer (kustomize) for the rest.

**Answer: B, and C for what B does not cover.** A free spec looks
flexible but merges badly: Helm's merge replaces lists, so one container
setting in `spec` drops the chart's container, its probes and its mounts;
and every key the chart derives (replicas, strategy, volumes) could be
overridden into a state that cannot run, past the checks of fork 2. The
hooks are per component and for the workers:

```yaml
    podAnnotations: {}
    podLabels: {}
    nodeSelector: {}
    tolerations: []
    affinity: {}
    topologySpreadConstraints: []
    priorityClassName: ""
    podSecurityContext: {}
    securityContext: {}      # the container's; hardened by default
    extraEnv: []
    extraVolumes: []
    extraVolumeMounts: []
```

What is still missing is a post-renderer's job (`helm install
--post-renderer`), outside the chart.

## Fork 7 — OpenShift or plain Kubernetes

The two reference manifests differ in two places only
(`deploy/manifests.yaml` for OpenShift, `deploy/kubernetes.yaml` for
plain Kubernetes): the pods set `runAsUser`/`runAsGroup`/`fsGroup` 1001
themselves on plain Kubernetes, where OpenShift's SCC assigns an
arbitrary UID in group 0 and refuses a fixed one; and the Ingress
annotations (`route.openshift.io/termination: edge` and its redirect, or
the controller's own).

**Answer: `platform: auto | openshift | kubernetes`**, not a boolean, so
a third kind of platform does not need a second switch. `auto` asks the
cluster (`.Capabilities.APIVersions.Has "route.openshift.io/v1"`); where
there is no cluster to ask (`helm template`, a GitOps renderer) it reads
as `kubernetes`, so a renderer for OpenShift sets `openshift`. The value
decides:

- the pod security context: none on OpenShift, the fixed UID, GID and
  `fsGroup` (with `fsGroupChangePolicy: OnRootMismatch`) on Kubernetes;
  `podSecurityContext` (fork 6) still overrides it;
- the Ingress's default annotations on OpenShift (edge termination and
  the redirect to HTTPS), merged under `ingress.annotations`. On plain
  Kubernetes the annotations belong to the controller, not to the
  platform (ingress-nginx's are not Traefik's), so the chart sets none and
  the values do.

## Status

decided 2026-10-18 — forks 1–7 as above.

2026-10-18: BUILT. The server's `jobs.scale-workers` first (a boolean
from `CASAS_*` did not decode; the loader parses booleans now too). The
chart in `deploy/helm` (0.2.0): `templates/components.yaml` (per
component its ServiceAccount, Role and RoleBinding where it scales the
workers, its volume, Deployment and Service), `workers.yaml`,
`ingress.yaml`, `secrets.yaml`, `configmap.yaml`; the derivations and
checks in `_helpers.tpl`; `examples/` for a split, s3, workers alone and a
server without workers of its own. A test keeps `workers.heapMB` equal to
the jobs module's `nodeHeapMB` (mirrors_test.go). Helm merges maps, so a
values file that replaces the default component sets `components.server:
null`; the duplicate-target message says so.

Checked: `helm lint`; every example rendered; every check fails with its
message (a doubled, a missing, an unknown target, `all` beside others,
replicas on a stateful component, workers alone without the server's
addresses, an unknown platform, the start cycle). Every rendered
component was started with the server binary, the chart's ConfigMap and
CASAS_* variables (paths moved to a temp directory, the Services mapped to
local ports, restarts as a Deployment does them): the monolith comes up;
the server without workers comes up with the scaler off; s3 passes the
config and stops at the missing key files, as without the Secret it
should; the split of `examples/split.yaml` comes up.

Found on the way, both the server's, not the chart's:

- **The browser sees one component.** `/v1/capabilities` reports only its
  own process's modules, and the client offers a login only when `auth`
  runs in its process (cmd/start.go, `loginPath`). So the component with
  `client` must also run `auth`, `world`, `jobs` and `docs` for the
  browser to see a whole server. To lift in the server next (the
  capabilities of the peers, and the login path of the auth service);
  the chart does not need to change for it.
- **The start cycle** of fork 2: with `world` and `jobs` in one component
  and `artifacts` in another, neither ever starts. Measured with the split
  first written as the example (front with world and jobs, artifacts
  apart): both exited at every restart. The chart refuses the shape; the
  server could instead wait for a peer in the background.

What today's server allows a browser is therefore one component of
everything but the relay, and the relay apart: `examples/split.yaml`.
Not checked in a cluster yet; the monolith default renders the objects
of `deploy/manifests.yaml`, with the chart's names and labels (the worker
Deployment keeps `casas-eternas/component: worker`, which the scaler finds
it by, so one release per namespace).

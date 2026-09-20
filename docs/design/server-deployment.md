---
summary: The deployment map for the server's small files — what each one is (config, secret, or state), how often it is read and written, where it lives on a plain machine versus Kubernetes versus a split-target deployment, and which modules touch it. casas.yaml is the one true ConfigMap; the session key and TLS material are Secrets; auth.db is state on the auth volume, administered over the pod-local admin socket. Also records the finding that forced the auth target: buildAuth used to run per process.
date: 2026-08-13
updated: 2026-08-13
area: platform
stage: built
status: agreed, built and made true in one day (2026-08-13, decisions/server-user-admin.md): auth target, admin socket and `auth user` CLI exist, htpasswd is gone, and every row of the map behaves identically on a plain machine and on the cluster. deploy/manifests.yaml matches.
---

# Server deployment: where the small files live

The server runs on three shapes: a plain machine (one binary, files beside
it), Kubernetes all-in-one (today's [deploy/manifests.yaml](../../deploy/manifests.yaml),
OpenShift), and the split-target deployment the module system was built for.
This doc maps every small file the server touches onto those shapes. The
sorting question for each file is not "where is it convenient" but **what
genre is it** — configuration flows operator → process one way; secrets are
configuration with narrower eyes; state is written by the process and
belongs to exactly one module's storage.

## Inventory

| File | Genre | Read | Written | Kubernetes home |
|---|---|---|---|---|
| `casas.yaml` | config | once, at start, by `cmd/` | operator only | **ConfigMap**, every Deployment |
| session key (`global.auth.session-key`) | secret | once, at start | operator only (rotation = rollout) | **Secret**, every API-serving Deployment |
| `auth.db` | state | per login (a read transaction) | process (admin socket), transactional | **PVC** (`auth.storage`), auth Deployment only, replicas 1 |
| TLS cert/key/ca (`global.tls.*`) | secret | once, at start | operator only | **not used** — the Route/Ingress terminates |
| bake-job token | credential in flight | the Job, as bearer | minted per job | no mount — travels in the Job spec |

## Per file

**casas.yaml — the one true ConfigMap.** It is the only file that describes
the *whole system's* behaviour, and the design already cut it for sharing:
target selection is deliberately absent from the file
([internal/config/tree.go](../../internal/config/tree.go)), so every process
of a split deployment reads the *same* file and only `CASAS_TARGET` differs
per Deployment. One ConfigMap, mounted read-only everywhere, environment
selects the role. Plain server: the same file beside the binary. There is no
behavioural difference between the platforms, only in what triggers the
restart after an edit.

**Session key — a Secret in every API-serving pod.** Read once at start,
held in memory; it is what lets every target verify tokens locally and
therefore run alone. Issuing is narrower than verifying: session (login) and
bake (job tokens) mint, everyone verifies. The asymmetry that matters:
**bake Jobs never see the key** — they carry one finished, world-scoped,
short-lived token in the Job spec. A compromised job can spend its token,
not mint identities. Rotation is a rollout, identically on both platforms.

**auth.db — state, and the deliberate odd one out.** Lives under
`auth.storage` on a volume, written by the process through the admin socket,
one process per store directory (with bbolt, kernel-enforced). Never a
ConfigMap, never a Secret — those are operator→process channels, and this
file goes the other way. On the cluster: a PVC on the auth Deployment,
replicas 1. On a plain machine: a directory. Identical code path on both,
which is the property the whole user-admin decision buys. (Its predecessor —
an htpasswd file in the Secret — was the one row whose write path differed
between platforms, and that asymmetry is why it is gone;
[server-user-admin.md](../decisions/server-user-admin.md).)

**TLS — the platform's job on the cluster.** The Route terminates with the
router's certificate (edge, HTTP redirect); pods speak HTTP. `global.tls.*`
exists for the plain-machine shape, where there is no router in front.

## The picture, as Deployments

```
ConfigMap  casas-config ────────► every Deployment   (env CASAS_TARGET differs)
Secret     casas-session-key ───► world, artifacts, bake, auth
PVC        auth-storage ────────► auth only,      replicas 1  (auth.db)
PVC        world-storage ───────► world only,     replicas 1
PVC        artifacts-storage ───► artifacts only, replicas 1
Route / cert-manager ───────────► TLS, in front of everything
admin socket (UDS) ─────────────► pod-local, per process; reached via pods/exec
```

`client` and `docs` serve static bytes; they need no credential store and
could in principle run without the key — fine detail, not a boundary anyone
enforces.

The admin socket ([server-user-admin.md](../decisions/server-user-admin.md))
is pod-local filesystem: nothing outside the pod reaches it, which is its
security model. A separate setup Job therefore cannot use it; bootstrap is
an exec, or an initContainer writing the pre-start `auth.db`.

## The finding that shaped the split: buildAuth was per-process

RESOLVED 2026-08-13, the same day, by server-user-admin.md step 3 — login
and the credential store now follow the `auth` target, and every other
process only verifies. The finding stays recorded because it is why the
target HAD to exist. As found: [cmd/start.go](../../cmd/start.go) built
authentication regardless of target — in password mode, *every* process
mounted the session module and opened the credential store. For the
all-in-one Deployment that is correct and invisible. For a split it is not:
either every pod opens the auth storage — violating "one process per store
directory", or worse, with per-pod PVCs each process mints *different* user
ids for the same name — or login is pinned to one target.

So the split deployment *requires* the auth target
([access-control.md](./access-control.md), "an auth target, but only for
authentication") — not as an elegance but because the Secret and PVC
boundaries above are target boundaries. "Session is a module with no target,
chosen by auth mode" stops being true on the day two pods run different
targets in password mode.

## The auth mode is configuration, deliberately

`global.auth.mode` defaults to `none` — right for the local single-player
case, and on a cluster it is the manifest's env line that makes the server
an authenticated one. A coded guard (refuse a defaulted mode when the
process detects Kubernetes) was built and REVERTED the same day
(2026-08-13): it would have made platform detection a policy input and made
the server ask where a config value came from — both against the grain of
"the server does not know where it runs" and "modules see plain values".
Whoever can drop the env line can drop the gate too; protecting the
manifest is the platform's job, not the binary's.

## What stays deliberately boring

Worlds, artifacts, revisions, grants: they are the *big* files and directory
trees, covered by [server-storage.md](../decisions/server-storage.md) — PVC
per store module, one process each, which the module rules already demand.
Nothing in this doc changes them; the map here is only the small files that
were ever tempted to be "just config".

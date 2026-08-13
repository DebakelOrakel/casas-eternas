---
summary: The cluster deployment — what the manifests set up, the one Secret, bootstrapping users over pod exec, how bakes run as Jobs, and the run-once deadline trap.
date: 2026-08-13
group: installation
order: 40
---

# Kubernetes

`deploy/manifests.yaml` is the reference deployment (written against
OpenShift; the Route is the only OpenShift-specific object). It creates:

- a **ServiceAccount + Role/RoleBinding** — the server creates bake Jobs
  beside itself, so it needs `jobs.batch` create/get/list/watch/delete in
  its own namespace and nothing anywhere else,
- a **PersistentVolumeClaim** (`/data`) — worlds, artifacts and the user
  store share it while everything runs in one pod,
- a **Secret** (`casas-eternas-auth`) — applied empty; holds the one
  value that must not be in git (below),
- the **Deployment** (replicas 1 — the stores' concurrency model is one
  process per directory), **Service** and **Route**.

TLS terminates at the Route; pods speak HTTP.

## First run

```
oc apply -f deploy/manifests.yaml

# the key session tokens are signed with — generated once and KEPT:
# without it every restart ends every session
oc create secret generic casas-eternas-auth \
  --from-literal=session.key="$(openssl rand -base64 48)" \
  --dry-run=client -o yaml | oc apply -f -
```

The Deployment sets `CASAS_GLOBAL_AUTH_MODE=password` explicitly. The
compiled default is `none` (the local mode) — that env line is what makes
this an authenticated server; guard it like the Secret.

Users are **state, not configuration**: they live in `auth.db` on the
data volume and are administered over the pod's admin socket
(`CASAS_GLOBAL_ADMIN_SOCKET=/tmp/admin.sock` in the Deployment). Reaching
the socket requires `pods/exec` — that RBAC is the whole authorization:

```
echo -n 'the-password' | oc exec -i deploy/casas-eternas -- \
  /app/casas-eternas auth user add ada --password-stdin
oc exec deploy/casas-eternas -- /app/casas-eternas auth role bind ada admin
```

No flags needed: the exec session inherits the pod's environment, and the
socket path is absolute. `auth user list|passwd|delete` and
`auth role bind|list` manage everything from there — effective
immediately, except the admin role, which lands in the token at the
member's next login.

## Bakes are Jobs

A server in a cluster runs amplification bakes as Kubernetes Jobs — same
image as the server (enforced with `imagePullPolicy: Always`; the
artifact key carries a pipeline version, and a stale baker fails
silently). The Job mounts nothing: it reads the world and writes the
artifacts over HTTP with a one-shot token scoped to that world.

Scheduling is left to real numbers: each Job requests its honest 3Gi
peak, so how many fit a node is the node's business; a topology spread
prefers empty nodes without forbidding co-location. Jobs beyond the
cluster's free memory sit Pending, and the server reports exactly that.
`bake.max-concurrent` (set to 3 in the manifests) caps how many are in
flight at all.

**Failed Jobs are kept** — the last three, so their pod logs survive for
diagnosis (`oc logs job/casas-bake-<id>`); successful ones are removed
immediately. A six-hour TTL is the backstop for jobs nobody deleted.

**The run-once deadline trap.** OpenShift's RunOnceDuration plugin (or a
project override) may inject `activeDeadlineSeconds` into run-once pods —
and a bake is one. An 8K bake can legitimately need 30–45 minutes on
modest nodes, which a default ~30-minute cap kills just before the finish
line, as `DeadlineExceeded`. The cap cannot be raised from the pod; it is
namespace configuration:

```
oc annotate namespace <ns> openshift.io/active-deadline-seconds-override=7200 --overwrite
```

## Updating

Push the image, then `oc apply -f deploy/manifests.yaml` and a rollout —
manifests and image travel together, because the env vocabulary and the
binary must agree (an old binary silently ignores env names it does not
know).

## Splitting targets

Every target runs alone; a split deployment is several Deployments of the
same image with different `CASAS_TARGET`, one store directory each, the
shared session-key Secret everywhere, and the auth target as the one
process holding login and the user store. The reference manifests
deliberately stay all-in-one; the map of what goes where is
[design/server-deployment.md](../design/server-deployment.md).

---
summary: The cluster deployment (OpenShift) — what the manifests set up, the one Secret, bootstrapping users over pod exec, the job workers the server scales and their service account, and the ingress.
date: 2026-08-13
updated: 2026-10-03
group: installation
order: 40
---

# Kubernetes

`deploy/manifests.yaml` is the reference deployment, written for
OpenShift and applied with `kubectl`. The pods set no `runAsUser` and no
`fsGroup`: OpenShift's `restricted-v2` policy gives each pod a UID from the
namespace's range and makes the volumes writable for it, and the image is
built for an arbitrary UID. On plain Kubernetes that is not done for you —
a fresh volume stays root's (`mkdir /data/auth: permission denied`) until
the pods get a `securityContext` with `runAsUser` and `fsGroup`. It creates:

- a **ServiceAccount + Role/RoleBinding** — the server scales its job
  workers beside itself, so it needs `list` on Deployments and
  `get`/`update` on `deployments/scale` in its own namespace and nothing
  anywhere else,
- a **PersistentVolumeClaim** (`/data`) — worlds, artifacts and the user
  store share it while everything runs in one pod,
- a **Secret** (`casas-eternas-auth`) — applied empty; holds the one
  value that must not be in git (below),
- the **Deployment** (replicas 1 — the stores' concurrency model is one
  process per directory), the job workers' Deployment, the **Service** and
  an **Ingress**.

OpenShift turns the Ingress into a Route by itself; its
`route.openshift.io/*` annotations make that Route end TLS at the router
and redirect HTTP to HTTPS. The certificate is Let's Encrypt, issued and
renewed by cert-manager through the ClusterIssuer `letsencrypt-production`
(Secret `casas-eternas-tls`); pods speak HTTP. **Set the host** in the
Ingress (twice: the rule and the TLS entry) before the first apply.
Uploads are worlds of tens of megabytes — on another controller, one with a
body limit must allow them (ingress-nginx:
`nginx.ingress.kubernetes.io/proxy-body-size: "0"`).

## First run

```
kubectl apply -f deploy/manifests.yaml

# the key session tokens are signed with — generated once and KEPT:
# without it every restart ends every session
kubectl create secret generic casas-eternas-auth \
  --from-literal=session.key="$(openssl rand -base64 48)" \
  --dry-run=client -o yaml | kubectl apply -f -
```

The Deployment sets `CASAS_GLOBAL_AUTH_MODE=password` explicitly. The
compiled default is `none` (the local mode) — that env line is what makes
this an authenticated server; guard it like the Secret.

Users are **state, not configuration**: they live in `auth.db` on the
data volume and are administered over the pod's admin socket
(`CASAS_GLOBAL_ADMIN_SOCKET=/tmp/admin.sock` in the Deployment). Reaching
the socket requires `pods/exec` — that RBAC is the whole authorization:

```
echo -n 'the-password' | kubectl exec -i deploy/casas-eternas -- \
  /app/casas-eternas auth user add ada --password-stdin
kubectl exec deploy/casas-eternas -- /app/casas-eternas auth role bind ada admin
```

No flags needed: the exec session inherits the pod's environment, and the
socket path is absolute. `auth user list|passwd|delete` and
`auth role bind|list` manage everything from there — effective
immediately, except the admin role, which lands in the token at the
member's next login.

## Job workers

The refinement's workers are their own Deployment, `casas-eternas-worker`,
shipped at `replicas: 0`: the jobs server scales it up when tasks wait and
back to zero when every job is through, finding it by the label
`casas-eternas/component: worker`. Do not set its replicas by hand; an
`kubectl apply` of the manifests puts it back to 0, which stops a running
refinement's workers until the server scales them up again (the tasks are
handed out again, so only time is lost). While any job is open the server
keeps as many workers as there are tasks, up to `jobs.max-concurrent`, and
never fewer than are running; when every job is through, zero. It needs
`list` on Deployments and `get`/`update` on `deployments/scale` in the
namespace (the Role in the manifests).

The workers reach the server inside the namespace only: the relay (NATS) on
the Service's `relay` port 4222, not on the Ingress, and the server's HTTP
API for their tasks. They prove themselves with a **service account** of
the server's auth system, which they trade for a bus token valid for an
hour. Create it once, after the first start:

```
kubectl exec deploy/casas-eternas -- /app/casas-eternas auth service add cluster-workers > credentials
kubectl create secret generic casas-eternas-worker --from-file=credentials
rm credentials
```

The credential is shown once. To replace it: `auth service rotate
cluster-workers`, then the Secret; the workers read the file again at
every trade and need no restart. `auth service delete` ends an account; the
tokens it bought run out within the hour.

## Updating

**Once, for a server deployed before the worker Deployment (2026-10-03):**
the server's pods are labelled `casas-eternas/component: server` now, and
a Deployment's selector cannot change in place. `kubectl delete deploy/casas-eternas`
before the apply; the data volume and the Secrets stay.

Push the image, then `kubectl apply -f deploy/manifests.yaml` and a rollout —
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

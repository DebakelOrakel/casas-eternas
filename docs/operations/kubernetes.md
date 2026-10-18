---
summary: The cluster deployment with the Helm chart — what it sets up, the Secrets, bootstrapping users over pod exec, the job workers the server scales and their service account, workers outside the cluster, and the ingress.
date: 2026-08-13
updated: 2026-10-18
group: installation
order: 40
---

# Kubernetes

`deploy/helm` is the deployment, a Helm chart for OpenShift and plain
Kubernetes ([decisions/helm-chart.md](../decisions/helm-chart.md)). By
default it runs everything in one pod (the component `server`, target
`all`) and the job workers beside it. It creates:

- a **ServiceAccount + Role/RoleBinding** for the component that runs the
  jobs: the server scales its workers beside itself, so it needs `list` on
  Deployments and `get`/`update` on `deployments/scale` in its own
  namespace and nothing anywhere else. Without workers in the chart
  (`workers.enabled: false`) only the ServiceAccount, with no rights: its
  token is how the server knows it is in a cluster, and off a cluster it
  starts workers in its own pod;
- a **PersistentVolumeClaim** (`/data`) per component that keeps state:
  the user store, the jobs, the relay's queue, and the worlds and artifacts
  while they are on the `dir` backend;
- per component a **Deployment** (replicas 1 where it keeps state: the
  stores' concurrency model is one process per directory) and a
  **Service**; the workers' Deployment; one **ConfigMap** (`casas.yaml`)
  and one **Ingress**.

It does not create the Secrets (below), unless told to.

```
helm install casas-eternas deploy/helm --namespace casas \
  --set platform=openshift \
  --set ingress.host=casas-eternas.ahoi.sh \
  --set ingress.tls.secretName=casas-eternas-tls \
  --set ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-production
```

- **`platform`**: `auto` asks the cluster for OpenShift's Route API; set
  it where the chart is rendered without a cluster (`helm template`, a
  GitOps tool). On `openshift` the pods set no UID (the `restricted-v2`
  policy gives each pod one from the namespace's range, and the image is
  built for an arbitrary UID), and the Ingress gets the annotations that
  make OpenShift's Route end TLS at the router and redirect HTTP to HTTPS.
  On `kubernetes` the pods run as UID, GID and `fsGroup` 1001, or a fresh
  volume stays root's (`mkdir /data/auth: permission denied`).
- **`config`** is the `casas.yaml`, in the server's own vocabulary (a key
  is the flag name is the `CASAS_*` variable). Its `global.auth.mode:
  password` is what makes the server an authenticated one; the compiled
  default is `none`, an open server. The chart sets the directories, the
  relay's listeners, the peers' addresses and the secrets' files itself.
- **`secrets`** names the Secrets by role; the chart mounts each where its
  targets run and sets the config key to the file.
- **`components`**: other shapes are in `deploy/helm/examples/`. Helm
  merges maps, so a values file with components of its own sets
  `components.server: null`. The component with the client speaks for the
  others to the browser (its login, and their modules under
  `/v1/capabilities`, through `global.peers`, which the chart sets).
- **`workers`** are scaled by the server up to `config.jobs.max-concurrent`.
- **`ingress`**: one host. The certificate is the controller's business
  (above: cert-manager, ClusterIssuer `letsencrypt-production`, into the
  Secret `casas-eternas-tls`); pods speak HTTP. Uploads are worlds of tens
  of megabytes: a controller with a body limit must allow them
  (ingress-nginx: `nginx.ingress.kubernetes.io/proxy-body-size: "0"`).

The scaler finds the worker Deployment by its label in the namespace: one
release per namespace.

## First run

```
# the key session tokens are signed with — generated once and KEPT:
# without it every restart ends every session
kubectl create secret generic casas-eternas-auth \
  --from-literal=session.key="$(openssl rand -base64 48)"

helm install casas-eternas deploy/helm --namespace casas …
```

Users are **state, not configuration**: they live in `auth.db` on the
data volume and are administered over the admin socket of the component
that runs `auth` (`global.admin.socket: /tmp/admin.sock`). Reaching the
socket requires `pods/exec` — that RBAC is the whole authorization:

```
echo -n 'the-password' | kubectl exec -i deploy/casas-eternas-server -- \
  /app/casas-eternas auth user add ada --password-stdin
kubectl exec deploy/casas-eternas-server -- /app/casas-eternas auth role bind ada admin
```

No flags needed: the exec session inherits the pod's environment, and the
socket path is absolute. `auth user list|passwd|delete` and
`auth role bind|list` manage everything from there — effective
immediately, except the admin role, which lands in the token at the
member's next login. The chart's notes after an install name the
Deployment to exec into.

## Job workers

The refinement's workers are their own Deployment,
`casas-eternas-worker`: the jobs server scales it up when tasks wait and
back to zero when every job is through, finding it by the label
`casas-eternas/component: worker`. Do not set its replicas by hand. The
chart leaves `replicas` out of it, so an upgrade keeps the scaler's number;
on the first install one worker starts until the scaler sets it to zero.
While any job is open the server keeps as many workers as there are tasks,
up to `jobs.max-concurrent`, and never fewer than are running.

The workers in the cluster reach the server inside the namespace: the
relay (NATS) on its Service's port 4222, and the server's HTTP API for
their tasks. They prove themselves with a **service account** of the
server's auth system, which they trade for a bus token valid for an hour.
Create it once, after the first start:

```
kubectl exec deploy/casas-eternas-server -- /app/casas-eternas auth service add cluster-workers > credentials
kubectl create secret generic casas-eternas-worker --from-file=credentials
rm credentials
```

The credential is shown once. To replace it: `auth service rotate
cluster-workers`, then the Secret; the workers read the file again at
every trade and need no restart. `auth service delete` ends an account; the
tokens it bought run out within the hour.

## Workers outside the cluster

A worker on another machine reaches the relay through the Ingress: the
server's relay listens for WebSockets on port 4223 (`relay.websocket`), and
the Ingress sends `/relay` there, with the TLS of the server's own host. The
relay pings every 30 s, so the Ingress's default timeouts hold without an
annotation. Give the worker a service account of its own (`auth service
add <name>`, as above), so it can be told apart and ended alone, and start
the worker bundle with its address and the server's:

```
RELAY_CREDENTIALS=./credentials node job-worker.mjs --serve \
  '{"relay":"wss://casas-eternas.ahoi.sh/relay","pools":["level","tile"],"auth":"https://casas-eternas.ahoi.sh","api":"https://casas-eternas.ahoi.sh"}'
```

`auth` is where it trades its credential for a bus token; `api` is the
server as this worker reaches it. A task names the world and the artifact
store at the server's address inside the cluster (its pod IP); the worker
replaces the scheme and host of both with `api`'s. Its artifacts go to the
bucket the server signs links for, so the bucket's endpoint must be one the
worker can reach.

A server whose workers all join from outside has no worker Deployment:
`workers.enabled: false`. The chart then sets `jobs.scale-workers: false`,
so the server starts no scaler, and grants no Role on Deployments.

## Updating

Push the image, then `helm upgrade` — chart and image travel together,
because the env vocabulary and the binary must agree (an old binary
silently ignores env names it does not know).

**Once, from the manifests that were here until 2026-10-18**
(`deploy/manifests.yaml`): the chart names its objects after the release
and its components. Keep the data volume and the Secrets, remove the rest,
and point the chart at the old claim:

```
kubectl delete deploy/casas-eternas deploy/casas-eternas-worker \
  service/casas-eternas ingress/casas-eternas \
  role/casas-eternas-jobs rolebinding/casas-eternas-jobs serviceaccount/casas-eternas
helm install casas-eternas deploy/helm --namespace casas … \
  --set components.server.persistence.existingClaim=casas-eternas-data
```

The Secrets `casas-eternas-auth` and `casas-eternas-worker` are the
chart's default names and stay as they are.

## Splitting targets

Every target runs alone; with the chart a split is a set of components,
each one Deployment of the same image running its targets
(`deploy/helm/examples/split.yaml`). The chart derives the wiring between
them and refuses what cannot run; the map of what goes where is
[design/server-deployment.md](../design/server-deployment.md).

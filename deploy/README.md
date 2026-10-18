# deploy/

**The operating documentation lives in [docs/operations/](../docs/operations/)**
(rendered on the doc site under Operations): what the chart sets up,
the Secrets, bootstrapping users over the admin socket and the job
workers are all in
[kubernetes.md](../docs/operations/kubernetes.md); the container without a
cluster is [docker.md](../docs/operations/docker.md). This file only says
what the files here are.

`Dockerfile` — one image: the Go binary serves the client and the docs
site, stores worlds and artifacts, bakes amplified terrain, and runs the
login. It carries Node because the bake pipeline is the browser's own
TypeScript; see the file's own header for why that is one image and not
two.

`helm/` — the Helm chart, the cluster deployment: components of targets
(the monolith by default) and the job workers beside them, for OpenShift
or plain Kubernetes; `helm/examples/` holds other shapes. It replaced the
hand-kept `manifests.yaml` and `kubernetes.yaml` (2026-10-18). Why it is built as
it is: [decisions/helm-chart.md](../docs/decisions/helm-chart.md).

`nginx.conf` — **unused.** Left until the one-binary image has been
running in a cluster for a while; delete it then.

# deploy/

**The operating documentation lives in [docs/operations/](../docs/operations/)**
(rendered on the doc site under Operations): what the manifests set up,
the Secret, bootstrapping users over the admin socket, bakes as Jobs and
the run-once deadline trap are all in
[kubernetes.md](../docs/operations/kubernetes.md); the container without a
cluster is [docker.md](../docs/operations/docker.md). This file only says
what the files here are.

`Dockerfile` — one image: the Go binary serves the client and the docs
site, stores worlds and artifacts, bakes amplified terrain, and runs the
login. It carries Node because the bake pipeline is the browser's own
TypeScript; see the file's own header for why that is one image and not
two.

`manifests.yaml` — ServiceAccount + RBAC (bake Jobs), PVC, Secret,
Deployment, Service, Route for OpenShift. The reference deployment the
guide walks through.

`nginx.conf` — **unused.** Left until the one-binary image has been
running in a cluster for a while; delete it then.

## The bake Job template

It is **not** here: `go:embed` cannot reach outside its own package, so it
lives beside the code that renders it, at

    internal/modules/bake/bake-job.yaml

It is plain YAML with Go template placeholders, and it is what the cluster
is actually asked for — edit it there. A ConfigMap-mounted override later
changes only where it is read from, not its shape.

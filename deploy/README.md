# deploy/

`Dockerfile` — one image: the Go binary serves the client, stores worlds and
artifacts, and bakes. It carries Node because the bake pipeline is the
browser's own TypeScript; see the file's own header for why that is one image
and not two.

`manifests.yaml` — PVC + Deployment + Service + Route for OpenShift.

`nginx.conf` — **unused.** Left until the one-binary image has been running in
a cluster for a while; delete it then.

## The bake Job template

It is **not** here: `go:embed` cannot reach outside its own package, so it
lives beside the code that renders it, at

    internal/bake/bake-job.yaml

It is plain YAML with Go template placeholders, and it is what the cluster is
actually asked for — edit it there. A ConfigMap-mounted override later changes
only where it is read from, not its shape.

# deploy/

`Dockerfile` — one image: the Go binary serves the client, stores worlds and
artifacts, and bakes. It carries Node because the bake pipeline is the
browser's own TypeScript; see the file's own header for why that is one image
and not two.

`manifests.yaml` — PVC + Secret + Deployment + Service + Route for OpenShift.

`nginx.conf` — **unused.** Left until the one-binary image has been running in
a cluster for a while; delete it then.

## The bake Job template

It is **not** here: `go:embed` cannot reach outside its own package, so it
lives beside the code that renders it, at

    internal/bake/bake-job.yaml

It is plain YAML with Go template placeholders, and it is what the cluster is
actually asked for — edit it there. A ConfigMap-mounted override later changes
only where it is read from, not its shape.

## First run: the deployment starts in password mode

`manifests.yaml` sets auth mode `password` (via CASAS_GLOBAL_AUTH_MODE). One
value belongs in the Secret, out of git:

    # the key session tokens are signed with. Generated once and kept: without
    # it every restart ends every session, and two replicas reject each other's
    # tokens.
    openssl rand -base64 48 > ./session.key

    oc create secret generic casas-eternas-auth \
      --from-literal=session.key="$(cat ./session.key)" \
      --dry-run=client -o yaml | oc apply -f -

    rm ./session.key                 # the cluster has it now

Users are STATE, not configuration: they live in auth.db on the data volume
and are administered over the pod's admin socket — reaching it is the
authorization, gated by `pods/exec` RBAC
(docs/decisions/server-user-admin.md). A fresh store starts empty and warns;
create the first user with

    echo -n 'the-password' | oc exec -i deploy/casas-eternas -- /app/casas-eternas auth user add ada --password-stdin
    # or interactively:  oc rsh deploy/casas-eternas  →  ./casas-eternas auth user add ada

No flags: the exec session inherits the pod's environment, so
CASAS_GLOBAL_ADMIN_SOCKET already points at the socket — an absolute path,
so the working directory does not matter either.

`auth user list|passwd|delete` manage them from there. Changes take effect
immediately — no restart, no Secret involved.

To run **without** authentication (a single-user server on a trusted
network), set `CASAS_GLOBAL_AUTH_MODE=none` — one synthetic identity then
owns everything and no login exists. Say it explicitly rather than dropping
the variable: `none` is also the compiled default, and an open server should
be visible in the manifest, not implied by an absence.

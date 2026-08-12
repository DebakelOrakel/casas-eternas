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

`manifests.yaml` sets auth mode `password` (via CASAS_GLOBAL_AUTH_MODE), and the Secret it mounts is applied
**empty**. The pod therefore will not start until it is filled — deliberately: a
server told to check identity that cannot would look healthy while rejecting
everybody, which is debugged as a permission bug rather than as the missing file
it is. The log says which flag is short.

Two values, both out of git:

    # a user. bcrypt cost 10 or above — `htpasswd -B` alone writes 5, which the
    # server refuses, so -C is not optional
    htpasswd -B -C 12 -c ./htpasswd ada
    htpasswd -B -C 12    ./htpasswd grace     # any further user; -c would truncate

    # the key session tokens are signed with. Generated once and kept: without
    # it every restart ends every session, and two replicas reject each other's
    # tokens.
    openssl rand -base64 48 > ./session.key

    oc create secret generic casas-eternas-auth \
      --from-file=htpasswd=./htpasswd \
      --from-literal=session.key="$(cat ./session.key)" \
      --dry-run=client -o yaml | oc apply -f -

    rm ./htpasswd ./session.key      # the cluster has them now

Changing a password later is the same command again; the server re-reads the
file on every sign-in, so a rolled Secret takes effect without a restart —
Kubernetes updates the projected file within its sync period.

To run **without** authentication (a single-user server on a trusted network),
drop the three `CASAS_AUTH_*` variables from the Deployment. The default is
`none`, in which one synthetic identity owns everything and no login exists.

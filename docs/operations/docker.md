---
summary: Running the container without a cluster — volumes, environment, password mode and the admin socket through docker exec.
date: 2026-08-13
updated: 2026-08-13
group: installation
order: 30
---

# Docker

The image (built from `deploy/Dockerfile`, context = repo root) carries
the server binary, the built client and docs, and Node for the bake
pipeline. Its entrypoint is the binary; the default command starts every
target with the client at `/app/dist` and state under `/data`.

## Single-user, trusted network

```
docker run -d --name casas \
  -p 8080:8080 \
  -v casas-data:/data \
  ghcr.io/debakelorakel/casas-eternas:latest
```

That is the `none` mode: no login, one owner. The volume holds worlds,
artifacts and (in password mode) the user store — it is the only thing
worth backing up.

## With authentication

```
docker run -d --name casas \
  -p 8080:8080 \
  -v casas-data:/data \
  -v casas-secrets:/etc/casas-eternas/auth:ro \
  -e CASAS_GLOBAL_AUTH_MODE=password \
  -e CASAS_GLOBAL_AUTH_SESSION_KEY=/etc/casas-eternas/auth/session.key \
  -e CASAS_GLOBAL_ADMIN_SOCKET=/tmp/admin.sock \
  ghcr.io/debakelorakel/casas-eternas:latest
```

Put a key into the secrets volume first (`openssl rand -base64 48 >
session.key`); without it, sessions end at every restart and the log says
so. **Set the mode explicitly** — the compiled default is `none`, and an
open server should be visible in your run command, not implied by an
absence.

Bootstrap the first user over the admin socket — reaching it requires
exec into the container, which is the access model:

```
echo -n 'the-password' | docker exec -i casas \
  /app/casas-eternas auth user add ada --password-stdin
docker exec casas /app/casas-eternas auth role bind ada admin
```

`auth user list|passwd|delete` manage users from there; changes take
effect immediately, no restart.

## Bakes

Outside a cluster the server runs bakes as local subprocesses — give the
container the memory they need (an 8192² bake peaks near 2.6 GB in the
Node process; `--memory 4g` is the honest floor with one concurrent bake,
`jobs.max-concurrent` multiplies it).

# syntax=docker/dockerfile:1
#
# Container image for casas-eternas: ONE binary that serves the client and
# the docs site, stores worlds and artifacts, bakes amplified terrain, and
# runs the login (auth target).
#
# Build context is the REPO ROOT (needs client/, docs/changelog/, cmd/,
# internal/, main.go):
#   docker build -f deploy/Dockerfile -t casas-eternas:latest .
#
# WHY THE RUNTIME CARRIES NODE. The job worker is the client's own
# TypeScript, bundled for Node and spawned as a subprocess — that is what keeps
# a server-baked artifact byte-identical to a browser-baked one, since both
# carry a key derived from their inputs. Two images (Go here, Node there) would
# be two things that can drift, and drift means a pipeline-version mismatch,
# which fails SILENTLY: bakes succeed, artifacts appear, and no client ever
# looks for them. One image, one commit, no drift.
#
# OpenShift-ready: runs as a non-root, ARBITRARY UID (member of GID 0), listens
# on 8080, and keeps all writable state on mounted volumes.

# ---- Stage 1: the client bundle and the job worker -------------------------
FROM node:22-alpine AS web
# Mirrors the repo layout (/app/client + /app/docs) rather than flattening the
# client to /app. The title screen's changelog viewer imports
# `../../../../docs/changelog/*.md` with Vite's ?raw, which reaches OUT of
# client/ — flattened, that path resolved to a /docs that does not exist in the
# image and the build failed on five unresolved imports.
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

# All of docs/ — the changelog viewer reads changelog/, and build:docs renders
# the whole tree into the site. ideas/ never enters the build's OUTPUT (the
# generator only reads vision/decisions/design/changelog), and the runtime
# image copies only docs-dist, so nothing private can ship even by accident.
COPY docs/ /app/docs/
COPY client/ ./

# dist/ is the app; job-worker.mjs is the job worker for the server to spawn.
# Both come out of the same source tree in the same layer, which is the point.
RUN npm run build && npm run build:worker && npm run build:docs

# ---- Stage 2: the server ----------------------------------------------------
FROM golang:1.26-alpine AS server
WORKDIR /src
# What `casas-eternas version` reports. Passed IN rather than derived here:
# .dockerignore keeps .git out of the build context on purpose, so nothing in
# this stage could run `git describe`. `make build` supplies it; a bare
# `docker build` leaves the honest default.
ARG CASAS_VERSION=dev
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# Static: the runtime image is Node's, which has no Go toolchain and need not
# match libc.
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags="-s -w -X github.com/DebakelOrakel/casas-eternas/cmd.buildVersion=${CASAS_VERSION}" \
    -o /out/casas-eternas .

# ---- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

# jobs.worker defaults to beside the executable, so it needs no flag. The
# client directory is passed explicitly in CMD: its default is empty on
# purpose, so that a dev run without a build serves only /config.json instead
# of refusing to start.
WORKDIR /app
COPY --from=server /out/casas-eternas /app/casas-eternas
COPY --from=web    /app/job-worker.mjs /app/job-worker.mjs
COPY --from=web    /app/client/dist   /app/dist
COPY --from=web    /app/client/docs-dist /app/docs-dist

# OpenShift assigns a random UID that is ALWAYS in the root group (GID 0). Give
# group 0 the owner's access on everything the process reads, so any assigned
# UID works. Writable state lives on mounted volumes, not here.
RUN chgrp -R 0 /app && chmod -R g=u /app \
 && mkdir -p /data/worlds /data/artifacts /data/auth /data/relay /data/jobs && chgrp -R 0 /data && chmod -R g=u /data

USER 1001
# 8080 the HTTP API, 4222 the relay (NATS) the job workers connect to.
EXPOSE 8080 4222
VOLUME ["/data"]

# Every module by default. A deployment that wants only storage, or only the
# frontend, overrides the arguments — see internal/config's target list.
ENTRYPOINT ["/app/casas-eternas"]
CMD ["start", "--target", "all", "--client.storage.dir.path", "/app/dist", "--docs.storage.dir.path", "/app/docs-dist", "--world.storage.dir.path", "/data/worlds", "--artifacts.storage.dir.path", "/data/artifacts", "--auth.storage.dir.path", "/data/auth", "--relay.storage.dir.path", "/data/relay", "--jobs.storage.dir.path", "/data/jobs"]

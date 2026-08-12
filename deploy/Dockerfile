# syntax=docker/dockerfile:1
#
# Container image for casas-eternas: ONE binary that serves the client, stores
# worlds and artifacts, and bakes amplified terrain.
#
# Build context is the REPO ROOT (needs client/, docs/changelog/, cmd/,
# internal/, main.go):
#   docker build -f deploy/Dockerfile -t casas-eternas:latest .
#
# WHY THE RUNTIME CARRIES NODE. The bake pipeline is the browser's own
# TypeScript, bundled for Node and spawned as a subprocess — that is what keeps
# a server-baked artifact byte-identical to a browser-baked one, since both
# carry a key derived from their inputs. Two images (Go here, Node there) would
# be two things that can drift, and drift means a pipeline-version mismatch,
# which fails SILENTLY: bakes succeed, artifacts appear, and no client ever
# looks for them. One image, one commit, no drift.
#
# OpenShift-ready: runs as a non-root, ARBITRARY UID (member of GID 0), listens
# on 8080, and keeps all writable state on mounted volumes.

# ---- Stage 1: the client bundle and the bake bundle -------------------------
FROM node:22-alpine AS web
# Mirrors the repo layout (/app/client + /app/docs) rather than flattening the
# client to /app. The title screen's changelog viewer imports
# `../../../../docs/changelog/*.md` with Vite's ?raw, which reaches OUT of
# client/ — flattened, that path resolved to a /docs that does not exist in the
# image and the build failed on five unresolved imports.
WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

# Only the changelog is needed, not all of docs/ — the viewer reads exactly these.
COPY docs/changelog/ /app/docs/changelog/
COPY client/ ./

# dist/ is the app; baker.mjs is the bake pipeline for the server to spawn.
# Both come out of the same source tree in the same layer, which is the point.
RUN npm run build && npm run build:baker

# ---- Stage 2: the server ----------------------------------------------------
FROM golang:1.26-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY cmd/ ./cmd/
COPY internal/ ./internal/
# Static: the runtime image is Node's, which has no Go toolchain and need not
# match libc.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/casas-eternas .

# ---- Runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime

# bake.baker defaults to beside the executable, so it needs no flag. The
# client directory is passed explicitly in CMD: its default is empty on
# purpose, so that a dev run without a build serves only /config.json instead
# of refusing to start.
WORKDIR /app
COPY --from=server /out/casas-eternas /app/casas-eternas
COPY --from=web    /app/baker.mjs     /app/baker.mjs
COPY --from=web    /app/client/dist   /app/dist

# OpenShift assigns a random UID that is ALWAYS in the root group (GID 0). Give
# group 0 the owner's access on everything the process reads, so any assigned
# UID works. Writable state lives on mounted volumes, not here.
RUN chgrp -R 0 /app && chmod -R g=u /app \
 && mkdir -p /data/worlds /data/artifacts && chgrp -R 0 /data && chmod -R g=u /data

USER 1001
EXPOSE 8080
VOLUME ["/data"]

# Every module by default. A deployment that wants only storage, or only the
# frontend, overrides the arguments — see internal/config's target list.
ENTRYPOINT ["/app/casas-eternas"]
CMD ["start", "--target", "all", "--client.storage.dir.path", "/app/dist", "--world.storage.dir.path", "/data/worlds", "--artifacts.storage.dir.path", "/data/artifacts"]

# syntax=docker/dockerfile:1
#
# Container image for the casas-eternas client (a static Vite/TypeScript SPA).
# Multi-stage: build the bundle with Node, then serve it with unprivileged nginx.
#
# Build context is the REPO ROOT (needs client/, docs/changelog/ and deploy/nginx.conf):
#   docker build -f deploy/Dockerfile -t casas-eternas:latest .
#
# OpenShift-ready: runs as a non-root, ARBITRARY UID (member of GID 0), listens
# on 8080, and keeps all writable state under /tmp. No manifests here — image only.

# ---- Build stage -----------------------------------------------------------
FROM node:22-alpine AS builder
# Mirrors the repo layout (/app/client + /app/docs) rather than flattening the client
# to /app. The title screen's changelog viewer imports `../../../../docs/changelog/*.md`
# with Vite's ?raw, which reaches OUT of client/ — flattened, that path resolved to a
# /docs that does not exist in the image, and the build failed on five unresolved
# imports. Keeping the same shape inside and outside the container means a relative
# import that works in the repo works here too, without a second path to maintain.
WORKDIR /app/client

# Install deps first so this layer is cached until the manifests change.
COPY client/package.json client/package-lock.json ./
RUN npm ci

# Only the changelog is needed, not all of docs/ — the viewer reads exactly these.
COPY docs/changelog/ /app/docs/changelog/

# Build the static bundle (npm run build == `tsc && vite build` → dist/).
COPY client/ ./
RUN npm run build

# ---- Runtime stage ---------------------------------------------------------
# nginx-unprivileged is purpose-built to run non-root; together with our config
# (pid/temp under /tmp, no `user` directive, listen 8080) and the GID-0
# permissions below it runs cleanly under OpenShift's random assigned UID.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Briefly root only to place files + fix group permissions; the container runs
# non-root (USER below / OpenShift's own UID).
USER root

# Server config + the built SPA.
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/client/dist /usr/share/nginx/html

# The base image's stray default site would make the entrypoint's ipv6 script
# try to sed it — which fails on a read-only root filesystem. Our nginx.conf
# doesn't include conf.d, so drop it.
RUN rm -f /etc/nginx/conf.d/default.conf \
# OpenShift assigns a random UID that is ALWAYS in the root group (GID 0). Give
# group 0 the same access as the owner on every path nginx reads, so any
# assigned UID works. (Runtime writes all go to /tmp — a writable emptyDir.)
 && chgrp -R 0 /usr/share/nginx/html /etc/nginx \
 && chmod -R g=u /usr/share/nginx/html /etc/nginx

# Non-root default for plain Docker/Kubernetes. OpenShift ignores this and
# injects its own UID from the namespace's range — both work.
USER 1001

EXPOSE 8080

# Inherits nginx-unprivileged's entrypoint/CMD (`nginx -g 'daemon off;'`),
# which now runs with the config above.

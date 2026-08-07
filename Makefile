# Build/ship targets for casas-eternas. Run from the repo root.
#
#   make lint    type-check the client (tsc --noEmit — the project's lint;
#                no ESLint/Biome is configured, and the branch convention is
#                "verify with tsc", so this is the honest gate)
#   make build   build the container image (deploy/Dockerfile, context = repo
#                root — the image needs client/, docs/changelog/ and deploy/)
#   make push    lint + build, then push to the registry
#
# Override the image/tag per invocation, e.g.:
#   make push TAG=v0.3.0
#   make build IMAGE=ghcr.io/someone-else/casas-eternas
#
# Pushing to ghcr.io needs a prior `docker login ghcr.io` with a token that
# has the `write:packages` scope.

IMAGE ?= ghcr.io/debakelorakel/casas-eternas
TAG   ?= latest

.PHONY: lint build push

lint:
	cd client && npx tsc --noEmit

build:
	docker build --platform linux/amd64 -f deploy/Dockerfile -t $(IMAGE):$(TAG) .

push: lint build
	docker push $(IMAGE):$(TAG)

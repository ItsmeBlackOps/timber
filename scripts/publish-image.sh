#!/usr/bin/env bash
# Build the Timber backend image and push it to Docker Hub so the VM can pull it.
#
# Prereqs: Docker daemon running + `docker login` already done.
# Usage:   DOCKERHUB_USER=<your-username> [TAG=1.0.0] bash scripts/publish-image.sh
#
# The VM then pulls with:  docker pull docker.io/<user>/timber:latest
# or, via the bundled compose:  TIMBER_IMAGE=docker.io/<user>/timber:latest docker compose pull && docker compose up -d
set -euo pipefail
cd "$(dirname "$0")/.."

USER="${DOCKERHUB_USER:?set DOCKERHUB_USER=<your docker hub username>}"
TAG="${TAG:-1.0.0}"
IMG="docker.io/${USER}/timber"
# VMs are almost always linux/amd64; pin it so a build on an arm Mac/Win host
# still produces an image the VM can run.
PLATFORM="${PLATFORM:-linux/amd64}"

echo "==> building ${IMG}:${TAG} (+ :latest) for ${PLATFORM}"
docker build --platform "${PLATFORM}" -t "${IMG}:${TAG}" -t "${IMG}:latest" .

echo "==> pushing ${IMG}:${TAG}"
docker push "${IMG}:${TAG}"
echo "==> pushing ${IMG}:latest"
docker push "${IMG}:latest"

echo
echo "DONE. On the VM:"
echo "  docker pull ${IMG}:latest"
echo "  # or with the bundled compose stack (Timber + Mongo):"
echo "  TIMBER_IMAGE=${IMG}:latest docker compose pull && docker compose up -d"

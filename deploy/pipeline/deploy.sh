#!/usr/bin/env bash
set -euo pipefail

# Story 1.10 Task 4.5/4.7: noninteractive deploy of the immutable images CD built to the Compose
# stack running on this host. Run on the target host itself - a self-hosted runner registered via
# deploy/pipeline/runner/bootstrap-runner.sh, or an operator with an equivalent shell on the box.
# The same script and the same image references are used for staging and production so promotion
# never rebuilds source (Story 1.10 AC3/AC4).
#
# Usage: deploy/pipeline/deploy.sh <staging|production>
# Required env: APP_IMAGE, EDGE_IMAGE, IMAGE_TAG, POSTGRES_ADMIN_PASSWORD, AUTH_JWKS_URI,
#   AUTH_ISSUER, AUTH_AUDIENCE, SCIM_BEARER_TOKEN, POWERSYNC_TOKEN_SECRET (this environment's).
# Optional env: HEALTH_URL (default http://localhost/api/v1/health).

ENVIRONMENT="${1:?usage: deploy.sh <staging|production>}"
case "$ENVIRONMENT" in
  staging | production) ;;
  *)
    echo "ERROR: environment must be 'staging' or 'production', got '${ENVIRONMENT}'" >&2
    exit 1
    ;;
esac

: "${APP_IMAGE:?set APP_IMAGE to the immutable app image reference}"
: "${EDGE_IMAGE:?set EDGE_IMAGE to the immutable edge image reference}"
: "${IMAGE_TAG:?set IMAGE_TAG to the commit SHA being deployed}"
: "${POSTGRES_ADMIN_PASSWORD:?set POSTGRES_ADMIN_PASSWORD for this environment}"
: "${AUTH_JWKS_URI:?set AUTH_JWKS_URI for this environment}"
: "${AUTH_ISSUER:?set AUTH_ISSUER for this environment}"
: "${AUTH_AUDIENCE:?set AUTH_AUDIENCE for this environment}"
: "${SCIM_BEARER_TOKEN:?set SCIM_BEARER_TOKEN for this environment}"
: "${POWERSYNC_TOKEN_SECRET:?set POWERSYNC_TOKEN_SECRET for this environment}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/../compose"
COMPOSE_FILES=(-f "${COMPOSE_DIR}/docker-compose.yml" -f "${COMPOSE_DIR}/docker-compose.images.yml")
HEALTH_URL="${HEALTH_URL:-http://localhost/api/v1/health}"
START_TIME=$(date +%s)

# The !reset merge tag in docker-compose.images.yml (which drops the base file's `build:` key so
# the immutable image is actually pulled instead of rebuilt) requires Compose v2.24+. Fail loudly
# rather than silently rebuilding from source on an older host.
MIN_COMPOSE_VERSION="2.24.0"
ACTUAL_COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo "0.0.0")"
ACTUAL_COMPOSE_VERSION="${ACTUAL_COMPOSE_VERSION#v}"
if [ "$(printf '%s\n%s\n' "$MIN_COMPOSE_VERSION" "$ACTUAL_COMPOSE_VERSION" | sort -V | head -n1)" != "$MIN_COMPOSE_VERSION" ]; then
  echo "ERROR: Docker Compose ${MIN_COMPOSE_VERSION}+ is required (found ${ACTUAL_COMPOSE_VERSION}) for the immutable-image !reset merge tag in docker-compose.images.yml." >&2
  exit 1
fi

echo "=== Deploying ${ENVIRONMENT}: app=${APP_IMAGE} edge=${EDGE_IMAGE} (commit ${IMAGE_TAG}) ==="

export APP_IMAGE EDGE_IMAGE POSTGRES_ADMIN_PASSWORD AUTH_JWKS_URI AUTH_ISSUER AUTH_AUDIENCE \
  SCIM_BEARER_TOKEN POWERSYNC_TOKEN_SECRET

PREVIOUS_APP_IMAGE=""
PREVIOUS_EDGE_IMAGE=""
APP_CONTAINER_ID="$(docker compose "${COMPOSE_FILES[@]}" ps -q app 2>/dev/null || true)"
EDGE_CONTAINER_ID="$(docker compose "${COMPOSE_FILES[@]}" ps -q edge 2>/dev/null || true)"
if [ -n "$APP_CONTAINER_ID" ]; then
  PREVIOUS_APP_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER_ID" 2>/dev/null || true)"
fi
if [ -n "$EDGE_CONTAINER_ID" ]; then
  PREVIOUS_EDGE_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$EDGE_CONTAINER_ID" 2>/dev/null || true)"
fi

wait_for_health() {
  local label="$1"
  local max_retries=30
  echo "Waiting for ${HEALTH_URL} (${label}) ..."
  for ((i = 1; i <= max_retries; i++)); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Health check passed (${label})."
      return 0
    fi
    echo "Waiting for app (${label})... (${i}/${max_retries})"
    sleep 2
  done
  return 1
}

rollback_after_failed_health() {
  if [ -z "$PREVIOUS_APP_IMAGE" ] || [ -z "$PREVIOUS_EDGE_IMAGE" ]; then
    echo "ERROR: health check failed and no previous app/edge image pair is available for rollback." >&2
    return 1
  fi
  echo "Health check failed. Rolling back to previous images: app=${PREVIOUS_APP_IMAGE} edge=${PREVIOUS_EDGE_IMAGE}"
  APP_IMAGE="$PREVIOUS_APP_IMAGE" EDGE_IMAGE="$PREVIOUS_EDGE_IMAGE" \
    docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans
  wait_for_health "rollback"
}

docker compose "${COMPOSE_FILES[@]}" pull app edge

echo "Applying migrations against the new image, before cutover..."
# migrate.js is plain compiled JS (no tsx/dev deps needed at runtime) and reads its SQL sources
# from dist/events and dist/read, which the Dockerfile places there for exactly this purpose.
# `run --rm` uses the newly pulled image without touching the currently-running app/edge
# containers, so if migration fails, `set -e` aborts here and the old containers keep serving
# traffic untouched - the cutover below never happens against a failed migration.
docker compose "${COMPOSE_FILES[@]}" run --rm \
  -e DB_ADMIN_USER=admin_user \
  -e DB_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
  app node dist/src/events/migrate.js

echo "Migrations applied. Cutting over to the new images..."
docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans

if wait_for_health "new release"; then
  END_TIME=$(date +%s)
  echo "UPGRADE_TIMING: environment=${ENVIRONMENT} commit=${IMAGE_TAG} seconds=$((END_TIME - START_TIME))"
  exit 0
fi

if rollback_after_failed_health; then
  echo "ERROR: new release failed health check and rollback completed. Check: docker compose ${COMPOSE_FILES[*]} logs" >&2
else
  echo "ERROR: new release failed health check and rollback did not complete. Check: docker compose ${COMPOSE_FILES[*]} logs" >&2
fi
exit 1

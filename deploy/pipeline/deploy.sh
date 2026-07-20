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
if [ "$(printf '%s\n%s\n' "$MIN_COMPOSE_VERSION" "$ACTUAL_COMPOSE_VERSION" | sort -V | head -n1)" != "$MIN_COMPOSE_VERSION" ]; then
  echo "ERROR: Docker Compose ${MIN_COMPOSE_VERSION}+ is required (found ${ACTUAL_COMPOSE_VERSION}) for the immutable-image !reset merge tag in docker-compose.images.yml." >&2
  exit 1
fi

echo "=== Deploying ${ENVIRONMENT}: app=${APP_IMAGE} edge=${EDGE_IMAGE} (commit ${IMAGE_TAG}) ==="

export APP_IMAGE EDGE_IMAGE POSTGRES_ADMIN_PASSWORD AUTH_JWKS_URI AUTH_ISSUER AUTH_AUDIENCE \
  SCIM_BEARER_TOKEN POWERSYNC_TOKEN_SECRET

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

echo "Waiting for ${HEALTH_URL} ..."
MAX_RETRIES=30
for ((i = 1; i <= MAX_RETRIES; i++)); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Health check passed."
    END_TIME=$(date +%s)
    echo "UPGRADE_TIMING: environment=${ENVIRONMENT} commit=${IMAGE_TAG} seconds=$((END_TIME - START_TIME))"
    exit 0
  fi
  echo "Waiting for app... (${i}/${MAX_RETRIES})"
  sleep 2
done

echo "ERROR: health check did not pass within timeout. Check: docker compose ${COMPOSE_FILES[*]} logs" >&2
exit 1

#!/usr/bin/env bash
set -euo pipefail

# Story 1.10 Task 4.5/4.7: noninteractive deploy of the immutable images CD built to the Compose
# stack running on this host. Run on the target host itself - a self-hosted runner registered via
# deploy/pipeline/runner/bootstrap-runner.sh, or an operator with an equivalent shell on the box.
# The same script and the same image references are used for staging and production so promotion
# never rebuilds source (Story 1.10 AC3/AC4).
#
# Usage: deploy/pipeline/deploy.sh <staging|production>
# Required env: APP_IMAGE, EDGE_IMAGE, IMAGE_TAG, POSTGRES_ADMIN_PASSWORD (this environment's).
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/../compose"
COMPOSE_FILES=(-f "${COMPOSE_DIR}/docker-compose.yml" -f "${COMPOSE_DIR}/docker-compose.images.yml")
HEALTH_URL="${HEALTH_URL:-http://localhost/api/v1/health}"
START_TIME=$(date +%s)

echo "=== Deploying ${ENVIRONMENT}: app=${APP_IMAGE} edge=${EDGE_IMAGE} (commit ${IMAGE_TAG}) ==="

export APP_IMAGE EDGE_IMAGE POSTGRES_ADMIN_PASSWORD

docker compose "${COMPOSE_FILES[@]}" pull app edge
docker compose "${COMPOSE_FILES[@]}" up -d --remove-orphans

echo "Applying migrations against the deployed image..."
# migrate.js is plain compiled JS (no tsx/dev deps needed at runtime) and reads its SQL sources
# from dist/events and dist/read, which the Dockerfile places there for exactly this purpose.
docker compose "${COMPOSE_FILES[@]}" exec -T \
  -e DB_ADMIN_USER=admin_user \
  -e DB_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
  app node dist/src/events/migrate.js

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

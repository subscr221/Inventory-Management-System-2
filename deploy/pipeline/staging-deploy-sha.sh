#!/usr/bin/env bash
# One-off operator wrapper: deploy the GHCR images of one commit to staging with deploy.sh.
# Usage: staging-deploy-sha.sh <full-commit-sha>
set -euo pipefail
SHA="${1:?usage: staging-deploy-sha.sh <full-commit-sha>}"
REPO=ghcr.io/subscr221/inventory-management-system-2

cd /opt/ims/deploy/compose
set -a
. ./.env
set +a
export APP_IMAGE="${REPO}-app:${SHA}"
export EDGE_IMAGE="${REPO}-edge:${SHA}"
export IMAGE_TAG="${SHA}"
export HEALTH_URL="http://127.0.0.1:${APP_HOST_PORT:-3100}/api/v1/health"

DUMP="/root/ims-db-pre-${SHA:0:7}-$(date +%Y%m%d%H%M).dump"
echo "=== pre-deploy dump -> ${DUMP}"
docker compose exec -T postgres pg_dump -U admin_user -Fc inventory_events > "${DUMP}"
ls -la "${DUMP}"

bash /opt/ims/deploy/pipeline/deploy.sh staging

# nginx holds the old upstream addresses after app/edge are recreated (seen 2026-09-14)
echo "=== restart nginx"
docker compose restart nginx
docker compose ps --format '{{.Service}} | {{.Image}} | {{.Status}}'

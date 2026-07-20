#!/usr/bin/env bash
set -euo pipefail

echo "=== Vendor-Neutral Host Provisioning ==="
echo "Target: native server or cloud VPS"
echo ""

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is not installed."
  echo "Install Docker before running this script."
  exit 1
fi

# Docker Compose ships as the `docker compose` CLI plugin on current hosts; the standalone
# `docker-compose` binary is optional and increasingly absent. Require at least one, and prefer
# the v2 plugin form (used everywhere else in this script) when both are present.
if docker compose version &>/dev/null; then
  COMPOSE_VERSION="$(docker compose version)"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_VERSION="$(docker-compose --version)"
else
  echo "ERROR: neither 'docker compose' (v2 plugin) nor 'docker-compose' (standalone) is available."
  echo "Install the Docker Compose plugin before running this script."
  exit 1
fi

echo "Docker: $(docker --version)"
echo "Compose: ${COMPOSE_VERSION}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/../compose"

if [ ! -f "${COMPOSE_DIR}/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found at ${COMPOSE_DIR}/docker-compose.yml"
  exit 1
fi

echo ""
echo "Starting infrastructure stack..."
cd "${COMPOSE_DIR}"
docker compose up -d --build

echo ""
echo "Waiting for services to be healthy..."
sleep 5

HEALTH_URL="http://localhost:3000/api/v1/health"
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "Health check passed."
    curl -s "${HEALTH_URL}" | python3 -m json.tool 2>/dev/null || curl -s "${HEALTH_URL}"
    break
  fi
  RETRY_COUNT=$((RETRY_COUNT + 1))
  echo "Waiting for app... (${RETRY_COUNT}/${MAX_RETRIES})"
  sleep 2
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "WARNING: Health check did not pass within timeout."
  echo "Check logs: docker compose -f ${COMPOSE_DIR}/docker-compose.yml logs"
  exit 1
fi

echo ""
echo "=== Provisioning complete ==="
echo "API: http://localhost/api/v1/health"
echo "Edge PWA: http://localhost/"
echo "PowerSync: http://localhost/powersync/"
echo "PostgreSQL: localhost:5432"
echo "Standby: localhost:5433"
echo "Nginx: http://localhost:80"

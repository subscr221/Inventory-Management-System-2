#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/../compose"

echo "=== Tearing down infrastructure ==="
cd "${COMPOSE_DIR}"
docker compose down -v --remove-orphans
echo "=== Teardown complete ==="

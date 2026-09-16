#!/bin/bash
# Applies a roles file to staging through the app container's provision-roles CLI.
# Runs from the Windows tree; ships the file, runs a dry run, then --apply when asked.
# Usage: staging-provision-roles.sh <roles.json> [--apply]
set -euo pipefail
FILE="${1:?roles.json path}"; shift
SSH=(ssh -p 2222 -i ~/.ssh/ims_vps_automation -o BatchMode=yes root@103.160.106.127)
scp -P 2222 -i ~/.ssh/ims_vps_automation -o BatchMode=yes "$FILE" root@103.160.106.127:/root/ims-roles-apply.json >/dev/null
"${SSH[@]}" "cd /opt/ims/deploy/compose && docker compose exec -T app sh -c 'cat > /tmp/ims-roles-apply.json' < /root/ims-roles-apply.json && docker compose exec -T app node dist/src/cli/provision-roles.js /tmp/ims-roles-apply.json $*"

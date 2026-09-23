#!/usr/bin/env bash
set -euo pipefail

# Story 1.10 AC4: provisions a GitHub Actions self-hosted runner on this host, entirely from this
# script plus the platform registration API - the CD workflow (.github/workflows/cd.yml) targets
# `runs-on: [self-hosted, staging]` / `[self-hosted, production]`, so deploy steps run directly on
# the target host with no SSH secrets to manage. Reproducible: tearing down and re-running this
# script on a clean host recreates the same runner registration.
#
# Usage: deploy/pipeline/runner/bootstrap-runner.sh <staging|production> [runner-version]
# Requires: gh, jq, curl, tar, docker, docker compose, sudo, and GitHub admin permissions.
# Production uses an organization runner group named by PRODUCTION_RUNNER_GROUP
# (default: production-deploy), matching .github/workflows/cd.yml so only approved deployment
# workflows can target the production runner.

ROLE="${1:?usage: bootstrap-runner.sh <staging|production> [runner-version]}"
case "$ROLE" in
  staging | production) ;;
  *)
    echo "ERROR: role must be 'staging' or 'production', got '${ROLE}'" >&2
    exit 1
    ;;
esac
RUNNER_VERSION="${2:-2.321.0}"
PRODUCTION_RUNNER_GROUP="${PRODUCTION_RUNNER_GROUP:-production-deploy}"

MISSING=()
for tool in gh jq curl tar docker uname hostname; do
  if ! command -v "$tool" &>/dev/null; then
    MISSING+=("$tool")
  fi
done
if ! command -v sudo &>/dev/null; then
  MISSING+=("sudo")
fi
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "ERROR: missing required host prerequisites: ${MISSING[*]}" >&2
  echo "Install the missing tools, then re-run this script on a clean target host." >&2
  exit 1
fi
if ! docker compose version &>/dev/null; then
  echo "ERROR: the Docker Compose v2 plugin is required; install it before running this script." >&2
  exit 1
fi
if ! gh auth status &>/dev/null; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' with runner administration permissions first." >&2
  exit 1
fi

REPO_JSON="$(gh repo view --json owner,name)"
OWNER="$(echo "$REPO_JSON" | jq -r '.owner.login')"
REPO="$(echo "$REPO_JSON" | jq -r '.name')"
REPO_URL="https://github.com/${OWNER}/${REPO}"
RUNNER_URL="$REPO_URL"
REGISTRATION_API="repos/${OWNER}/${REPO}/actions/runners/registration-token"
CONFIG_ARGS=()

if [ "$ROLE" = "production" ]; then
  OWNER_TYPE="$(gh api "repos/${OWNER}/${REPO}" --jq '.owner.type')"
  if [ "$OWNER_TYPE" != "Organization" ]; then
    echo "ERROR: production runner isolation uses runner group '${PRODUCTION_RUNNER_GROUP}', which requires an organization-owned repository." >&2
    exit 1
  fi
  RUNNER_GROUP_JSON="$(gh api "orgs/${OWNER}/actions/runner-groups" | jq -c --arg name "$PRODUCTION_RUNNER_GROUP" '[.runner_groups[]? | select(.name == $name)][0] // empty')"
  if [ -z "$RUNNER_GROUP_JSON" ]; then
    echo "ERROR: production runner group '${PRODUCTION_RUNNER_GROUP}' does not exist or is not visible to this token." >&2
    echo "Create it in the organization and restrict it to the CD workflow before running this script." >&2
    exit 1
  fi
  if [ "$(echo "$RUNNER_GROUP_JSON" | jq -r '.restricted_to_workflows // false')" != "true" ]; then
    echo "ERROR: production runner group '${PRODUCTION_RUNNER_GROUP}' is not restricted to selected workflows." >&2
    echo "Restrict it to .github/workflows/cd.yml before registering the production runner." >&2
    exit 1
  fi
  RUNNER_GROUP_ID="$(echo "$RUNNER_GROUP_JSON" | jq -r '.id')"
  SELECTED_WORKFLOWS_JSON="$(gh api "orgs/${OWNER}/actions/runner-groups/${RUNNER_GROUP_ID}/restricted-to-workflows")"
  if [ "$(echo "$SELECTED_WORKFLOWS_JSON" | jq -r 'any((.selected_workflows // [])[]; contains(".github/workflows/cd.yml"))')" != "true" ]; then
    echo "ERROR: production runner group '${PRODUCTION_RUNNER_GROUP}' is not restricted to .github/workflows/cd.yml." >&2
    exit 1
  fi
  RUNNER_URL="https://github.com/${OWNER}"
  REGISTRATION_API="orgs/${OWNER}/actions/runners/registration-token"
  CONFIG_ARGS+=(--runnergroup "$PRODUCTION_RUNNER_GROUP")
fi

echo "=== Bootstrapping self-hosted runner (role: ${ROLE}) for ${OWNER}/${REPO} ==="

RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner-${ROLE}}"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) RUNNER_ARCH="x64" ;;
  aarch64 | arm64) RUNNER_ARCH="arm64" ;;
  *)
    echo "ERROR: unsupported architecture '${ARCH}'" >&2
    exit 1
    ;;
esac

PACKAGE="actions-runner-linux-${RUNNER_ARCH}-${RUNNER_VERSION}.tar.gz"
if [ ! -f "$PACKAGE" ]; then
  echo "Downloading GitHub Actions runner v${RUNNER_VERSION}..."
  curl -fsSL -o "$PACKAGE" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${PACKAGE}"
fi
tar xzf "$PACKAGE"

echo "Requesting a fresh registration token..."
REG_TOKEN="$(gh api --method POST "$REGISTRATION_API" --jq '.token')"

./config.sh --unattended \
  --url "$RUNNER_URL" \
  --token "$REG_TOKEN" \
  --name "$(hostname)-${ROLE}" \
  --labels "self-hosted,${ROLE}" \
  "${CONFIG_ARGS[@]}" \
  --work "_work" \
  --replace

if [ -x ./svc.sh ]; then
  sudo ./svc.sh install
  sudo ./svc.sh start
  echo "Runner installed and started as a system service."
else
  echo "svc.sh not found (non-Linux host?) - start the runner manually with ./run.sh"
fi

echo ""
if [ "$ROLE" = "production" ]; then
  echo "=== Runner bootstrap complete: group [${PRODUCTION_RUNNER_GROUP}], labels [self-hosted, ${ROLE}] ==="
  echo "Verify at: https://github.com/organizations/${OWNER}/settings/actions/runners"
else
  echo "=== Runner bootstrap complete: labels [self-hosted, ${ROLE}] ==="
  echo "Verify at: ${REPO_URL}/settings/actions/runners"
fi

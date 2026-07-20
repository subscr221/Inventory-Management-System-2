#!/usr/bin/env bash
set -euo pipefail

# Story 1.10 AC4: provisions a GitHub Actions self-hosted runner on this host, entirely from this
# script plus the platform registration API - the CD workflow (.github/workflows/cd.yml) targets
# `runs-on: [self-hosted, staging]` / `[self-hosted, production]`, so deploy steps run directly on
# the target host with no SSH secrets to manage. Reproducible: tearing down and re-running this
# script on a clean host recreates the same runner registration.
#
# Usage: deploy/pipeline/runner/bootstrap-runner.sh <staging|production> [runner-version]
# Requires: GitHub CLI (gh) authenticated with admin access to the repository, run from a machine
# that can reach the GitHub API (this can be the target host itself, or a workstation that then
# copies the resulting ./actions-runner directory over - the registration token step must run
# close in time to the runner ./config.sh step since tokens expire quickly).

ROLE="${1:?usage: bootstrap-runner.sh <staging|production> [runner-version]}"
case "$ROLE" in
  staging | production) ;;
  *)
    echo "ERROR: role must be 'staging' or 'production', got '${ROLE}'" >&2
    exit 1
    ;;
esac
RUNNER_VERSION="${2:-2.321.0}"

if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI (gh) is required. Install it and run 'gh auth login' first." >&2
  exit 1
fi

REPO_JSON="$(gh repo view --json owner,name)"
OWNER="$(echo "$REPO_JSON" | jq -r '.owner.login')"
REPO="$(echo "$REPO_JSON" | jq -r '.name')"
REPO_URL="https://github.com/${OWNER}/${REPO}"

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
REG_TOKEN="$(gh api --method POST "repos/${OWNER}/${REPO}/actions/runners/registration-token" --jq '.token')"

./config.sh --unattended \
  --url "$REPO_URL" \
  --token "$REG_TOKEN" \
  --name "$(hostname)-${ROLE}" \
  --labels "self-hosted,${ROLE}" \
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
echo "=== Runner bootstrap complete: labels [self-hosted, ${ROLE}] ==="
echo "Verify at: ${REPO_URL}/settings/actions/runners"

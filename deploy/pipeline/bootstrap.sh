#!/usr/bin/env bash
set -euo pipefail

# Story 1.10 pipeline bootstrap IaC (AC4): provisions the repository automation state that CI/CD
# depends on - branch protection and deployment environments - from version-controlled
# configuration instead of hand-clicking GitHub repository settings.
#
# Requires: GitHub CLI (`gh`) authenticated with `repo` and `workflow` scopes against the target
# repository. Does not commit or print any deployment secret; production secrets are configured
# separately with `gh secret set` (see the instructions this script prints at the end).
#
# Usage: deploy/pipeline/bootstrap.sh
# Env:   PRODUCTION_REVIEWER  GitHub username or team slug required to approve production
#                             deployments. Required - no default, since an unset reviewer would
#                             silently leave production unprotected.
#        PRODUCTION_REVIEWER_TYPE  "User" (default) or "Team".

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI (gh) is required. Install it from https://cli.github.com/ and run 'gh auth login'." >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required to build API request bodies." >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' with repo admin permissions first." >&2
  exit 1
fi

if [ -z "${PRODUCTION_REVIEWER:-}" ]; then
  echo "ERROR: PRODUCTION_REVIEWER is not set." >&2
  echo "Set it to the GitHub username (or team slug, with PRODUCTION_REVIEWER_TYPE=Team) that" >&2
  echo "must approve every production deployment, e.g.:" >&2
  echo "  PRODUCTION_REVIEWER=<github-username> deploy/pipeline/bootstrap.sh" >&2
  exit 1
fi
PRODUCTION_REVIEWER_TYPE="${PRODUCTION_REVIEWER_TYPE:-User}"

REPO_JSON="$(gh repo view --json owner,name,defaultBranchRef)"
OWNER="$(echo "$REPO_JSON" | jq -r '.owner.login')"
REPO="$(echo "$REPO_JSON" | jq -r '.name')"
DEFAULT_BRANCH="$(echo "$REPO_JSON" | jq -r '.defaultBranchRef.name')"

if [ -z "$OWNER" ] || [ -z "$REPO" ] || [ -z "$DEFAULT_BRANCH" ] || [ "$DEFAULT_BRANCH" = "null" ]; then
  echo "ERROR: could not detect owner/repo/default branch from 'gh repo view'." >&2
  exit 1
fi

echo "=== Pipeline bootstrap ==="
echo "Repository: ${OWNER}/${REPO}"
echo "Protected branch (detected from platform, not hard-coded): ${DEFAULT_BRANCH}"
echo ""

echo "--- Branch protection ---"
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${OWNER}/${REPO}/branches/${DEFAULT_BRANCH}/protection" \
  --input "${SCRIPT_DIR}/branch-protection.json" >/dev/null
echo "Branch protection applied to '${DEFAULT_BRANCH}' with required checks, enforce_admins=true, no bypass restrictions."

echo ""
echo "--- Environments ---"

STAGING_BODY="$(jq -c '.staging | {
  wait_timer: .wait_timer,
  prevent_self_review: .prevent_self_review,
  deployment_branch_policy: .deployment_branch_policy
}' "${SCRIPT_DIR}/environments.json")"

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${OWNER}/${REPO}/environments/staging" \
  --input - <<<"$STAGING_BODY" >/dev/null
echo "Environment 'staging' created/updated (no required reviewers, deployment restricted to protected branches)."

REVIEWER_ID="$(gh api "users/${PRODUCTION_REVIEWER}" --jq '.id' 2>/dev/null || true)"
if [ "$PRODUCTION_REVIEWER_TYPE" = "Team" ]; then
  REVIEWER_ID="$(gh api "orgs/${OWNER}/teams/${PRODUCTION_REVIEWER}" --jq '.id')"
fi
if [ -z "$REVIEWER_ID" ]; then
  echo "ERROR: could not resolve PRODUCTION_REVIEWER='${PRODUCTION_REVIEWER}' (type=${PRODUCTION_REVIEWER_TYPE}) to an id." >&2
  exit 1
fi

PRODUCTION_BODY="$(jq -c --argjson reviewer_id "$REVIEWER_ID" --arg reviewer_type "$PRODUCTION_REVIEWER_TYPE" \
  '.production | {
    wait_timer: .wait_timer,
    prevent_self_review: .prevent_self_review,
    reviewers: [{type: $reviewer_type, id: $reviewer_id}],
    deployment_branch_policy: .deployment_branch_policy
  }' "${SCRIPT_DIR}/environments.json")"

gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/${OWNER}/${REPO}/environments/production" \
  --input - <<<"$PRODUCTION_BODY" >/dev/null
echo "Environment 'production' created/updated (required reviewer: ${PRODUCTION_REVIEWER}, prevent_self_review=true, deployment restricted to protected branches)."

echo ""
echo "=== Bootstrap complete ==="
echo "Next steps (secrets are never committed - set them per environment):"
echo "  gh secret set POSTGRES_ADMIN_PASSWORD --env staging"
echo "  gh secret set AUTH_JWKS_URI --env staging"
echo "  gh secret set AUTH_ISSUER --env staging"
echo "  gh secret set AUTH_AUDIENCE --env staging"
echo "  gh secret set SCIM_BEARER_TOKEN --env staging"
echo "  gh secret set POWERSYNC_TOKEN_SECRET --env staging"
echo "  gh secret set STAGING_SSH_HOST / STAGING_SSH_USER / STAGING_SSH_KEY (or your runner's equivalent)"
echo "  ...and the same set again with --env production for the production environment."
echo ""
echo "Run deploy/pipeline/verify.sh to read back and confirm this configuration."

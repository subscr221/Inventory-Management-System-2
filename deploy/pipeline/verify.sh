#!/usr/bin/env bash
set -uo pipefail

# Story 1.10 Task 3.6: dry-run / read-back verification. Read-only (GET requests only) - safe to
# run at any time, including against a repository that has not been bootstrapped yet. Fails with a
# nonzero exit code and a list of missing pieces if required checks, admin enforcement, or
# production approvals are absent.

if ! command -v gh &>/dev/null || ! command -v jq &>/dev/null; then
  echo "ERROR: gh and jq are required." >&2
  exit 1
fi

REPO_JSON="$(gh repo view --json owner,name,defaultBranchRef)"
OWNER="$(echo "$REPO_JSON" | jq -r '.owner.login')"
REPO="$(echo "$REPO_JSON" | jq -r '.name')"
DEFAULT_BRANCH="$(echo "$REPO_JSON" | jq -r '.defaultBranchRef.name')"

echo "=== Verifying pipeline bootstrap state for ${OWNER}/${REPO} (branch: ${DEFAULT_BRANCH}) ==="

FAILURES=0
fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

PROTECTION_JSON="$(gh api "repos/${OWNER}/${REPO}/branches/${DEFAULT_BRANCH}/protection" 2>/dev/null || echo '{}')"

if [ "$(echo "$PROTECTION_JSON" | jq -r 'has("required_status_checks")')" != "true" ]; then
  fail "no branch protection is configured on '${DEFAULT_BRANCH}'"
else
  EXPECTED_CHECKS=(backend-quality backend-tests spine-acceptance-contract edge-quality edge-accessibility)
  ACTUAL_CHECKS="$(echo "$PROTECTION_JSON" | jq -r '.required_status_checks.checks[]?.context // .required_status_checks.contexts[]?')"
  for check in "${EXPECTED_CHECKS[@]}"; do
    if ! grep -qx "$check" <<<"$ACTUAL_CHECKS"; then
      fail "required status check '${check}' is missing from branch protection"
    fi
  done

  if [ "$(echo "$PROTECTION_JSON" | jq -r '.enforce_admins.enabled')" != "true" ]; then
    fail "enforce_admins is not enabled - administrators could bypass required checks"
  fi

  REQUIRED_REVIEW_COUNT="$(echo "$PROTECTION_JSON" | jq -r '.required_pull_request_reviews.required_approving_review_count // 0')"
  if [ "$REQUIRED_REVIEW_COUNT" -lt 1 ]; then
    fail "required_pull_request_reviews is missing or requires zero approvals - a PR review is required to merge"
  fi

  BYPASS_COUNT="$(echo "$PROTECTION_JSON" | jq '((.required_pull_request_reviews.bypass_pull_request_allowances.users // []) | length) + ((.required_pull_request_reviews.bypass_pull_request_allowances.teams // []) | length) + ((.required_pull_request_reviews.bypass_pull_request_allowances.apps // []) | length)')"
  if [ "$BYPASS_COUNT" != "0" ] && [ "$BYPASS_COUNT" != "null" ]; then
    fail "required_pull_request_reviews names specific bypass users/teams/apps - expected none"
  fi

  RESTRICTIONS="$(echo "$PROTECTION_JSON" | jq -c '.restrictions')"
  if [ "$RESTRICTIONS" != "null" ]; then
    USERS_AND_TEAMS="$(echo "$PROTECTION_JSON" | jq '((.restrictions.users // []) | length) + ((.restrictions.teams // []) | length) + ((.restrictions.apps // []) | length)')"
    if [ "$USERS_AND_TEAMS" != "0" ]; then
      fail "branch protection restrictions name specific bypass users/teams/apps - expected none"
    fi
  fi
fi

for env_name in staging production; do
  ENV_JSON="$(gh api "repos/${OWNER}/${REPO}/environments/${env_name}" 2>/dev/null || echo '{}')"
  if [ "$(echo "$ENV_JSON" | jq -r 'has("name")')" != "true" ]; then
    fail "environment '${env_name}' does not exist"
    continue
  fi
  if [ "$env_name" = "production" ]; then
    REVIEWER_COUNT="$(echo "$ENV_JSON" | jq '(.protection_rules // []) | map(select(.type == "required_reviewers")) | length')"
    if [ "$REVIEWER_COUNT" = "0" ]; then
      fail "environment 'production' has no required reviewer protection rule"
    fi
  fi
done

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS: branch protection and environments match the expected pipeline bootstrap state."
  exit 0
else
  echo "FAIL: ${FAILURES} check(s) did not match the expected pipeline bootstrap state."
  exit 1
fi

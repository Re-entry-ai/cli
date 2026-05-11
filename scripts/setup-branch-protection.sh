#!/usr/bin/env bash
# Apply main-branch protection to Re-entry-ai/cli.
#
# Why this script exists:
#   GitHub's UI for branch protection has 14+ checkboxes; getting them
#   right twice (now and after a future rename) is error-prone. This
#   script applies a versioned config (branch-protection.json) so the
#   exact rules are reviewable in git.
#
# Prerequisites:
#   1. A personal access token with repo:admin on Re-entry-ai/cli.
#      Generate at https://github.com/settings/tokens (classic) or use
#      a fine-grained token scoped to this repo with "Administration:
#      Read and write".
#   2. Set GITHUB_TOKEN in your shell:
#         export GITHUB_TOKEN=ghp_...
#   3. The CI workflow (.github/workflows/ci.yml) must have run at least
#      once before applying this — required_status_checks rejects names
#      that have never appeared on the repo.
#
# Run:
#   bash scripts/setup-branch-protection.sh
#
# Verify:
#   curl -sH "Authorization: Bearer $GITHUB_TOKEN" \
#        https://api.github.com/repos/Re-entry-ai/cli/branches/main/protection \
#     | jq '{ enforce_admins: .enforce_admins.enabled, required_pr_reviews: .required_pull_request_reviews, status_checks: .required_status_checks.contexts }'

set -euo pipefail

REPO="${REPO:-Re-entry-ai/cli}"
BRANCH="${BRANCH:-main}"
CONFIG_FILE="$(dirname "$0")/branch-protection.json"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "error: GITHUB_TOKEN is not set" >&2
  echo "  see the header of this script for token instructions" >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "error: $CONFIG_FILE not found" >&2
  exit 1
fi

echo "Applying branch protection to $REPO @ $BRANCH"
echo "Config: $CONFIG_FILE"

http_status=$(curl -sS -o /tmp/branch-protection-response.json -w "%{http_code}" \
  -X PUT \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  --data @"$CONFIG_FILE" \
  "https://api.github.com/repos/$REPO/branches/$BRANCH/protection")

if [ "$http_status" != "200" ]; then
  echo "error: GitHub API returned $http_status" >&2
  cat /tmp/branch-protection-response.json >&2
  exit 1
fi

echo "OK — protection applied. Response saved to /tmp/branch-protection-response.json"

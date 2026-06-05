#!/usr/bin/env bash
# Pre-push hook: run E2E tests before allowing push to main
# Install: cp pre-push.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push

REPO_ROOT="$(git rev-parse --show-toplevel)"
E2E_RUNNER="$REPO_ROOT/backend/tests/run-e2e.sh"

echo "🔱 Pre-push E2E gate..."

while read local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == "refs/heads/main" ]]; then
    echo "▶ Pushing to main — running E2E suite..."
    if bash "$E2E_RUNNER"; then
      echo "✅ E2E passed — push allowed"
    else
      echo "❌ E2E FAILED — push rejected"
      echo "   Fix the failures, then push again."
      exit 1
    fi
  fi
done

exit 0

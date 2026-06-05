#!/usr/bin/env bash
# wooverse-safe-restart.sh — runs E2E tests then restarts PM2
# Gate: tests MUST pass before restart happens
set -e

BACKEND_DIR="/root/.openclaw/workspace/wooverse/app/backend"

echo "🔱 Wooverse Safe Deploy"
echo ""

# Step 1: Run E2E tests
echo "▶ Running E2E test suite..."
if bash "$BACKEND_DIR/tests/run-e2e.sh"; then
  echo "✓ All E2E tests passed"
else
  echo "❌ E2E tests FAILED — aborting restart"
  echo "   Fix the failures before deploying"
  exit 1
fi

# Step 2: Restart PM2
echo ""
echo "▶ Restarting wooverse-backend..."
pm2 restart wooverse-backend

sleep 2

# Step 3: Post-restart smoke test
echo ""
echo "▶ Post-restart smoke test..."
HEALTH=$(curl -s "http://localhost:8102/health")
echo "   Health: $HEALTH"

if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "✅ Deploy complete — backend healthy"
  exit 0
else
  echo "❌ Backend failed to start properly"
  exit 1
fi

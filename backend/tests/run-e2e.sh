#!/usr/bin/env bash
# Wooverse E2E Test Runner
# Runs all E2E test suites against the live backend (must be running on :8102)
set -e

BACKEND_PORT=8102
TEST_DIR="$(cd "$(dirname "$0")" && pwd)/e2e"

echo "🔱 Wooverse E2E Test Runner"
echo "============================"

# Check backend is up
if ! curl -s "http://localhost:${BACKEND_PORT}/health" > /dev/null 2>&1; then
  echo "❌ Backend not running on :${BACKEND_PORT}"
  echo "   Start it with: pm2 start wooverse-backend"
  exit 1
fi

echo "✓ Backend alive on :${BACKEND_PORT}"
echo ""

PASS=0
FAIL=0
FAILED_SUITES=""

for test_file in "$TEST_DIR"/*.test.js; do
  if [ ! -f "$test_file" ]; then
    echo "No test files found in $TEST_DIR"
    exit 0
  fi

  SUITE_NAME=$(basename "$test_file" .test.js)
  echo "▶ Running $SUITE_NAME..."

  if node "$test_file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILED_SUITES="$FAILED_SUITES $SUITE_NAME"
  fi
  echo ""
done

echo "============================"
echo "Total: $((PASS + FAIL)) suites, $PASS passed, $FAIL failed"

if [ "$FAIL" -eq 0 ]; then
  echo "✅ ALL E2E TESTS PASSED"
  exit 0
else
  echo "❌ FAILED:$FAILED_SUITES"
  exit 1
fi

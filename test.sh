#!/usr/bin/env bash
set -euo pipefail

# Free port 8899 before localnet setup (a stale validator blocks arcium).
STALE_PID=$(lsof -ti :8899 || true)
if [ -n "$STALE_PID" ]; then
  echo "Killing stale solana-test-validator (PID $STALE_PID) on port 8899..."
  kill $STALE_PID
  sleep 1
fi

./build.sh --env dev

# Unit tests (host-native, fast — run before spinning up the validator)
echo "Running unit tests..."
cargo test -p opportunity_market --lib --features disable-prod-guardrails,allow-test-guardrails

echo "Running integration tests..."
arcium test --skip-build

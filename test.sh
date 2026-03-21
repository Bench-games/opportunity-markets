#!/usr/bin/env bash
set -euo pipefail

KEYPAIR_NAME="bncZ1gDqgqhSWFzcxjeMoCtqN7odS8wYn1nS5tXZ9jA"
KEYPAIR_PATH="../${KEYPAIR_NAME}.json"

# Verify the deterministic keypair exists
if [ ! -f "$KEYPAIR_PATH" ]; then
  echo "Error: Program keypair not found at $KEYPAIR_PATH"
  exit 1
fi

# Ensure the deploy keypair matches our deterministic program keypair
# (must be in place BEFORE build so key sync and compilation use the right ID)
mkdir -p target/deploy
cp "$KEYPAIR_PATH" target/deploy/opportunity_market-keypair.json

# Build (let arcium sync keys from the deploy keypair, then compile)
echo "Building..."
arcium build

# Test (--skip-build prevents overwriting the keypair)
echo "Running tests..."
arcium test --skip-build

# Kill stale solana-test-validator if one is hogging port 8899
STALE_PID=$(lsof -ti :8899 || true)
if [ -n "$STALE_PID" ]; then
  echo "Killing stale solana-test-validator (PID $STALE_PID) on port 8899..."
  kill $STALE_PID
  sleep 1
fi


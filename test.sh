#!/usr/bin/env bash
set -euo pipefail

KEYPAIR_NAME="bncZ1gDqgqhSWFzcxjeMoCtqN7odS8wYn1nS5tXZ9jA"
KEYPAIR_PATH="../${KEYPAIR_NAME}.json"

# Verify the deterministic keypair exists
if [ ! -f "$KEYPAIR_PATH" ]; then
  echo "Error: Program keypair not found at $KEYPAIR_PATH"
  exit 1
fi

# Build (--skip-keys-sync preserves the declare_id! macro)
echo "Building..."
arcium build --skip-keys-sync

# Test (--skip-build prevents overwriting the keypair)
echo "Running tests..."
arcium test --skip-build

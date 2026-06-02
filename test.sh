#!/usr/bin/env bash
set -euo pipefail

# Copy the deterministic keypair and build
./build.sh

# Unit tests (host-native, fast — run before spinning up the validator)
echo "Running unit tests..."
cargo test -p opportunity_market --lib

# Integration tests
echo "Running integration tests..."
# This block here is for a temp fix with mxe issue
if [ -f artifacts/localnet/mxe_utility_pubkeys.bin ]; then
  arcium test --skip-build --skip-keygen
else
  arcium test --skip-build
fi

# Kill stale solana-test-validator if one is hogging port 8899
STALE_PID=$(lsof -ti :8899 || true)
if [ -n "$STALE_PID" ]; then
  echo "Killing stale solana-test-validator (PID $STALE_PID) on port 8899..."
  kill $STALE_PID
  sleep 1
fi

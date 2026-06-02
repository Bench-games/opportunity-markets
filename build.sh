#!/usr/bin/env bash
set -euo pipefail

KEYPAIR_NAME="bnchkMdYe3MWubqAWJbCYQGNmnjTg2YWEEi1a8qs82G"
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

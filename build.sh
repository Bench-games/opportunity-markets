#!/usr/bin/env bash
set -euo pipefail

DISABLE_PROD_GUARDRAILS=false
if [ "${1:-}" = "--disable-prod-guardrails" ]; then
  DISABLE_PROD_GUARDRAILS=true
fi

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

if [ "$DISABLE_PROD_GUARDRAILS" = true ]; then
  # Local-test build path: keep Arcium key sync/circuit build, compile program with relaxed feature.
  echo "Building for local tests with disable-prod-guardrails..."
  arcium build --skip-program
  anchor build -- --features disable-prod-guardrails
else
  # Default build path for deploys/devnet/mainnet (production guardrails active).
  echo "Building..."
  arcium build
fi

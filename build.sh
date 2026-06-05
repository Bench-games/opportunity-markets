#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--env" ] && [ "${2:-}" = "dev" ]; then
  echo "Building for local tests with disable-prod-guardrails..."
  rm -f target/deploy/opportunity_market-keypair.json
  arcium build --skip-program --skip-keys-sync
  anchor build --ignore-keys -- --features disable-prod-guardrails

else
  KEYPAIR_NAME="bnchkMdYe3MWubqAWJbCYQGNmnjTg2YWEEi1a8qs82G"
  KEYPAIR_PATH="../${KEYPAIR_NAME}.json"

  # Verify the deterministic keypair exists
  if [ ! -f "$KEYPAIR_PATH" ]; then
    echo "Error: Program keypair not found at $KEYPAIR_PATH"
    exit 1
  fi

  # Ensure the deploy keypair matches our deterministic program keypair
  mkdir -p target/deploy
  cp "$KEYPAIR_PATH" target/deploy/opportunity_market-keypair.json

  echo "Building..."
  arcium build
fi

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

PROGRAM_NAME="${PROGRAM_NAME:-opportunity_market}"
PROGRAM_SO_PATH="${PROGRAM_SO_PATH:-${REPO_ROOT}/target/deploy/${PROGRAM_NAME}.so}"
IDL_PATH="${IDL_PATH:-${REPO_ROOT}/target/idl/${PROGRAM_NAME}.json}"
CLUSTER_OFFSET="${CLUSTER_OFFSET:-456}"
RECOVERY_SET_SIZE="${RECOVERY_SET_SIZE:-4}"
MAX_SIGN_ATTEMPTS="${MAX_SIGN_ATTEMPTS:-30}"

: "${DEPLOYER_KEYPAIR_PATH:?Set DEPLOYER_KEYPAIR_PATH to the funded deployer keypair}"
: "${PROGRAM_KEYPAIR_PATH:?Set PROGRAM_KEYPAIR_PATH to the program keypair}"
: "${RPC_URL:?Set RPC_URL to the target Solana RPC URL}"

for command in solana solana-keygen arcium anchor; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: required command not found: $command" >&2
    exit 1
  fi
done

for file in "$PROGRAM_SO_PATH" "$IDL_PATH" "$DEPLOYER_KEYPAIR_PATH" "$PROGRAM_KEYPAIR_PATH"; do
  if [ ! -f "$file" ]; then
    echo "Error: required file not found: $file" >&2
    exit 1
  fi
done

PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR_PATH")"
BUFFER_KEYPAIR_PATH="${BUFFER_KEYPAIR_PATH:-${REPO_ROOT}/target/deploy/${PROGRAM_ID}/buffer-keypair.json}"
PROGRAM_EXISTS=0

if solana program show "$PROGRAM_ID" --url "$RPC_URL" >/dev/null 2>&1; then
  PROGRAM_EXISTS=1
fi

if [ "$PROGRAM_EXISTS" -eq 1 ] && [ ! -f "$BUFFER_KEYPAIR_PATH" ]; then
  echo "Program account exists and no local buffer keypair was found; skipping program deployment."
else
  if [ "$PROGRAM_EXISTS" -eq 1 ]; then
    echo "Program account and local buffer keypair exist; resuming interrupted deployment."
  else
    echo "Program account does not exist; starting program deployment."
  fi

  mkdir -p "$(dirname -- "$BUFFER_KEYPAIR_PATH")"
  if [ ! -f "$BUFFER_KEYPAIR_PATH" ]; then
    solana-keygen new \
      --no-bip39-passphrase \
      --silent \
      --force \
      --outfile "$BUFFER_KEYPAIR_PATH"
    chmod 600 "$BUFFER_KEYPAIR_PATH"
  fi

  solana program deploy "$PROGRAM_SO_PATH" \
    --url "$RPC_URL" \
    --keypair "$DEPLOYER_KEYPAIR_PATH" \
    --fee-payer "$DEPLOYER_KEYPAIR_PATH" \
    --upgrade-authority "$DEPLOYER_KEYPAIR_PATH" \
    --program-id "$PROGRAM_KEYPAIR_PATH" \
    --buffer "$BUFFER_KEYPAIR_PATH" \
    --use-rpc \
    --max-sign-attempts "$MAX_SIGN_ATTEMPTS" \
    --commitment confirmed

  rm -f "$BUFFER_KEYPAIR_PATH"
fi

arcium deploy \
  --cluster-offset "$CLUSTER_OFFSET" \
  --recovery-set-size "$RECOVERY_SET_SIZE" \
  --keypair-path "$DEPLOYER_KEYPAIR_PATH" \
  --rpc-url "$RPC_URL" \
  --program-keypair "$PROGRAM_KEYPAIR_PATH" \
  --program-name "$PROGRAM_NAME" \
  --skip-deploy \
  --resume \
  --verbose

if anchor idl fetch "$PROGRAM_ID" \
  --provider.cluster "$RPC_URL" \
  --provider.wallet "$DEPLOYER_KEYPAIR_PATH" \
  >/dev/null 2>&1; then
  anchor idl upgrade "$PROGRAM_ID" \
    --filepath "$IDL_PATH" \
    --provider.cluster "$RPC_URL" \
    --provider.wallet "$DEPLOYER_KEYPAIR_PATH" \
    --commitment confirmed
else
  anchor idl init "$PROGRAM_ID" \
    --filepath "$IDL_PATH" \
    --provider.cluster "$RPC_URL" \
    --provider.wallet "$DEPLOYER_KEYPAIR_PATH" \
    --commitment confirmed
fi

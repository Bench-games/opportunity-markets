#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

PROGRAM_NAME="${PROGRAM_NAME:-opportunity_market}"
PROGRAM_SO_PATH="${PROGRAM_SO_PATH:-${REPO_ROOT}/target/deploy/${PROGRAM_NAME}.so}"
IDL_PATH="${IDL_PATH:-${REPO_ROOT}/target/idl/${PROGRAM_NAME}.json}"
CLUSTER_OFFSET="${CLUSTER_OFFSET:-456}"
RECOVERY_SET_SIZE="${RECOVERY_SET_SIZE:-4}"
MAX_SIGN_ATTEMPTS="${MAX_SIGN_ATTEMPTS:-30}"
PROGRAM_EXTEND_BYTES="${PROGRAM_EXTEND_BYTES:-}"
REDEPLOY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --redeploy)
      REDEPLOY=1
      ;;
    --help|-h)
      echo "Usage: $0 [--redeploy]"
      echo
      echo "  --redeploy  Deploy the program even when the program account already exists."
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      echo "Usage: $0 [--redeploy]" >&2
      exit 1
      ;;
  esac
  shift
done

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
PROGRAM_SHOW_OUTPUT=""

if PROGRAM_SHOW_OUTPUT="$(solana program show "$PROGRAM_ID" --url "$RPC_URL" 2>/dev/null)"; then
  PROGRAM_EXISTS=1
fi

PRE_EXTEND_BYTES="$PROGRAM_EXTEND_BYTES"

if [ "$PROGRAM_EXISTS" -eq 1 ] && [ "$REDEPLOY" -eq 1 ] && [ -z "$PRE_EXTEND_BYTES" ]; then
  CURRENT_PROGRAM_LEN="$(printf '%s\n' "$PROGRAM_SHOW_OUTPUT" | awk '/Data Length:/ {print $3; exit}')"
  NEW_PROGRAM_LEN="$(wc -c < "$PROGRAM_SO_PATH" | tr -d ' ')"

  if [ -n "$CURRENT_PROGRAM_LEN" ] && [ "$NEW_PROGRAM_LEN" -gt "$CURRENT_PROGRAM_LEN" ]; then
    REQUIRED_EXTEND_BYTES="$((NEW_PROGRAM_LEN - CURRENT_PROGRAM_LEN))"
    if [ "$REQUIRED_EXTEND_BYTES" -lt 10240 ]; then
      PRE_EXTEND_BYTES=10240
    else
      PRE_EXTEND_BYTES="$REQUIRED_EXTEND_BYTES"
    fi
  fi
fi

if [ "$PROGRAM_EXISTS" -eq 1 ] && [ "$REDEPLOY" -eq 0 ] && [ ! -f "$BUFFER_KEYPAIR_PATH" ]; then
  echo "Program account exists and no local buffer keypair was found; skipping program deployment."
else
  if [ "$PROGRAM_EXISTS" -eq 1 ] && [ "$REDEPLOY" -eq 1 ]; then
    echo "Program account exists; redeploying program because --redeploy was passed."
  elif [ "$PROGRAM_EXISTS" -eq 1 ]; then
    echo "Program account and local buffer keypair exist; resuming interrupted deployment."
  else
    echo "Program account does not exist; starting program deployment."
  fi

  if [ -n "$PRE_EXTEND_BYTES" ] && [ "$PRE_EXTEND_BYTES" -gt 0 ]; then
    echo "Extending program by $PRE_EXTEND_BYTES bytes before deploy."
    solana program extend "$PROGRAM_ID" "$PRE_EXTEND_BYTES" \
      --url "$RPC_URL" \
      --keypair "$DEPLOYER_KEYPAIR_PATH" \
      --commitment confirmed
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

  DEPLOY_ARGS=(
    "$PROGRAM_SO_PATH"
    --url "$RPC_URL"
    --keypair "$DEPLOYER_KEYPAIR_PATH"
    --fee-payer "$DEPLOYER_KEYPAIR_PATH"
    --upgrade-authority "$DEPLOYER_KEYPAIR_PATH"
    --program-id "$PROGRAM_KEYPAIR_PATH"
    --buffer "$BUFFER_KEYPAIR_PATH"
    --use-rpc
    --max-sign-attempts "$MAX_SIGN_ATTEMPTS"
    --commitment confirmed
  )

  solana program deploy "${DEPLOY_ARGS[@]}"

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

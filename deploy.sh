#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

PROGRAM_NAME="${PROGRAM_NAME:-opportunity_market}"
PROGRAM_SO_PATH="${PROGRAM_SO_PATH:-${REPO_ROOT}/target/deploy/${PROGRAM_NAME}.so}"
IDL_PATH="${IDL_PATH:-${REPO_ROOT}/target/idl/${PROGRAM_NAME}.json}"
CLUSTER_OFFSET="${CLUSTER_OFFSET:-10000}"
RECOVERY_SET_SIZE="${RECOVERY_SET_SIZE:-7}"

if [ "$#" -ne 1 ]; then
  echo "Error: pass exactly one deployment stage: program, mxe, or idl" >&2
  echo "Usage: $0 <program|mxe|idl>" >&2
  exit 1
fi

case "$1" in
  program)
    : "${DEPLOYER_KEYPAIR_PATH:?Set DEPLOYER_KEYPAIR_PATH to the funded deployer keypair}"
    : "${PROGRAM_KEYPAIR_PATH:?Set PROGRAM_KEYPAIR_PATH to the program keypair}"
    : "${RPC_URL:?Set RPC_URL to the target Solana RPC URL}"

    PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR_PATH")"
    if solana program show "$PROGRAM_ID" --url "$RPC_URL" >/dev/null 2>&1; then
      echo "Error: program already exists on chain: $PROGRAM_ID" >&2
      exit 1
    fi

    solana program deploy "$PROGRAM_SO_PATH" \
      --url "$RPC_URL" \
      --keypair "$DEPLOYER_KEYPAIR_PATH" \
      --fee-payer "$DEPLOYER_KEYPAIR_PATH" \
      --upgrade-authority "$DEPLOYER_KEYPAIR_PATH" \
      --program-id "$PROGRAM_KEYPAIR_PATH" \
      --use-rpc \
      --commitment confirmed
    ;;

  mxe)
    : "${DEPLOYER_KEYPAIR_PATH:?Set DEPLOYER_KEYPAIR_PATH to the funded deployer keypair}"
    : "${PROGRAM_KEYPAIR_PATH:?Set PROGRAM_KEYPAIR_PATH to the program keypair}"
    : "${RPC_URL:?Set RPC_URL to the target Solana RPC URL}"

    arcium deploy \
      --cluster-offset "$CLUSTER_OFFSET" \
      --recovery-set-size "$RECOVERY_SET_SIZE" \
      --keypair-path "$DEPLOYER_KEYPAIR_PATH" \
      --rpc-url "$RPC_URL" \
      --program-keypair "$PROGRAM_KEYPAIR_PATH" \
      --program-name "$PROGRAM_NAME" \
      --skip-deploy \
      --verbose
    ;;

  idl)
    : "${DEPLOYER_KEYPAIR_PATH:?Set DEPLOYER_KEYPAIR_PATH to the funded deployer keypair}"
    : "${PROGRAM_KEYPAIR_PATH:?Set PROGRAM_KEYPAIR_PATH to the program keypair}"
    : "${RPC_URL:?Set RPC_URL to the target Solana RPC URL}"

    PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR_PATH")"
    if anchor idl fetch "$PROGRAM_ID" \
      --provider.cluster "$RPC_URL" \
      --provider.wallet "$DEPLOYER_KEYPAIR_PATH" \
      >/dev/null 2>&1; then
      echo "IDL already exists. To update it, run:" >&2
      echo >&2
      echo "anchor idl upgrade \"$PROGRAM_ID\" --filepath \"$IDL_PATH\" --provider.cluster \"$RPC_URL\" --provider.wallet \"$DEPLOYER_KEYPAIR_PATH\" --commitment confirmed" >&2
      exit 1
    fi

    anchor idl init "$PROGRAM_ID" \
      --filepath "$IDL_PATH" \
      --provider.cluster "$RPC_URL" \
      --provider.wallet "$DEPLOYER_KEYPAIR_PATH" \
      --commitment confirmed
    ;;

  *)
    echo "Error: invalid deployment stage: $1" >&2
    echo "Usage: $0 <program|mxe|idl>" >&2
    exit 1
    ;;
esac

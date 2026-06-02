import { type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";

const TIMEOUT_SLOTS = 180;
const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_SIGNATURE_LIMIT = 100;

export interface AwaitComputationOptions {
  commitment?: "confirmed" | "finalized";
  pollInterval?: number;
  transactionCountLimit?: number;
}

/**
 * Waits for a single Arcium computation to be finalized.
 */
export const awaitComputationFinalization = async (
  rpc: Rpc<SolanaRpcApi>,
  computationAccount: Address,
  invocationSignature: Signature,
  options?: AwaitComputationOptions
): Promise<Signature> => {
  const commitment = options?.commitment ?? "confirmed";
  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const limit = options?.transactionCountLimit ?? DEFAULT_SIGNATURE_LIMIT;

  const invocationTx = await rpc.getTransaction(invocationSignature, {
    commitment,
    encoding: "json",
    maxSupportedTransactionVersion: 0,
  }).send();

  if (!invocationTx) {
    throw new Error(`Invocation transaction ${invocationSignature} not found`);
  }

  const deadlineSlot = invocationTx.slot + BigInt(TIMEOUT_SLOTS);

  for (;;) {
    const signatures = await rpc.getSignaturesForAddress(computationAccount, {
      limit,
      commitment,
    }).send();

    for (const sigInfo of signatures) {
      if (sigInfo.signature === invocationSignature) continue;
      if (sigInfo.err === null) {
        return sigInfo.signature;
      }
    }

    const currentSlot = await rpc.getSlot({ commitment }).send();
    if (currentSlot > deadlineSlot) {
      throw new Error(
        `Computation ${computationAccount} not finalized within ${TIMEOUT_SLOTS} slots of invocation ${invocationSignature}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
};

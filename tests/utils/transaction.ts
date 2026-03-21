import {
  type Instruction,
  type TransactionSigner,
  type Signature,
  type TransactionError,
  assertIsTransactionWithBlockhashLifetime,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  createSolanaRpc,
  sendAndConfirmTransactionFactory,
} from "@solana/kit";

/**
 * Custom error type for on-chain transaction failures.
 * Error format: { InstructionError: [ 0, { Custom: 6026 } ] }
 */
export class OnChainError extends Error {
  readonly code: number | null;

  constructor(err: TransactionError) {
    let code: number | null = null;

    if (typeof err === "object" && "InstructionError" in err) {
      const inner = err.InstructionError[1];
      if (typeof inner === "object" && "Custom" in inner) {
        code = Number(inner.Custom);
      }
    }

    super(`OnChainError: ${code}`);
    this.name = "OnChainError";
    this.code = code;
  }
}

export type RpcClient = ReturnType<typeof createSolanaRpc>;
export type SendAndConfirmFn = ReturnType<typeof sendAndConfirmTransactionFactory>;

export interface SendTransactionOptions {
  /** Label for logging (e.g., "Fund market", "Open market") */
  label?: string;
  /** Whether to print simulation logs (default: true) */
  printLogs?: boolean;
  /** Commitment level (default: "confirmed") */
  commitment?: "processed" | "confirmed" | "finalized";
}

export interface SendTransactionResult {
  signature: Signature;
  logs: readonly string[] | undefined;
}

/**
 * Helper to build, sign, simulate, and send a transaction.
 *
 * This handles all the boilerplate for Kit transactions:
 * 1. Fetches latest blockhash
 * 2. Builds transaction message with fee payer and instructions
 * 3. Signs with all signers extracted from instructions
 * 4. Simulates and logs results
 * 5. Sends and confirms
 *
 * @param rpc - Solana RPC client
 * @param sendAndConfirm - sendAndConfirmTransactionFactory result
 * @param feePayer - Transaction signer who pays fees
 * @param instructions - Array of instructions to include
 * @param options - Optional configuration
 * @returns Signature and logs from the transaction
 */
export async function sendTransaction(
  rpc: RpcClient,
  sendAndConfirm: SendAndConfirmFn,
  feePayer: TransactionSigner,
  instructions: Instruction[],
  options: SendTransactionOptions = {}
): Promise<SendTransactionResult> {
  const { label, printLogs = false, commitment = "confirmed" } = options;
  const logPrefix = label ? `   [${label}] ` : "   ";

  // Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();

  // Build transaction message
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(feePayer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions(instructions, msg)
  );

  // Sign the transaction
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  // Simulate
  if (printLogs) {
    console.log(`${logPrefix}Simulating...`);
  }

  const base64Tx = getBase64EncodedWireTransaction(signedTransaction);
  const simResult = await rpc.simulateTransaction(base64Tx, {
    commitment,
    encoding: "base64",
  }).send();

  const logs = simResult.value.logs;

  if (printLogs) {
    const logFunc = simResult.value.err ? console.error : console.log
      logFunc(`${logPrefix}Simulation:`, simResult.value.err);
    if (logs) {
      logFunc(`${logPrefix}Logs:`);
      logs.forEach((log) => logFunc(`${logPrefix}  ${log}`));
    }
  }

  if (simResult.value.err) {
    throw new OnChainError(simResult.value.err);
  }

  // Send and confirm
  if (printLogs) {
    console.log(`${logPrefix}Sending...`);
  }

  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  await sendAndConfirm(signedTransaction, { commitment });
  const signature = getSignatureFromTransaction(signedTransaction);

  // Fetch transaction to verify instruction succeeded (not just tx confirmed)
  const txResult = await rpc.getTransaction(signature, {
    commitment,
    maxSupportedTransactionVersion: 0,
    encoding: "jsonParsed"
  }).send();

  if (txResult?.meta?.err) {
    throw new OnChainError(txResult.meta.err);
  }

  if (printLogs) {
    console.log(`${logPrefix}Confirmed: ${signature.slice(0, 20)}...`);
  }

  if (process.env.PRINT_TX_TIMES) {
    const ts = txResult?.blockTime ? new Date(Number(txResult.blockTime) * 1000).toISOString() : new Date().toISOString();
    console.log(`${ts}: ${signature}`);
  }

  return { signature, logs };
}

/**
 * Simulate a transaction without sending it.
 * Useful for checking if a transaction would succeed.
 */
export async function simulateTransaction(
  rpc: RpcClient,
  feePayer: TransactionSigner,
  instructions: Instruction[],
  options: Omit<SendTransactionOptions, "printLogs"> & { printLogs?: boolean } = {}
): Promise<{ success: boolean; logs: readonly string[] | undefined; error: unknown }> {
  const { label, printLogs = false, commitment = "confirmed" } = options;
  const logPrefix = label ? `   [${label}] ` : "   ";

  // Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();

  // Build transaction message
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(feePayer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions(instructions, msg)
  );

  // Sign the transaction
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  // Simulate
  if (printLogs) {
    console.log(`${logPrefix}Simulating...`);
  }

  const base64Tx = getBase64EncodedWireTransaction(signedTransaction);
  const simResult = await rpc.simulateTransaction(base64Tx, {
    commitment,
    encoding: "base64",
  }).send();

  const logs = simResult.value.logs;

  if (printLogs) {
    console.log(`${logPrefix}Simulation error:`, simResult.value.err);
    if (logs) {
      console.log(`${logPrefix}Logs:`);
      logs.forEach((log) => console.log(`${logPrefix}  ${log}`));
    }
  }

  return {
    success: simResult.value.err === null,
    logs,
    error: simResult.value.err,
  };
}

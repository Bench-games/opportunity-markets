import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Rpc,
  type SolanaRpcApi,
  type Signature,
} from "@solana/kit";
import {
  getInitCompDefInstruction,
  getCompDefAccount,
  type CompDefCircuitName,
  ALL_COMP_DEF_CIRCUITS,
} from "../js/src";
import * as fs from "fs";
import * as os from "os";

// Configuration
if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

function readSecretKey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  return new Uint8Array(JSON.parse(file.toString()));
}

async function sendAndConfirmTx(
  rpc: Rpc<SolanaRpcApi>,
  signedTx: Parameters<typeof getBase64EncodedWireTransaction>[0]
): Promise<Signature> {
  const encodedTx = getBase64EncodedWireTransaction(signedTx);
  const signature = getSignatureFromTransaction(signedTx);

  await rpc.sendTransaction(encodedTx, { encoding: "base64" }).send();

  // Poll for confirmation
  const start = Date.now();
  const timeout = 60_000;
  while (Date.now() - start < timeout) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      return signature;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${signature} not confirmed within ${timeout / 1000}s`);
}

async function main() {
  console.log("=".repeat(60));
  console.log("Opportunity Markets - Compute Definition Initialization");
  console.log("=".repeat(60));
  console.log(`\nProgram ID: ${PROGRAM_ID}`);
  console.log(`RPC URL: ${RPC_URL}`);

  // Load keypair
  const keypairPath =
    process.env.KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
  console.log(`\nLoading keypair from: ${keypairPath}`);

  let secretKey: Uint8Array;
  try {
    secretKey = readSecretKey(keypairPath);
  } catch {
    console.error(`Failed to load keypair from ${keypairPath}`);
    console.error(
      "Set KEYPAIR_PATH or ensure ~/.config/solana/id.json exists"
    );
    process.exit(1);
  }

  const payer = await createKeyPairSignerFromBytes(secretKey);
  console.log(`Payer: ${payer.address}`);

  const rpc = createSolanaRpc(RPC_URL);

  // Check balance
  const { value: balanceLamports } = await rpc
    .getBalance(payer.address)
    .send();
  const balanceSol = Number(balanceLamports) / 1_000_000_000;
  console.log(`Balance: ${balanceSol} SOL`);

  if (balanceSol < 0.5) {
    console.error(
      "\nWarning: Low balance! You need at least 0.5 SOL to initialize circuits."
    );
    console.log("Request an airdrop with: solana airdrop 2 -u devnet");
  }

  console.log("\n" + "=".repeat(60));
  console.log("Initializing Computation Definitions");
  console.log("=".repeat(60));

  for (const circuitName of ALL_COMP_DEF_CIRCUITS) {
    try {
      await initCompDef(rpc, payer, circuitName);
    } catch(error) {
      console.error(`\nFailed to initialize ${circuitName}, stopping...`);
      console.error(error)
      process.exit(1);
    }
  }

  console.log("\nAll computation definitions initialized!");
}

async function initCompDef(
  rpc: Rpc<SolanaRpcApi>,
  payer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  circuitName: CompDefCircuitName
): Promise<void> {
  console.log(`\nInitializing ${circuitName}...`);

  // Check if already initialized
  const compDefAddress = getCompDefAccount(circuitName, PROGRAM_ID);
  console.log("PROGRAM ID", PROGRAM_ID)
  const accountInfo = await rpc
    .getAccountInfo(compDefAddress, { encoding: "base64" })
    .send();
  if (accountInfo.value !== null) {
    console.log(`  Already initialized at ${compDefAddress}, skipping.`);
    return;
  }

  console.log(`  Creating comp def account...`);
  const initIx = await getInitCompDefInstruction(rpc, payer, circuitName, {
    programAddress: PROGRAM_ID,
  });

  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const txMsg = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions([initIx], msg)
  );

  const signedTx = await signTransactionMessageWithSigners(txMsg);

  try {
    await sendAndConfirmTx(rpc, signedTx);
    console.log(`  Initialized!`);
  } catch (err: any) {
    const logs = err?.context?.logs || err?.logs;
    if (logs) {
      console.error("  Transaction logs:");
      logs.forEach((log: string) => console.error(`    ${log}`));
    }
    console.error("  Error:", err?.message || err);
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nFatal error:", error);
    process.exit(1);
  });

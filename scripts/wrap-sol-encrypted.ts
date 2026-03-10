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
  type Instruction,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  initEncryptedTokenAccount,
  wrapEncryptedTokens,
  getEncryptedTokenAccountAddress,
  randomStateNonce,
  randomComputationOffset,
  awaitComputationFinalization,
} from "../js/src";
import { getArciumEnv } from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

const NATIVE_MINT = address("So11111111111111111111111111111111111111112");

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

const X25519_KEYPAIR_PATH = process.argv[2];
const LAMPORTS = process.argv[3];

if (!X25519_KEYPAIR_PATH || !LAMPORTS) {
  console.error(
    "Usage: npx tsx scripts/wrap-sol-encrypted.ts <X25519_KEYPAIR_PATH> <LAMPORTS>"
  );
  process.exit(1);
}

const lamportsAmount = BigInt(LAMPORTS);

function readSecretKey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  return new Uint8Array(JSON.parse(file.toString()));
}

function readX25519Keypair(path: string): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  const file = fs.readFileSync(path);
  const json = JSON.parse(file.toString());
  return {
    publicKey: new Uint8Array(json.publicKey),
    secretKey: new Uint8Array(json.secretKey),
  };
}

async function sendAndConfirmTx(
  rpc: Rpc<SolanaRpcApi>,
  signedTx: Parameters<typeof getBase64EncodedWireTransaction>[0]
): Promise<Signature> {
  const encodedTx = getBase64EncodedWireTransaction(signedTx);
  const signature = getSignatureFromTransaction(signedTx);

  try {
    await rpc.sendTransaction(encodedTx, { encoding: "base64" }).send();
  } catch (err: any) {
    const logs = err?.context?.logs || err?.data?.logs;
    if (logs) {
      console.error("\nTransaction logs:");
      logs.forEach((log: string) => console.error(`  ${log}`));
    }
    throw err;
  }

  const start = Date.now();
  const timeout = 60_000;
  while (Date.now() - start < timeout) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        // Fetch transaction to get logs
        const txInfo = await rpc
          .getTransaction(signature, {
            commitment: "confirmed",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          })
          .send();
        const logs = txInfo?.meta?.logMessages;
        if (logs) {
          console.error("\nTransaction logs:");
          logs.forEach((log: string) => console.error(`  ${log}`));
        }
        throw new Error(
          `Transaction failed: ${JSON.stringify(status.err)}`
        );
      }
      return signature;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `Transaction ${signature} not confirmed within ${timeout / 1000}s`
  );
}

async function main() {
  const keypairPath =
    process.env.DEPLOYER_KEYPAIR_PATH ||
    `${os.homedir()}/.config/solana/id.json`;
  const secretKey = readSecretKey(keypairPath);
  const payer = await createKeyPairSignerFromBytes(secretKey);
  const rpc = createSolanaRpc(RPC_URL);

  const x25519Keypair = readX25519Keypair(X25519_KEYPAIR_PATH);
  const arciumEnv = getArciumEnv();

  console.log(`Program:     ${PROGRAM_ID}`);
  console.log(`Payer:       ${payer.address}`);
  console.log(`Token mint:  ${NATIVE_MINT} (wSOL)`);
  console.log(`Amount:      ${lamportsAmount} lamports`);

  const instructions: Instruction[] = [];

  // 1. Create wSOL ATA (idempotent)
  const [wsolAta] = await findAssociatedTokenPda({
    mint: NATIVE_MINT,
    owner: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log(`wSOL ATA:    ${wsolAta}`);

  const createAtaIx =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      mint: NATIVE_MINT,
      owner: payer.address,
    });
  instructions.push(createAtaIx as Instruction);

  // 2. Transfer SOL -> wSOL ATA
  const transferIx = getTransferSolInstruction({
    source: payer,
    destination: wsolAta,
    amount: lamportsAmount,
  });
  instructions.push(transferIx as Instruction);

  // 3. SyncNative to reflect lamports as wSOL balance
  const syncIx = getSyncNativeInstruction({ account: wsolAta });
  instructions.push(syncIx as Instruction);

  // 4. Init encrypted token account
  const stateNonce = randomStateNonce();
  const initEtaIx = await initEncryptedTokenAccount({
    signer: payer,
    tokenMint: NATIVE_MINT,
    userPubkey: x25519Keypair.publicKey,
    stateNonce,
    programAddress: PROGRAM_ID,
  });
  instructions.push(initEtaIx as Instruction);

  // 5. Wrap encrypted tokens
  const [etaAddress] = await getEncryptedTokenAccountAddress(
    NATIVE_MINT,
    payer.address,
    PROGRAM_ID
  );
  console.log(`ETA:         ${etaAddress}`);

  const computationOffset = randomComputationOffset();
  const wrapIx = await wrapEncryptedTokens(
    {
      signer: payer,
      tokenMint: NATIVE_MINT,
      encryptedTokenAccount: etaAddress,
      signerTokenAccount: wsolAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: lamportsAmount,
      programAddress: PROGRAM_ID,
    },
    {
      clusterOffset: arciumEnv.arciumClusterOffset,
      computationOffset,
      programId: PROGRAM_ID,
    }
  );
  instructions.push(wrapIx as Instruction);

  // Send transaction
  console.log(
    `\nSending transaction (${instructions.length} instructions)...`
  );
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const signedTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg)
    )
  );

  const sig = await sendAndConfirmTx(rpc, signedTx);
  console.log(`Transaction confirmed: ${sig}`);

  // Await Arcium computation finalization
  console.log(`\nAwaiting Arcium computation finalization...`);
  const result = await awaitComputationFinalization(rpc, computationOffset, {
    mxeProgramId: PROGRAM_ID,
  });

  if (result.error) {
    console.error(`Computation callback failed: ${result.error}`);
    console.error(`Callback signature: ${result.signature}`);
    process.exit(1);
  }

  console.log(`Computation finalized: ${result.signature}`);
  console.log("\nDone!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });

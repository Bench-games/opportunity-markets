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
} from "@solana-program/token";
import { initTokenVault, getTokenVaultAddress } from "../js/src";
import * as fs from "fs";
import * as os from "os";

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

const TOKEN_MINT = process.argv[2];
const FUND_MANAGER = process.argv[3];

if (!TOKEN_MINT || !FUND_MANAGER) {
  console.error("Usage: npx tsx scripts/init-token-vault.ts <TOKEN_MINT> <FUND_MANAGER>");
  process.exit(1);
}

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
  const keypairPath = process.env.DEPLOYER_KEYPAIR_PATH || `${os.homedir()}/.config/solana/id.json`;
  const secretKey = readSecretKey(keypairPath);
  const payer = await createKeyPairSignerFromBytes(secretKey);
  const rpc = createSolanaRpc(RPC_URL);

  const tokenMint = address(TOKEN_MINT);
  const fundManager = address(FUND_MANAGER);

  console.log(`Program:      ${PROGRAM_ID}`);
  console.log(`Payer:        ${payer.address}`);
  console.log(`Token mint:   ${tokenMint}`);
  console.log(`Fund manager: ${fundManager}`);

  const [tokenVaultAddress] = await getTokenVaultAddress(tokenMint, PROGRAM_ID);
  console.log(`Token vault:  ${tokenVaultAddress}`);

  const instructions: Instruction[] = [];

  // Check if token vault already exists
  const tokenVaultAccount = await rpc.getAccountInfo(tokenVaultAddress).send();
  if (tokenVaultAccount.value) {
    console.log("\nToken vault already exists, skipping.");
  } else {
    console.log("\nToken vault not found, will initialize.");
    const ix = await initTokenVault({
      payer,
      tokenMint,
      fundManager,
      programAddress: PROGRAM_ID,
    });
    instructions.push(ix as Instruction);
  }

  // Check if ATA for the vault exists
  const [ataAddress] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: tokenVaultAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log(`Vault ATA:    ${ataAddress}`);

  const ataAccount = await rpc.getAccountInfo(ataAddress).send();
  if (ataAccount.value) {
    console.log("Vault ATA already exists, skipping.");
  } else {
    console.log("Vault ATA not found, will initialize.");
    const ataIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      mint: tokenMint,
      owner: tokenVaultAddress,
    });
    instructions.push(ataIx as Instruction);
  }

  if (instructions.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  console.log(`\nSending transaction (${instructions.length} instruction(s))...`);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

  const signedTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg)
    )
  );

  const sig = await sendAndConfirmTx(rpc, signedTx);
  console.log(`Done. Signature: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });

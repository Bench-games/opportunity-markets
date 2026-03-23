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
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createMarket } from "../js/src";
import config from "./market.json";
import * as fs from "fs";
import * as os from "os";

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

function readSecretKey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  return new Uint8Array(JSON.parse(file.toString()));
}

function readX25519Pubkey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  const keypair = JSON.parse(file.toString());
  return new Uint8Array(keypair.publicKey);
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

  console.log(`Program: ${PROGRAM_ID}`);
  console.log(`Payer:   ${payer.address}`);

  const marketIndex = BigInt(config.marketIndex);
  const authorizedReaderPubkey = readX25519Pubkey(config.authorizedReaderKeypairPath);
  if (authorizedReaderPubkey.length !== 32) {
    throw new Error(`authorizedReaderPubkey must be 32 bytes, got ${authorizedReaderPubkey.length}`);
  }

  console.log(`\nCreating market (index: ${marketIndex})...`);

  const createMarketIx = await createMarket({
    creator: payer,
    tokenMint: address(config.tokenMint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    marketIndex,
    timeToStake: BigInt(config.timeToStake),
    timeToReveal: BigInt(config.timeToReveal),
    marketAuthority: config.marketAuthority ? address(config.marketAuthority) : null,
    unstakeDelaySeconds: BigInt(config.unstakeDelaySeconds),
    authorizedReaderPubkey,
    allowClosingEarly: config.allowClosingEarly,
    revealPeriodAuthority: payer.address,
    programAddress: PROGRAM_ID,
  });

  const marketAddress = createMarketIx.accounts[3].address;

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

  const signedTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      (msg) => appendTransactionMessageInstructions([createMarketIx], msg)
    )
  );

  const sig = await sendAndConfirmTx(rpc, signedTx);
  console.log(`Done. Market: ${marketAddress}`);
  console.log(`Signature: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });

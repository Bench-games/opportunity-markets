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
import { TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { getMXEPublicKey } from "@arcium-hq/client";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  stake,
  initStakeAccount,
  getTokenVaultAddress,
  fetchOpportunityMarket,
  randomComputationOffset,
  createCipher,
  generateX25519Keypair,
} from "../js/src";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";

if (!process.env.PROGRAM_ID) throw new Error("PROGRAM_ID env var is required");
if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");

const PROGRAM_ID = address(process.env.PROGRAM_ID);
const RPC_URL = process.env.RPC_URL;

const MARKET_ADDRESS = process.argv[2];
const AMOUNT = process.argv[3];
const OPTION_ID = process.argv[4];
const X25519_KEYPAIR_PATH = process.argv[5];

if (!MARKET_ADDRESS || !AMOUNT || !OPTION_ID) {
  console.error("Usage: npx tsx scripts/stake.ts <MARKET_ADDRESS> <AMOUNT> <OPTION_ID> [X25519_KEYPAIR_PATH]");
  process.exit(1);
}

const ARCIUM_CLUSTER_OFFSET = 456;

function readSecretKey(path: string): Uint8Array {
  const file = fs.readFileSync(path);
  return new Uint8Array(JSON.parse(file.toString()));
}

function deserializeLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
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

  const marketAddress = address(MARKET_ADDRESS);
  const amount = BigInt(AMOUNT);
  const optionId = parseInt(OPTION_ID, 10);

  if (isNaN(optionId)) {
    throw new Error(`Invalid OPTION_ID: ${OPTION_ID}`);
  }

  console.log(`Program:   ${PROGRAM_ID}`);
  console.log(`Payer:     ${payer.address}`);
  console.log(`Market:    ${marketAddress}`);
  console.log(`Amount:    ${amount}`);
  console.log(`Option ID: ${optionId}`);

  // Fetch market to get token mint
  const marketAccount = await fetchOpportunityMarket(rpc, marketAddress,);
  const tokenMint = marketAccount.data.mint;
  console.log(`Token mint: ${tokenMint}`);

  // Load or generate X25519 keypair for encryption
  let userX25519Keypair;
  if (X25519_KEYPAIR_PATH) {
    const data = JSON.parse(fs.readFileSync(X25519_KEYPAIR_PATH, "utf-8"));
    userX25519Keypair = {
      secretKey: new Uint8Array(data.secretKey),
      publicKey: new Uint8Array(data.publicKey),
    };
    console.log("Using X25519 keypair from file");
  } else {
    userX25519Keypair = generateX25519Keypair();
    console.log("Generated ephemeral X25519 keypair");
  }

  // Get MXE public key
  const wallet = new Wallet(Keypair.fromSecretKey(secretKey));
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const programIdLegacy = new PublicKey(PROGRAM_ID);
  const mxePublicKey = await getMXEPublicKey(provider, programIdLegacy);
  if (!mxePublicKey) {
    throw new Error("MXE public key not found on-chain");
  }

  // Derive token accounts
  const [tokenVaultAddress] = await getTokenVaultAddress(tokenMint, PROGRAM_ID);
  const [signerTokenAccount] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log(`Signer ATA: ${signerTokenAccount}`);
  const [marketTokenAta] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: marketAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [tokenVaultAta] = await findAssociatedTokenPda({
    mint: tokenMint,
    owner: tokenVaultAddress,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // Ensure staker's associated token account exists
  const signerAtaAccount = await rpc.getAccountInfo(signerTokenAccount, { encoding: "base64" }).send();
  if (!signerAtaAccount.value) {
    console.log("\nStaker ATA not found, creating...");
    const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      mint: tokenMint,
      owner: payer.address,
    });

    const { value: ataBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const signedAtaTx = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(payer.address, msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash(ataBlockhash, msg),
        (msg) => appendTransactionMessageInstructions([createAtaIx as Instruction], msg)
      )
    );
    const ataSig = await sendAndConfirmTx(rpc, signedAtaTx);
    console.log(`Staker ATA created: ${ataSig}`);
  }

  // Init stake account
  const stakeAccountId = Math.floor(Math.random() * 1_000_000_000) + 1;
  const stateNonce = deserializeLE(randomBytes(16));

  console.log(`\nInitializing stake account (id: ${stakeAccountId})...`);
  const initIx = await initStakeAccount({
    signer: payer,
    market: marketAddress,
    stateNonce,
    stakeAccountId,
    programAddress: PROGRAM_ID,
  });

  const { value: latestBlockhash1 } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signedInitTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash1, msg),
      (msg) => appendTransactionMessageInstructions([initIx as Instruction], msg)
    )
  );
  const initSig = await sendAndConfirmTx(rpc, signedInitTx);
  console.log(`Init stake account sig: ${initSig}`);

  // Encrypt option choice
  const cipher = createCipher(userX25519Keypair.secretKey, mxePublicKey);
  const inputNonce = randomBytes(16);
  const optionCiphertext = cipher.encrypt([BigInt(optionId)], inputNonce);
  const computationOffset = randomComputationOffset();

  console.log(`\nStaking ${amount} tokens on option ${optionId}...`);
  const stakeIx = await stake(
    {
      signer: payer,
      payer,
      market: marketAddress,
      stakeAccountId,
      tokenMint,
      signerTokenAccount,
      marketTokenAta,
      tokenVault: tokenVaultAddress,
      tokenVaultAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount,
      selectedOptionCiphertext: optionCiphertext[0],
      inputNonce: deserializeLE(inputNonce),
      authorizedReaderNonce: deserializeLE(randomBytes(16)),
      userPubkey: userX25519Keypair.publicKey,
      programAddress: PROGRAM_ID,
    },
    {
      clusterOffset: ARCIUM_CLUSTER_OFFSET,
      computationOffset,
      programId: PROGRAM_ID,
    }
  );

  const { value: latestBlockhash2 } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signedStakeTx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayer(payer.address, msg),
      (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash2, msg),
      (msg) => appendTransactionMessageInstructions([stakeIx as Instruction], msg)
    )
  );

  const stakeSig = await sendAndConfirmTx(rpc, signedStakeTx);
  console.log(`Done. Stake account ID: ${stakeAccountId}`);
  console.log(`Signature: ${stakeSig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });

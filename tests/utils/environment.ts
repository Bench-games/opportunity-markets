import {
  getMXEPublicKey,
} from "@arcium-hq/client";
import {
  KeyPairSigner,
  Address,
  generateKeyPairSigner,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  lamports,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  assertIsTransactionWithBlockhashLifetime,
} from "@solana/kit";
import {
  OpportunityMarket,
  OpportunityMarketOption,
  createMarket,
  fetchOpportunityMarket,
  getInitCentralStateInstructionAsync,
} from "../../js/src";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { generateX25519Keypair, X25519Keypair } from "../../js/src/x25519/keypair";
import { createTokenMint, createAta, mintTokensTo, TOKEN_PROGRAM_ADDRESS } from "./spl-token";

export interface Account {
  keypair: KeyPairSigner;
  x25519Keypair: X25519Keypair;
  initialAirdroppedLamports: bigint;
  tokenAccount: Address;
}

export interface AccountWithETA extends Account {
  encryptedTokenAccount: Address;
}

export type WithAddress<T> = T & {
  address: Address;
};

export interface TestEnvironment {
  market: WithAddress<OpportunityMarket> & {
    creatorAccount: Account;
    options: WithAddress<OpportunityMarketOption>[];
    timeToReveal: bigint;
  };
  participants: Account[];
  mxePublicKey: Uint8Array;
  mint: KeyPairSigner;
  tokenProgram: Address;
  rpc: ReturnType<typeof createSolanaRpc>;
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
}

export interface CreateTestEnvironmentConfig {
  rpcUrl?: string;
  wsUrl?: string;
  numParticipants?: number;
  airdropLamports?: bigint;
  initialTokenAmount?: bigint;
  marketConfig?: {
    rewardAmount?: bigint;
    timeToStake?: bigint;
    timeToReveal?: bigint;
    unstakeDelaySeconds?: bigint;
  };
}

const DEFAULT_CONFIG: Required<CreateTestEnvironmentConfig> = {
  rpcUrl: "http://127.0.0.1:8899",
  wsUrl: "ws://127.0.0.1:8900",
  numParticipants: 5,
  airdropLamports: 2_000_000_000n, // 2 SOL
  initialTokenAmount: 1_000_000_000n, // 1 billion tokens per account
  marketConfig: {
    rewardAmount: 1_000_000_000n, // 1 billion tokens
    timeToStake: 120n, // 2 minutes
    timeToReveal: 60n, // 1 minute
    unstakeDelaySeconds: 10n, // 10 seconds
  },
};

/**
 * Fetches the MXE public key from the chain with retry logic.
 */
async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: anchor.web3.PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(`Failed to fetch MXE public key after ${maxRetries} attempts`);
}

/**
 * Creates a test account with x25519 keypair for encryption.
 * Note: tokenAccount is set later after mint creation.
 */
async function createAccount(): Promise<Omit<Account, "initialAirdroppedLamports" | "tokenAccount">> {
  const keypair = await generateKeyPairSigner();

  // Generate x25519 keypair for encryption
  const x25519Keypair = generateX25519Keypair();

  return { keypair, x25519Keypair };
}

/**
 * Creates a test environment with participant accounts, airdrops, and a market.
 *
 * This function:
 * 1. Creates the specified number of participant accounts (default: 5)
 * 2. Creates a market creator account
 * 3. Airdrops SOL to all accounts in parallel
 * 4. Creates a market using the createMarket instruction
 *
 * Note: This does NOT initialize encrypted token accounts or open the market.
 * Those operations require MPC computation and should be done separately.
 */
export async function createTestEnvironment(
  provider: anchor.AnchorProvider,
  programId: Address,
  config: CreateTestEnvironmentConfig = {}
): Promise<TestEnvironment> {
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    marketConfig: { ...DEFAULT_CONFIG.marketConfig, ...config.marketConfig },
  };

  const { rpcUrl, wsUrl, numParticipants, airdropLamports, initialTokenAmount, marketConfig } = mergedConfig;

  // Initialize RPC clients
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const airdrop = airdropFactory({ rpc, rpcSubscriptions });
  const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  // Fetch MXE public key (requires web3.js PublicKey for @arcium-hq/client)
  const programIdLegacy = new PublicKey(programId);
  const mxePublicKey = await getMXEPublicKeyWithRetry(provider, programIdLegacy);

  // Create all accounts (participants + market creator)
  const accountPromises = Array.from({ length: numParticipants + 1 }, () =>
    createAccount()
  );
  const accounts = await Promise.all(accountPromises);

  // Split into participants and creator
  const participantAccounts = accounts.slice(0, numParticipants);
  const creatorAccountBase = accounts[numParticipants];

  // Airdrop to all accounts in parallel
  console.log(`\nAirdropping ${Number(airdropLamports) / 1_000_000_000} SOL to all accounts...`);
  const airdropPromises = accounts.map((account) =>
    airdrop({
      recipientAddress: account.keypair.address,
      lamports: lamports(airdropLamports),
      commitment: "confirmed",
    })
  );
  await Promise.all(airdropPromises);

  // Create SPL token mint (creator is mint authority)
  console.log("\nCreating SPL token mint...");
  const mint = await createTokenMint(
    rpc,
    sendAndConfirmTransaction,
    creatorAccountBase.keypair,
    creatorAccountBase.keypair.address
  );
  console.log(`  Mint created: ${mint.address}`);

  // Create ATAs and mint tokens for all accounts
  console.log("\nCreating ATAs and minting tokens...");
  const accountsWithTokens: Array<{
    keypair: KeyPairSigner;
    x25519Keypair: X25519Keypair;
    tokenAccount: Address;
  }> = [];

  for (const account of accounts) {
    const ata = await createAta(
      rpc,
      sendAndConfirmTransaction,
      creatorAccountBase.keypair,
      mint.address,
      account.keypair.address
    );
    await mintTokensTo(
      rpc,
      sendAndConfirmTransaction,
      creatorAccountBase.keypair,
      mint.address,
      ata,
      initialTokenAmount
    );
    accountsWithTokens.push({
      keypair: account.keypair,
      x25519Keypair: account.x25519Keypair,
      tokenAccount: ata,
    });
  }

  // Split into participants and creator with full Account type
  const participantsWithTokens = accountsWithTokens.slice(0, numParticipants);
  const creatorAccountWithTokens = accountsWithTokens[numParticipants];

  // Build the final account objects
  const participants: Account[] = participantsWithTokens.map((account) => ({
    ...account,
    initialAirdroppedLamports: airdropLamports,
  }));

  const creatorAccount: Account = {
    ...creatorAccountWithTokens,
    initialAirdroppedLamports: airdropLamports,
  };

  // Initialize central state
  const initCentralStateIx = await getInitCentralStateInstructionAsync({
    payer: creatorAccount.keypair,
    earlinessCutoffSeconds: 0n,
    minOptionDeposit: 1n,
    protocolFeeBp: 0,
    feeRecipient: creatorAccount.keypair.address,
    rewardWithdrawStakedLimit: 100,
  });

  const { value: csBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const csTxMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(creatorAccount.keypair.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(csBlockhash, msg),
    (msg) => appendTransactionMessageInstructions([initCentralStateIx], msg)
  );
  const csSignedTx = await signTransactionMessageWithSigners(csTxMessage);
  assertIsTransactionWithBlockhashLifetime(csSignedTx);
  await sendAndConfirmTransaction(csSignedTx, { commitment: "confirmed" });
  console.log("  Central state initialized");

  // Create the market
  const marketIndex = BigInt(Math.floor(Math.random() * 1000000));

  const createMarketIx = await createMarket({
    creator: creatorAccount.keypair,
    tokenMint: mint.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    marketIndex,
    rewardAmount: marketConfig.rewardAmount,
    timeToStake: marketConfig.timeToStake,
    timeToReveal: marketConfig.timeToReveal,
    marketAuthority: null,
    unstakeDelaySeconds: marketConfig.unstakeDelaySeconds,
    authorizedReaderPubkey: creatorAccount.x25519Keypair.publicKey,
    allowClosingEarly: true,
  });

  // Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();

  // Build transaction message
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(creatorAccount.keypair.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions([createMarketIx], msg)
  );

  // Sign the transaction
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

  // Simulate first to see any errors
  const base64Tx = getBase64EncodedWireTransaction(signedTransaction);
  const simResult = await rpc.simulateTransaction(base64Tx, {
    commitment: "confirmed",
    encoding: "base64",
  }).send();


  if (simResult.value.err) {
    console.log("  Simulation failed:");
    console.log("    Error:", simResult.value.err);
    console.log("    Logs:");
    simResult.value.logs?.forEach((log) => console.log("      ", log));
    throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
  }

  // Send and confirm transaction using Kit RPC
  assertIsTransactionWithBlockhashLifetime(signedTransaction);
  await sendAndConfirmTransaction(signedTransaction, { commitment: "confirmed" });
  // Get market address from the instruction accounts and fetch from chain
  const marketAddress = createMarketIx.accounts[3].address as Address;
  const marketAccount = await fetchOpportunityMarket(rpc, marketAddress, { commitment: "confirmed" });

  return {
    market: {
      ...marketAccount.data,
      address: marketAddress,
      creatorAccount,
      options: [], // Options need to be added separately via addMarketOption
      timeToReveal: marketConfig.timeToReveal,
    },
    participants,
    mxePublicKey,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    rpc,
    rpcSubscriptions,
  };
}

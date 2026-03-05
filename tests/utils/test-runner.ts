import {
  getArciumEnv,
  getMXEPublicKey,
  deserializeLE,
} from "@arcium-hq/client";
import {
  KeyPairSigner,
  Address,
  generateKeyPairSigner,
  airdropFactory,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  lamports,
  sendAndConfirmTransactionFactory,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  getTransferInstruction,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  createMarket,
  fetchOpportunityMarket,
  getClaimFeesInstructionAsync,
  randomComputationOffset,
  randomStateNonce,
  ensureCentralState,
  initEncryptedTokenAccount,
  initTokenVault,
  getTokenVaultAddress,
  wrapEncryptedTokens,
  addMarketOption,
  addMarketOptionAsCreator,
  initShareAccount,
  stake,
  selectWinningOptions as selectWinningOptionsIx,
  revealShares,
  incrementOptionTally,
  closeShareAccount,
  unstakeEarly as unstakeEarlyIx,
  doUnstakeEarly as doUnstakeEarlyIx,
  openMarket as openMarketIx,
  awaitComputationFinalization,
  type ComputationResult,
  getEncryptedTokenAccountAddress,
  getShareAccountAddress as getShareAccountAddressPda,
  fetchShareAccount,
  getOpportunityMarketOptionAddress,
  fetchOpportunityMarketOption,
  fetchEncryptedTokenAccount,
} from "../../js/src";
import { randomBytes } from "crypto";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { generateX25519Keypair, X25519Keypair, createCipher } from "../../js/src/x25519/keypair";
import { createTokenMint, createAta, mintTokensTo } from "./spl-token";
import { sendTransaction, type SendAndConfirmFn } from "./transaction";
import { nonceToBytes } from "./nonce";
import { getDeployerKeypair } from "./deployer";

// ============================================================================
// Types
// ============================================================================

export interface ShareAccountInfo {
  id: number;
  amount: bigint;
  optionIndex: number;
  encryptedState: Array<Array<number>>;
  stateNonce: bigint;
  encryptedStateDisclosure: Array<Array<number>>;
  stateNonceDisclosure: bigint;
}

interface TestUser {
  solanaKeypair: KeyPairSigner;
  x25519Keypair: X25519Keypair;
  tokenAccount: Address;
  encryptedTokenAccount?: Address;
  shareAccounts: ShareAccountInfo[];
}

interface MarketConfig {
  rewardAmount: bigint;
  timeToStake: bigint;
  timeToReveal: bigint;
  unstakeDelaySeconds: bigint;
  authorizedReaderPubkey: Uint8Array;
  allowClosingEarly: boolean;
}

export interface TestRunnerConfig {
  rpcUrl?: string;
  wsUrl?: string;
  numParticipants?: number;
  airdropLamports?: bigint;
  initialTokenAmount?: bigint;
  marketConfig?: Partial<MarketConfig>;
}

// Batch input types
export interface SharePurchase {
  userId: Address;
  amount: bigint;
  optionIndex: number;
}

export interface RevealRequest {
  userId: Address;
  shareAccountId: number;
}

export interface TallyIncrement {
  userId: Address;
  optionIndex: number;
  shareAccountId: number;
}

export interface CloseRequest {
  userId: Address;
  optionIndex: number;
  shareAccountId: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: Required<TestRunnerConfig> = {
  rpcUrl: "http://127.0.0.1:8899",
  wsUrl: "ws://127.0.0.1:8900",
  numParticipants: 2,
  airdropLamports: 2_000_000_000n, // 2 SOL
  initialTokenAmount: 1_000_000_000n, // 1 billion tokens per account
  marketConfig: {
    rewardAmount: 1_000_000_000n,
    timeToStake: 120n, // 2 minutes
    timeToReveal: 60n, // 1 minute
    unstakeDelaySeconds: 10n, // 10 seconds
    allowClosingEarly: true, // Allow market to be closed before stake period ends
  },
};

// ============================================================================
// Helper: getMXEPublicKeyWithRetry (kept as-is per requirements)
// ============================================================================

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
        console.log(`MXE public key: ${Buffer.from(mxePublicKey).toString("hex")}`);
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

// ============================================================================
// TestRunner Class
// ============================================================================

export class TestRunner {
  // Infrastructure
  private rpc: Rpc<SolanaRpcApi>;
  private rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
  private sendAndConfirm: SendAndConfirmFn;

  // Arcium
  private arciumEnv: ReturnType<typeof getArciumEnv>;
  private mxePublicKey: Uint8Array;
  private programId: Address;

  // Market
  private mint: KeyPairSigner;
  private marketAddress: Address;
  private marketCreator: TestUser;
  private marketConfig: MarketConfig;
  private optionCount: number;
  private openTimestamp: bigint | null = null;

  // Users: Map<address string, TestUser>
  private users: Map<string, TestUser>;

  private constructor() {
    // Private constructor - use static initialize()
    this.users = new Map();
    this.optionCount = 0;
  }

  // ============================================================================
  // Static Initializer
  // ============================================================================

  static async initialize(
    provider: anchor.AnchorProvider,
    programId: Address,
    config: TestRunnerConfig = {}
  ): Promise<TestRunner> {
    const runner = new TestRunner();

    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      marketConfig: { ...DEFAULT_CONFIG.marketConfig, ...config.marketConfig },
    };

    const { rpcUrl, wsUrl, numParticipants, airdropLamports, initialTokenAmount, marketConfig } = mergedConfig;

    // Store config
    runner.marketConfig = marketConfig as MarketConfig;
    runner.programId = programId;
    runner.arciumEnv = getArciumEnv();

    // Initialize RPC clients
    runner.rpc = createSolanaRpc(rpcUrl) as unknown as Rpc<SolanaRpcApi>;
    runner.rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    // Cast to any for airdropFactory since it has complex cluster-based typing
    const airdrop = airdropFactory({ rpc: runner.rpc, rpcSubscriptions: runner.rpcSubscriptions } as any);
    runner.sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: runner.rpc,
      rpcSubscriptions: runner.rpcSubscriptions,
    });

    // Fetch MXE public key (requires web3.js PublicKey for @arcium-hq/client)
    const programIdLegacy = new PublicKey(programId);
    runner.mxePublicKey = await getMXEPublicKeyWithRetry(provider, programIdLegacy);

    // Create all accounts (participants + market creator)
    console.log(`\nCreating ${numParticipants + 1} accounts...`);
    const accountPromises = Array.from({ length: numParticipants + 1 }, async () => {
      const keypair = await generateKeyPairSigner();
      const x25519Keypair = generateX25519Keypair();
      return { keypair, x25519Keypair };
    });
    const accounts = await Promise.all(accountPromises);

    // Split into participants and creator
    const participantAccounts = accounts.slice(0, numParticipants);
    const creatorAccountBase = accounts[numParticipants];

    // Airdrop to all accounts in parallel
    console.log(`Airdropping ${Number(airdropLamports) / 1_000_000_000} SOL to all accounts...`);
    const airdropPromises = accounts.map((account) =>
      airdrop({
        recipientAddress: account.keypair.address,
        lamports: lamports(airdropLamports),
        commitment: "confirmed",
      })
    );
    await Promise.all(airdropPromises);

    // Initialize or update central state (use stable deployer key as authority)
    const deployer = await getDeployerKeypair();
    const centralStateIx = await ensureCentralState(runner.rpc, {
      signer: deployer,
      earlinessCutoffSeconds: 0n,
      minOptionDeposit: 1n,
      protocolFeeBp: 100,
      feeRecipient: creatorAccountBase.keypair.address,
    });
    if (centralStateIx) {
      await sendTransaction(runner.rpc, runner.sendAndConfirm, deployer, [centralStateIx], {
        label: "Ensure central state",
      });
    }

    // Create SPL token mint (creator is mint authority)
    console.log("Creating SPL token mint...");
    runner.mint = await createTokenMint(
      runner.rpc,
      runner.sendAndConfirm,
      creatorAccountBase.keypair,
      creatorAccountBase.keypair.address
    );
    console.log(`  Mint created: ${runner.mint.address}`);

    // Initialize token vault (if not already initialized)
    const [tokenVaultAddress] = await getTokenVaultAddress(runner.mint.address, programId);
    const tokenVaultAccount = await runner.rpc.getAccountInfo(tokenVaultAddress).send();
    if (!tokenVaultAccount.value) {
      console.log("Initializing token vault...");
      const initVaultIx = await initTokenVault({
        payer: creatorAccountBase.keypair,
        tokenMint: runner.mint.address,
        fundManager: creatorAccountBase.keypair.address,
      });
      await sendTransaction(runner.rpc, runner.sendAndConfirm, creatorAccountBase.keypair, [initVaultIx], {
        label: "Init token vault",
      });
      console.log(`  Token vault created: ${tokenVaultAddress}`);
    } else {
      console.log("Token vault already exists, skipping initialization...");
    }

    // Create token vault ATA for this mint
    console.log("Creating token vault ATA...");
    await createAta(
      runner.rpc,
      runner.sendAndConfirm,
      creatorAccountBase.keypair,
      runner.mint.address,
      tokenVaultAddress
    );

    // Create ATAs and mint tokens for all accounts
    console.log("Creating ATAs and minting tokens...");
    const accountsWithTokens: Array<{
      keypair: KeyPairSigner;
      x25519Keypair: X25519Keypair;
      tokenAccount: Address;
    }> = [];

    for (const account of accounts) {
      const ata = await createAta(
        runner.rpc,
        runner.sendAndConfirm,
        creatorAccountBase.keypair,
        runner.mint.address,
        account.keypair.address
      );
      await mintTokensTo(
        runner.rpc,
        runner.sendAndConfirm,
        creatorAccountBase.keypair,
        runner.mint.address,
        ata,
        initialTokenAmount
      );
      accountsWithTokens.push({
        keypair: account.keypair,
        x25519Keypair: account.x25519Keypair,
        tokenAccount: ata,
      });
    }

    // Build TestUser objects and populate the map
    for (let i = 0; i < numParticipants; i++) {
      const acc = accountsWithTokens[i];
      const user: TestUser = {
        solanaKeypair: acc.keypair,
        x25519Keypair: acc.x25519Keypair,
        tokenAccount: acc.tokenAccount,
        shareAccounts: [],
      };
      runner.users.set(acc.keypair.address.toString(), user);
    }

    // Market creator
    const creatorAcc = accountsWithTokens[numParticipants];
    runner.marketCreator = {
      solanaKeypair: creatorAcc.keypair,
      x25519Keypair: creatorAcc.x25519Keypair,
      tokenAccount: creatorAcc.tokenAccount,
      shareAccounts: [],
    };
    // Also add creator to users map so they can be looked up
    runner.users.set(creatorAcc.keypair.address.toString(), runner.marketCreator);

    // Create the market
    console.log("Creating market...");
    const marketIndex = BigInt(Math.floor(Math.random() * 1000000));

    const createMarketIx = await createMarket({
      creator: runner.marketCreator.solanaKeypair,
      tokenMint: runner.mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      marketIndex,
      rewardAmount: marketConfig.rewardAmount,
      timeToStake: marketConfig.timeToStake,
      timeToReveal: marketConfig.timeToReveal,
      marketAuthority: null,
      unstakeDelaySeconds: marketConfig.unstakeDelaySeconds,
      authorizedReaderPubkey: marketConfig.authorizedReaderPubkey,
      allowClosingEarly: marketConfig.allowClosingEarly,
    });

    await sendTransaction(runner.rpc, runner.sendAndConfirm, runner.marketCreator.solanaKeypair, [createMarketIx], {
      label: "Create market",
    });

    // Get market address from the instruction accounts
    runner.marketAddress = createMarketIx.accounts[3].address as Address;
    console.log(`  Market created: ${runner.marketAddress}`);

    return runner;
  }

  // ============================================================================
  // Accessors
  // ============================================================================

  get participants(): Address[] {
    return Array.from(this.users.keys())
      .filter((k) => k !== this.marketCreator.solanaKeypair.address.toString())
      .map((k) => this.users.get(k)!.solanaKeypair.address);
  }

  get creator(): Address {
    return this.marketCreator.solanaKeypair.address;
  }

  get market(): Address {
    return this.marketAddress;
  }

  get mintAddress(): Address {
    return this.mint.address;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private getUser(userId: Address): TestUser {
    const user = this.users.get(userId.toString());
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    return user;
  }

  private getArciumConfig(computationOffset: bigint) {
    return {
      clusterOffset: this.arciumEnv.arciumClusterOffset,
      computationOffset,
      programId: this.programId,
    };
  }

  private getNextShareAccountId(user: TestUser): number {
    return user.shareAccounts.length;
  }

  private addShareAccount(user: TestUser, info: ShareAccountInfo): void {
    user.shareAccounts.push(info);
  }

  private assertEtaInitialized(user: TestUser): void {
    if (!user.encryptedTokenAccount) {
      throw new Error(
        `ETA not initialized for user ${user.solanaKeypair.address}. Call initEncryptedTokenAccount first.`
      );
    }
  }

  private assertComputationSucceeded(result: ComputationResult, operation: string): void {
    if (result.error) {
      throw new Error(`${operation} computation callback failed: ${result.error}`);
    }
  }

  // ============================================================================
  // Market Operations
  // ============================================================================

  async fundMarket(amount?: bigint): Promise<void> {
    const fundingAmount = amount ?? this.marketConfig.rewardAmount;

    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = getTransferInstruction({
      source: this.marketCreator.tokenAccount,
      destination: marketAta,
      authority: this.marketCreator.solanaKeypair,
      amount: fundingAmount,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Fund market",
    });
  }

  async openMarket(openTimestampArg?: bigint): Promise<bigint> {
    const timestamp = openTimestampArg ?? BigInt(Math.floor(Date.now() / 1000) + 6);

    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const ix = openMarketIx({
      creator: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      marketTokenAta: marketAta,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      openTimestamp: timestamp,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Open market",
    });

    this.openTimestamp = timestamp;
    return timestamp;
  }

  async selectWinningOptions(selections: Array<{ optionIndex: number; rewardPercentage: number }>): Promise<void> {
    const ix = selectWinningOptionsIx({
      authority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      selections,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Select winning options",
    });
  }

  async selectSingleWinningOption(optionIndex: number): Promise<void> {
    await this.selectWinningOptions([{ optionIndex, rewardPercentage: 100 }]);
  }

  // ============================================================================
  // ETA Operations
  // ============================================================================

  async initEncryptedTokenAccount(userId: Address): Promise<Address> {
    const user = this.getUser(userId);

    const ix = await initEncryptedTokenAccount({
      signer: user.solanaKeypair,
      tokenMint: this.mint.address,
      userPubkey: user.x25519Keypair.publicKey,
      stateNonce: randomStateNonce(),
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: `Init ETA for ${userId.toString().slice(0, 8)}...`,
    });

    const [etaAddress] = await getEncryptedTokenAccountAddress(this.mint.address, userId);
    user.encryptedTokenAccount = etaAddress;
    return etaAddress;
  }

  async wrapEncryptedTokens(userId: Address, amount: bigint): Promise<void> {
    const user = this.getUser(userId);
    this.assertEtaInitialized(user);
    const offset = randomComputationOffset();

    const ix = await wrapEncryptedTokens(
      {
        signer: user.solanaKeypair,
        tokenMint: this.mint.address,
        encryptedTokenAccount: user.encryptedTokenAccount!,
        signerTokenAccount: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount,
      },
      this.getArciumConfig(offset)
    );

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: `Wrap ${amount} encrypted tokens`,
    });

    const result = await awaitComputationFinalization(this.rpc, offset);
    this.assertComputationSucceeded(result, "wrapEncryptedTokens");
  }

  // ============================================================================
  // Option Management
  // ============================================================================

  /**
   * Add a market option as the market creator.
   * Simple instruction with no MPC computation and no stake required.
   */
  async addOptionAsCreator(name: string): Promise<{ optionIndex: number }> {
    const optionIndex = ++this.optionCount;

    const addOptionIx = await addMarketOptionAsCreator({
      creator: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      optionIndex,
      name,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [addOptionIx], {
      label: `Add option "${name}" (as creator)`,
    });

    return { optionIndex };
  }

  /**
   * Add a market option as a regular user with an initial stake.
   * Uses MPC computation and creates a share account.
   */
  async addMarketOption(
    userId: Address,
    name: string,
    depositAmount: bigint
  ): Promise<{ optionIndex: number; shareAccountId: number }> {
    const user = this.getUser(userId);
    this.assertEtaInitialized(user);

    const optionIndex = ++this.optionCount;
    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const shareAccountId = this.getNextShareAccountId(user);
    const shareAccountNonce = deserializeLE(randomBytes(16));

    // Get share account address first
    const [shareAccountAddress] = await getShareAccountAddressPda(userId, this.marketAddress, shareAccountId);

    // Init share account instruction
    const initIx = await initShareAccount({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      stateNonce: shareAccountNonce,
      shareAccountId,
    });

    const inputNonce = randomBytes(16);
    const amountCiphertext = cipher.encrypt([depositAmount], inputNonce);
    const offset = randomComputationOffset();

    // Add market option instruction
    const addOptionIx = await addMarketOption(
      {
        creator: user.solanaKeypair,
        market: this.marketAddress,
        sourceEta: user.encryptedTokenAccount!,
        shareAccount: shareAccountAddress,
        optionIndex,
        shareAccountId,
        name,
        amountCiphertext: amountCiphertext[0],
        inputNonce: deserializeLE(inputNonce),
        authorizedReaderNonce: deserializeLE(randomBytes(16)),
      },
      this.getArciumConfig(offset)
    );

    // Send both instructions in one transaction
    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx, addOptionIx], {
      label: `Add option "${name}"`,
    });

    const result = await awaitComputationFinalization(this.rpc, offset);
    this.assertComputationSucceeded(result, `addMarketOption("${name}")`);

    // Fetch the share account to get the encrypted state
    const shareAccountData = await fetchShareAccount(this.rpc, shareAccountAddress);

    // Store share account info with encrypted state
    this.addShareAccount(user, {
      id: shareAccountId,
      amount: depositAmount,
      optionIndex,
      encryptedState: shareAccountData.data.encryptedState,
      stateNonce: shareAccountData.data.stateNonce,
      encryptedStateDisclosure: shareAccountData.data.encryptedStateDisclosure,
      stateNonceDisclosure: shareAccountData.data.stateNonceDisclosure,
    });

    return { optionIndex, shareAccountId };
  }

  // ============================================================================
  // Share Operations - Batch First
  // ============================================================================

  async stakeOnOptionBatch(
    purchases: SharePurchase[]
  ): Promise<number[]> {
    // Group purchases by user to handle ETA locking correctly
    // Each stake locks the ETA until callback completes, so same-user stakes must be sequential
    const purchasesByUser = new Map<string, { purchase: SharePurchase; originalIndex: number }[]>();
    for (let i = 0; i < purchases.length; i++) {
      const p = purchases[i];
      const key = p.userId.toString();
      if (!purchasesByUser.has(key)) {
        purchasesByUser.set(key, []);
      }
      purchasesByUser.get(key)!.push({ purchase: p, originalIndex: i });
    }

    // Results array to maintain original order
    const results: { shareAccountId: number; originalIndex: number }[] = [];

    // Process users in parallel, but each user's purchases sequentially
    await Promise.all(
      Array.from(purchasesByUser.entries()).map(async ([_userId, userPurchases]) => {
        for (const { purchase: p, originalIndex } of userPurchases) {
          const user = this.getUser(p.userId);
          this.assertEtaInitialized(user);

          const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
          const shareAccountId = this.getNextShareAccountId(user);

          // Init share account
          const initIx = await initShareAccount({
            signer: user.solanaKeypair,
            market: this.marketAddress,
            stateNonce: deserializeLE(randomBytes(16)),
            shareAccountId,
          });

          await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
            label: `Init share account`,
          });

          // Stake instruction
          const inputNonce = randomBytes(16);
          const ciphertexts = cipher.encrypt([p.amount, BigInt(p.optionIndex)], inputNonce);
          const computationOffset = randomComputationOffset();

          const [userEta] = await getEncryptedTokenAccountAddress(this.mint.address, p.userId);

          const stakeIx = await stake(
            {
              signer: user.solanaKeypair,
              market: this.marketAddress,
              userEta,
              shareAccountId,
              amountCiphertext: ciphertexts[0],
              selectedOptionCiphertext: ciphertexts[1],
              inputNonce: deserializeLE(inputNonce),
              authorizedReaderNonce: deserializeLE(randomBytes(16)),
            },
            this.getArciumConfig(computationOffset)
          );

          await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [stakeIx], {
            label: `Stake on option`,
          });

          // Wait for this computation to finalize before next stake for this user
          // This ensures the ETA is unlocked by the callback
          const result = await awaitComputationFinalization(this.rpc, computationOffset);
          this.assertComputationSucceeded(result, "stakeOnOption");

          // Fetch the share account to get the encrypted state
          const [shareAccountAddress] = await getShareAccountAddressPda(p.userId, this.marketAddress, shareAccountId);
          const shareAccountData = await fetchShareAccount(this.rpc, shareAccountAddress);

          // Store share account info with encrypted state
          this.addShareAccount(user, {
            id: shareAccountId,
            amount: p.amount,
            optionIndex: p.optionIndex,
            encryptedState: shareAccountData.data.encryptedState,
            stateNonce: shareAccountData.data.stateNonce,
            encryptedStateDisclosure: shareAccountData.data.encryptedStateDisclosure,
            stateNonceDisclosure: shareAccountData.data.stateNonceDisclosure,
          });

          results.push({ shareAccountId, originalIndex });
        }
      })
    );

    // Sort by original index to maintain input order
    results.sort((a, b) => a.originalIndex - b.originalIndex);
    return results.map((r) => r.shareAccountId);
  }

  async stakeOnOption(
    userId: Address,
    amount: bigint,
    optionIndex: number
  ): Promise<number> {
    const [shareAccountId] = await this.stakeOnOptionBatch([{ userId, amount, optionIndex }]);
    return shareAccountId;
  }

  async revealSharesBatch(reveals: RevealRequest[]): Promise<void> {
    // Group reveals by user to handle ETA locking correctly
    // Each reveal locks the ETA until callback completes, so same-user reveals must be sequential
    const revealsByUser = new Map<string, RevealRequest[]>();
    for (const r of reveals) {
      const key = r.userId.toString();
      if (!revealsByUser.has(key)) {
        revealsByUser.set(key, []);
      }
      revealsByUser.get(key)!.push(r);
    }

    // Process users in parallel, but each user's reveals sequentially
    await Promise.all(
      Array.from(revealsByUser.entries()).map(async ([_userId, userReveals]) => {
        for (const r of userReveals) {
          const user = this.getUser(r.userId);
          const computationOffset = randomComputationOffset();
          const [userEta] = await getEncryptedTokenAccountAddress(this.mint.address, r.userId);

          const ix = await revealShares(
            {
              signer: user.solanaKeypair,
              owner: user.solanaKeypair.address,
              market: this.marketAddress,
              userEta,
              shareAccountId: r.shareAccountId,
            },
            this.getArciumConfig(computationOffset)
          );

          await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
            label: `Reveal shares`,
          });

          // Wait for this computation to finalize before next reveal for this user
          // This ensures the ETA is unlocked by the callback
          const result = await awaitComputationFinalization(this.rpc, computationOffset);
          this.assertComputationSucceeded(result, "revealShares");
        }
      })
    );
  }

  async revealShares(userId: Address, shareAccountId: number): Promise<void> {
    await this.revealSharesBatch([{ userId, shareAccountId }]);
  }

  async unstakeEarly(userId: Address, shareAccountId: number): Promise<void> {
    const user = this.getUser(userId);

    const ix = await unstakeEarlyIx({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      shareAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: `Unstake early (initiate)`,
    });
  }

  async doUnstakeEarly(
    executorId: Address,
    shareOwnerId: Address,
    shareAccountId: number
  ): Promise<void> {
    const executor = this.getUser(executorId);
    const owner = this.getUser(shareOwnerId);
    this.assertEtaInitialized(owner);

    const computationOffset = randomComputationOffset();
    const [userEta] = await getEncryptedTokenAccountAddress(this.mint.address, shareOwnerId);

    const ix = await doUnstakeEarlyIx(
      {
        signer: executor.solanaKeypair,
        market: this.marketAddress,
        userEta,
        shareAccountId,
        shareAccountOwner: shareOwnerId,
      },
      this.getArciumConfig(computationOffset)
    );

    await sendTransaction(this.rpc, this.sendAndConfirm, executor.solanaKeypair, [ix], {
      label: `Do unstake early (execute)`,
    });

    const result = await awaitComputationFinalization(this.rpc, computationOffset);
    this.assertComputationSucceeded(result, "doUnstakeEarly");
  }

  async incrementOptionTallyBatch(increments: TallyIncrement[]): Promise<void> {
    const instructions = await Promise.all(
      increments.map(async (inc) => {
        const user = this.getUser(inc.userId);
        const ix = await incrementOptionTally({
          signer: user.solanaKeypair,
          owner: user.solanaKeypair.address,
          market: this.marketAddress,
          optionIndex: inc.optionIndex,
          shareAccountId: inc.shareAccountId,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Increment tally`,
      });
    }
  }

  async incrementOptionTally(userId: Address, optionIndex: number, shareAccountId: number): Promise<void> {
    await this.incrementOptionTallyBatch([{ userId, optionIndex, shareAccountId }]);
  }

  async closeShareAccountBatch(closes: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const user = this.getUser(close.userId);
        const ix = await closeShareAccount({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          optionIndex: close.optionIndex,
          shareAccountId: close.shareAccountId,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Close share account`,
      });
    }
  }

  async closeShareAccount(userId: Address, optionIndex: number, shareAccountId: number): Promise<void> {
    await this.closeShareAccountBatch([{ userId, optionIndex, shareAccountId }]);
  }

  // ============================================================================
  // Fee Operations
  // ============================================================================

  async claimFees(): Promise<void> {
    const ix = await getClaimFeesInstructionAsync({
      signer: this.marketCreator.solanaKeypair,
      tokenMint: this.mint.address,
      feeRecipientTokenAccount: this.marketCreator.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Claim fees",
    });
  }

  // ============================================================================
  // Utility Methods for Tests
  // ============================================================================

  /** Get the RPC client for assertions */
  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  /** Fetch the market account */
  async fetchMarket() {
    return fetchOpportunityMarket(this.rpc, this.marketAddress);
  }

  /** Get the MXE public key for encryption */
  getMxePublicKey(): Uint8Array {
    return this.mxePublicKey;
  }

  /** Get a user's x25519 keypair for encryption operations in tests */
  getUserX25519Keypair(userId: Address): X25519Keypair {
    return this.getUser(userId).x25519Keypair;
  }

  /** Get a user's token account address */
  getUserTokenAccount(userId: Address): Address {
    return this.getUser(userId).tokenAccount;
  }

  /** Get a user's share accounts info (id, amount, optionIndex for each) */
  getUserShareAccounts(userId: Address): ShareAccountInfo[] {
    return this.getUser(userId).shareAccounts;
  }

  /** Get share accounts for a user filtered by option index */
  getUserShareAccountsForOption(userId: Address, optionIndex: number): ShareAccountInfo[] {
    return this.getUser(userId).shareAccounts.filter((sa) => sa.optionIndex === optionIndex);
  }

  /** Get a specific share account by ID */
  getShareAccountInfo(userId: Address, shareAccountId: number): ShareAccountInfo {
    const user = this.getUser(userId);
    const shareAccount = user.shareAccounts.find((sa) => sa.id === shareAccountId);
    if (!shareAccount) {
      throw new Error(`Share account ${shareAccountId} not found for user ${userId}`);
    }
    return shareAccount;
  }

  /**
   * Decrypt the stake amount and option from a share account.
   * Uses the user's x25519 keypair and MXE public key to derive the cipher.
   * @returns { amount: bigint, optionIndex: bigint }
   */
  decryptStakeAmount(userId: Address, shareAccountId: number): { amount: bigint; optionIndex: bigint } {
    const user = this.getUser(userId);
    const shareAccount = this.getShareAccountInfo(userId, shareAccountId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(shareAccount.stateNonce);
    const decrypted = cipher.decrypt(shareAccount.encryptedState, nonceBytes);

    return {
      amount: decrypted[0],
      optionIndex: decrypted[1],
    };
  }

  /**
   * Decrypt the disclosed stake amount and option from a share account.
   * Uses the provided x25519 keypair (the authorized reader) and MXE public key to derive the cipher.
   * @param userId - The owner of the share account
   * @param shareAccountId - The share account ID
   * @param readerKeypair - The x25519 keypair of the authorized reader
   * @returns { amount: bigint, optionIndex: bigint }
   */
  decryptDisclosedStakeAmount(
    userId: Address,
    shareAccountId: number,
    readerKeypair: X25519Keypair
  ): { amount: bigint; optionIndex: bigint } {
    const shareAccount = this.getShareAccountInfo(userId, shareAccountId);

    const cipher = createCipher(readerKeypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(shareAccount.stateNonceDisclosure);
    const decrypted = cipher.decrypt(shareAccount.encryptedStateDisclosure, nonceBytes);

    return {
      amount: decrypted[0],
      optionIndex: decrypted[1],
    };
  }

  /**
   * Decrypt the user's encrypted token account balance.
   */
  async decryptEtaBalance(userId: Address): Promise<bigint> {
    const user = this.getUser(userId);
    this.assertEtaInitialized(user);

    const [etaAddress] = await getEncryptedTokenAccountAddress(this.mint.address, userId);
    const eta = await fetchEncryptedTokenAccount(this.rpc, etaAddress);
    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(eta.data.stateNonce);
    const decrypted = cipher.decrypt(eta.data.encryptedState, nonceBytes);
    return decrypted[0];
  }

  /** Get the open timestamp (set after openMarket is called) */
  getOpenTimestamp(): bigint {
    if (this.openTimestamp === null) {
      throw new Error("Market not opened yet. Call openMarket() first.");
    }
    return this.openTimestamp;
  }

  /** Get timeToStake from market config */
  getTimeToStake(): bigint {
    return this.marketConfig.timeToStake;
  }

  /** Get timeToReveal from market config */
  getTimeToReveal(): bigint {
    return this.marketConfig.timeToReveal;
  }

  /** Get rewardAmount from market config */
  getRewardAmount(): bigint {
    return this.marketConfig.rewardAmount;
  }

  /** Get unstakeDelaySeconds from market config */
  getUnstakeDelaySeconds(): bigint {
    return this.marketConfig.unstakeDelaySeconds;
  }

  /** Get market's token ATA address */
  async getMarketAta(): Promise<Address> {
    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return marketAta;
  }

  /** Get share account PDA address for a user */
  async getShareAccountAddress(userId: Address, shareAccountId: number): Promise<Address> {
    const [address] = await getShareAccountAddressPda(userId, this.marketAddress, shareAccountId);
    return address;
  }

  /** Fetch a share account */
  async fetchShareAccountData(userId: Address, shareAccountId: number) {
    const address = await this.getShareAccountAddress(userId, shareAccountId);
    return fetchShareAccount(this.rpc, address);
  }

  /** Get option PDA address */
  async getOptionAddress(optionIndex: number): Promise<Address> {
    const [address] = await getOpportunityMarketOptionAddress(this.marketAddress, optionIndex);
    return address;
  }

  /** Fetch an option account */
  async fetchOptionData(optionIndex: number) {
    const address = await this.getOptionAddress(optionIndex);
    return fetchOpportunityMarketOption(this.rpc, address);
  }

  /** Check if an account exists (for verifying closure) */
  async accountExists(address: Address): Promise<boolean> {
    const info = await this.rpc.getAccountInfo(address).send();
    return info.value !== null;
  }
}

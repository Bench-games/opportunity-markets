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
  initTokenVault,
  getTokenVaultAddress,
  addMarketOption,
  initStakeAccount,
  stake,
  selectWinningOptions as selectWinningOptionsIx,
  revealStake,
  incrementOptionTally,
  closeStakeAccount,
  closeStuckStakeAccount as closeStuckStakeAccountIx,
  reclaimStake as reclaimStakeIx,
  unstakeEarly as unstakeEarlyIx,
  doUnstakeEarly as doUnstakeEarlyIx,
  openMarket as openMarketIx,
  addReward as addRewardIx,
  withdrawReward as withdrawRewardIx,
  endRevealPeriod as endRevealPeriodIx,
  awaitComputationFinalization,
  type ComputationResult,
  getStakeAccountAddress as getStakeAccountAddressPda,
  fetchStakeAccount,
  getOpportunityMarketOptionAddress,
  fetchOpportunityMarketOption,
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

export interface StakeAccountInfo {
  id: number;
  amount: bigint;
  optionId: number;
  encryptedOption: Array<number>;
  stateNonce: bigint;
  encryptedOptionDisclosure: Array<number>;
  stateNonceDisclosure: bigint;
}

interface TestUser {
  solanaKeypair: KeyPairSigner;
  x25519Keypair: X25519Keypair;
  tokenAccount: Address;
  stakeAccounts: StakeAccountInfo[];
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
export interface StakePurchase {
  userId: Address;
  amount: bigint;
  optionId: number;
}

export interface RevealRequest {
  userId: Address;
  stakeAccountId: number;
}

export interface TallyIncrement {
  userId: Address;
  optionId: number;
  stakeAccountId: number;
}

export interface CloseRequest {
  userId: Address;
  optionId: number;
  stakeAccountId: number;
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
  private usedOptionIds: Set<number>;
  private openTimestamp: bigint | null = null;

  // Users: Map<address string, TestUser>
  private users: Map<string, TestUser>;

  private constructor() {
    // Private constructor - use static initialize()
    this.users = new Map();
    this.usedOptionIds = new Set();
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
      protocolFeeBp: 100,
      feeRecipient: creatorAccountBase.keypair.address,
      minimumInitialRevealPeriod: 0n,
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
        stakeAccounts: [],
      };
      runner.users.set(acc.keypair.address.toString(), user);
    }

    // Market creator
    const creatorAcc = accountsWithTokens[numParticipants];
    runner.marketCreator = {
      solanaKeypair: creatorAcc.keypair,
      x25519Keypair: creatorAcc.x25519Keypair,
      tokenAccount: creatorAcc.tokenAccount,
      stakeAccounts: [],
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
      timeToStake: marketConfig.timeToStake,
      timeToReveal: marketConfig.timeToReveal,
      marketAuthority: null,
      unstakeDelaySeconds: marketConfig.unstakeDelaySeconds,
      authorizedReaderPubkey: marketConfig.authorizedReaderPubkey,
      allowClosingEarly: marketConfig.allowClosingEarly,
      revealPeriodAuthority: runner.marketCreator.solanaKeypair.address,
    });

    await sendTransaction(runner.rpc, runner.sendAndConfirm, runner.marketCreator.solanaKeypair, [createMarketIx], {
      label: "Create market",
    });

    // Get market address from the instruction accounts
    runner.marketAddress = createMarketIx.accounts[3].address as Address;
    console.log(`  Market created: ${runner.marketAddress}`);

    // Add initial reward from creator if configured
    if (marketConfig.rewardAmount > 0n) {
      await runner.addReward(runner.marketCreator.solanaKeypair.address, marketConfig.rewardAmount, true);
      console.log(`  Creator added reward: ${marketConfig.rewardAmount}`);
    }

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

  private getNextStakeAccountId(user: TestUser): number {
    return user.stakeAccounts.length;
  }

  private addStakeAccount(user: TestUser, info: StakeAccountInfo): void {
    user.stakeAccounts.push(info);
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

    const ix = openMarketIx({
      creator: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      openTimestamp: timestamp,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Open market",
    });

    this.openTimestamp = timestamp;
    return timestamp;
  }

  async selectWinningOptions(selections: Array<{ optionId: number; rewardPercentage: number }>): Promise<void> {
    const ix = selectWinningOptionsIx({
      authority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      selections,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Select winning options",
    });
  }

  async selectSingleWinningOption(optionId: number): Promise<void> {
    await this.selectWinningOptions([{ optionId, rewardPercentage: 100 }]);
  }

  async addReward(userId: Address, amount: bigint, lock: boolean = false): Promise<void> {
    const user = this.getUser(userId);

    const ix = await addRewardIx({
      sponsor: user.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      sponsorTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount,
      lock,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: "Add reward",
    });
  }

  async withdrawReward(userId?: Address, refundTokenAccount?: Address): Promise<void> {
    const sponsorId = userId ?? this.marketCreator.solanaKeypair.address;
    const user = this.getUser(sponsorId);
    const refund = refundTokenAccount ?? user.tokenAccount;

    const ix = await withdrawRewardIx({
      sponsor: user.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      refundTokenAccount: refund,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: "Withdraw reward",
    });
  }

  async endRevealPeriod(): Promise<void> {
    const ix = endRevealPeriodIx({
      authority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "End reveal period",
    });
  }

  // ============================================================================
  // Option Management
  // ============================================================================

  async addOption(): Promise<{ optionId: number }> {
    let optionId: number;
    do {
      optionId = Math.floor(Math.random() * 1_000_000_000) + 1;
    } while (this.usedOptionIds.has(optionId));
    this.usedOptionIds.add(optionId);

    const addOptionIx = await addMarketOption({
      creator: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      optionId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [addOptionIx], {
      label: `Add option ${optionId}`,
    });

    return { optionId };
  }

  // ============================================================================
  // Stake Operations
  // ============================================================================

  async stakeOnOptionBatch(
    purchases: StakePurchase[]
  ): Promise<number[]> {
    const purchasesByUser = new Map<string, { purchase: StakePurchase; originalIndex: number }[]>();
    for (let i = 0; i < purchases.length; i++) {
      const p = purchases[i];
      const key = p.userId.toString();
      if (!purchasesByUser.has(key)) {
        purchasesByUser.set(key, []);
      }
      purchasesByUser.get(key)!.push({ purchase: p, originalIndex: i });
    }

    const results: { stakeAccountId: number; originalIndex: number }[] = [];

    await Promise.all(
      Array.from(purchasesByUser.entries()).map(async ([_userId, userPurchases]) => {
        for (const { purchase: p, originalIndex } of userPurchases) {
          const user = this.getUser(p.userId);

          const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
          const stakeAccountId = this.getNextStakeAccountId(user);
          const stakeAccountNonce = deserializeLE(randomBytes(16));

          // Init stake account
          const initIx = await initStakeAccount({
            signer: user.solanaKeypair,
            market: this.marketAddress,
            stateNonce: stakeAccountNonce,
            stakeAccountId,
          });

          await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
            label: `Init stake account`,
          });

          // Build stake instruction
          const inputNonce = randomBytes(16);
          const optionCiphertext = cipher.encrypt([BigInt(p.optionId)], inputNonce);
          const computationOffset = randomComputationOffset();

          const [tokenVaultAddress] = await getTokenVaultAddress(this.mint.address, this.programId);
          const [marketAta] = await findAssociatedTokenPda({
            mint: this.mint.address,
            owner: this.marketAddress,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          });
          const [tokenVaultAta] = await findAssociatedTokenPda({
            mint: this.mint.address,
            owner: tokenVaultAddress,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          });

          const stakeIx = await stake(
            {
              signer: user.solanaKeypair,
              payer: user.solanaKeypair,
              market: this.marketAddress,
              stakeAccountId,
              tokenMint: this.mint.address,
              signerTokenAccount: user.tokenAccount,
              marketTokenAta: marketAta,
              tokenVault: tokenVaultAddress,
              tokenVaultAta,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
              amount: p.amount,
              selectedOptionCiphertext: optionCiphertext[0],
              inputNonce: deserializeLE(inputNonce),
              authorizedReaderNonce: deserializeLE(randomBytes(16)),
              userPubkey: user.x25519Keypair.publicKey,
            },
            this.getArciumConfig(computationOffset)
          );

          await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [stakeIx], {
            label: `Stake on option`,
          });

          const result = await awaitComputationFinalization(this.rpc, computationOffset);
          this.assertComputationSucceeded(result, "stakeOnOption");

          // Fetch the stake account to get the encrypted state
          const [stakeAccountAddress] = await getStakeAccountAddressPda(p.userId, this.marketAddress, stakeAccountId);
          const stakeAccountData = await fetchStakeAccount(this.rpc, stakeAccountAddress);

          this.addStakeAccount(user, {
            id: stakeAccountId,
            amount: p.amount,
            optionId: p.optionId,
            encryptedOption: stakeAccountData.data.encryptedOption,
            stateNonce: stakeAccountData.data.stateNonce,
            encryptedOptionDisclosure: stakeAccountData.data.encryptedOptionDisclosure,
            stateNonceDisclosure: stakeAccountData.data.stateNonceDisclosure,
          });

          results.push({ stakeAccountId, originalIndex });
        }
      })
    );

    results.sort((a, b) => a.originalIndex - b.originalIndex);
    return results.map((r) => r.stakeAccountId);
  }

  async stakeOnOption(
    userId: Address,
    amount: bigint,
    optionId: number
  ): Promise<number> {
    const [stakeAccountId] = await this.stakeOnOptionBatch([{ userId, amount, optionId }]);
    return stakeAccountId;
  }

  async revealStakeBatch(reveals: RevealRequest[]): Promise<void> {
    for (const r of reveals) {
      const user = this.getUser(r.userId);
      const computationOffset = randomComputationOffset();

      const ix = await revealStake(
        {
          signer: user.solanaKeypair,
          owner: user.solanaKeypair.address,
          market: this.marketAddress,
          stakeAccountId: r.stakeAccountId,
        },
        this.getArciumConfig(computationOffset)
      );

      await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
        label: `Reveal stake`,
      });

      const result = await awaitComputationFinalization(this.rpc, computationOffset);
      this.assertComputationSucceeded(result, "revealStake");
    }
  }

  async revealStake(userId: Address, stakeAccountId: number): Promise<void> {
    await this.revealStakeBatch([{ userId, stakeAccountId }]);
  }

  async unstakeEarly(userId: Address, stakeAccountId: number): Promise<void> {
    const user = this.getUser(userId);

    const ix = await unstakeEarlyIx({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      stakeAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
      label: `Unstake early (initiate)`,
    });
  }

  async doUnstakeEarly(
    executorId: Address,
    stakeOwnerId: Address,
    stakeAccountId: number
  ): Promise<void> {
    const executor = this.getUser(executorId);

    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const owner = this.getUser(stakeOwnerId);

    const ix = await doUnstakeEarlyIx({
      signer: executor.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      marketTokenAta: marketAta,
      ownerTokenAccount: owner.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      stakeAccountId,
      stakeAccountOwner: stakeOwnerId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, executor.solanaKeypair, [ix], {
      label: `Do unstake early (execute)`,
    });
  }

  async incrementOptionTallyBatch(increments: TallyIncrement[]): Promise<void> {
    const instructions = await Promise.all(
      increments.map(async (inc) => {
        const user = this.getUser(inc.userId);
        const ix = await incrementOptionTally({
          signer: user.solanaKeypair,
          owner: user.solanaKeypair.address,
          market: this.marketAddress,
          optionId: inc.optionId,
          stakeAccountId: inc.stakeAccountId,
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

  async incrementOptionTally(userId: Address, optionId: number, stakeAccountId: number): Promise<void> {
    await this.incrementOptionTallyBatch([{ userId, optionId, stakeAccountId }]);
  }

  async closeStakeAccountBatch(closes: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const user = this.getUser(close.userId);
        const ix = await closeStakeAccount({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          optionId: close.optionId,
          stakeAccountId: close.stakeAccountId,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Close stake account`,
      });
    }
  }

  async closeStakeAccount(userId: Address, optionId: number, stakeAccountId: number): Promise<void> {
    await this.closeStakeAccountBatch([{ userId, optionId, stakeAccountId }]);
  }

  /**
   * Stakes and immediately closes the stuck stake account in the same transaction.
   * Since the MPC callback hasn't fired yet, the account is in pending_stake=true state,
   * which makes it eligible for close_stuck_stake_account.
   * Returns the stakeAccountId used.
   */
  async stakeAndCloseStuck(
    userId: Address,
    amount: bigint,
    optionId: number
  ): Promise<number> {
    const user = this.getUser(userId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const stakeAccountId = this.getNextStakeAccountId(user);
    const stakeAccountNonce = deserializeLE(randomBytes(16));

    // Init stake account
    const initIx = await initStakeAccount({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      stateNonce: stakeAccountNonce,
      stakeAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
      label: `Init stake account`,
    });

    // Build stake instruction
    const inputNonce = randomBytes(16);
    const optionCiphertext = cipher.encrypt([BigInt(optionId)], inputNonce);
    const computationOffset = randomComputationOffset();

    const [tokenVaultAddress] = await getTokenVaultAddress(this.mint.address, this.programId);
    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [tokenVaultAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: tokenVaultAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const stakeIx = await stake(
      {
        signer: user.solanaKeypair,
        payer: user.solanaKeypair,
        market: this.marketAddress,
        stakeAccountId,
        tokenMint: this.mint.address,
        signerTokenAccount: user.tokenAccount,
        marketTokenAta: marketAta,
        tokenVault: tokenVaultAddress,
        tokenVaultAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount,
        selectedOptionCiphertext: optionCiphertext[0],
        inputNonce: deserializeLE(inputNonce),
        authorizedReaderNonce: deserializeLE(randomBytes(16)),
        userPubkey: user.x25519Keypair.publicKey,
      },
      this.getArciumConfig(computationOffset)
    );

    // Build close stuck instruction
    const closeStuckIx = await closeStuckStakeAccountIx({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      signerTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      stakeAccountId,
    });

    // Send both in the same transaction
    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [stakeIx, closeStuckIx], {
      label: `Stake + close stuck stake account`,
    });

    return stakeAccountId;
  }

  async reclaimStakeBatch(requests: RevealRequest[]): Promise<void> {
    for (const r of requests) {
      const user = this.getUser(r.userId);

      const [marketAta] = await findAssociatedTokenPda({
        mint: this.mint.address,
        owner: this.marketAddress,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const ix = await reclaimStakeIx({
        signer: user.solanaKeypair,
        owner: user.solanaKeypair.address,
        market: this.marketAddress,
        tokenMint: this.mint.address,
        marketTokenAta: marketAta,
        ownerTokenAccount: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        stakeAccountId: r.stakeAccountId,
      });

      await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
        label: `Reclaim stake`,
      });
    }
  }

  async reclaimStake(userId: Address, stakeAccountId: number): Promise<void> {
    await this.reclaimStakeBatch([{ userId, stakeAccountId }]);
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

  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  async fetchMarket() {
    return fetchOpportunityMarket(this.rpc, this.marketAddress);
  }

  getMxePublicKey(): Uint8Array {
    return this.mxePublicKey;
  }

  getUserX25519Keypair(userId: Address): X25519Keypair {
    return this.getUser(userId).x25519Keypair;
  }

  getUserTokenAccount(userId: Address): Address {
    return this.getUser(userId).tokenAccount;
  }

  getUserStakeAccounts(userId: Address): StakeAccountInfo[] {
    return this.getUser(userId).stakeAccounts;
  }

  getUserStakeAccountsForOption(userId: Address, optionId: number): StakeAccountInfo[] {
    return this.getUser(userId).stakeAccounts.filter((sa) => sa.optionId === optionId);
  }

  getStakeAccountInfo(userId: Address, stakeAccountId: number): StakeAccountInfo {
    const user = this.getUser(userId);
    const stakeAccount = user.stakeAccounts.find((sa) => sa.id === stakeAccountId);
    if (!stakeAccount) {
      throw new Error(`Stake account ${stakeAccountId} not found for user ${userId}`);
    }
    return stakeAccount;
  }

  decryptStakeOption(userId: Address, stakeAccountId: number): { optionId: bigint } {
    const user = this.getUser(userId);
    const stakeAccount = this.getStakeAccountInfo(userId, stakeAccountId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(stakeAccount.stateNonce);
    const decrypted = cipher.decrypt([stakeAccount.encryptedOption], nonceBytes);

    return {
      optionId: decrypted[0],
    };
  }

  decryptDisclosedStakeOption(
    userId: Address,
    stakeAccountId: number,
    readerKeypair: X25519Keypair
  ): { optionId: bigint } {
    const stakeAccount = this.getStakeAccountInfo(userId, stakeAccountId);

    const cipher = createCipher(readerKeypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(stakeAccount.stateNonceDisclosure);
    const decrypted = cipher.decrypt([stakeAccount.encryptedOptionDisclosure], nonceBytes);

    return {
      optionId: decrypted[0],
    };
  }

  getOpenTimestamp(): bigint {
    if (this.openTimestamp === null) {
      throw new Error("Market not opened yet. Call openMarket() first.");
    }
    return this.openTimestamp;
  }

  getTimeToStake(): bigint {
    return this.marketConfig.timeToStake;
  }

  getTimeToReveal(): bigint {
    return this.marketConfig.timeToReveal;
  }

  getRewardAmount(): bigint {
    return this.marketConfig.rewardAmount;
  }

  getUnstakeDelaySeconds(): bigint {
    return this.marketConfig.unstakeDelaySeconds;
  }

  async getMarketAta(): Promise<Address> {
    const [marketAta] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return marketAta;
  }

  async getStakeAccountAddress(userId: Address, stakeAccountId: number): Promise<Address> {
    const [address] = await getStakeAccountAddressPda(userId, this.marketAddress, stakeAccountId);
    return address;
  }

  async fetchStakeAccountData(userId: Address, stakeAccountId: number) {
    const address = await this.getStakeAccountAddress(userId, stakeAccountId);
    return fetchStakeAccount(this.rpc, address);
  }

  async getOptionAddress(optionId: number): Promise<Address> {
    const [address] = await getOpportunityMarketOptionAddress(this.marketAddress, optionId);
    return address;
  }

  async fetchOptionData(optionId: number) {
    const address = await this.getOptionAddress(optionId);
    return fetchOpportunityMarketOption(this.rpc, address);
  }

  async accountExists(address: Address): Promise<boolean> {
    const info = await this.rpc.getAccountInfo(address).send();
    return info.value !== null;
  }
}

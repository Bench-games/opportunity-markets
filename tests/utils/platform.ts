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
  isNone,
  unwrapOption,
  type Rpc,
  type Signature,
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
  getPlatformConfigAddress,
  claimFees as claimFeesIx,
  claimCreatorFees as claimCreatorFeesIx,
  randomComputationOffset,
  createPlatformConfig,
  addMarketOption,
  initStakeAccount,
  initAllowedMint,
  stake as stakeIx,
  setWinningOption as setWinningOptionIx,
  resolveMarket as resolveMarketIx,
  revealStake,
  finalizeRevealStake,
  claimRewards,
  closeStakeAccount,
  closeUnrevealedStakeAccount,
  closeOptionAccount,
  closeStuckStakeAccount as closeStuckStakeAccountIx,
  unstake as unstakeIx,
  openMarket as openMarketIx,
  addReward as addRewardIx,
  withdrawReward as withdrawRewardIx,
  endRevealPeriod as endRevealPeriodIx,
  awaitStakeFinalization,
  awaitRevealStakeFinalization,
  getStakeAccountAddress as getStakeAccountAddressPda,
  fetchStakeAccount,
  getOpportunityMarketOptionAddress,
  fetchOpportunityMarketOption,
  getOpportunityMarketAddress,
} from "../../js/src";
import { randomBytes } from "crypto";
import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { generateX25519Keypair, X25519Keypair, createCipher } from "../../js/src/x25519/keypair";
import { createTokenMint, createAta, mintTokensTo } from "./spl-token";
import { sendTransaction, type SendAndConfirmFn } from "./transaction";
import { nonceToBytes } from "./nonce";
import { getDeployerKeypair } from "./deployer";
import { sleepUntilOnChainTimestamp } from "./sleep";

// Buffer (seconds) added to on-chain timestamps before polling resumes; the
// validator clock can lag wall-clock by a few seconds.
const STAKE_END_BUFFER_SECONDS = 2;

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
  nextStakeAccountId: number;
}

interface MarketConfig {
  rewardAmount: bigint;
  timeToStake: bigint;
  allowUnstakingEarly: boolean;
  authorizedReaderPubkey: Uint8Array;
  earlinessCutoffSeconds: bigint;
  earlinessMultiplier: number;
  minStakeAmount: bigint;
  marketFeeClaimer?: Address;
}

export interface PlatformConfigArgs {
  rpcUrl?: string;
  wsUrl?: string;
  numParticipants?: number;
  airdropLamports?: bigint;
  initialTokenAmount?: bigint;
  marketConfig?: Partial<MarketConfig>;
  platformFeeBp?: number;
  rewardPoolFeeBp?: number;
  creatorFeeBp?: number;
  marketResolutionDeadlineSeconds?: bigint;
  revealPeriodSeconds?: bigint;
  revealAuthority?: Address;
  name?: string;
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

export interface UnstakeRequest {
  userId: Address;
  stakeAccountId: number;
  signerId?: Address;
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

const DEFAULT_CONFIG: Required<Omit<PlatformConfigArgs, "name">> = {
  rpcUrl: "http://127.0.0.1:8899",
  wsUrl: "ws://127.0.0.1:8900",
  numParticipants: 2,
  airdropLamports: 2_000_000_000n,
  initialTokenAmount: 1_000_000_000n,
  platformFeeBp: 100,
  rewardPoolFeeBp: 0,
  creatorFeeBp: 0,
  // Program enforces a hard floor of 7 days.
  marketResolutionDeadlineSeconds: 7n * 24n * 60n * 60n,
  // Program enforces 1 week .. 60 days; pick the floor for tests.
  revealPeriodSeconds: 7n * 24n * 60n * 60n,
  revealAuthority: undefined as unknown as Address,
  marketConfig: {
    rewardAmount: 1_000_000_000n,
    // Short by design so tests can wait through the stake window quickly.
    timeToStake: 10n,
    allowUnstakingEarly: false,
    earlinessCutoffSeconds: 0n,
    earlinessMultiplier: 10_000,
    minStakeAmount: 0n,
  },
};

let nextPlatformIndex = 0;
function generatePlatformName(): string {
  return `platform-${nextPlatformIndex++}`;
}

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
// Platform Class
// ============================================================================

export class Platform {
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
  private platformConfigAddress: Address;
  private platformName: string;
  private marketCreator: TestUser;
  private marketConfig: MarketConfig;
  private usedOptionIds: Set<number>;
  private stakeEndTimestamp: bigint | null = null;

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
    config: PlatformConfigArgs = {}
  ): Promise<Platform> {
    const runner = new Platform();

    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      marketConfig: { ...DEFAULT_CONFIG.marketConfig, ...config.marketConfig },
    };

    const {
      rpcUrl,
      wsUrl,
      numParticipants,
      airdropLamports,
      initialTokenAmount,
      marketConfig,
      platformFeeBp,
      rewardPoolFeeBp,
      creatorFeeBp,
      marketResolutionDeadlineSeconds,
      revealPeriodSeconds,
      revealAuthority,
    } = mergedConfig;
    const platformName = config.name ?? generatePlatformName();

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

    const deployer = await getDeployerKeypair();
    const [platformConfigAddress] = await getPlatformConfigAddress(
      deployer.address,
      platformName,
      programId,
    );
    runner.platformConfigAddress = platformConfigAddress;
    runner.platformName = platformName;

    const resolvedRevealAuthority =
      revealAuthority ?? creatorAccountBase.keypair.address;

    const platformConfigIx = await createPlatformConfig(runner.rpc, {
      signer: deployer,
      name: platformName,
      platformFeeBp,
      rewardPoolFeeBp,
      creatorFeeBp,
      feeClaimAuthority: creatorAccountBase.keypair.address,
      revealAuthority: resolvedRevealAuthority,
      minTimeToStakeSeconds: 1n,
      revealPeriodSeconds,
      marketResolutionDeadlineSeconds,
    });
    await sendTransaction(runner.rpc, runner.sendAndConfirm, deployer, [platformConfigIx], {
      label: `Create platform config (${platformName})`,
    });

    console.log("Creating SPL token mint...");
    runner.mint = await createTokenMint(
      runner.rpc,
      runner.sendAndConfirm,
      creatorAccountBase.keypair,
      creatorAccountBase.keypair.address
    );
    console.log(`  Mint created: ${runner.mint.address}`);

    console.log("Whitelisting mint on platform...");
    const initAllowedMintIx = await initAllowedMint({
      updateAuthority: deployer,
      platformConfig: platformConfigAddress,
      tokenMint: runner.mint.address,
    });
    await sendTransaction(runner.rpc, runner.sendAndConfirm, deployer, [initAllowedMintIx], {
      label: "Init allowed mint",
    });

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
        nextStakeAccountId: 0,
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
      nextStakeAccountId: 0,
    };
    // Also add creator to users map so they can be looked up
    runner.users.set(creatorAcc.keypair.address.toString(), runner.marketCreator);

    // Create the market
    console.log("Creating market...");
    const marketIndex = BigInt(Math.floor(Math.random() * 1000000));

    const createMarketIx = await createMarket({
      creator: runner.marketCreator.solanaKeypair,
      platformConfig: runner.platformConfigAddress,
      tokenMint: runner.mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      marketIndex,
      marketAuthority: runner.marketCreator.solanaKeypair.address,
      allowUnstakingEarly: marketConfig.allowUnstakingEarly,
      authorizedReaderPubkey: marketConfig.authorizedReaderPubkey,
      earlinessCutoffSeconds: marketConfig.earlinessCutoffSeconds,
      earlinessMultiplier: marketConfig.earlinessMultiplier,
      minStakeAmount: marketConfig.minStakeAmount,
      creatorFeeClaimer:
        marketConfig.marketFeeClaimer ?? runner.marketCreator.solanaKeypair.address,
    });

    await sendTransaction(runner.rpc, runner.sendAndConfirm, runner.marketCreator.solanaKeypair, [createMarketIx], {
      label: "Create market",
    });

    const [derivedMarket] = await getOpportunityMarketAddress(
      runner.platformConfigAddress,
      runner.marketCreator.solanaKeypair.address,
      marketIndex,
      programId,
    );
    runner.marketAddress = derivedMarket;
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
    return user.nextStakeAccountId++;
  }

  private addStakeAccount(user: TestUser, info: StakeAccountInfo): void {
    user.stakeAccounts.push(info);
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

  async openMarket(): Promise<bigint> {
    const ix = openMarketIx({
      marketAuthority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      platformConfig: this.platformConfigAddress,
      timeToStake: this.marketConfig.timeToStake,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Open market",
    });

    const market = await this.fetchMarket();
    const stakeEnd = unwrapOption(market.data.stakeEndTimestamp);
    if (stakeEnd === null) {
      throw new Error("Market did not record stake_end_timestamp after open_market");
    }
    this.stakeEndTimestamp = stakeEnd;
    return stakeEnd;
  }

  async selectWinningOptions(
    selections: Array<{ optionId: number; rewardBp: number }>,
  ): Promise<void> {
    const setIxs = await Promise.all(
      selections.map(({ optionId, rewardBp }) =>
        setWinningOptionIx({
          marketAuthority: this.marketCreator.solanaKeypair,
          market: this.marketAddress,
          optionId,
          rewardBp,
        }),
      ),
    );

    const resolveIx = resolveMarketIx({
      marketAuthority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
    });

    await sendTransaction(
      this.rpc,
      this.sendAndConfirm,
      this.marketCreator.solanaKeypair,
      [...setIxs, resolveIx],
      { label: "Set winning options and resolve market" },
    );
  }

  async selectSingleWinningOption(optionId: number): Promise<void> {
    await this.selectWinningOptions([{ optionId, rewardBp: 10_000 }]);
  }

  async setWinningOption(optionId: number, rewardBp: number): Promise<void> {
    const ix = await setWinningOptionIx({
      marketAuthority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      optionId,
      rewardBp,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: `Set winning option ${optionId} = ${rewardBp} bp`,
    });
  }

  async resolveMarket(): Promise<void> {
    const ix = resolveMarketIx({
      marketAuthority: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Resolve market",
    });
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

  async endRevealPeriod(signer?: KeyPairSigner): Promise<void> {
    const ix = endRevealPeriodIx({
      signer: signer ?? this.marketCreator.solanaKeypair,
      platformConfig: this.platformConfigAddress,
      market: this.marketAddress,
    });

    await sendTransaction(
      this.rpc,
      this.sendAndConfirm,
      signer ?? this.marketCreator.solanaKeypair,
      [ix],
      {
        label: "End reveal period",
      },
    );
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
      signer: this.marketCreator.solanaKeypair,
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

    // Queue all stake txs while the on-chain staking window is open, then await MPC
    // callbacks in parallel. Sequential await-per-stake can exceed short timeToStake values.
    await Promise.all(
      Array.from(purchasesByUser.entries()).map(async ([_userId, userPurchases]) => {
        type PendingStake = {
          user: ReturnType<Platform["getUser"]>;
          purchase: StakePurchase;
          originalIndex: number;
          stakeAccountId: number;
          stakeAccountAddress: Awaited<ReturnType<typeof getStakeAccountAddressPda>>[0];
          computationOffset: bigint;
          invocationSignature: Signature;
        };
        const pending: PendingStake[] = [];

        for (const { purchase: p, originalIndex } of userPurchases) {
          const user = this.getUser(p.userId);

          const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
          const stakeAccountId = this.getNextStakeAccountId(user);
          const stakeAccountNonce = deserializeLE(randomBytes(16));

          const [stakeAccountAddress] = await getStakeAccountAddressPda(
            p.userId,
            this.marketAddress,
            stakeAccountId,
          );

          const initIx = await initStakeAccount({
            payer: user.solanaKeypair,
            owner: user.solanaKeypair.address,
            market: this.marketAddress,
            stakeAccountId,
          });

          const inputNonce = randomBytes(16);
          const optionCiphertext = cipher.encrypt([BigInt(p.optionId)], inputNonce);
          const computationOffset = randomComputationOffset();

          const stakeInstruction = await stakeIx(
            {
              signer: user.solanaKeypair,
              payer: user.solanaKeypair,
              market: this.marketAddress,
              stakeAccount: stakeAccountAddress,
              stakeAccountId,
              tokenMint: this.mint.address,
              signerTokenAccount: user.tokenAccount,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
              amount: p.amount,
              selectedOptionCiphertext: optionCiphertext[0],
              inputNonce: deserializeLE(inputNonce),
              authorizedReaderNonce: deserializeLE(randomBytes(16)),
              userPubkey: user.x25519Keypair.publicKey,
              stateNonce: stakeAccountNonce,
            },
            this.getArciumConfig(computationOffset),
          );

          const { signature: invocationSignature } = await sendTransaction(
            this.rpc,
            this.sendAndConfirm,
            user.solanaKeypair,
            [initIx, stakeInstruction],
            { label: "Stake on option" },
          );

          pending.push({
            user,
            purchase: p,
            originalIndex,
            stakeAccountId,
            stakeAccountAddress,
            computationOffset,
            invocationSignature,
          });
        }

        await Promise.all(
          pending.map(async (entry) => {
            await awaitStakeFinalization(
              this.rpc,
              entry.invocationSignature,
              this.getArciumConfig(entry.computationOffset),
            );

            const stakeAccountData = await fetchStakeAccount(
              this.rpc,
              entry.stakeAccountAddress,
            );

            this.addStakeAccount(entry.user, {
              id: entry.stakeAccountId,
              amount: entry.purchase.amount,
              optionId: entry.purchase.optionId,
              encryptedOption: stakeAccountData.data.encryptedOption,
              stateNonce: stakeAccountData.data.stateNonce,
              encryptedOptionDisclosure: stakeAccountData.data.encryptedOptionDisclosure,
              stateNonceDisclosure: stakeAccountData.data.stateNonceDisclosure,
            });

            results.push({
              stakeAccountId: entry.stakeAccountId,
              originalIndex: entry.originalIndex,
            });
          }),
        );
      }),
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

      const { signature } = await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
        label: `Reveal stake`,
      });

      await awaitRevealStakeFinalization(
        this.rpc,
        signature,
        this.getArciumConfig(computationOffset),
      );
    }
  }

  async revealStake(userId: Address, stakeAccountId: number): Promise<void> {
    await this.revealStakeBatch([{ userId, stakeAccountId }]);
  }

  async finalizeRevealStakeBatch(increments: TallyIncrement[]): Promise<void> {
    const instructions = await Promise.all(
      increments.map(async (inc) => {
        const user = this.getUser(inc.userId);
        const ix = await finalizeRevealStake({
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
        label: `Finalize reveal stake`,
      });
    }
  }

  async finalizeRevealStake(userId: Address, optionId: number, stakeAccountId: number): Promise<void> {
    await this.finalizeRevealStakeBatch([{ userId, optionId, stakeAccountId }]);
  }

  private async getStakeSettlementAccounts(
    userId: Address,
    optionId: number,
    stakeAccountId: number
  ): Promise<{
    user: TestUser;
    stakeAccount: Awaited<ReturnType<typeof getStakeAccountAddressPda>>[0];
    option: Awaited<ReturnType<typeof getOpportunityMarketOptionAddress>>[0];
  }> {
    const user = this.getUser(userId);
    const [stakeAccount] = await getStakeAccountAddressPda(
      userId,
      this.marketAddress,
      stakeAccountId
    );
    const [option] = await getOpportunityMarketOptionAddress(this.marketAddress, optionId);
    return { user, stakeAccount, option };
  }

  private stakeNeedsRewardClaim(
    stake: Awaited<ReturnType<typeof fetchStakeAccount>>,
    option: Awaited<ReturnType<typeof fetchOpportunityMarketOption>>
  ): boolean {
    return (
      option.data.rewardBp > 0 &&
      !isNone(stake.data.score) &&
      !stake.data.rewardsClaimed
    );
  }

  async claimRewardsBatch(claims: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      claims.map(async (claim) => {
        const { user, stakeAccount, option } = await this.getStakeSettlementAccounts(
          claim.userId,
          claim.optionId,
          claim.stakeAccountId
        );
        const ix = await claimRewards({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          stakeAccount,
          option,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Claim rewards`,
      });
    }
  }

  async claimRewards(userId: Address, optionId: number, stakeAccountId: number): Promise<void> {
    await this.claimRewardsBatch([{ userId, optionId, stakeAccountId }]);
  }

  async closeRevealedStakeAccountBatch(closes: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const { user, stakeAccount, option } = await this.getStakeSettlementAccounts(
          close.userId,
          close.optionId,
          close.stakeAccountId
        );
        const ix = await closeStakeAccount({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          stakeAccount,
          option,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
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

  async closeUnrevealedStakeAccountBatch(closes: Array<{ userId: Address; stakeAccountId: number }>): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const user = this.getUser(close.userId);
        const [stakeAccount] = await getStakeAccountAddressPda(
          close.userId,
          this.marketAddress,
          close.stakeAccountId
        );
        const ix = await closeUnrevealedStakeAccount({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          stakeAccount,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Close unrevealed stake account`,
      });
    }
  }

  async closeUnrevealedStakeAccount(userId: Address, stakeAccountId: number): Promise<void> {
    await this.closeUnrevealedStakeAccountBatch([{ userId, stakeAccountId }]);
  }

  /**
   * Claims rewards for winning finalized stakes when needed, then closes the account.
   * Routes never-revealed stakes to `close_unrevealed_stake_account`.
   */
  async closeStakeAccountBatch(closes: CloseRequest[]): Promise<void> {
    const claims: CloseRequest[] = [];
    const revealedCloses: CloseRequest[] = [];
    const unrevealedCloses: Array<{ userId: Address; stakeAccountId: number }> = [];

    for (const close of closes) {
      const stake = await this.fetchStakeAccountData(close.userId, close.stakeAccountId);
      if (isNone(stake.data.revealedOption)) {
        unrevealedCloses.push({
          userId: close.userId,
          stakeAccountId: close.stakeAccountId,
        });
        continue;
      }

      const optionId = close.optionId;
      const option = await this.fetchOptionData(optionId);
      if (this.stakeNeedsRewardClaim(stake, option)) {
        claims.push(close);
      }
      revealedCloses.push(close);
    }

    if (claims.length > 0) {
      await this.claimRewardsBatch(claims);
    }
    if (unrevealedCloses.length > 0) {
      await this.closeUnrevealedStakeAccountBatch(unrevealedCloses);
    }
    if (revealedCloses.length > 0) {
      await this.closeRevealedStakeAccountBatch(revealedCloses);
    }
  }

  async closeStakeAccount(userId: Address, optionId: number, stakeAccountId: number): Promise<void> {
    await this.closeStakeAccountBatch([{ userId, optionId, stakeAccountId }]);
  }

  async closeOptionAccount(optionId: number): Promise<void> {
    const ix = await closeOptionAccount({
      signer: this.marketCreator.solanaKeypair,
      creator: this.creator,
      market: this.marketAddress,
      optionId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: `Close option account ${optionId}`,
    });
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
      payer: user.solanaKeypair,
      owner: user.solanaKeypair.address,
      market: this.marketAddress,
      stakeAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
      label: `Init stake account`,
    });

    const [stakeAccountAddress] = await getStakeAccountAddressPda(userId, this.marketAddress, stakeAccountId);

    // Build stake instruction
    const inputNonce = randomBytes(16);
    const optionCiphertext = cipher.encrypt([BigInt(optionId)], inputNonce);
    const computationOffset = randomComputationOffset();

    const stakeInstruction = await stakeIx(
      {
        signer: user.solanaKeypair,
        payer: user.solanaKeypair,
        market: this.marketAddress,
        stakeAccount: stakeAccountAddress,
        stakeAccountId,
        tokenMint: this.mint.address,
        signerTokenAccount: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount,
        selectedOptionCiphertext: optionCiphertext[0],
        inputNonce: deserializeLE(inputNonce),
        authorizedReaderNonce: deserializeLE(randomBytes(16)),
        userPubkey: user.x25519Keypair.publicKey,
        stateNonce: stakeAccountNonce,
      },
      this.getArciumConfig(computationOffset)
    );

    // Build close stuck instruction (codama auto-derives tokenVault/tokenVaultAta from tokenMint)
    const closeStuckIx = await closeStuckStakeAccountIx({
      signer: user.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      signerTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      stakeAccountId,
    });

    // Send both in the same transaction
    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [stakeInstruction, closeStuckIx], {
      label: `Stake + close stuck stake account`,
    });

    return stakeAccountId;
  }

  async unstakeBatch(requests: UnstakeRequest[]): Promise<void> {
    for (const r of requests) {
      const owner = this.getUser(r.userId);
      const signer = r.signerId ? this.getUser(r.signerId) : owner;

      const ix = await unstakeIx({
        signer: signer.solanaKeypair,
        owner: owner.solanaKeypair.address,
        market: this.marketAddress,
        tokenMint: this.mint.address,
        ownerTokenAccount: owner.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        stakeAccountId: r.stakeAccountId,
      });

      await sendTransaction(this.rpc, this.sendAndConfirm, signer.solanaKeypair, [ix], {
        label: `Unstake`,
      });
    }
  }

  async unstake(userId: Address, stakeAccountId: number, signerId?: Address): Promise<void> {
    await this.unstakeBatch([{ userId, stakeAccountId, signerId }]);
  }

  // ============================================================================
  // Fee Operations
  // ============================================================================

  async claimFees(): Promise<void> {
    const ix = await claimFeesIx({
      signer: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      platformConfig: this.platformConfigAddress,
      tokenMint: this.mint.address,
      destinationTokenAccount: this.marketCreator.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Claim fees",
    });
  }

  async claimCreatorFees(destinationTokenAccount?: Address): Promise<void> {
    const ix = await claimCreatorFeesIx({
      signer: this.marketCreator.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      destinationTokenAccount: destinationTokenAccount ?? this.marketCreator.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Claim creator fees",
    });
  }

  // ============================================================================
  // Utility Methods for Tests
  // ============================================================================

  getRpc(): Rpc<SolanaRpcApi> {
    return this.rpc;
  }

  getSendAndConfirm(): SendAndConfirmFn {
    return this.sendAndConfirm;
  }

  getArciumClusterOffset(): number {
    return this.arciumEnv.arciumClusterOffset;
  }

  getProgramId(): Address {
    return this.programId;
  }

  getUserSigner(userId: Address): KeyPairSigner {
    return this.getUser(userId).solanaKeypair;
  }

  async fetchMarket() {
    return fetchOpportunityMarket(this.rpc, this.marketAddress);
  }

  get platformConfig(): Address {
    return this.platformConfigAddress;
  }

  get name(): string {
    return this.platformName;
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

  getStakeEndTimestamp(): bigint {
    if (this.stakeEndTimestamp === null) {
      throw new Error("Market not opened yet. Call openMarket() first.");
    }
    return this.stakeEndTimestamp;
  }

  async waitForStakeEnd(): Promise<void> {
    await sleepUntilOnChainTimestamp(
      Number(this.getStakeEndTimestamp()) + STAKE_END_BUFFER_SECONDS,
    );
  }

  getTimeToStake(): bigint {
    return this.marketConfig.timeToStake;
  }

  getRewardAmount(): bigint {
    return this.marketConfig.rewardAmount;
  }

  getAllowUnstakingEarly(): boolean {
    return this.marketConfig.allowUnstakingEarly;
  }

  async getMarketAta(): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
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

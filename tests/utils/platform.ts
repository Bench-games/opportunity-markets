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
  initVouchAccount,
  initAllowedMint,
  vouch as vouchIx,
  setWinningOption as setWinningOptionIx,
  resolveMarket as resolveMarketIx,
  revealVouch,
  finalizeRevealVouch,
  claimRewards,
  closeVouchAccount,
  closeUnrevealedVouchAccount,
  closeOptionAccount,
  closeStuckVouchAccount as closeStuckVouchAccountIx,
  withdrawVouch as withdrawVouchIx,
  openMarket as openMarketIx,
  addReward as addRewardIx,
  withdrawReward as withdrawRewardIx,
  endRevealPeriod as endRevealPeriodIx,
  awaitVouchFinalization,
  awaitRevealVouchFinalization,
  getVouchAccountAddress as getVouchAccountAddressPda,
  fetchVouchAccount,
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

// Selection phase requires on-chain now >= vouching_window_end; poll the validator
// clock rather than wall time so phase guards see the post-vouching window.
const VOUCH_END_BUFFER_SECONDS = 1;

// ============================================================================
// Types
// ============================================================================

export interface VouchAccountInfo {
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
  vouchAccounts: VouchAccountInfo[];
  nextVouchAccountId: number;
}

interface MarketConfig {
  rewardAmount: bigint;
  timeToVouch: bigint;
  authorizedReaderPubkey: Uint8Array;
  earlinessCutoffSeconds: bigint;
  earlinessMultiplier: number;
  minVouchAmount: bigint;
  marketFeeClaimer?: Address;
}

export interface PlatformConfigArgs {
  rpcUrl?: string;
  wsUrl?: string;
  numParticipants?: number;
  airdropLamports?: bigint;
  initialTokenAmount?: bigint;
  marketConfig?: Partial<MarketConfig>;
  userPlatformFeeBp?: number;
  userRewardPoolFeeBp?: number;
  userCreatorFeeBp?: number;
  sponsorPlatformFeeBp?: number;
  marketResolutionDeadlineSeconds?: bigint;
  revealPeriodSeconds?: bigint;
  revealAuthority?: Address;
  name?: string;
}

// Batch input types
export interface VouchPurchase {
  userId: Address;
  amount: bigint;
  optionId: number;
}

export interface RevealRequest {
  userId: Address;
  vouchAccountId: number;
}

export interface WithdrawVouchRequest {
  userId: Address;
  vouchAccountId: number;
  signerId?: Address;
}

export interface TallyIncrement {
  userId: Address;
  optionId: number;
  vouchAccountId: number;
}

export interface CloseRequest {
  userId: Address;
  optionId: number;
  vouchAccountId: number;
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
  userPlatformFeeBp: 100,
  userRewardPoolFeeBp: 0,
  userCreatorFeeBp: 0,
  sponsorPlatformFeeBp: 1000,
  // Program enforces a hard floor of 7 days.
  marketResolutionDeadlineSeconds: 7n * 24n * 60n * 60n,
  // Program enforces 1 week .. 60 days; pick the floor for tests.
  revealPeriodSeconds: 7n * 24n * 60n * 60n,
  revealAuthority: undefined as unknown as Address,
  marketConfig: {
    rewardAmount: 1_000_000_000n,
    // Short by design so tests can wait through the vouch window quickly.
    timeToVouch: 10n,
    earlinessCutoffSeconds: 60n,
    earlinessMultiplier: 10_000,
    minVouchAmount: 1n,
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
  private vouchEndTimestamp: bigint | null = null;

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
      userPlatformFeeBp,
      userRewardPoolFeeBp,
      userCreatorFeeBp,
      sponsorPlatformFeeBp,
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
      userPlatformFeeBp,
      userRewardPoolFeeBp,
      userCreatorFeeBp,
      sponsorPlatformFeeBp,
      feeClaimAuthority: creatorAccountBase.keypair.address,
      revealAuthority: resolvedRevealAuthority,
      minTimeToVouchSeconds: 1n,
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
        vouchAccounts: [],
        nextVouchAccountId: 0,
      };
      runner.users.set(acc.keypair.address.toString(), user);
    }

    // Market creator
    const creatorAcc = accountsWithTokens[numParticipants];
    runner.marketCreator = {
      solanaKeypair: creatorAcc.keypair,
      x25519Keypair: creatorAcc.x25519Keypair,
      tokenAccount: creatorAcc.tokenAccount,
      vouchAccounts: [],
      nextVouchAccountId: 0,
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
      authorizedReaderPubkey: marketConfig.authorizedReaderPubkey,
      earlinessCutoffSeconds: marketConfig.earlinessCutoffSeconds,
      earlinessMultiplier: marketConfig.earlinessMultiplier,
      minVouchAmount: marketConfig.minVouchAmount,
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
      await runner.addReward(runner.marketCreator.solanaKeypair.address, marketConfig.rewardAmount);
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

  private getNextVouchAccountId(user: TestUser): number {
    return user.nextVouchAccountId++;
  }

  private addVouchAccount(user: TestUser, info: VouchAccountInfo): void {
    user.vouchAccounts.push(info);
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
      timeToVouch: this.marketConfig.timeToVouch,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, this.marketCreator.solanaKeypair, [ix], {
      label: "Open market",
    });

    const market = await this.fetchMarket();
    const vouchEnd = unwrapOption(market.data.vouchingWindowEnd);
    if (vouchEnd === null) {
      throw new Error("Market did not record vouch_end_timestamp after open_market");
    }
    this.vouchEndTimestamp = vouchEnd;
    return vouchEnd;
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

  async addReward(userId: Address, amount: bigint): Promise<void> {
    const user = this.getUser(userId);

    const ix = await addRewardIx({
      sponsor: user.solanaKeypair,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      sponsorTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount,
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
  // Vouch Operations
  // ============================================================================

  async vouchOnOptionBatch(
    purchases: VouchPurchase[]
  ): Promise<number[]> {
    const purchasesByUser = new Map<string, { purchase: VouchPurchase; originalIndex: number }[]>();
    for (let i = 0; i < purchases.length; i++) {
      const p = purchases[i];
      const key = p.userId.toString();
      if (!purchasesByUser.has(key)) {
        purchasesByUser.set(key, []);
      }
      purchasesByUser.get(key)!.push({ purchase: p, originalIndex: i });
    }

    const results: { vouchAccountId: number; originalIndex: number }[] = [];

    // Queue all vouch txs while the on-chain vouching window is open, then await MPC
    // callbacks in parallel. Sequential await-per-vouch can exceed short timeToVouch values.
    await Promise.all(
      Array.from(purchasesByUser.entries()).map(async ([_userId, userPurchases]) => {
        type PendingVouch = {
          user: ReturnType<Platform["getUser"]>;
          purchase: VouchPurchase;
          originalIndex: number;
          vouchAccountId: number;
          vouchAccountAddress: Awaited<ReturnType<typeof getVouchAccountAddressPda>>[0];
          computationOffset: bigint;
          invocationSignature: Signature;
        };
        const pending: PendingVouch[] = [];

        for (const { purchase: p, originalIndex } of userPurchases) {
          const user = this.getUser(p.userId);

          const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
          const vouchAccountId = this.getNextVouchAccountId(user);
          const vouchAccountNonce = deserializeLE(randomBytes(16));

          const [vouchAccountAddress] = await getVouchAccountAddressPda(
            p.userId,
            this.marketAddress,
            vouchAccountId,
          );

          const initIx = await initVouchAccount({
            payer: user.solanaKeypair,
            owner: user.solanaKeypair.address,
            market: this.marketAddress,
            vouchAccountId,
          });

          const inputNonce = randomBytes(16);
          const optionCiphertext = cipher.encrypt([BigInt(p.optionId)], inputNonce);
          const computationOffset = randomComputationOffset();

          const vouchInstruction = await vouchIx(
            {
              signer: user.solanaKeypair,
              payer: user.solanaKeypair,
              market: this.marketAddress,
              vouchAccount: vouchAccountAddress,
              vouchAccountId,
              tokenMint: this.mint.address,
              signerTokenAccount: user.tokenAccount,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
              amount: p.amount,
              selectedOptionCiphertext: optionCiphertext[0],
              inputNonce: deserializeLE(inputNonce),
              authorizedReaderNonce: deserializeLE(randomBytes(16)),
              userPubkey: user.x25519Keypair.publicKey,
              stateNonce: vouchAccountNonce,
            },
            this.getArciumConfig(computationOffset),
          );

          const { signature: invocationSignature } = await sendTransaction(
            this.rpc,
            this.sendAndConfirm,
            user.solanaKeypair,
            [initIx, vouchInstruction],
            { label: "Vouch on option" },
          );

          pending.push({
            user,
            purchase: p,
            originalIndex,
            vouchAccountId,
            vouchAccountAddress,
            computationOffset,
            invocationSignature,
          });
        }

        await Promise.all(
          pending.map(async (entry) => {
            await awaitVouchFinalization(
              this.rpc,
              entry.invocationSignature,
              this.getArciumConfig(entry.computationOffset),
            );

            const vouchAccountData = await fetchVouchAccount(
              this.rpc,
              entry.vouchAccountAddress,
            );

            this.addVouchAccount(entry.user, {
              id: entry.vouchAccountId,
              amount: entry.purchase.amount,
              optionId: entry.purchase.optionId,
              encryptedOption: vouchAccountData.data.encryptedOption,
              stateNonce: vouchAccountData.data.stateNonce,
              encryptedOptionDisclosure: vouchAccountData.data.encryptedOptionDisclosure,
              stateNonceDisclosure: vouchAccountData.data.stateNonceDisclosure,
            });

            results.push({
              vouchAccountId: entry.vouchAccountId,
              originalIndex: entry.originalIndex,
            });
          }),
        );
      }),
    );

    results.sort((a, b) => a.originalIndex - b.originalIndex);
    return results.map((r) => r.vouchAccountId);
  }

  async vouchOnOption(
    userId: Address,
    amount: bigint,
    optionId: number
  ): Promise<number> {
    const [vouchAccountId] = await this.vouchOnOptionBatch([{ userId, amount, optionId }]);
    return vouchAccountId;
  }

  async revealVouchBatch(reveals: RevealRequest[]): Promise<void> {
    for (const r of reveals) {
      const user = this.getUser(r.userId);
      const computationOffset = randomComputationOffset();

      const ix = await revealVouch(
        {
          signer: user.solanaKeypair,
          owner: user.solanaKeypair.address,
          market: this.marketAddress,
          vouchAccountId: r.vouchAccountId,
        },
        this.getArciumConfig(computationOffset)
      );

      const { signature } = await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [ix], {
        label: `Reveal vouch`,
      });

      await awaitRevealVouchFinalization(
        this.rpc,
        signature,
        this.getArciumConfig(computationOffset),
      );
    }
  }

  async revealVouch(userId: Address, vouchAccountId: number): Promise<void> {
    await this.revealVouchBatch([{ userId, vouchAccountId }]);
  }

  async finalizeRevealVouchBatch(increments: TallyIncrement[]): Promise<void> {
    const instructions = await Promise.all(
      increments.map(async (inc) => {
        const user = this.getUser(inc.userId);
        const ix = await finalizeRevealVouch({
          signer: user.solanaKeypair,
          owner: user.solanaKeypair.address,
          market: this.marketAddress,
          optionId: inc.optionId,
          vouchAccountId: inc.vouchAccountId,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Finalize reveal vouch`,
      });
    }
  }

  async finalizeRevealVouch(userId: Address, optionId: number, vouchAccountId: number): Promise<void> {
    await this.finalizeRevealVouchBatch([{ userId, optionId, vouchAccountId }]);
  }

  private async getVouchSettlementAccounts(
    userId: Address,
    optionId: number,
    vouchAccountId: number
  ): Promise<{
    user: TestUser;
    vouchAccount: Awaited<ReturnType<typeof getVouchAccountAddressPda>>[0];
    option: Awaited<ReturnType<typeof getOpportunityMarketOptionAddress>>[0];
  }> {
    const user = this.getUser(userId);
    const [vouchAccount] = await getVouchAccountAddressPda(
      userId,
      this.marketAddress,
      vouchAccountId
    );
    const [option] = await getOpportunityMarketOptionAddress(this.marketAddress, optionId);
    return { user, vouchAccount, option };
  }

  private vouchNeedsRewardClaim(
    vouch: Awaited<ReturnType<typeof fetchVouchAccount>>,
    option: Awaited<ReturnType<typeof fetchOpportunityMarketOption>>
  ): boolean {
    return (
      option.data.rewardBp > 0 &&
      !isNone(vouch.data.score) &&
      !vouch.data.rewardsClaimed
    );
  }

  async claimRewardsBatch(claims: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      claims.map(async (claim) => {
        const { user, vouchAccount, option } = await this.getVouchSettlementAccounts(
          claim.userId,
          claim.optionId,
          claim.vouchAccountId
        );
        const ix = await claimRewards({
          owner: user.solanaKeypair,
          market: this.marketAddress,
          vouchAccount,
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

  async claimRewards(userId: Address, optionId: number, vouchAccountId: number): Promise<void> {
    await this.claimRewardsBatch([{ userId, optionId, vouchAccountId }]);
  }

  async closeRevealedVouchAccountBatch(closes: CloseRequest[]): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const { user, vouchAccount, option } = await this.getVouchSettlementAccounts(
          close.userId,
          close.optionId,
          close.vouchAccountId
        );
        const ix = await closeVouchAccount({
          owner: user.solanaKeypair,
          rentPayer: user.solanaKeypair.address,
          market: this.marketAddress,
          vouchAccount,
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
        label: `Close vouch account`,
      });
    }
  }

  async closeUnrevealedVouchAccountBatch(closes: Array<{ userId: Address; vouchAccountId: number }>): Promise<void> {
    const instructions = await Promise.all(
      closes.map(async (close) => {
        const user = this.getUser(close.userId);
        const [vouchAccount] = await getVouchAccountAddressPda(
          close.userId,
          this.marketAddress,
          close.vouchAccountId
        );
        const ix = await closeUnrevealedVouchAccount({
          owner: user.solanaKeypair,
          rentPayer: user.solanaKeypair.address,
          market: this.marketAddress,
          vouchAccount,
          tokenMint: this.mint.address,
          ownerTokenAccount: user.tokenAccount,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        return { user, ix };
      })
    );

    for (const data of instructions) {
      await sendTransaction(this.rpc, this.sendAndConfirm, data.user.solanaKeypair, [data.ix], {
        label: `Close unrevealed vouch account`,
      });
    }
  }

  async closeUnrevealedVouchAccount(userId: Address, vouchAccountId: number): Promise<void> {
    await this.closeUnrevealedVouchAccountBatch([{ userId, vouchAccountId }]);
  }

  /**
   * Claims rewards for winning finalized vouches when needed, then closes the account.
   * Routes never-revealed vouches to `close_unrevealed_vouch_account`.
   */
  async closeVouchAccountBatch(closes: CloseRequest[]): Promise<void> {
    const claims: CloseRequest[] = [];
    const revealedCloses: CloseRequest[] = [];
    const unrevealedCloses: Array<{ userId: Address; vouchAccountId: number }> = [];

    for (const close of closes) {
      const vouch = await this.fetchVouchAccountData(close.userId, close.vouchAccountId);
      if (isNone(vouch.data.revealedOption)) {
        unrevealedCloses.push({
          userId: close.userId,
          vouchAccountId: close.vouchAccountId,
        });
        continue;
      }

      const optionId = close.optionId;
      const option = await this.fetchOptionData(optionId);
      if (this.vouchNeedsRewardClaim(vouch, option)) {
        claims.push(close);
      }
      revealedCloses.push(close);
    }

    if (claims.length > 0) {
      await this.claimRewardsBatch(claims);
    }
    if (unrevealedCloses.length > 0) {
      await this.closeUnrevealedVouchAccountBatch(unrevealedCloses);
    }
    if (revealedCloses.length > 0) {
      await this.closeRevealedVouchAccountBatch(revealedCloses);
    }
  }

  async closeVouchAccount(userId: Address, optionId: number, vouchAccountId: number): Promise<void> {
    await this.closeVouchAccountBatch([{ userId, optionId, vouchAccountId }]);
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
   * Vouches and immediately closes the stuck vouch account in the same transaction.
   * Since the MPC callback hasn't fired yet, the account is in pending_vouch=true state,
   * which makes it eligible for close_stuck_vouch_account.
   * Returns the vouchAccountId used.
   */
  async vouchAndCloseStuck(
    userId: Address,
    amount: bigint,
    optionId: number
  ): Promise<number> {
    const user = this.getUser(userId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const vouchAccountId = this.getNextVouchAccountId(user);
    const vouchAccountNonce = deserializeLE(randomBytes(16));

    // Init vouch account
    const initIx = await initVouchAccount({
      payer: user.solanaKeypair,
      owner: user.solanaKeypair.address,
      market: this.marketAddress,
      vouchAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
      label: `Init vouch account`,
    });

    const [vouchAccountAddress] = await getVouchAccountAddressPda(userId, this.marketAddress, vouchAccountId);

    // Build vouch instruction
    const inputNonce = randomBytes(16);
    const optionCiphertext = cipher.encrypt([BigInt(optionId)], inputNonce);
    const computationOffset = randomComputationOffset();

    const vouchInstruction = await vouchIx(
      {
        signer: user.solanaKeypair,
        payer: user.solanaKeypair,
        market: this.marketAddress,
        vouchAccount: vouchAccountAddress,
        vouchAccountId,
        tokenMint: this.mint.address,
        signerTokenAccount: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount,
        selectedOptionCiphertext: optionCiphertext[0],
        inputNonce: deserializeLE(inputNonce),
        authorizedReaderNonce: deserializeLE(randomBytes(16)),
        userPubkey: user.x25519Keypair.publicKey,
        stateNonce: vouchAccountNonce,
      },
      this.getArciumConfig(computationOffset)
    );

    // Build close stuck instruction (codama auto-derives tokenVault/tokenVaultAta from tokenMint)
    const closeStuckIx = await closeStuckVouchAccountIx({
      signer: user.solanaKeypair,
      rentPayer: user.solanaKeypair.address,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      signerTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      vouchAccountId,
    });

    // Send both in the same transaction
    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [vouchInstruction, closeStuckIx], {
      label: `Vouch + close stuck vouch account`,
    });

    return vouchAccountId;
  }

  /**
   * Vouches, withdraws the vouch, and closes the stuck vouch account in the same transaction.
   * While the MPC callback is pending this was a double-withdraw vector (OM-007).
   */
  async vouchWithdrawAndCloseStuck(
    userId: Address,
    amount: bigint,
    optionId: number,
  ): Promise<void> {
    const user = this.getUser(userId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const vouchAccountId = this.getNextVouchAccountId(user);
    const vouchAccountNonce = deserializeLE(randomBytes(16));

    const initIx = await initVouchAccount({
      payer: user.solanaKeypair,
      owner: user.solanaKeypair.address,
      market: this.marketAddress,
      vouchAccountId,
    });

    await sendTransaction(this.rpc, this.sendAndConfirm, user.solanaKeypair, [initIx], {
      label: `Init vouch account`,
    });

    const [vouchAccountAddress] = await getVouchAccountAddressPda(
      userId,
      this.marketAddress,
      vouchAccountId,
    );

    const inputNonce = randomBytes(16);
    const optionCiphertext = cipher.encrypt([BigInt(optionId)], inputNonce);
    const computationOffset = randomComputationOffset();

    const vouchInstruction = await vouchIx(
      {
        signer: user.solanaKeypair,
        payer: user.solanaKeypair,
        market: this.marketAddress,
        vouchAccount: vouchAccountAddress,
        vouchAccountId,
        tokenMint: this.mint.address,
        signerTokenAccount: user.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount,
        selectedOptionCiphertext: optionCiphertext[0],
        inputNonce: deserializeLE(inputNonce),
        authorizedReaderNonce: deserializeLE(randomBytes(16)),
        userPubkey: user.x25519Keypair.publicKey,
        stateNonce: vouchAccountNonce,
      },
      this.getArciumConfig(computationOffset),
    );

    const withdrawVouchInstruction = await withdrawVouchIx({
      signer: user.solanaKeypair,
      owner: user.solanaKeypair.address,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      ownerTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      vouchAccountId,
    });

    const closeStuckIx = await closeStuckVouchAccountIx({
      signer: user.solanaKeypair,
      rentPayer: user.solanaKeypair.address,
      market: this.marketAddress,
      tokenMint: this.mint.address,
      signerTokenAccount: user.tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      vouchAccountId,
    });

    await sendTransaction(
      this.rpc,
      this.sendAndConfirm,
      user.solanaKeypair,
      [vouchInstruction, withdrawVouchInstruction, closeStuckIx],
      { label: `Vouch + withdraw vouch + close stuck vouch account` },
    );
  }

  async withdrawVouchBatch(requests: WithdrawVouchRequest[]): Promise<void> {
    for (const r of requests) {
      const owner = this.getUser(r.userId);
      const signer = r.signerId ? this.getUser(r.signerId) : owner;

      const ix = await withdrawVouchIx({
        signer: signer.solanaKeypair,
        owner: owner.solanaKeypair.address,
        market: this.marketAddress,
        tokenMint: this.mint.address,
        ownerTokenAccount: owner.tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        vouchAccountId: r.vouchAccountId,
      });

      await sendTransaction(this.rpc, this.sendAndConfirm, signer.solanaKeypair, [ix], {
        label: `Withdraw vouch`,
      });
    }
  }

  async withdrawVouch(userId: Address, vouchAccountId: number, signerId?: Address): Promise<void> {
    await this.withdrawVouchBatch([{ userId, vouchAccountId, signerId }]);
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

  getUserVouchAccounts(userId: Address): VouchAccountInfo[] {
    return this.getUser(userId).vouchAccounts;
  }

  getUserVouchAccountsForOption(userId: Address, optionId: number): VouchAccountInfo[] {
    return this.getUser(userId).vouchAccounts.filter((sa) => sa.optionId === optionId);
  }

  getVouchAccountInfo(userId: Address, vouchAccountId: number): VouchAccountInfo {
    const user = this.getUser(userId);
    const vouchAccount = user.vouchAccounts.find((sa) => sa.id === vouchAccountId);
    if (!vouchAccount) {
      throw new Error(`Vouch account ${vouchAccountId} not found for user ${userId}`);
    }
    return vouchAccount;
  }

  decryptVouchOption(userId: Address, vouchAccountId: number): { optionId: bigint } {
    const user = this.getUser(userId);
    const vouchAccount = this.getVouchAccountInfo(userId, vouchAccountId);

    const cipher = createCipher(user.x25519Keypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(vouchAccount.stateNonce);
    const decrypted = cipher.decrypt([vouchAccount.encryptedOption], nonceBytes);

    return {
      optionId: decrypted[0],
    };
  }

  decryptDisclosedVouchOption(
    userId: Address,
    vouchAccountId: number,
    readerKeypair: X25519Keypair
  ): { optionId: bigint } {
    const vouchAccount = this.getVouchAccountInfo(userId, vouchAccountId);

    const cipher = createCipher(readerKeypair.secretKey, this.mxePublicKey);
    const nonceBytes = nonceToBytes(vouchAccount.stateNonceDisclosure);
    const decrypted = cipher.decrypt([vouchAccount.encryptedOptionDisclosure], nonceBytes);

    return {
      optionId: decrypted[0],
    };
  }

  getVouchEndTimestamp(): bigint {
    if (this.vouchEndTimestamp === null) {
      throw new Error("Market not opened yet. Call openMarket() first.");
    }
    return this.vouchEndTimestamp;
  }

  async waitForVouchEnd(): Promise<void> {
    await sleepUntilOnChainTimestamp(
      Number(this.getVouchEndTimestamp()) + VOUCH_END_BUFFER_SECONDS,
      this.rpc,
    );
  }

  getTimeToVouch(): bigint {
    return this.marketConfig.timeToVouch;
  }

  getRewardAmount(): bigint {
    return this.marketConfig.rewardAmount;
  }

  async getMarketAta(): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({
      mint: this.mint.address,
      owner: this.marketAddress,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return ata;
  }

  async getVouchAccountAddress(userId: Address, vouchAccountId: number): Promise<Address> {
    const [address] = await getVouchAccountAddressPda(userId, this.marketAddress, vouchAccountId);
    return address;
  }

  async fetchVouchAccountData(userId: Address, vouchAccountId: number) {
    const address = await this.getVouchAccountAddress(userId, vouchAccountId);
    return fetchVouchAccount(this.rpc, address);
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

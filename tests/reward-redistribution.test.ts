import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { address, some, createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory } from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { expect } from "chai";
import { OPPORTUNITY_MARKET_ERROR__NO_FINALIZED_WINNING_OPTION } from "../js/src";
import { OpportunityMarket } from "../target/types/opportunity_market";
import { Platform } from "./utils/platform";
import { initializeAllCompDefs } from "./utils/comp-defs";
import { generateX25519Keypair } from "../js/src/x25519/keypair";
import { shouldThrowCustomError } from "./utils/errors";
import * as fs from "fs";
import * as os from "os";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WS_URL = RPC_URL.replace("http", "ws").replace(":8899", ":8900");

describe("Redistributes rewards in unstaked options", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.OpportunityMarket as Program<OpportunityMarket>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const programId = address(program.programId.toBase58());

  before(async () => {
    const file = fs.readFileSync(`${os.homedir()}/.config/solana/id.json`);
    const secretKey = new Uint8Array(JSON.parse(file.toString()));
    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    await initializeAllCompDefs(rpc, sendAndConfirmTransaction, secretKey, programId);
  });

  it("increments active_bp once per winning option on first finalize", async () => {
    const observer = generateX25519Keypair();
    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000n,
        timeToStake: 8n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const user = platform.participants[0];
    await platform.openMarket();
    const { optionId: optA } = await platform.addOption();
    const { optionId: optB } = await platform.addOption();

    const [saA1, saA2] = await platform.stakeOnOptionBatch([
      { userId: user, amount: 1000n, optionId: optA },
      { userId: user, amount: 2000n, optionId: optA },
    ]);
    await platform.stakeOnOption(user, 3000n, optB);

    await platform.waitForStakeEnd();
    await platform.selectWinningOptions([
      { optionId: optA, rewardBp: 6000 },
      { optionId: optB, rewardBp: 4000 },
    ]);

    const saB = platform.getUserStakeAccountsForOption(user, optB)[0].id;
    await platform.revealStakeBatch([
      { userId: user, stakeAccountId: saA1 },
      { userId: user, stakeAccountId: saA2 },
      { userId: user, stakeAccountId: saB },
    ]);

    let market = await platform.fetchMarket();
    expect(market.data.winningOptionActiveBp).to.equal(0);

    await platform.finalizeRevealStake(user, optA, saA1);
    market = await platform.fetchMarket();
    expect(market.data.winningOptionActiveBp).to.equal(6000);
    const optAData = await platform.fetchOptionData(optA);
    expect(optAData.data.includedInActiveBp).to.be.true;

    await platform.finalizeRevealStake(user, optA, saA2);
    market = await platform.fetchMarket();
    expect(market.data.winningOptionActiveBp).to.equal(6000);

    await platform.finalizeRevealStake(user, optB, saB);
    market = await platform.fetchMarket();
    expect(market.data.winningOptionActiveBp).to.equal(10_000);
    expect((await platform.fetchOptionData(optB)).data.includedInActiveBp).to.be.true;
  });

  it("redistributes slice when a winning option has no finalize", async () => {
    const rewardAmount = 1_000_000_000n;
    const observer = generateX25519Keypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      platformFeeBp: 0,
      creatorFeeBp: 0,
      rewardPoolFeeBp: 0,
      marketConfig: {
        rewardAmount,
        timeToStake: 8n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const user = platform.participants[0];
    await platform.openMarket();
    const { optionId: optA } = await platform.addOption();
    const { optionId: optC } = await platform.addOption();

    const saA = await platform.stakeOnOption(user, 50_000_000n, optA);

    await platform.waitForStakeEnd();
    await platform.selectWinningOptions([
      { optionId: optA, rewardBp: 6000 },
      { optionId: optC, rewardBp: 4000 },
    ]);

    await platform.revealStake(user, saA);
    await platform.finalizeRevealStake(user, optA, saA);

    const market = await platform.fetchMarket();
    expect(market.data.winningOptionActiveBp).to.equal(6000);
    expect((await platform.fetchOptionData(optC)).data.includedInActiveBp).to.be.false;

    await platform.unstake(user, saA);
    await platform.endRevealPeriod();

    const rpc = platform.getRpc();
    const before = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    await platform.closeStakeAccount(user, optA, saA);
    const after = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;

    // A=60% / C=40% winners; only A finalized → active_bp=6000 → full 1B pool (not 600M).
    expect(after - before).to.equal(1_000_000_000n);
  });

  it("blocks end_reveal_period when no winning option is finalized", async () => {
    const observer = generateX25519Keypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000n,
        timeToStake: 5n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const user = platform.participants[0];
    await platform.openMarket();
    const { optionId: optWinnerA } = await platform.addOption();
    const { optionId: optWinnerB } = await platform.addOption();
    const { optionId: optStaked } = await platform.addOption();

    await platform.stakeOnOption(user, 1000n, optStaked);

    await platform.waitForStakeEnd();
    await platform.selectWinningOptions([
      { optionId: optWinnerA, rewardBp: 5000 },
      { optionId: optWinnerB, rewardBp: 5000 },
    ]);

    const sa = platform.getUserStakeAccountsForOption(user, optStaked)[0].id;
    await platform.revealStake(user, sa);
    // Finalize on non-winner does not bump active_bp
    await platform.finalizeRevealStake(user, optStaked, sa);

    expect((await platform.fetchMarket()).data.winningOptionActiveBp).to.equal(0);

    await shouldThrowCustomError(
      () => platform.endRevealPeriod(),
      OPPORTUNITY_MARKET_ERROR__NO_FINALIZED_WINNING_OPTION,
    );
  });

  it("clears a winner with reward_bp 0 and reassigns allocation", async () => {
    const observer = generateX25519Keypair();
    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 0,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 0n,
        timeToStake: 5n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId: optA } = await platform.addOption();
    const { optionId: optB } = await platform.addOption();

    await platform.waitForStakeEnd();
    await platform.setWinningOption(optA, 10_000);
    let market = await platform.fetchMarket();
    expect(market.data.winningOptionAllocation).to.equal(10_000);
    expect((await platform.fetchOptionData(optA)).data.rewardBp).to.equal(10_000);

    await platform.setWinningOption(optA, 0);
    market = await platform.fetchMarket();
    expect(market.data.winningOptionAllocation).to.equal(0);
    expect((await platform.fetchOptionData(optA)).data.rewardBp).to.equal(0);

    await platform.setWinningOption(optB, 10_000);
    await platform.resolveMarket();

    market = await platform.fetchMarket();
    expect(market.data.winningOptionAllocation).to.equal(10_000);
    expect((await platform.fetchOptionData(optB)).data.rewardBp).to.equal(10_000);
    expect((await platform.fetchOptionData(optA)).data.rewardBp).to.equal(0);
  });
});

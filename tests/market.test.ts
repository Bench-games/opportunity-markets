import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { address, some, isNone, isSome, unwrapOption, createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory } from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { expect } from "chai";
import {
  fetchTokenVault,
  getTokenVaultAddress,
  OPPORTUNITY_MARKET_ERROR__CLOSING_EARLY_NOT_ALLOWED,
  OPPORTUNITY_MARKET_ERROR__REWARD_AMOUNT_NOT_INCREASED,
  OPPORTUNITY_MARKET_ERROR__REWARD_ALREADY_WITHDRAWN,
  OPPORTUNITY_MARKET_ERROR__STAKING_NOT_ACTIVE,
  OPPORTUNITY_MARKET_ERROR__UNSTAKE_DELAY_NOT_MET,
} from "../js/src";

import { OpportunityMarket } from "../target/types/opportunity_market";
import { TestRunner } from "./utils/test-runner";
import { initializeAllCompDefs } from "./utils/comp-defs";
import { sleepUntilOnChainTimestamp } from "./utils/sleep";
import { generateX25519Keypair, X25519Keypair } from "../js/src/x25519/keypair";
import { shouldThrowCustomError } from "./utils/errors";
import * as fs from "fs";
import * as os from "os";

const ONCHAIN_TIMESTAMP_BUFFER_SECONDS = 6;

// Environment setup
const RPC_URL = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const WS_URL = RPC_URL.replace("http", "ws").replace(":8899", ":8900");

function loadObserverKeypair(): X25519Keypair {
  const keyfilePath = process.env.TEST_OBSERVER_KEYPAIR;
  if (keyfilePath) {
    const data = JSON.parse(fs.readFileSync(keyfilePath, "utf-8"));
    return {
      secretKey: new Uint8Array(data.secretKey),
      publicKey: new Uint8Array(data.publicKey),
    };
  }
  return generateX25519Keypair();
}

describe("OpportunityMarket", () => {
  // Anchor setup
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

  it("passes full opportunity market flow", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const numParticipants = 4;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 120n,
        timeToReveal: 20n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Fund and open market
    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    // Add two options
    const { optionId: optionA } = await runner.addOption();
    const { optionId: optionB } = await runner.addOption();

    // Wait for market staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Define voting: first half vote Option A, second half vote Option B
    const stakeAmounts = [50_000_000n, 75_000_000n, 100_000_000n, 60_000_000n];
    const protocolFeeBp = 100n; // 1% fee configured in TestRunner
    const expectedFeePerUser = stakeAmounts.map(a => a * protocolFeeBp / 10_000n);
    const expectedNetPerUser = stakeAmounts.map((a, i) => a - expectedFeePerUser[i]);

    const purchases = runner.participants.map((userId, idx) => ({
      userId,
      amount: stakeAmounts[idx],
      optionId: idx < numParticipants / 2 ? optionA : optionB,
    }));
    const stakeAccountIds = await runner.stakeOnOptionBatch(purchases);

    // Verify user can decrypt their own encrypted option choice
    purchases.forEach((purchase, i) => {
      const decrypted = runner.decryptStakeOption(purchase.userId, stakeAccountIds[i]);
      expect(decrypted.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Verify observer can decrypt disclosed option choices
    purchases.forEach((purchase, i) => {
      const disclosed = runner.decryptDisclosedStakeOption(purchase.userId, stakeAccountIds[i], observer);
      expect(disclosed.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Market creator selects winning option
    const winningOptionIndex = optionA;
    await runner.selectSingleWinningOption(winningOptionIndex);

    // Verify selected option
    const resolvedMarket = await runner.fetchMarket();
    expect(resolvedMarket.data.selectedOptions).to.deep.equal(
      some([{ optionId: BigInt(winningOptionIndex), rewardPercentage: 100 }])
    );

    // Reveal stakes for winners
    const winners = runner.participants.filter(
      (userId) => runner.getUserStakeAccountsForOption(userId, winningOptionIndex).length > 0
    );
    const winnerStakeAccounts = winners.map(
      (userId) => runner.getUserStakeAccountsForOption(userId, winningOptionIndex)[0]
    );

    await runner.revealStakeBatch(
      winners.map((userId, i) => ({ userId, stakeAccountId: winnerStakeAccounts[i].id }))
    );

    // Verify revealed option for winners
    for (let i = 0; i < winners.length; i++) {
      const sa = winnerStakeAccounts[i];
      const stakeAccount = await runner.fetchStakeAccountData(winners[i], sa.id);
      expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(winningOptionIndex)));
    }

    // Increment option tally for winners
    await runner.incrementOptionTallyBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // Verify option tally (amounts are net of fees)
    const totalWinningStaked = winnerStakeAccounts.reduce((sum, sa) => {
      const idx = purchases.findIndex(p => p.userId === winners[winnerStakeAccounts.indexOf(sa)]);
      return sum + expectedNetPerUser[idx];
    }, 0n);
    const optionAccount = await runner.fetchOptionData(winningOptionIndex);
    expect(optionAccount.data.totalStaked).to.deep.equal(some(totalWinningStaked));

    // Get timestamps for reward calculation
    const updatedMarket = await runner.fetchMarket();
    const marketCloseTimestamp =
      BigInt(unwrapOption(updatedMarket.data.openTimestamp) ?? 0n) + updatedMarket.data.timeToStake;

    const winnerTimestamps = await Promise.all(
      winners.map(async (userId, i) => {
        const stakeAccount = await runner.fetchStakeAccountData(userId, winnerStakeAccounts[i].id);
        const ts = stakeAccount.data.stakedAtTimestamp;
        if (!isSome(ts)) throw new Error("stakedAtTimestamp is None");
        return ts.value;
      })
    );

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    // Reclaim staked tokens for winners (required before close_stake_account)
    await runner.reclaimStakeBatch(
      winners.map((userId, i) => ({
        userId,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // Get token balances before closing (after reclaim, so only reward transfer remains)
    const rpc = runner.getRpc();
    const marketAta = await runner.getMarketAta();

    const balancesBefore = await Promise.all(
      winners.map(async (userId) => ({
        userId,
        balance: (await fetchToken(rpc, runner.getUserTokenAccount(userId))).data.amount,
      }))
    );
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close stake accounts for winners (transfers reward only)
    await runner.closeStakeAccountBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // Verify stake accounts were closed
    for (let i = 0; i < winners.length; i++) {
      const addr = await runner.getStakeAccountAddress(winners[i], winnerStakeAccounts[i].id);
      const exists = await runner.accountExists(addr);
      expect(exists).to.be.false;
    }

    // Get token balances after closing
    const balancesAfter = await Promise.all(
      winners.map(async (userId) => ({
        userId,
        balance: (await fetchToken(rpc, runner.getUserTokenAccount(userId))).data.amount,
      }))
    );
    const marketBalanceAfter = (await fetchToken(rpc, marketAta)).data.amount;

    // Calculate gains (reward only, since staked tokens were already reclaimed)
    const gains = winners.map((userId, i) => ({
      userId,
      gain: balancesAfter[i].balance - balancesBefore[i].balance,
      staked: winnerStakeAccounts[i].amount,
    }));

    // All winners should have gained funds (reward)
    for (const { gain } of gains) {
      expect(gain > 0n).to.be.true;
    }

    // Total market loss should equal the full reward amount (tolerance of 2 for rounding)
    const marketLoss = marketBalanceBefore - marketBalanceAfter;
    expect(marketLoss >= marketFundingAmount - 2n && marketLoss <= marketFundingAmount).to.be.true;

    // Verify proportional reward distribution
    const winnerScores = gains.map(({ gain, staked }, i) => ({
      gain,
      score: staked * (marketCloseTimestamp - winnerTimestamps[i]),
    }));

    winnerScores.forEach((a, i) =>
      winnerScores.slice(i + 1).forEach((b, j) => {
        const lhs = a.gain * b.score;
        const rhs = b.gain * a.score;
        const tolerance = (lhs > rhs ? lhs : rhs) / 100n; // 1%
        expect(
          Math.abs(Number(lhs - rhs)) <= tolerance,
          `Reward ratio mismatch between winner ${i} and ${i + j + 1}: ${lhs} - ${rhs}`
        ).to.be.true;
      })
    );

    // Verify total gains equal reward amount
    const totalGains = gains.reduce((sum, { gain }) => sum + gain, 0n);
    expect(totalGains >= marketFundingAmount - 2n).to.be.true;
    expect(totalGains <= marketFundingAmount).to.be.true;

    // Verify token vault has collected fees
    const totalExpectedFees = expectedFeePerUser.reduce((sum, f) => sum + f, 0n);
    const [tokenVaultAddress] = await getTokenVaultAddress(runner.mintAddress, programId);
    const vaultBefore = await fetchTokenVault(rpc, tokenVaultAddress);
    expect(vaultBefore.data.collectedFees).to.equal(totalExpectedFees,
      `Vault should have collected ${totalExpectedFees} in fees`);

    // Get fee recipient balance before claiming
    const feeRecipientBalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(runner.creator))).data.amount;

    // Claim fees
    await runner.claimFees();

    // Verify fee recipient received the fees
    const feeRecipientBalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(runner.creator))).data.amount;
    expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(totalExpectedFees,
      `Fee recipient should have received ${totalExpectedFees} in fees`);

    // Verify vault fees reset to 0
    const vaultAfter = await fetchTokenVault(rpc, tokenVaultAddress);
    expect(vaultAfter.data.collectedFees).to.equal(0n, "Vault collected fees should be 0 after claiming");
  });

  it("distributes rewards across multiple winning options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const stakeAmount = 1000n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 120n,
        timeToReveal: 25n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    const [user1, user2] = runner.participants;

    // Create 7 options: A-G
    const options: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { optionId } = await runner.addOption();
      options.push(optionId);
    }
    const [optA, optB, optC, _optD, optE, optF, optG] = options;

    // Wait for staking period
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // User 1 stakes on A, B, C
    const u1StakeIds = await runner.stakeOnOptionBatch([
      { userId: user1, amount: stakeAmount, optionId: optA },
      { userId: user1, amount: stakeAmount, optionId: optB },
      { userId: user1, amount: stakeAmount, optionId: optC },
    ]);

    // User 2 stakes on E, F, G
    const u2StakeIds = await runner.stakeOnOptionBatch([
      { userId: user2, amount: stakeAmount, optionId: optE },
      { userId: user2, amount: stakeAmount, optionId: optF },
      { userId: user2, amount: stakeAmount, optionId: optG },
    ]);

    // Creator selects 3 winning options with different percentages: A=50%, B=30%, E=20%
    await runner.selectWinningOptions([
      { optionId: optA, rewardPercentage: 50 },
      { optionId: optB, rewardPercentage: 30 },
      { optionId: optE, rewardPercentage: 20 },
    ]);

    // Verify selected options
    const resolvedMarket = await runner.fetchMarket();
    expect(resolvedMarket.data.selectedOptions).to.deep.equal(some([
      { optionId: BigInt(optA), rewardPercentage: 50 },
      { optionId: BigInt(optB), rewardPercentage: 30 },
      { optionId: BigInt(optE), rewardPercentage: 20 },
    ]));

    // selectWinningOptions with allow_closing_early shortens time_to_stake, so reveal window starts now.
    const updatedMarket = await runner.fetchMarket();
    const updatedOpenTs = Number(unwrapOption(updatedMarket.data.openTimestamp) ?? 0n);
    const revealStart = updatedOpenTs + Number(updatedMarket.data.timeToStake);
    await sleepUntilOnChainTimestamp(revealStart + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Reveal all stake accounts
    await Promise.all([
      runner.revealStakeBatch(u1StakeIds.map(sid => ({ userId: user1, stakeAccountId: sid }))),
      runner.revealStakeBatch(u2StakeIds.map(sid => ({ userId: user2, stakeAccountId: sid }))),
    ]);

    // Increment tally for winning stake accounts only
    // User 1: A (stake 0), B (stake 1) — C is a loser
    // User 2: E (stake 0) — F, G are losers
    await Promise.all([
      runner.incrementOptionTally(user1, optA, u1StakeIds[0]),
      runner.incrementOptionTally(user1, optB, u1StakeIds[1]),
      runner.incrementOptionTally(user2, optE, u2StakeIds[0]),
    ]);

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    // Reclaim staked tokens for all accounts (required before close_stake_account)
    await runner.reclaimStakeBatch([
      ...u1StakeIds.map(sid => ({ userId: user1, stakeAccountId: sid })),
      ...u2StakeIds.map(sid => ({ userId: user2, stakeAccountId: sid })),
    ]);

    const rpc = runner.getRpc();

    // Get user1 balance before closing
    const u1BalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user1))).data.amount;

    // Close all user1 stake accounts (A, B winning; C losing)
    await runner.closeStakeAccountBatch([
      { userId: user1, optionId: optA, stakeAccountId: u1StakeIds[0] },
      { userId: user1, optionId: optB, stakeAccountId: u1StakeIds[1] },
      { userId: user1, optionId: optC, stakeAccountId: u1StakeIds[2] },
    ]);

    const u1BalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user1))).data.amount;
    const u1Gain = u1BalanceAfter - u1BalanceBefore;

    // Get user2 balance before closing
    const u2BalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user2))).data.amount;

    // Close all user2 stake accounts (E winning; F, G losing)
    await runner.closeStakeAccountBatch([
      { userId: user2, optionId: optE, stakeAccountId: u2StakeIds[0] },
      { userId: user2, optionId: optF, stakeAccountId: u2StakeIds[1] },
      { userId: user2, optionId: optG, stakeAccountId: u2StakeIds[2] },
    ]);

    const u2BalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user2))).data.amount;
    const u2Gain = u2BalanceAfter - u2BalanceBefore;

    // User 1 should receive rewards from A (50%) and B (30%) = 80% of total
    // User 2 should receive rewards from E (20%) = 20% of total
    const expectedU1Gain = marketFundingAmount * 80n / 100n;
    const expectedU2Gain = marketFundingAmount * 20n / 100n;

    // Allow tolerance of 2 for rounding
    expect(
      u1Gain >= expectedU1Gain - 2n && u1Gain <= expectedU1Gain,
      `User 1 should gain ~${expectedU1Gain} (80%), got ${u1Gain}`
    ).to.be.true;

    expect(
      u2Gain >= expectedU2Gain - 2n && u2Gain <= expectedU2Gain,
      `User 2 should gain ~${expectedU2Gain} (20%), got ${u2Gain}`
    ).to.be.true;

    // Total paid out should equal the full reward amount
    const totalGains = u1Gain + u2Gain;
    expect(
      totalGains >= marketFundingAmount - 3n && totalGains <= marketFundingAmount,
      `Total gains should be ~${marketFundingAmount}, got ${totalGains}`
    ).to.be.true;

    // All stake accounts should be closed
    for (const [userId, stakeIds] of [[user1, u1StakeIds], [user2, u2StakeIds]] as const) {
      for (const sid of stakeIds) {
        const addr = await runner.getStakeAccountAddress(userId, sid);
        expect(await runner.accountExists(addr)).to.be.false;
      }
    }
  });

  it("allows users to vote for multiple options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const stakeAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 120n,
        timeToReveal: 20n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Fund and open market
    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    // Get the single participant
    const user = runner.participants[0];

    // Create 2 options
    const { optionId: optionA } = await runner.addOption();
    const { optionId: optionB } = await runner.addOption();

    // Wait for market staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // User stakes on both options twice (4 stake accounts total)
    const stakeAccountIds = await runner.stakeOnOptionBatch([
      { userId: user, amount: stakeAmount, optionId: optionA },
      { userId: user, amount: stakeAmount, optionId: optionB },
      { userId: user, amount: stakeAmount, optionId: optionA },
      { userId: user, amount: stakeAmount, optionId: optionB },
    ]);
    const [sa0, sa1, sa2, sa3] = stakeAccountIds;

    // User now has 4 stake accounts
    const userStakeAccounts = runner.getUserStakeAccounts(user);
    expect(userStakeAccounts.length).to.equal(4);

    // Verify user can decrypt all stake accounts
    const expectedStakes = [
      { id: sa0, optionId: optionA },
      { id: sa1, optionId: optionB },
      { id: sa2, optionId: optionA },
      { id: sa3, optionId: optionB },
    ];
    expectedStakes.forEach(({ id, optionId }) => {
      const decrypted = runner.decryptStakeOption(user, id);
      expect(decrypted.optionId).to.equal(BigInt(optionId));
    });

    // Verify observer can decrypt all disclosed stakes
    expectedStakes.forEach(({ id, optionId }) => {
      const disclosed = runner.decryptDisclosedStakeOption(user, id, observer);
      expect(disclosed.optionId).to.equal(BigInt(optionId));
    });

    // Market creator selects winning option (Option A)
    const winningOptionId = optionA;
    await runner.selectSingleWinningOption(winningOptionId);

    // Wait for reveal window to start (selectSingleWinningOption truncates time_to_stake)
    const updatedMarket = await runner.fetchMarket();
    const marketOpenTs = Number(unwrapOption(updatedMarket.data.openTimestamp) ?? 0n);
    const revealStart = marketOpenTs + Number(updatedMarket.data.timeToStake);
    await sleepUntilOnChainTimestamp(revealStart + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Reveal ALL stake accounts sequentially
    for (const sa of userStakeAccounts) {
      await runner.revealStake(user, sa.id);
    }

    // Verify all stakes are revealed
    for (const sa of userStakeAccounts) {
      const stakeAccount = await runner.fetchStakeAccountData(user, sa.id);
      expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(sa.optionId)));
    }

    // Increment tally for winning option stake accounts
    const winningStakeAccounts = runner.getUserStakeAccountsForOption(user, winningOptionId);
    await runner.incrementOptionTallyBatch(
      winningStakeAccounts.map((sa) => ({
        userId: user,
        optionId: winningOptionId,
        stakeAccountId: sa.id,
      }))
    );

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    // Reclaim staked tokens for all accounts
    await runner.reclaimStakeBatch(
      userStakeAccounts.map((sa) => ({ userId: user, stakeAccountId: sa.id }))
    );

    // Get balances before closing
    const rpc = runner.getRpc();
    const userBalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;
    const marketAta = await runner.getMarketAta();
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close ALL stake accounts (both winning and losing)
    await runner.closeStakeAccountBatch(
      userStakeAccounts.map((sa) => ({
        userId: user,
        optionId: sa.optionId,
        stakeAccountId: sa.id,
      }))
    );

    // Verify all stake accounts were closed
    for (const sa of userStakeAccounts) {
      const addr = await runner.getStakeAccountAddress(user, sa.id);
      const exists = await runner.accountExists(addr);
      expect(exists).to.be.false;
    }

    // Get balances after closing
    const userBalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;
    const marketBalanceAfter = (await fetchToken(rpc, marketAta)).data.amount;

    // Calculate gains
    const userGained = userBalanceAfter - userBalanceBefore;
    const marketPaidOut = marketBalanceBefore - marketBalanceAfter;

    // User is the only participant, so they should receive the entire market reward
    expect(
      userGained >= marketFundingAmount - 1n && userGained <= marketFundingAmount,
      `User should gain ~${marketFundingAmount}, got ${userGained}`
    ).to.be.true;

    // Market should have paid out the full reward amount
    expect(
      marketPaidOut >= marketFundingAmount - 1n && marketPaidOut <= marketFundingAmount,
      `Market should pay out ~${marketFundingAmount}, paid ${marketPaidOut}`
    ).to.be.true;

    // Market ATA should be empty (or nearly empty due to rounding)
    expect(marketBalanceAfter <= 1n, `Market ATA should be empty, has ${marketBalanceAfter}`).to.be.true;
  });

  it("prevents closing market early when not allowed", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToStake = 10n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake,
        timeToReveal: 20n,
        authorizedReaderPubkey: observer.publicKey,
        allowClosingEarly: false,
      },
    });

    // Fund and open market
    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    // Add options as creator
    const { optionId: optionA } = await runner.addOption();
    await runner.addOption();

    // Wait for staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Try to select option before stake period ends - should fail
    await shouldThrowCustomError(
      () => runner.selectSingleWinningOption(optionA),
      OPPORTUNITY_MARKET_ERROR__CLOSING_EARLY_NOT_ALLOWED
    );

    // Verify market is still open (no selected option)
    let market = await runner.fetchMarket();
    expect(isNone(market.data.selectedOptions)).to.be.true;

    // Wait for stake period to end
    const stakeEndTimestamp = Number(openTimestamp) + Number(timeToStake);
    await sleepUntilOnChainTimestamp(stakeEndTimestamp + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Now selecting option should succeed
    await runner.selectSingleWinningOption(optionA);

    // Verify option was selected
    market = await runner.fetchMarket();
    expect(market.data.selectedOptions).to.deep.equal(some([{ optionId: BigInt(optionA), rewardPercentage: 100 }]));
  });

  it("allows increasing the reward pool during staking", async () => {
    const initialReward = 1_000_000_000n;
    const increasedReward = 2_000_000_000n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 5_000_000_000n,
      marketConfig: {
        rewardAmount: initialReward,
        timeToStake: 120n,
        timeToReveal: 20n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Fund with enough for the increased reward, open market
    await runner.fundMarket(increasedReward);
    const openTimestamp = await runner.openMarket();

    // Add an option so staking can happen
    await runner.addOption();

    // Wait for staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Verify initial reward amount
    let market = await runner.fetchMarket();
    expect(market.data.rewardAmount).to.equal(initialReward);

    // Increase the reward pool
    await runner.increaseRewardPool(increasedReward);

    // Verify updated reward amount
    market = await runner.fetchMarket();
    expect(market.data.rewardAmount).to.equal(increasedReward);

    // Negative: try to decrease (set to a smaller amount) — should fail
    await shouldThrowCustomError(
      () => runner.increaseRewardPool(initialReward),
      OPPORTUNITY_MARKET_ERROR__REWARD_AMOUNT_NOT_INCREASED
    );

    // Negative: try to set same amount — should fail
    await shouldThrowCustomError(
      () => runner.increaseRewardPool(increasedReward),
      OPPORTUNITY_MARKET_ERROR__REWARD_AMOUNT_NOT_INCREASED
    );
  });

  it("allows creator to withdraw reward and resolve market without winners", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToStake = 10n;
    const timeToReveal = 20n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake,
        timeToReveal,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Fund and open market
    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    // Add options
    const { optionId: optionA } = await runner.addOption();
    await runner.addOption();

    // Wait for staking period to be active, then stake
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    const user = runner.participants[0];
    const stakeAccountId = await runner.stakeOnOption(user, 50_000_000n, optionA);

    // Get creator balance before withdrawal
    const rpc = runner.getRpc();
    const creatorBalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(runner.creator))).data.amount;

    // Withdraw reward
    await runner.withdrawReward();

    // Verify creator received the reward tokens back
    const creatorBalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(runner.creator))).data.amount;
    expect(creatorBalanceAfter - creatorBalanceBefore).to.equal(marketFundingAmount);

    // Verify market state
    const market = await runner.fetchMarket();
    expect(market.data.rewardWithdrawn).to.be.true;
    expect(market.data.rewardAmount).to.equal(0n);
    expect(isNone(market.data.selectedOptions)).to.be.true;

    // Cannot withdraw again
    await shouldThrowCustomError(
      () => runner.withdrawReward(),
      OPPORTUNITY_MARKET_ERROR__REWARD_ALREADY_WITHDRAWN
    );

    // Cannot select winners after withdrawal
    await shouldThrowCustomError(
      () => runner.selectSingleWinningOption(optionA),
      OPPORTUNITY_MARKET_ERROR__REWARD_ALREADY_WITHDRAWN
    );

    // Wait for reveal period to end so close_stake_account is allowed
    // withdraw_reward truncates time_to_stake, so fetch the updated market state
    const updatedMarket = await runner.fetchMarket();
    const updatedOpenTs = Number(unwrapOption(updatedMarket.data.openTimestamp) ?? 0n);
    const revealEnd = updatedOpenTs + Number(updatedMarket.data.timeToStake) + Number(updatedMarket.data.timeToReveal);
    await sleepUntilOnChainTimestamp(revealEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Reclaim staked tokens (required before closing, even when reward is withdrawn)
    const userBalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;
    await runner.reclaimStake(user, stakeAccountId);
    const userBalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;

    // Verify user received staked tokens back (50M minus 1% protocol fee = 49.5M)
    const stakeAmount = 50_000_000n;
    const protocolFeeBp = 100n;
    const expectedNet = stakeAmount - (stakeAmount * protocolFeeBp / 10_000n);
    expect(userBalanceAfter - userBalanceBefore).to.equal(expectedNet,
      `User should receive ${expectedNet} staked tokens back after reclaim`);

    // Close stake account WITHOUT revealing — allowed when reward is withdrawn
    await runner.closeStakeAccount(user, optionA, stakeAccountId);

    // Verify stake account was closed
    const addr = await runner.getStakeAccountAddress(user, stakeAccountId);
    expect(await runner.accountExists(addr)).to.be.false;
  });

  it("rejects staking before staking period is active", async () => {
    const marketFundingAmount = 1_000_000_000n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 120n,
        timeToReveal: 20n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await runner.fundMarket();

    // Open market with a timestamp far in the future so staking is not yet active
    const futureTimestamp = BigInt(Math.floor(Date.now() / 1000) + 600);
    await runner.openMarket(futureTimestamp);

    const user = runner.participants[0];

    // Add options
    const { optionId: optionA } = await runner.addOption();
    await runner.addOption();

    // Try to stake before staking period starts — should fail
    await shouldThrowCustomError(
      () => runner.stakeOnOption(user, 50_000_000n, optionA),
      OPPORTUNITY_MARKET_ERROR__STAKING_NOT_ACTIVE
    );
  });

  it("allows early unstaking with delay", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const unstakeDelaySeconds = 10n;
    const timeToStake = 30n;
    const stakeAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const runner = await TestRunner.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake,
        timeToReveal: 20n,
        unstakeDelaySeconds,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Fund and open market
    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    const [staker, executor] = runner.participants;

    // Add options
    const { optionId: optionA } = await runner.addOption();
    await runner.addOption();

    // Wait for staking period and stake
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    const rpc = runner.getRpc();
    const balanceBeforeStake = (await fetchToken(rpc, runner.getUserTokenAccount(staker))).data.amount;

    const stakeAccountId = await runner.stakeOnOption(staker, stakeAmount, optionA);

    // Verify token balance decreased after staking
    const balanceAfterStake = (await fetchToken(rpc, runner.getUserTokenAccount(staker))).data.amount;
    expect(balanceBeforeStake - balanceAfterStake).to.equal(stakeAmount);

    // Verify initial state
    let stakeAccount = await runner.fetchStakeAccountData(staker, stakeAccountId);
    expect(isNone(stakeAccount.data.unstakeableAtTimestamp)).to.be.true;
    expect(isNone(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Initiate early unstake (sets unstakeableAtTimestamp)
    await runner.unstakeEarly(staker, stakeAccountId);

    stakeAccount = await runner.fetchStakeAccountData(staker, stakeAccountId);
    expect(isSome(stakeAccount.data.unstakeableAtTimestamp)).to.be.true;
    expect(isNone(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Execute unstake too early — should fail
    await shouldThrowCustomError(
      () => runner.doUnstakeEarly(executor, staker, stakeAccountId),
      OPPORTUNITY_MARKET_ERROR__UNSTAKE_DELAY_NOT_MET
    );

    // Wait for unstake delay to pass
    const unstakeableAt = unwrapOption(stakeAccount.data.unstakeableAtTimestamp);
    if (!unstakeableAt) throw new Error("unstakeableAtTimestamp is None");
    await sleepUntilOnChainTimestamp(Number(unstakeableAt) + 1);

    // Execute unstake (permissionless — different user can call)
    const balanceBeforeUnstake = (await fetchToken(rpc, runner.getUserTokenAccount(staker))).data.amount;
    await runner.doUnstakeEarly(executor, staker, stakeAccountId);

    stakeAccount = await runner.fetchStakeAccountData(staker, stakeAccountId);
    expect(isSome(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Verify staker received tokens back (net of 1% protocol fee)
    const balanceAfterUnstake = (await fetchToken(rpc, runner.getUserTokenAccount(staker))).data.amount;
    const protocolFeeBp = 100n;
    const expectedNet = stakeAmount - (stakeAmount * protocolFeeBp / 10_000n);
    expect(balanceAfterUnstake - balanceBeforeUnstake).to.equal(expectedNet);

    // Select winner and wait for stake period to end
    await runner.selectSingleWinningOption(optionA);
    const stakeEndTimestamp = Number(openTimestamp) + Number(timeToStake);
    await sleepUntilOnChainTimestamp(stakeEndTimestamp + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Reveal stake
    await runner.revealStake(staker, stakeAccountId);
    stakeAccount = await runner.fetchStakeAccountData(staker, stakeAccountId);
    expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(optionA)));
  });
});

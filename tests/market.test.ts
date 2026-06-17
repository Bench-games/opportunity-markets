import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { address, some, isNone, isSome, createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory } from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { expect } from "chai";
import {
  OPPORTUNITY_MARKET_ERROR__ALREADY_UNSTAKED,
  OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
  OPPORTUNITY_MARKET_ERROR__STAKE_BELOW_MINIMUM,
  OPPORTUNITY_MARKET_ERROR__INVALID_PARAMETERS,
  OPPORTUNITY_MARKET_ERROR__OPTION_STILL_NEEDED,
  OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
  OPPORTUNITY_MARKET_ERROR__LOCKED,
} from "../js/src";

import { OpportunityMarket } from "../target/types/opportunity_market";
import { Platform } from "./utils/platform";
import { initializeAllCompDefs } from "./utils/comp-defs";
import { getWalletSecretKey } from "./utils/deployer";
import { sleepUntilOnChainTimestamp } from "./utils/sleep";
import { generateX25519Keypair, X25519Keypair } from "../js/src/x25519/keypair";
import { shouldThrowCustomError } from "./utils/errors";
import * as fs from "fs";

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

describe("Opportunity markets", () => {
  // Anchor setup
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.OpportunityMarket as Program<OpportunityMarket>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const programId = address(program.programId.toBase58());

  before(async () => {
    const secretKey = getWalletSecretKey();

    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    await initializeAllCompDefs(rpc, sendAndConfirmTransaction, secretKey, programId);
  });

  it("passes full opportunity market flow", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const numParticipants = 4;
    const platformFeeBp = 100n; // 1%
    const creatorFeeBp = 50n;  // 0.5%

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      platformFeeBp: Number(platformFeeBp),
      creatorFeeBp: Number(creatorFeeBp),
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });
    const rpc = platform.getRpc();

    // Open market
    await platform.openMarket();

    // Add two options
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();
    // First half stake on Option A, second half stake on Option B
    const stakeAmounts = [50_000_000n, 75_000_000n, 100_000_000n, 60_000_000n];
    const expectedPlatformFeePerUser = stakeAmounts.map(a => a * platformFeeBp / 10_000n);
    const expectedCreatorFeePerUser = stakeAmounts.map(a => a * creatorFeeBp / 10_000n);
    const expectedNetPerUser = stakeAmounts.map(
      (a, i) => a - expectedPlatformFeePerUser[i] - expectedCreatorFeePerUser[i],
    );

    const stakes = platform.participants.map((userId, idx) => ({
      userId,
      amount: stakeAmounts[idx],
      optionId: idx < numParticipants / 2 ? optionA : optionB,
    }));
    const stakeAccountIds = await platform.stakeOnOptionBatch(stakes);

    // Verify user can decrypt their own encrypted option choice
    stakes.forEach((purchase, i) => {
      const decrypted = platform.decryptStakeOption(purchase.userId, stakeAccountIds[i]);
      expect(decrypted.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Verify observer can decrypt disclosed option choices
    stakes.forEach((purchase, i) => {
      const disclosed = platform.decryptDisclosedStakeOption(purchase.userId, stakeAccountIds[i], observer);
      expect(disclosed.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Negative check: creator fees cannot be claimed before winners are selected
    await shouldThrowCustomError(
      () => platform.claimCreatorFees(),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // Market creator selects winning option
    await platform.waitForStakeEnd();
    const winningOptionIndex = optionA;
    await platform.selectSingleWinningOption(winningOptionIndex);

    // Verify market is resolved and the winning option carries 100% allocation.
    const resolvedMarket = await platform.fetchMarket();
    expect(isSome(resolvedMarket.data.resolvedAtTimestamp)).to.be.true;
    expect(resolvedMarket.data.winningOptionAllocation).to.equal(10_000);
    const winningOption = await platform.fetchOptionData(winningOptionIndex);
    expect(winningOption.data.rewardBp).to.equal(10_000);

    // Reveal stakes for winners
    const winners = platform.participants.filter(
      (userId) => platform.getUserStakeAccountsForOption(userId, winningOptionIndex).length > 0
    );
    const winnerStakeAccounts = winners.map(
      (userId) => platform.getUserStakeAccountsForOption(userId, winningOptionIndex)[0]
    );

    await platform.revealStakeBatch(
      winners.map((userId, i) => ({ userId, stakeAccountId: winnerStakeAccounts[i].id }))
    );

    // Verify revealed option for winners
    for (let i = 0; i < winners.length; i++) {
      const sa = winnerStakeAccounts[i];
      const stakeAccount = await platform.fetchStakeAccountData(winners[i], sa.id);
      expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(winningOptionIndex)));
    }

    // Finalize stake reveal for winners
    await platform.finalizeRevealStakeBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // Verify option tally equals sum of all stake on it
    const totalWinningStaked = winnerStakeAccounts.reduce((sum, sa) => {
      const idx = stakes.findIndex(p => p.userId === winners[winnerStakeAccounts.indexOf(sa)]);
      return sum + expectedNetPerUser[idx];
    }, 0n);
    const optionAccount = await platform.fetchOptionData(winningOptionIndex);
    expect(optionAccount.data.unclaimedStake).to.equal(totalWinningStaked);

    // Reclaim staked tokens for winners
    await platform.unstakeBatch(
      winners.map((userId, i) => ({
        userId,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // Get timestamps for reward calculation
    const optionCreatedTimestamp = (await platform.fetchOptionData(winningOptionIndex)).data.createdAt;

    const winnerTimestamps = await Promise.all(
      winners.map(async (userId, i) => {
        const stakeAccount = await platform.fetchStakeAccountData(userId, winnerStakeAccounts[i].id);
        const ts = stakeAccount.data.stakedAtTimestamp;
        if (!isSome(ts)) throw new Error("stakedAtTimestamp is None");
        return ts.value;
      })
    );

    // Options cannot be closed while the reveal period is still open.
    await shouldThrowCustomError(
      () => platform.closeOptionAccount(winningOptionIndex),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );
    await shouldThrowCustomError(
      () => platform.closeOptionAccount(optionB),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    await platform.endRevealPeriod();

    // Losing option with no finalized tally can be closed after the reveal period ends.
    await platform.closeOptionAccount(optionB);
    const optionBAddress = await platform.getOptionAddress(optionB);
    expect(await platform.accountExists(optionBAddress)).to.be.false;

    // After the reveal period ends, the market creator can claim the accumulated creator fees.
    const winnerIndices = stakes
      .map((p, idx) => (p.optionId === winningOptionIndex ? idx : -1))
      .filter((idx) => idx !== -1);
    const sumWinnerCreatorFees = winnerIndices.reduce(
      (sum, idx) => sum + expectedCreatorFeePerUser[idx],
      0n,
    );
    const totalExpectedCreatorFees = expectedCreatorFeePerUser.reduce((sum, f) => sum + f, 0n);
    const claimableCreatorFees = totalExpectedCreatorFees - sumWinnerCreatorFees;

    const creatorBalanceBeforeCreatorFee = (
      await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))
    ).data.amount;
    await platform.claimCreatorFees();
    const creatorBalanceAfterCreatorFee = (
      await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))
    ).data.amount;
    expect(creatorBalanceAfterCreatorFee - creatorBalanceBeforeCreatorFee).to.equal(
      claimableCreatorFees,
      `Market creator should have received ${claimableCreatorFees} in creator fees (losers only)`,
    );

    const marketAfterCreatorClaim = await platform.fetchMarket();
    expect(marketAfterCreatorClaim.data.collectedCreatorFees).to.equal(0n);

    // Get token balances before closing (after reclaim, so only reward transfer remains)
    const marketAta = await platform.getMarketAta();

    const balancesBefore = await Promise.all(
      winners.map(async (userId) => ({
        userId,
        balance: (await fetchToken(rpc, platform.getUserTokenAccount(userId))).data.amount,
      }))
    );
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // The winning option still cannot be closed while some stake accounts are open.
    await shouldThrowCustomError(
      () => platform.closeOptionAccount(winningOptionIndex),
      OPPORTUNITY_MARKET_ERROR__OPTION_STILL_NEEDED,
    );

    // Settle stake accounts (claim rewards, then close)
    await platform.closeStakeAccountBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        stakeAccountId: winnerStakeAccounts[i].id,
      }))
    );

    // All winning stake has been claimed.
    const optionAfterClaim = await platform.fetchOptionData(winningOptionIndex);
    expect(optionAfterClaim.data.unclaimedStake).to.equal(0n);

    // Verify stake accounts were closed
    for (let i = 0; i < winners.length; i++) {
      const addr = await platform.getStakeAccountAddress(winners[i], winnerStakeAccounts[i].id);
      const exists = await platform.accountExists(addr);
      expect(exists).to.be.false;
    }

    // Get token balances after closing
    const balancesAfter = await Promise.all(
      winners.map(async (userId) => ({
        userId,
        balance: (await fetchToken(rpc, platform.getUserTokenAccount(userId))).data.amount,
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

    // Total market loss equals the reward pool plus winners' refunded creator fees.
    const expectedMarketLoss = marketFundingAmount + sumWinnerCreatorFees;
    const marketLoss = marketBalanceBefore - marketBalanceAfter;
    expect(marketLoss >= expectedMarketLoss - 2n && marketLoss <= expectedMarketLoss).to.be.true;

    // Verify proportional reward distribution. 
    const winnerScores = gains.map(({ gain, staked }, i) => ({
      gain,
      score: staked * (winnerTimestamps[i] - optionCreatedTimestamp),
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

    // Verify total gains equal reward amount + winners' refunded creator fees
    const totalGains = gains.reduce((sum, { gain }) => sum + gain, 0n);
    expect(totalGains >= expectedMarketLoss - 2n).to.be.true;
    expect(totalGains <= expectedMarketLoss).to.be.true;

    // Verify the fee vault has collected platform fees
    const totalExpectedPlatformFees = expectedPlatformFeePerUser.reduce((sum, f) => sum + f, 0n);
    const marketBefore = await platform.fetchMarket();
    expect(marketBefore.data.collectedPlatformFees).to.equal(totalExpectedPlatformFees,
      `Market should have collected ${totalExpectedPlatformFees} in platform fees`);

    // Get fee recipient balance before claiming
    const feeRecipientBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;

    // Claim fees
    await platform.claimFees();

    // Verify fee recipient received the fees
    const feeRecipientBalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(totalExpectedPlatformFees,
      `Fee recipient should have received ${totalExpectedPlatformFees} in fees`);

    const marketAfter = await platform.fetchMarket();
    expect(marketAfter.data.collectedPlatformFees).to.equal(0n, "Market collected platform fees should be 0 after claiming");

    // Close the remaining option account
    await platform.closeOptionAccount(winningOptionIndex);

    for (const optionId of [winningOptionIndex, optionB]) {
      const addr = await platform.getOptionAddress(optionId);
      expect(await platform.accountExists(addr)).to.be.false;
    }
  });

  it("distributes rewards across multiple winning options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const stakeAmount = 1000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        // Six sequential stakes so larger time window
        timeToStake: 30n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();

    const [user1, user2] = platform.participants;

    // Create 7 options: A-G
    const options: number[] = [];
    for (let i = 0; i < 7; i++) {
      const { optionId } = await platform.addOption();
      options.push(optionId);
    }
    const [optA, optB, optC, _optD, optE, optF, optG] = options;
    // User 1 stakes on A, B, C
    const u1StakeIds = await platform.stakeOnOptionBatch([
      { userId: user1, amount: stakeAmount, optionId: optA },
      { userId: user1, amount: stakeAmount, optionId: optB },
      { userId: user1, amount: stakeAmount, optionId: optC },
    ]);

    // User 2 stakes on E, F, G
    const u2StakeIds = await platform.stakeOnOptionBatch([
      { userId: user2, amount: stakeAmount, optionId: optE },
      { userId: user2, amount: stakeAmount, optionId: optF },
      { userId: user2, amount: stakeAmount, optionId: optG },
    ]);

    // Creator selects 3 winning options with different allocations: A=50%, B=30%, E=20%.
    await platform.waitForStakeEnd();
    await platform.selectWinningOptions([
      { optionId: optA, rewardBp: 5000 },
      { optionId: optB, rewardBp: 3000 },
      { optionId: optE, rewardBp: 2000 },
    ]);

    // Verify market is resolved and each winning option carries its allocation.
    const resolvedMarket = await platform.fetchMarket();
    expect(isSome(resolvedMarket.data.resolvedAtTimestamp)).to.be.true;
    expect(resolvedMarket.data.winningOptionAllocation).to.equal(10_000);
    const expectedWinners: Array<{ optionId: number; rewardBp: number }> = [
      { optionId: optA, rewardBp: 5000 },
      { optionId: optB, rewardBp: 3000 },
      { optionId: optE, rewardBp: 2000 },
    ];
    for (const { optionId, rewardBp } of expectedWinners) {
      const opt = await platform.fetchOptionData(optionId);
      expect(opt.data.rewardBp).to.equal(rewardBp);
    }

    // Reveal all stake accounts
    await Promise.all([
      platform.revealStakeBatch(u1StakeIds.map(sid => ({ userId: user1, stakeAccountId: sid }))),
      platform.revealStakeBatch(u2StakeIds.map(sid => ({ userId: user2, stakeAccountId: sid }))),
    ]);

    // Increment tally for winning stake accounts only
    // User 1: A (stake 0), B (stake 1) — C is a loser
    // User 2: E (stake 0) — F, G are losers
    await Promise.all([
      platform.finalizeRevealStake(user1, optA, u1StakeIds[0]),
      platform.finalizeRevealStake(user1, optB, u1StakeIds[1]),
      platform.finalizeRevealStake(user2, optE, u2StakeIds[0]),
    ]);

    expect((await platform.fetchMarket()).data.winningOptionActiveBp).to.equal(10_000);

    // Reclaim staked tokens for all accounts
    await platform.unstakeBatch([
      ...u1StakeIds.map(sid => ({ userId: user1, stakeAccountId: sid })),
      ...u2StakeIds.map(sid => ({ userId: user2, stakeAccountId: sid })),
    ]);

    await platform.endRevealPeriod();

    const rpc = platform.getRpc();

    // Get user1 balance before closing
    const u1BalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user1))).data.amount;

    // Close all user1 stake accounts (A, B winning; C losing)
    await platform.closeStakeAccountBatch([
      { userId: user1, optionId: optA, stakeAccountId: u1StakeIds[0] },
      { userId: user1, optionId: optB, stakeAccountId: u1StakeIds[1] },
      { userId: user1, optionId: optC, stakeAccountId: u1StakeIds[2] },
    ]);

    const u1BalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user1))).data.amount;
    const u1Gain = u1BalanceAfter - u1BalanceBefore;

    // Get user2 balance before closing
    const u2BalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user2))).data.amount;

    // Close all user2 stake accounts (E winning; F, G losing)
    await platform.closeStakeAccountBatch([
      { userId: user2, optionId: optE, stakeAccountId: u2StakeIds[0] },
      { userId: user2, optionId: optF, stakeAccountId: u2StakeIds[1] },
      { userId: user2, optionId: optG, stakeAccountId: u2StakeIds[2] },
    ]);

    const u2BalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user2))).data.amount;
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
        const addr = await platform.getStakeAccountAddress(userId, sid);
        expect(await platform.accountExists(addr)).to.be.false;
      }
    }
  });

  it("allows users to stake on multiple options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const stakeAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Open market
    await platform.openMarket();

    // Get the single participant
    const user = platform.participants[0];

    // Create 2 options
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();
    // User stakes on both options twice (4 stake accounts total)
    const stakeAccountIds = await platform.stakeOnOptionBatch([
      { userId: user, amount: stakeAmount, optionId: optionA },
      { userId: user, amount: stakeAmount, optionId: optionB },
      { userId: user, amount: stakeAmount, optionId: optionA },
      { userId: user, amount: stakeAmount, optionId: optionB },
    ]);
    const [sa0, sa1, sa2, sa3] = stakeAccountIds;

    // User now has 4 stake accounts
    const userStakeAccounts = platform.getUserStakeAccounts(user);
    expect(userStakeAccounts.length).to.equal(4);

    // Verify user can decrypt all stake accounts
    const expectedStakes = [
      { id: sa0, optionId: optionA },
      { id: sa1, optionId: optionB },
      { id: sa2, optionId: optionA },
      { id: sa3, optionId: optionB },
    ];
    expectedStakes.forEach(({ id, optionId }) => {
      const decrypted = platform.decryptStakeOption(user, id);
      expect(decrypted.optionId).to.equal(BigInt(optionId));
    });

    // Verify observer can decrypt all disclosed stakes
    expectedStakes.forEach(({ id, optionId }) => {
      const disclosed = platform.decryptDisclosedStakeOption(user, id, observer);
      expect(disclosed.optionId).to.equal(BigInt(optionId));
    });

    // Market creator selects winning option (Option A)
    await platform.waitForStakeEnd();
    const winningOptionId = optionA;
    await platform.selectSingleWinningOption(winningOptionId);

    // Reveal ALL stake accounts sequentially
    for (const sa of userStakeAccounts) {
      await platform.revealStake(user, sa.id);
    }

    // Verify all stakes are revealed
    for (const sa of userStakeAccounts) {
      const stakeAccount = await platform.fetchStakeAccountData(user, sa.id);
      expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(sa.optionId)));
    }

    // Increment tally for winning option stake accounts
    const winningStakeAccounts = platform.getUserStakeAccountsForOption(user, winningOptionId);
    await platform.finalizeRevealStakeBatch(
      winningStakeAccounts.map((sa) => ({
        userId: user,
        optionId: winningOptionId,
        stakeAccountId: sa.id,
      }))
    );

    // Reclaim staked tokens for all accounts
    await platform.unstakeBatch(
      userStakeAccounts.map((sa) => ({ userId: user, stakeAccountId: sa.id }))
    );

    await platform.endRevealPeriod();

    // Get balances before closing
    const rpc = platform.getRpc();
    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const marketAta = await platform.getMarketAta();
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close ALL stake accounts (both winning and losing)
    await platform.closeStakeAccountBatch(
      userStakeAccounts.map((sa) => ({
        userId: user,
        optionId: sa.optionId,
        stakeAccountId: sa.id,
      }))
    );

    // Verify all stake accounts were closed
    for (const sa of userStakeAccounts) {
      const addr = await platform.getStakeAccountAddress(user, sa.id);
      const exists = await platform.accountExists(addr);
      expect(exists).to.be.false;
    }

    // Get balances after closing
    const userBalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
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

    const marketStateAfter = await platform.fetchMarket();
    const collectedFees = marketStateAfter.data.collectedPlatformFees;
    expect(
      marketBalanceAfter <= collectedFees + 1n,
      `Market ATA should hold only collected platform fees (~${collectedFees}), has ${marketBalanceAfter}`
    ).to.be.true;
  });

  it("rejects resolve_market when winning option allocation does not sum to 100", async () => {
    const marketFundingAmount = 1_000_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = await platform.openMarket();
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();

    //  Wait until stake is over so we can resolve the market
    await sleepUntilOnChainTimestamp(Number(stakeEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Under (5000 + 3000 = 8000 bp): resolve must reject.
    await platform.setWinningOption(optionA, 5000);
    await platform.setWinningOption(optionB, 3000);

    let market = await platform.fetchMarket();
    expect(market.data.winningOptionAllocation).to.equal(8000);

    await shouldThrowCustomError(
      () => platform.resolveMarket(),
      OPPORTUNITY_MARKET_ERROR__INVALID_PARAMETERS,
    );

    market = await platform.fetchMarket();
    expect(isNone(market.data.resolvedAtTimestamp)).to.be.true;

    // Over (8000 + 3000 = 11000 bp): set must reject before allocation moves.
    await shouldThrowCustomError(
      () => platform.setWinningOption(optionA, 8000),
      OPPORTUNITY_MARKET_ERROR__INVALID_PARAMETERS,
    );

    market = await platform.fetchMarket();
    expect(market.data.winningOptionAllocation).to.equal(8000);

    // Correcting optionA up to exactly 7000 bp brings the total to 10_000 and resolve succeeds.
    await platform.setWinningOption(optionA, 7000);
    await platform.resolveMarket();

    market = await platform.fetchMarket();
    expect(isSome(market.data.resolvedAtTimestamp)).to.be.true;
    expect(market.data.winningOptionAllocation).to.equal(10_000);
  });

  it("rejects setting winning option before stake period ends", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToStake = 10n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Open market
    const stakeEnd = await platform.openMarket();

    // Add options as creator
    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();
    // Try to select option before stake period ends - should fail
    await shouldThrowCustomError(
      () => platform.selectSingleWinningOption(optionA),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // Verify market is still unresolved
    let market = await platform.fetchMarket();
    expect(isNone(market.data.resolvedAtTimestamp)).to.be.true;

    // Wait for stake period to end
    await sleepUntilOnChainTimestamp(Number(stakeEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Now selecting option should succeed
    await platform.selectSingleWinningOption(optionA);

    // Verify option was selected and market resolved
    market = await platform.fetchMarket();
    expect(isSome(market.data.resolvedAtTimestamp)).to.be.true;
    expect(market.data.winningOptionAllocation).to.equal(10_000);
    const optionAAccount = await platform.fetchOptionData(optionA);
    expect(optionAAccount.data.rewardBp).to.equal(10_000);
  });

  it("allows adding more reward during staking", async () => {
    const initialReward = 1_000_000_000n;
    const additionalReward = 1_000_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 5_000_000_000n,
      marketConfig: {
        rewardAmount: initialReward,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();

    // Add an option so staking can happen
    await platform.addOption();
    // Verify initial reward amount
    let market = await platform.fetchMarket();
    expect(market.data.rewardAmount).to.equal(initialReward);

    // Add more reward from creator
    await platform.addReward(platform.creator, additionalReward);

    // Verify updated reward amount
    market = await platform.fetchMarket();
    expect(market.data.rewardAmount).to.equal(initialReward + additionalReward);
  });

  it("early unstaking works as expected", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToStake = 30n;
    const stakeAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      platformFeeBp: 100,
      creatorFeeBp: 100,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = await platform.openMarket();

    const [staker] = platform.participants;

    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();
    const rpc = platform.getRpc();
    const balanceBeforeStake = (await fetchToken(rpc, platform.getUserTokenAccount(staker))).data.amount;

    const stakeAccountId = await platform.stakeOnOption(staker, stakeAmount, optionA);

    const balanceAfterStake = (await fetchToken(rpc, platform.getUserTokenAccount(staker))).data.amount;
    expect(balanceBeforeStake - balanceAfterStake).to.equal(stakeAmount);

    let stakeAccount = await platform.fetchStakeAccountData(staker, stakeAccountId);
    expect(isNone(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Unstake during the staking window.
    await platform.unstake(staker, stakeAccountId);

    // Early unstake records the shortened staking window for scoring.
    stakeAccount = await platform.fetchStakeAccountData(staker, stakeAccountId);
    expect(isSome(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Only the net stake is refunded: 1% platform fee and the 1% creator fee are forfeit
    const balanceAfterUnstake = (await fetchToken(rpc, platform.getUserTokenAccount(staker))).data.amount;
    const platformFee = stakeAmount * 100n / 10_000n;
    const creatorFee = stakeAmount * 100n / 10_000n;
    const expectedNet = stakeAmount - platformFee - creatorFee;
    expect(balanceAfterUnstake - balanceBeforeStake + stakeAmount).to.equal(expectedNet);

    // The creator fee collected at stake time stays with the market
    const marketAfterUnstake = await platform.fetchMarket();
    expect(marketAfterUnstake.data.collectedCreatorFees).to.equal(creatorFee);

    // Double unstake should fail.
    await shouldThrowCustomError(
      () => platform.unstake(staker, stakeAccountId),
      OPPORTUNITY_MARKET_ERROR__ALREADY_UNSTAKED,
    );

    await sleepUntilOnChainTimestamp(Number(stakeEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionA);

    // Reveal works
    await platform.revealStake(staker, stakeAccountId);
    stakeAccount = await platform.fetchStakeAccountData(staker, stakeAccountId);
    expect(stakeAccount.data.revealedOption).to.deep.equal(some(BigInt(optionA)));
  });

  it("staking becomes permissionless only after stake period", async () => {
    const timeToStake = 12n;
    const stakeAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = await platform.openMarket();

    const [staker, thirdParty] = platform.participants;
    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();

    const stakeAccountId = await platform.stakeOnOption(staker, stakeAmount, optionA);

    // While stake window is open, only the owner may unstake
    await shouldThrowCustomError(
      () => platform.unstake(staker, stakeAccountId, thirdParty),
      OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
    );

    let stakeAccount = await platform.fetchStakeAccountData(staker, stakeAccountId);
    expect(isNone(stakeAccount.data.unstakedAtTimestamp)).to.be.true;

    // Once stake_end has passed, unstake is permissionless
    await sleepUntilOnChainTimestamp(Number(stakeEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.unstake(staker, stakeAccountId, thirdParty);

    stakeAccount = await platform.fetchStakeAccountData(staker, stakeAccountId);
    expect(isSome(stakeAccount.data.unstakedAtTimestamp)).to.be.true;
  });

  it("can close a stuck stake account and refund", async () => {
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const [user] = platform.participants;
    const rpc = platform.getRpc();
    const stakeAmount = 100_000_000n;

    // Record balances before
    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const tokenVaultAta = await platform.getMarketAta();
    const vaultAtaBalanceBefore = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    const vaultBefore = await platform.fetchMarket();

    // Stake and immediately close stuck in the same transaction
    const stakeAccountId = await platform.stakeAndCloseStuck(user, stakeAmount, optionId);

    // Verify stake account PDA no longer exists
    const stakeAccountAddress = await platform.getStakeAccountAddress(user, stakeAccountId);
    const exists = await platform.accountExists(stakeAccountAddress);
    expect(exists).to.be.false;

    // Verify user token balance is restored (full amount refunded)
    const userBalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    expect(userBalanceAfter).to.equal(userBalanceBefore,
      "User balance should be fully restored after close_stuck");

    // Verify token vault ATA balance unchanged (full amount went in and came back out)
    const vaultAtaBalanceAfter = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    expect(vaultAtaBalanceAfter).to.equal(vaultAtaBalanceBefore,
      "Token vault ATA balance should be unchanged");

    const vaultAfter = await platform.fetchMarket();
    expect(vaultAfter.data.collectedPlatformFees).to.equal(vaultBefore.data.collectedPlatformFees,
      "Market collected_platform_fees should not have changed");
  });

  it("rejects stake + unstake + close_stuck double withdraw (OM-007)", async () => {
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();

    const [victim, attacker] = platform.participants;
    const rpc = platform.getRpc();
    const victimStakeAmount = 100_000_000n;
    const attackerStakeAmount = 50_000_000n;

    await platform.stakeOnOption(victim, victimStakeAmount, optionId);

    const tokenVaultAta = await platform.getMarketAta();
    const vaultBalanceBefore = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    const attackerBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(attacker)))
      .data.amount;

    await shouldThrowCustomError(
      () => platform.stakeUnstakeAndCloseStuck(attacker, attackerStakeAmount, optionId),
      OPPORTUNITY_MARKET_ERROR__LOCKED,
    );

    const vaultBalanceAfter = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    const attackerBalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(attacker)))
      .data.amount;

    expect(vaultBalanceAfter).to.equal(
      vaultBalanceBefore,
      "market ATA should keep victim principal after blocked double-withdraw",
    );
    expect(attackerBalanceAfter).to.equal(
      attackerBalanceBefore,
      "attacker balance should be unchanged after failed exploit tx",
    );
  });

  it("collects fee components correctly", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const stakeAmount = 100_000_000n;
    const platformFeeBp = 100n;     // 1%
    const rewardPoolFeeBp = 200n;   // 2%
    const creatorFeeBp = 150n;      // 1.5%

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      platformFeeBp: Number(platformFeeBp),
      rewardPoolFeeBp: Number(rewardPoolFeeBp),
      creatorFeeBp: Number(creatorFeeBp),
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];
    const rpc = platform.getRpc();

    const expectedPlatformFee = stakeAmount * platformFeeBp / 10_000n;
    const expectedRewardPoolFee = stakeAmount * rewardPoolFeeBp / 10_000n;
    const expectedCreatorFee = stakeAmount * creatorFeeBp / 10_000n;
    const expectedNetStake =
      stakeAmount - expectedPlatformFee - expectedRewardPoolFee - expectedCreatorFee;

    const stakeAccountId = await platform.stakeOnOption(user, stakeAmount, optionId);

    // Stake account records each fee component plus the net stake.
    const stakeAccount = await platform.fetchStakeAccountData(user, stakeAccountId);
    expect(stakeAccount.data.amount).to.equal(expectedNetStake);
    expect(stakeAccount.data.collectedFees.platformFee).to.equal(expectedPlatformFee);
    expect(stakeAccount.data.collectedFees.rewardPoolFee).to.equal(expectedRewardPoolFee);
    expect(stakeAccount.data.collectedFees.creatorFee).to.equal(expectedCreatorFee);

    // Market accumulators credit each fee bucket appropriately.
    let market = await platform.fetchMarket();
    expect(market.data.collectedPlatformFees).to.equal(expectedPlatformFee);
    expect(market.data.collectedCreatorFees).to.equal(expectedCreatorFee);
    expect(market.data.rewardAmount).to.equal(marketFundingAmount + expectedRewardPoolFee);

    // Resolve the market and run through reveal/reclaim.
    await platform.waitForStakeEnd();
    await platform.selectSingleWinningOption(optionId);

    await platform.revealStake(user, stakeAccountId);
    await platform.finalizeRevealStake(user, optionId, stakeAccountId);
    await platform.unstake(user, stakeAccountId);
    await platform.endRevealPeriod();

    // Platform fee → fee_claim_authority (= creator in default Platform setup).
    const feeAuthBefore = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    await platform.claimFees();
    const feeAuthAfter = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    expect(feeAuthAfter - feeAuthBefore).to.equal(expectedPlatformFee);

    // Winner claims reward + fee refund, then closes the stake account.
    const userBalanceBeforeClose = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    await platform.claimRewards(user, optionId, stakeAccountId);
    await platform.closeRevealedStakeAccountBatch([{ userId: user, optionId, stakeAccountId }]);
    const userBalanceAfterClose = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const expectedReward = marketFundingAmount + expectedRewardPoolFee + expectedCreatorFee;
    const userGain = userBalanceAfterClose - userBalanceBeforeClose;
    expect(
      userGain >= expectedReward - 1n && userGain <= expectedReward,
      `User should receive ~${expectedReward} as reward, got ${userGain}`,
    ).to.be.true;

    // All fee accumulators drained, only dust may remain in the market ATA.
    market = await platform.fetchMarket();
    expect(market.data.collectedPlatformFees).to.equal(0n);
    expect(market.data.collectedCreatorFees).to.equal(0n);
  });

  it("expired market refunds reward_pool and creator fees", async () => {
    const stakeAmount = 100_000_000n;
    const platformFeeBp = 100n;
    const rewardPoolFeeBp = 200n;
    const creatorFeeBp = 150n;
    const marketResolutionDeadlineSeconds = 10n;
    const timeToStake = 10n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      platformFeeBp: Number(platformFeeBp),
      rewardPoolFeeBp: Number(rewardPoolFeeBp),
      creatorFeeBp: Number(creatorFeeBp),
      marketResolutionDeadlineSeconds,
      marketConfig: {
        rewardAmount: 0n,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];
    const rpc = platform.getRpc();

    const expectedPlatformFee = stakeAmount * platformFeeBp / 10_000n;
    const expectedRewardPoolFee = stakeAmount * rewardPoolFeeBp / 10_000n;
    const expectedCreatorFee = stakeAmount * creatorFeeBp / 10_000n;
    const expectedNetStake =
      stakeAmount - expectedPlatformFee - expectedRewardPoolFee - expectedCreatorFee;

    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const stakeAccountId = await platform.stakeOnOption(user, stakeAmount, optionId);

    const stakeAccount = await platform.fetchStakeAccountData(user, stakeAccountId);
    expect(stakeAccount.data.collectedFees.platformFee).to.equal(expectedPlatformFee);
    expect(stakeAccount.data.collectedFees.rewardPoolFee).to.equal(expectedRewardPoolFee);
    expect(stakeAccount.data.collectedFees.creatorFee).to.equal(expectedCreatorFee);
    expect(stakeAccount.data.amount).to.equal(expectedNetStake);

    // Wait past stake_end + market_resolution_deadline without selecting winners.
    const selectDeadline = stakeEnd + Number(marketResolutionDeadlineSeconds);
    await sleepUntilOnChainTimestamp(selectDeadline + ONCHAIN_TIMESTAMP_BUFFER_SECONDS, rpc);

    // Stake reclaim returns the net staked amount.
    await platform.unstake(user, stakeAccountId);

    // Expired path: never revealed → close_unrevealed refunds reward_pool_fee + creator_fee.
    await platform.closeUnrevealedStakeAccount(user, stakeAccountId);

    const userBalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    // Net loss equals the platform fee only — reward pool and creator fees were refunded.
    expect(userBalanceBefore - userBalanceAfter).to.equal(expectedPlatformFee);

    let market = await platform.fetchMarket();
    expect(market.data.collectedPlatformFees).to.equal(expectedPlatformFee);
    expect(market.data.collectedCreatorFees).to.equal(0n);
    expect(market.data.rewardAmount).to.equal(0n);

    // The platform fee remains claimable by the fee_claim_authority.
    const feeAuthBefore = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    await platform.claimFees();
    const feeAuthAfter = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    expect(feeAuthAfter - feeAuthBefore).to.equal(expectedPlatformFee);

    market = await platform.fetchMarket();
    expect(market.data.collectedPlatformFees).to.equal(0n);
  });

  it("expired market lets sponsors recover their deposits", async () => {
    const sponsorAmountA = 500_000_000n;
    const sponsorAmountB = 300_000_000n;
    const timeToStake = 15n;
    const marketResolutionDeadlineSeconds = 15n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketResolutionDeadlineSeconds,
      marketConfig: {
        rewardAmount: 0n,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const [sponsorA, sponsorB] = platform.participants;
    const rpc = platform.getRpc();

    const balanceBeforeA = (await fetchToken(rpc, platform.getUserTokenAccount(sponsorA))).data.amount;
    const balanceBeforeB = (await fetchToken(rpc, platform.getUserTokenAccount(sponsorB))).data.amount;

    await platform.addReward(sponsorA, sponsorAmountA);
    await platform.addReward(sponsorB, sponsorAmountB);

    let market = await platform.fetchMarket();
    expect(market.data.rewardAmount).to.equal(sponsorAmountA + sponsorAmountB);

    // Pre-open: the market has no stake window yet, so withdrawal is rejected.
    await shouldThrowCustomError(
      () => platform.withdrawReward(sponsorA),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    const stakeEnd = Number(await platform.openMarket());
    await sleepUntilOnChainTimestamp(stakeEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS, rpc);

    // Resolution window: rewards stay locked until the resolution deadline passes.
    await shouldThrowCustomError(
      () => platform.withdrawReward(sponsorB),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // After expiry without resolution, both sponsors recover their deposits in full.
    const expiredAt = stakeEnd + Number(marketResolutionDeadlineSeconds);
    await sleepUntilOnChainTimestamp(expiredAt + ONCHAIN_TIMESTAMP_BUFFER_SECONDS, rpc);

    await platform.withdrawReward(sponsorA);
    await platform.withdrawReward(sponsorB);

    const balanceAfterA = (await fetchToken(rpc, platform.getUserTokenAccount(sponsorA))).data.amount;
    const balanceAfterB = (await fetchToken(rpc, platform.getUserTokenAccount(sponsorB))).data.amount;
    expect(balanceAfterA).to.equal(balanceBeforeA);
    expect(balanceAfterB).to.equal(balanceBeforeB);

    market = await platform.fetchMarket();
    expect(market.data.rewardAmount).to.equal(0n);

    const marketAta = await platform.getMarketAta();
    const marketAtaBalance = (await fetchToken(rpc, marketAta)).data.amount;
    expect(marketAtaBalance).to.equal(0n);
  });

  it("rejects staking below the minimum stake amount", async () => {
    const minStakeAmount = 100_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
        minStakeAmount,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // Stake just below the minimum should fail
    await shouldThrowCustomError(
      () => platform.stakeOnOption(user, minStakeAmount - 1n, optionId),
      OPPORTUNITY_MARKET_ERROR__STAKE_BELOW_MINIMUM
    );

    // Stake at exactly the minimum should succeed
    const stakeAccountId = await platform.stakeOnOption(user, minStakeAmount, optionId);
    const stakeAccount = await platform.fetchStakeAccountData(user, stakeAccountId);
    expect(stakeAccount.data.amount > 0n).to.be.true;
  });

  it("reveal period authority can close immediately after resolution", async () => {
    const timeToStake = 5n;
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 0n,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // At least one stake on the winning option must be revealed before reveal period can be ended.
    const stakeAccountId = await platform.stakeOnOption(user, 1_000_000_000n, optionId);
    await sleepUntilOnChainTimestamp(stakeEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionId);
    await platform.revealStake(user, stakeAccountId);
    await platform.finalizeRevealStake(user, optionId, stakeAccountId);

    await platform.endRevealPeriod();
    expect((await platform.fetchMarket()).data.revealEnded).to.be.true;
  });

  it("non-authority cannot close reveal period before reveal_period_seconds", async () => {
    const timeToStake = 5n;
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 0n,
        timeToStake,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const stakeEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // At least one stake on the winning option must be revealed before reveal period can be ended.
    const stakeAccountId = await platform.stakeOnOption(user, 1_000_000_000n, optionId);
    await sleepUntilOnChainTimestamp(stakeEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionId);
    await platform.revealStake(user, stakeAccountId);
    await platform.finalizeRevealStake(user, optionId, stakeAccountId);

    const nonAuthority = platform.getUserSigner(platform.participants[0]);
    await shouldThrowCustomError(
      () => platform.endRevealPeriod(nonAuthority),
      OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
    );

    await platform.endRevealPeriod();
    expect((await platform.fetchMarket()).data.revealEnded).to.be.true;
  });

  it("winner takes all when fees sum up to 100%", async () => {
    // Fees consume all but 1 bp of the stake; net remains so unstake can run.
    const platformFeeBp = 100;
    const creatorFeeBp = 100;
    const rewardPoolFeeBp = 9799;

    const stakeAmount = 100_000_000_000n;
    const expectedPoolFee = stakeAmount * BigInt(rewardPoolFeeBp) / 10_000n;
    const expectedPlatformFee = stakeAmount * BigInt(platformFeeBp) / 10_000n;
    const expectedCreatorFee = stakeAmount * BigInt(creatorFeeBp) / 10_000n;
    const expectedNetStake =
      stakeAmount - expectedPlatformFee - expectedPoolFee - expectedCreatorFee;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 1_000_000_000_000n,
      platformFeeBp,
      rewardPoolFeeBp,
      creatorFeeBp,
      marketConfig: {
        // No initial reward — the entire winning pool is the loser's contribution.
        rewardAmount: 0n,
        timeToStake: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const [staker1, staker2] = platform.participants;
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();
    const [sa1, sa2] = await platform.stakeOnOptionBatch([
      { userId: staker1, amount: stakeAmount, optionId: optionA },
      { userId: staker2, amount: stakeAmount, optionId: optionB },
    ]);

    const marketAfterStakes = await platform.fetchMarket();
    expect(marketAfterStakes.data.rewardAmount).to.equal(expectedPoolFee * 2n);
    expect(marketAfterStakes.data.collectedPlatformFees).to.equal(expectedPlatformFee * 2n);
    expect(marketAfterStakes.data.collectedCreatorFees).to.equal(expectedCreatorFee * 2n);

    // Stake accounts retain 1 bp net; the rest went to fees.
    expect((await platform.fetchStakeAccountData(staker1, sa1)).data.amount).to.equal(expectedNetStake);
    expect((await platform.fetchStakeAccountData(staker2, sa2)).data.amount).to.equal(expectedNetStake);

    // Resolve with option A as the sole winner.
    await platform.waitForStakeEnd();
    await platform.selectSingleWinningOption(optionA);

    // Both stakes can be revealed.
    await platform.revealStakeBatch([
      { userId: staker1, stakeAccountId: sa1 },
      { userId: staker2, stakeAccountId: sa2 },
    ]);
    expect((await platform.fetchStakeAccountData(staker1, sa1)).data.revealedOption)
      .to.deep.equal(some(BigInt(optionA)));
    expect((await platform.fetchStakeAccountData(staker2, sa2)).data.revealedOption)
      .to.deep.equal(some(BigInt(optionB)));

    await platform.finalizeRevealStakeBatch([
      { userId: staker1, optionId: optionA, stakeAccountId: sa1 },
      { userId: staker2, optionId: optionB, stakeAccountId: sa2 },
    ]);

    const marketAfterFinalize = await platform.fetchMarket();
    expect(marketAfterFinalize.data.rewardAmount).to.equal(expectedPoolFee);
    expect(marketAfterFinalize.data.collectedCreatorFees).to.equal(expectedCreatorFee);

    // Unstake returns the negligible net stake; the reward pool holds the rest.
    const rpc = platform.getRpc();
    const bal1BeforeUnstake = (await fetchToken(rpc, platform.getUserTokenAccount(staker1))).data.amount;
    const bal2BeforeUnstake = (await fetchToken(rpc, platform.getUserTokenAccount(staker2))).data.amount;
    await platform.unstakeBatch([
      { userId: staker1, stakeAccountId: sa1 },
      { userId: staker2, stakeAccountId: sa2 },
    ]);
    const bal1AfterUnstake = (await fetchToken(rpc, platform.getUserTokenAccount(staker1))).data.amount;
    const bal2AfterUnstake = (await fetchToken(rpc, platform.getUserTokenAccount(staker2))).data.amount;
    expect(bal1AfterUnstake - bal1BeforeUnstake).to.equal(expectedNetStake);
    expect(bal2AfterUnstake - bal2BeforeUnstake).to.equal(expectedNetStake);

    await platform.endRevealPeriod();

    await platform.closeStakeAccountBatch([
      { userId: staker1, optionId: optionA, stakeAccountId: sa1 },
      { userId: staker2, optionId: optionB, stakeAccountId: sa2 },
    ]);

    const bal1AfterClose = (await fetchToken(rpc, platform.getUserTokenAccount(staker1))).data.amount;
    const bal2AfterClose = (await fetchToken(rpc, platform.getUserTokenAccount(staker2))).data.amount;

    const expectedWinnerCloseGain = 2n * expectedPoolFee + expectedCreatorFee;
    expect(bal1AfterClose - bal1AfterUnstake).to.equal(expectedWinnerCloseGain);
    expect(bal2AfterClose - bal2AfterUnstake).to.equal(0n);

    expect(await platform.accountExists(await platform.getStakeAccountAddress(staker1, sa1))).to.be.false;
    expect(await platform.accountExists(await platform.getStakeAccountAddress(staker2, sa2))).to.be.false;
  });
});

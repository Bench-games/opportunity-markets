import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { address, some, isNone, isSome, createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory } from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { expect } from "chai";
import {
  OPPORTUNITY_MARKET_ERROR__ALREADY_UNVOUCHED,
  OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
  OPPORTUNITY_MARKET_ERROR__VOUCH_BELOW_MINIMUM,
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
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });
    const rpc = platform.getRpc();

    // Open market
    await platform.openMarket();

    // Add two options
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();
    // First half vouch on Option A, second half vouch on Option B
    const vouchAmounts = [50_000_000n, 75_000_000n, 100_000_000n, 60_000_000n];
    const expectedPlatformFeePerUser = vouchAmounts.map(a => a * platformFeeBp / 10_000n);
    const expectedCreatorFeePerUser = vouchAmounts.map(a => a * creatorFeeBp / 10_000n);
    const expectedNetPerUser = vouchAmounts.map(
      (a, i) => a - expectedPlatformFeePerUser[i] - expectedCreatorFeePerUser[i],
    );

    const vouches = platform.participants.map((userId, idx) => ({
      userId,
      amount: vouchAmounts[idx],
      optionId: idx < numParticipants / 2 ? optionA : optionB,
    }));
    const vouchAccountIds = await platform.vouchOnOptionBatch(vouches);

    // Verify user can decrypt their own encrypted option choice
    vouches.forEach((purchase, i) => {
      const decrypted = platform.decryptVouchOption(purchase.userId, vouchAccountIds[i]);
      expect(decrypted.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Verify observer can decrypt disclosed option choices
    vouches.forEach((purchase, i) => {
      const disclosed = platform.decryptDisclosedVouchOption(purchase.userId, vouchAccountIds[i], observer);
      expect(disclosed.optionId).to.equal(BigInt(purchase.optionId));
    });

    // Negative check: creator fees cannot be claimed before winners are selected
    await shouldThrowCustomError(
      () => platform.claimCreatorFees(),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // Market creator selects winning option
    await platform.waitForVouchEnd();
    const winningOptionIndex = optionA;
    await platform.selectSingleWinningOption(winningOptionIndex);

    // Verify market is resolved and the winning option carries 100% allocation.
    const resolvedMarket = await platform.fetchMarket();
    expect(isSome(resolvedMarket.data.resolvedAtTimestamp)).to.be.true;
    expect(resolvedMarket.data.winningOptionAllocation).to.equal(10_000);
    const winningOption = await platform.fetchOptionData(winningOptionIndex);
    expect(winningOption.data.rewardBp).to.equal(10_000);

    // Reveal vouches for winners
    const winners = platform.participants.filter(
      (userId) => platform.getUserVouchAccountsForOption(userId, winningOptionIndex).length > 0
    );
    const winnerVouchAccounts = winners.map(
      (userId) => platform.getUserVouchAccountsForOption(userId, winningOptionIndex)[0]
    );

    await platform.revealVouchBatch(
      winners.map((userId, i) => ({ userId, vouchAccountId: winnerVouchAccounts[i].id }))
    );

    // Verify revealed option for winners
    for (let i = 0; i < winners.length; i++) {
      const sa = winnerVouchAccounts[i];
      const vouchAccount = await platform.fetchVouchAccountData(winners[i], sa.id);
      expect(vouchAccount.data.revealedOption).to.deep.equal(some(BigInt(winningOptionIndex)));
    }

    // Finalize vouch reveal for winners
    await platform.finalizeRevealVouchBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        vouchAccountId: winnerVouchAccounts[i].id,
      }))
    );

    // Verify option tally equals sum of gross vouch on it (net + collected fees)
    const totalWinningGrossVouched = winnerVouchAccounts.reduce((sum, sa) => {
      const idx = vouches.findIndex(p => p.userId === winners[winnerVouchAccounts.indexOf(sa)]);
      return sum + vouchAmounts[idx];
    }, 0n);
    const optionAccount = await platform.fetchOptionData(winningOptionIndex);
    expect(optionAccount.data.unclaimedGrossVouch).to.equal(totalWinningGrossVouched);

    // Reclaim vouched tokens for winners
    await platform.unvouchBatch(
      winners.map((userId, i) => ({
        userId,
        vouchAccountId: winnerVouchAccounts[i].id,
      }))
    );

    // Get timestamps for reward calculation
    const optionCreatedTimestamp = (await platform.fetchOptionData(winningOptionIndex)).data.createdAt;

    const winnerTimestamps = await Promise.all(
      winners.map(async (userId, i) => {
        const vouchAccount = await platform.fetchVouchAccountData(userId, winnerVouchAccounts[i].id);
        const ts = vouchAccount.data.vouchedAtTimestamp;
        if (!isSome(ts)) throw new Error("vouchedAtTimestamp is None");
        return ts.value;
      })
    );

    // Options cannot be closed while the reveal period is still open.
    await shouldThrowCustomError(
      () => platform.closeOptionAccount(winningOptionIndex),
      OPPORTUNITY_MARKET_ERROR__OPTION_STILL_NEEDED,
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
    const winnerIndices = vouches
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

    // The winning option still cannot be closed while some vouch accounts are open.
    await shouldThrowCustomError(
      () => platform.closeOptionAccount(winningOptionIndex),
      OPPORTUNITY_MARKET_ERROR__OPTION_STILL_NEEDED,
    );

    // Settle vouch accounts (claim rewards, then close)
    await platform.closeVouchAccountBatch(
      winners.map((userId, i) => ({
        userId,
        optionId: winningOptionIndex,
        vouchAccountId: winnerVouchAccounts[i].id,
      }))
    );

    // All winning vouch has been claimed.
    const optionAfterClaim = await platform.fetchOptionData(winningOptionIndex);
    expect(optionAfterClaim.data.unclaimedGrossVouch).to.equal(0n);

    // Verify vouch accounts were closed
    for (let i = 0; i < winners.length; i++) {
      const addr = await platform.getVouchAccountAddress(winners[i], winnerVouchAccounts[i].id);
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

    // Calculate gains (reward only, since vouched tokens were already reclaimed)
    const gains = winners.map((userId, i) => ({
      userId,
      gain: balancesAfter[i].balance - balancesBefore[i].balance,
      vouched: winnerVouchAccounts[i].amount,
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
    const winnerScores = gains.map(({ gain, vouched }, i) => ({
      gain,
      score: vouched * (winnerTimestamps[i] - optionCreatedTimestamp),
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
    const vouchAmount = 1000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        // Six sequential vouches so larger time window
        timeToVouch: 30n,
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
    // User 1 vouches on A, B, C
    const u1VouchIds = await platform.vouchOnOptionBatch([
      { userId: user1, amount: vouchAmount, optionId: optA },
      { userId: user1, amount: vouchAmount, optionId: optB },
      { userId: user1, amount: vouchAmount, optionId: optC },
    ]);

    // User 2 vouches on E, F, G
    const u2VouchIds = await platform.vouchOnOptionBatch([
      { userId: user2, amount: vouchAmount, optionId: optE },
      { userId: user2, amount: vouchAmount, optionId: optF },
      { userId: user2, amount: vouchAmount, optionId: optG },
    ]);

    // Creator selects 3 winning options with different allocations: A=50%, B=30%, E=20%.
    await platform.waitForVouchEnd();
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

    // Reveal all vouch accounts
    await Promise.all([
      platform.revealVouchBatch(u1VouchIds.map(sid => ({ userId: user1, vouchAccountId: sid }))),
      platform.revealVouchBatch(u2VouchIds.map(sid => ({ userId: user2, vouchAccountId: sid }))),
    ]);

    // Increment tally for winning vouch accounts only
    // User 1: A (vouch 0), B (vouch 1) — C is a loser
    // User 2: E (vouch 0) — F, G are losers
    await Promise.all([
      platform.finalizeRevealVouch(user1, optA, u1VouchIds[0]),
      platform.finalizeRevealVouch(user1, optB, u1VouchIds[1]),
      platform.finalizeRevealVouch(user2, optE, u2VouchIds[0]),
    ]);

    expect((await platform.fetchMarket()).data.winningOptionActiveBp).to.equal(10_000);

    // Reclaim vouched tokens for all accounts
    await platform.unvouchBatch([
      ...u1VouchIds.map(sid => ({ userId: user1, vouchAccountId: sid })),
      ...u2VouchIds.map(sid => ({ userId: user2, vouchAccountId: sid })),
    ]);

    await platform.endRevealPeriod();

    const rpc = platform.getRpc();

    // Get user1 balance before closing
    const u1BalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user1))).data.amount;

    // Close all user1 vouch accounts (A, B winning; C losing)
    await platform.closeVouchAccountBatch([
      { userId: user1, optionId: optA, vouchAccountId: u1VouchIds[0] },
      { userId: user1, optionId: optB, vouchAccountId: u1VouchIds[1] },
      { userId: user1, optionId: optC, vouchAccountId: u1VouchIds[2] },
    ]);

    const u1BalanceAfter = (await fetchToken(rpc, platform.getUserTokenAccount(user1))).data.amount;
    const u1Gain = u1BalanceAfter - u1BalanceBefore;

    // Get user2 balance before closing
    const u2BalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user2))).data.amount;

    // Close all user2 vouch accounts (E winning; F, G losing)
    await platform.closeVouchAccountBatch([
      { userId: user2, optionId: optE, vouchAccountId: u2VouchIds[0] },
      { userId: user2, optionId: optF, vouchAccountId: u2VouchIds[1] },
      { userId: user2, optionId: optG, vouchAccountId: u2VouchIds[2] },
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

    // All vouch accounts should be closed
    for (const [userId, vouchIds] of [[user1, u1VouchIds], [user2, u2VouchIds]] as const) {
      for (const sid of vouchIds) {
        const addr = await platform.getVouchAccountAddress(userId, sid);
        expect(await platform.accountExists(addr)).to.be.false;
      }
    }
  });

  it("allows users to vouch on multiple options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const vouchAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToVouch: 10n,
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
    // User vouches on both options twice (4 vouch accounts total)
    const vouchAccountIds = await platform.vouchOnOptionBatch([
      { userId: user, amount: vouchAmount, optionId: optionA },
      { userId: user, amount: vouchAmount, optionId: optionB },
      { userId: user, amount: vouchAmount, optionId: optionA },
      { userId: user, amount: vouchAmount, optionId: optionB },
    ]);
    const [sa0, sa1, sa2, sa3] = vouchAccountIds;

    // User now has 4 vouch accounts
    const userVouchAccounts = platform.getUserVouchAccounts(user);
    expect(userVouchAccounts.length).to.equal(4);

    // Verify user can decrypt all vouch accounts
    const expectedVouches = [
      { id: sa0, optionId: optionA },
      { id: sa1, optionId: optionB },
      { id: sa2, optionId: optionA },
      { id: sa3, optionId: optionB },
    ];
    expectedVouches.forEach(({ id, optionId }) => {
      const decrypted = platform.decryptVouchOption(user, id);
      expect(decrypted.optionId).to.equal(BigInt(optionId));
    });

    // Verify observer can decrypt all disclosed vouches
    expectedVouches.forEach(({ id, optionId }) => {
      const disclosed = platform.decryptDisclosedVouchOption(user, id, observer);
      expect(disclosed.optionId).to.equal(BigInt(optionId));
    });

    // Market creator selects winning option (Option A)
    await platform.waitForVouchEnd();
    const winningOptionId = optionA;
    await platform.selectSingleWinningOption(winningOptionId);

    // Reveal ALL vouch accounts sequentially
    for (const sa of userVouchAccounts) {
      await platform.revealVouch(user, sa.id);
    }

    // Verify all vouches are revealed
    for (const sa of userVouchAccounts) {
      const vouchAccount = await platform.fetchVouchAccountData(user, sa.id);
      expect(vouchAccount.data.revealedOption).to.deep.equal(some(BigInt(sa.optionId)));
    }

    // Increment tally for winning option vouch accounts
    const winningVouchAccounts = platform.getUserVouchAccountsForOption(user, winningOptionId);
    await platform.finalizeRevealVouchBatch(
      winningVouchAccounts.map((sa) => ({
        userId: user,
        optionId: winningOptionId,
        vouchAccountId: sa.id,
      }))
    );

    // Reclaim vouched tokens for all accounts
    await platform.unvouchBatch(
      userVouchAccounts.map((sa) => ({ userId: user, vouchAccountId: sa.id }))
    );

    await platform.endRevealPeriod();

    // Get balances before closing
    const rpc = platform.getRpc();
    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const marketAta = await platform.getMarketAta();
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close ALL vouch accounts (both winning and losing)
    await platform.closeVouchAccountBatch(
      userVouchAccounts.map((sa) => ({
        userId: user,
        optionId: sa.optionId,
        vouchAccountId: sa.id,
      }))
    );

    // Verify all vouch accounts were closed
    for (const sa of userVouchAccounts) {
      const addr = await platform.getVouchAccountAddress(user, sa.id);
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
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = await platform.openMarket();
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();

    //  Wait until vouch is over so we can resolve the market
    await sleepUntilOnChainTimestamp(Number(vouchEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

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

  it("rejects setting winning option before vouch period ends", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToVouch = 10n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: marketFundingAmount,
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    // Open market
    const vouchEnd = await platform.openMarket();

    // Add options as creator
    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();
    // Try to select option before vouch period ends - should fail
    await shouldThrowCustomError(
      () => platform.selectSingleWinningOption(optionA),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // Verify market is still unresolved
    let market = await platform.fetchMarket();
    expect(isNone(market.data.resolvedAtTimestamp)).to.be.true;

    // Wait for vouch period to end
    await sleepUntilOnChainTimestamp(Number(vouchEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Now selecting option should succeed
    await platform.selectSingleWinningOption(optionA);

    // Verify option was selected and market resolved
    market = await platform.fetchMarket();
    expect(isSome(market.data.resolvedAtTimestamp)).to.be.true;
    expect(market.data.winningOptionAllocation).to.equal(10_000);
    const optionAAccount = await platform.fetchOptionData(optionA);
    expect(optionAAccount.data.rewardBp).to.equal(10_000);
  });

  it("allows adding more reward during vouching", async () => {
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
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();

    // Add an option so vouching can happen
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

  it("early unvouching works as expected", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToVouch = 30n;
    const vouchAmount = 50_000_000n;

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
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = await platform.openMarket();

    const [vouchingUser] = platform.participants;

    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();
    const rpc = platform.getRpc();
    const balanceBeforeVouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser))).data.amount;

    const vouchAccountId = await platform.vouchOnOption(vouchingUser, vouchAmount, optionA);

    const balanceAfterVouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser))).data.amount;
    expect(balanceBeforeVouch - balanceAfterVouch).to.equal(vouchAmount);

    let vouchAccount = await platform.fetchVouchAccountData(vouchingUser, vouchAccountId);
    expect(isNone(vouchAccount.data.unvouchedAtTimestamp)).to.be.true;

    // Unvouch during the vouching window.
    await platform.unvouch(vouchingUser, vouchAccountId);

    // Early unvouch records the shortened vouching window for scoring.
    vouchAccount = await platform.fetchVouchAccountData(vouchingUser, vouchAccountId);
    expect(isSome(vouchAccount.data.unvouchedAtTimestamp)).to.be.true;

    // Only the net vouch is refunded: 1% platform fee and the 1% creator fee are forfeit
    const balanceAfterUnvouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser))).data.amount;
    const platformFee = vouchAmount * 100n / 10_000n;
    const creatorFee = vouchAmount * 100n / 10_000n;
    const expectedNet = vouchAmount - platformFee - creatorFee;
    expect(balanceAfterUnvouch - balanceBeforeVouch + vouchAmount).to.equal(expectedNet);

    // The creator fee collected at vouch time stays with the market
    const marketAfterUnvouch = await platform.fetchMarket();
    expect(marketAfterUnvouch.data.collectedCreatorFees).to.equal(creatorFee);

    // Double unvouch should fail.
    await shouldThrowCustomError(
      () => platform.unvouch(vouchingUser, vouchAccountId),
      OPPORTUNITY_MARKET_ERROR__ALREADY_UNVOUCHED,
    );

    await sleepUntilOnChainTimestamp(Number(vouchEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionA);

    // Reveal works
    await platform.revealVouch(vouchingUser, vouchAccountId);
    vouchAccount = await platform.fetchVouchAccountData(vouchingUser, vouchAccountId);
    expect(vouchAccount.data.revealedOption).to.deep.equal(some(BigInt(optionA)));
  });

  it("vouching becomes permissionless only after vouch period", async () => {
    const timeToVouch = 12n;
    const vouchAmount = 50_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = await platform.openMarket();

    const [vouchingUser, thirdParty] = platform.participants;
    const { optionId: optionA } = await platform.addOption();
    await platform.addOption();

    const vouchAccountId = await platform.vouchOnOption(vouchingUser, vouchAmount, optionA);

    // While vouch window is open, only the owner may unvouch
    await shouldThrowCustomError(
      () => platform.unvouch(vouchingUser, vouchAccountId, thirdParty),
      OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
    );

    let vouchAccount = await platform.fetchVouchAccountData(vouchingUser, vouchAccountId);
    expect(isNone(vouchAccount.data.unvouchedAtTimestamp)).to.be.true;

    // Once vouch_end has passed, unvouch is permissionless
    await sleepUntilOnChainTimestamp(Number(vouchEnd) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.unvouch(vouchingUser, vouchAccountId, thirdParty);

    vouchAccount = await platform.fetchVouchAccountData(vouchingUser, vouchAccountId);
    expect(isSome(vouchAccount.data.unvouchedAtTimestamp)).to.be.true;
  });

  it("can close a stuck vouch account and refund", async () => {
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const [user] = platform.participants;
    const rpc = platform.getRpc();
    const vouchAmount = 100_000_000n;

    // Record balances before
    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const tokenVaultAta = await platform.getMarketAta();
    const vaultAtaBalanceBefore = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    const vaultBefore = await platform.fetchMarket();

    // Vouch and immediately close stuck in the same transaction
    const vouchAccountId = await platform.vouchAndCloseStuck(user, vouchAmount, optionId);

    // Verify vouch account PDA no longer exists
    const vouchAccountAddress = await platform.getVouchAccountAddress(user, vouchAccountId);
    const exists = await platform.accountExists(vouchAccountAddress);
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

  it("rejects vouch + unvouch + close_stuck double withdraw (OM-007)", async () => {
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();

    const [victim, attacker] = platform.participants;
    const rpc = platform.getRpc();
    const victimVouchAmount = 100_000_000n;
    const attackerVouchAmount = 50_000_000n;

    await platform.vouchOnOption(victim, victimVouchAmount, optionId);

    const tokenVaultAta = await platform.getMarketAta();
    const vaultBalanceBefore = (await fetchToken(rpc, tokenVaultAta)).data.amount;
    const attackerBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(attacker)))
      .data.amount;

    await shouldThrowCustomError(
      () => platform.vouchUnvouchAndCloseStuck(attacker, attackerVouchAmount, optionId),
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
    const vouchAmount = 100_000_000n;
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
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];
    const rpc = platform.getRpc();

    const expectedPlatformFee = vouchAmount * platformFeeBp / 10_000n;
    const expectedRewardPoolFee = vouchAmount * rewardPoolFeeBp / 10_000n;
    const expectedCreatorFee = vouchAmount * creatorFeeBp / 10_000n;
    const expectedNetVouch =
      vouchAmount - expectedPlatformFee - expectedRewardPoolFee - expectedCreatorFee;

    const vouchAccountId = await platform.vouchOnOption(user, vouchAmount, optionId);

    // Vouch account records each fee component plus the net vouch.
    const vouchAccount = await platform.fetchVouchAccountData(user, vouchAccountId);
    expect(vouchAccount.data.amount).to.equal(expectedNetVouch);
    expect(vouchAccount.data.collectedFees.platformFee).to.equal(expectedPlatformFee);
    expect(vouchAccount.data.collectedFees.rewardPoolFee).to.equal(expectedRewardPoolFee);
    expect(vouchAccount.data.collectedFees.creatorFee).to.equal(expectedCreatorFee);

    // Market accumulators credit each fee bucket appropriately.
    let market = await platform.fetchMarket();
    expect(market.data.collectedPlatformFees).to.equal(expectedPlatformFee);
    expect(market.data.collectedCreatorFees).to.equal(expectedCreatorFee);
    expect(market.data.rewardAmount).to.equal(marketFundingAmount + expectedRewardPoolFee);

    // Resolve the market and run through reveal/reclaim.
    await platform.waitForVouchEnd();
    await platform.selectSingleWinningOption(optionId);

    await platform.revealVouch(user, vouchAccountId);
    await platform.finalizeRevealVouch(user, optionId, vouchAccountId);
    await platform.unvouch(user, vouchAccountId);
    await platform.endRevealPeriod();

    // Platform fee → fee_claim_authority (= creator in default Platform setup).
    const feeAuthBefore = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    await platform.claimFees();
    const feeAuthAfter = (await fetchToken(rpc, platform.getUserTokenAccount(platform.creator))).data.amount;
    expect(feeAuthAfter - feeAuthBefore).to.equal(expectedPlatformFee);

    // Winner claims reward + fee refund, then closes the vouch account.
    const userBalanceBeforeClose = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    await platform.claimRewards(user, optionId, vouchAccountId);
    await platform.closeRevealedVouchAccountBatch([{ userId: user, optionId, vouchAccountId }]);
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
    const vouchAmount = 100_000_000n;
    const platformFeeBp = 100n;
    const rewardPoolFeeBp = 200n;
    const creatorFeeBp = 150n;
    const marketResolutionDeadlineSeconds = 10n;
    const timeToVouch = 10n;

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
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];
    const rpc = platform.getRpc();

    const expectedPlatformFee = vouchAmount * platformFeeBp / 10_000n;
    const expectedRewardPoolFee = vouchAmount * rewardPoolFeeBp / 10_000n;
    const expectedCreatorFee = vouchAmount * creatorFeeBp / 10_000n;
    const expectedNetVouch =
      vouchAmount - expectedPlatformFee - expectedRewardPoolFee - expectedCreatorFee;

    const userBalanceBefore = (await fetchToken(rpc, platform.getUserTokenAccount(user))).data.amount;
    const vouchAccountId = await platform.vouchOnOption(user, vouchAmount, optionId);

    const vouchAccount = await platform.fetchVouchAccountData(user, vouchAccountId);
    expect(vouchAccount.data.collectedFees.platformFee).to.equal(expectedPlatformFee);
    expect(vouchAccount.data.collectedFees.rewardPoolFee).to.equal(expectedRewardPoolFee);
    expect(vouchAccount.data.collectedFees.creatorFee).to.equal(expectedCreatorFee);
    expect(vouchAccount.data.amount).to.equal(expectedNetVouch);

    // Wait past vouch_end + market_resolution_deadline without selecting winners.
    const selectDeadline = vouchEnd + Number(marketResolutionDeadlineSeconds);
    await sleepUntilOnChainTimestamp(selectDeadline + ONCHAIN_TIMESTAMP_BUFFER_SECONDS, rpc);

    // Vouch reclaim returns the net vouched amount.
    await platform.unvouch(user, vouchAccountId);

    // Expired path: never revealed → close_unrevealed refunds reward_pool_fee + creator_fee.
    await platform.closeUnrevealedVouchAccount(user, vouchAccountId);

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
    const timeToVouch = 15n;
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
        timeToVouch,
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

    // Pre-open: the market has no vouch window yet, so withdrawal is rejected.
    await shouldThrowCustomError(
      () => platform.withdrawReward(sponsorA),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    const vouchEnd = Number(await platform.openMarket());
    await sleepUntilOnChainTimestamp(vouchEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS, rpc);

    // Resolution window: rewards stay locked until the resolution deadline passes.
    await shouldThrowCustomError(
      () => platform.withdrawReward(sponsorB),
      OPPORTUNITY_MARKET_ERROR__WRONG_MARKET_PHASE,
    );

    // After expiry without resolution, both sponsors recover their deposits in full.
    const expiredAt = vouchEnd + Number(marketResolutionDeadlineSeconds);
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

  it("rejects vouching below the minimum vouch amount", async () => {
    const minVouchAmount = 100_000_000n;

    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 1_000_000_000n,
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
        minVouchAmount,
      },
    });

    await platform.openMarket();
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // Vouch just below the minimum should fail
    await shouldThrowCustomError(
      () => platform.vouchOnOption(user, minVouchAmount - 1n, optionId),
      OPPORTUNITY_MARKET_ERROR__VOUCH_BELOW_MINIMUM
    );

    // Vouch at exactly the minimum should succeed
    const vouchAccountId = await platform.vouchOnOption(user, minVouchAmount, optionId);
    const vouchAccount = await platform.fetchVouchAccountData(user, vouchAccountId);
    expect(vouchAccount.data.amount > 0n).to.be.true;
  });

  it("reveal period authority can close immediately after resolution", async () => {
    const timeToVouch = 5n;
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 1,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 0n,
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // At least one vouch on the winning option must be revealed before reveal period can be ended.
    const vouchAccountId = await platform.vouchOnOption(user, 1_000_000_000n, optionId);
    await sleepUntilOnChainTimestamp(vouchEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionId);
    await platform.revealVouch(user, vouchAccountId);
    await platform.finalizeRevealVouch(user, optionId, vouchAccountId);

    await platform.endRevealPeriod();
    expect((await platform.fetchMarket()).data.revealEnded).to.be.true;
  });

  it("non-authority cannot close reveal period before reveal_period_seconds", async () => {
    const timeToVouch = 5n;
    const observer = loadObserverKeypair();

    const platform = await Platform.initialize(provider, programId, {
      rpcUrl: RPC_URL,
      wsUrl: WS_URL,
      numParticipants: 2,
      airdropLamports: 2_000_000_000n,
      initialTokenAmount: 2_000_000_000n,
      marketConfig: {
        rewardAmount: 0n,
        timeToVouch,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    const vouchEnd = Number(await platform.openMarket());
    const { optionId } = await platform.addOption();
    const user = platform.participants[0];

    // At least one vouch on the winning option must be revealed before reveal period can be ended.
    const vouchAccountId = await platform.vouchOnOption(user, 1_000_000_000n, optionId);
    await sleepUntilOnChainTimestamp(vouchEnd + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    await platform.selectSingleWinningOption(optionId);
    await platform.revealVouch(user, vouchAccountId);
    await platform.finalizeRevealVouch(user, optionId, vouchAccountId);

    const nonAuthority = platform.getUserSigner(platform.participants[0]);
    await shouldThrowCustomError(
      () => platform.endRevealPeriod(nonAuthority),
      OPPORTUNITY_MARKET_ERROR__UNAUTHORIZED,
    );

    await platform.endRevealPeriod();
    expect((await platform.fetchMarket()).data.revealEnded).to.be.true;
  });

  it("winner takes all when fees sum up to 100%", async () => {
    // Fees consume all but 1 bp of the vouch; net remains so unvouch can run.
    const platformFeeBp = 100;
    const creatorFeeBp = 100;
    const rewardPoolFeeBp = 9799;

    const vouchAmount = 100_000_000_000n;
    const expectedPoolFee = vouchAmount * BigInt(rewardPoolFeeBp) / 10_000n;
    const expectedPlatformFee = vouchAmount * BigInt(platformFeeBp) / 10_000n;
    const expectedCreatorFee = vouchAmount * BigInt(creatorFeeBp) / 10_000n;
    const expectedNetVouch =
      vouchAmount - expectedPlatformFee - expectedPoolFee - expectedCreatorFee;

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
        timeToVouch: 10n,
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await platform.openMarket();
    const [vouchingUser1, vouchingUser2] = platform.participants;
    const { optionId: optionA } = await platform.addOption();
    const { optionId: optionB } = await platform.addOption();
    const [sa1, sa2] = await platform.vouchOnOptionBatch([
      { userId: vouchingUser1, amount: vouchAmount, optionId: optionA },
      { userId: vouchingUser2, amount: vouchAmount, optionId: optionB },
    ]);

    const marketAfterVouches = await platform.fetchMarket();
    expect(marketAfterVouches.data.rewardAmount).to.equal(expectedPoolFee * 2n);
    expect(marketAfterVouches.data.collectedPlatformFees).to.equal(expectedPlatformFee * 2n);
    expect(marketAfterVouches.data.collectedCreatorFees).to.equal(expectedCreatorFee * 2n);

    // Vouch accounts retain 1 bp net; the rest went to fees.
    expect((await platform.fetchVouchAccountData(vouchingUser1, sa1)).data.amount).to.equal(expectedNetVouch);
    expect((await platform.fetchVouchAccountData(vouchingUser2, sa2)).data.amount).to.equal(expectedNetVouch);

    // Resolve with option A as the sole winner.
    await platform.waitForVouchEnd();
    await platform.selectSingleWinningOption(optionA);

    // Both vouches can be revealed.
    await platform.revealVouchBatch([
      { userId: vouchingUser1, vouchAccountId: sa1 },
      { userId: vouchingUser2, vouchAccountId: sa2 },
    ]);
    expect((await platform.fetchVouchAccountData(vouchingUser1, sa1)).data.revealedOption)
      .to.deep.equal(some(BigInt(optionA)));
    expect((await platform.fetchVouchAccountData(vouchingUser2, sa2)).data.revealedOption)
      .to.deep.equal(some(BigInt(optionB)));

    await platform.finalizeRevealVouchBatch([
      { userId: vouchingUser1, optionId: optionA, vouchAccountId: sa1 },
      { userId: vouchingUser2, optionId: optionB, vouchAccountId: sa2 },
    ]);

    const marketAfterFinalize = await platform.fetchMarket();
    expect(marketAfterFinalize.data.rewardAmount).to.equal(expectedPoolFee);
    expect(marketAfterFinalize.data.collectedCreatorFees).to.equal(expectedCreatorFee);

    // Unvouch returns the negligible net vouch; the reward pool holds the rest.
    const rpc = platform.getRpc();
    const bal1BeforeUnvouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser1))).data.amount;
    const bal2BeforeUnvouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser2))).data.amount;
    await platform.unvouchBatch([
      { userId: vouchingUser1, vouchAccountId: sa1 },
      { userId: vouchingUser2, vouchAccountId: sa2 },
    ]);
    const bal1AfterUnvouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser1))).data.amount;
    const bal2AfterUnvouch = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser2))).data.amount;
    expect(bal1AfterUnvouch - bal1BeforeUnvouch).to.equal(expectedNetVouch);
    expect(bal2AfterUnvouch - bal2BeforeUnvouch).to.equal(expectedNetVouch);

    await platform.endRevealPeriod();

    await platform.closeVouchAccountBatch([
      { userId: vouchingUser1, optionId: optionA, vouchAccountId: sa1 },
      { userId: vouchingUser2, optionId: optionB, vouchAccountId: sa2 },
    ]);

    const bal1AfterClose = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser1))).data.amount;
    const bal2AfterClose = (await fetchToken(rpc, platform.getUserTokenAccount(vouchingUser2))).data.amount;

    const expectedWinnerCloseGain = 2n * expectedPoolFee + expectedCreatorFee;
    expect(bal1AfterClose - bal1AfterUnvouch).to.equal(expectedWinnerCloseGain);
    expect(bal2AfterClose - bal2AfterUnvouch).to.equal(0n);

    expect(await platform.accountExists(await platform.getVouchAccountAddress(vouchingUser1, sa1))).to.be.false;
    expect(await platform.accountExists(await platform.getVouchAccountAddress(vouchingUser2, sa2))).to.be.false;
  });
});

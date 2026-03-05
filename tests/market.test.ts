import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { address, some, isSome, isNone, createSolanaRpc, createSolanaRpcSubscriptions, sendAndConfirmTransactionFactory  } from "@solana/kit";
import { fetchToken } from "@solana-program/token";
import { expect } from "chai";
import { fetchTokenVault, getTokenVaultAddress } from "../js/src";

import { OpportunityMarket } from "../target/types/opportunity_market";
import { TestRunner } from "./utils/test-runner";
import { initializeAllCompDefs } from "./utils/comp-defs";
import { sleepUntilOnChainTimestamp } from "./utils/sleep";
import { shouldThrowCustomError } from "./utils/errors";
import { generateX25519Keypair, X25519Keypair } from "../js/src/x25519/keypair";
import {
  OPPORTUNITY_MARKET_ERROR__CLOSING_EARLY_NOT_ALLOWED,
  OPPORTUNITY_MARKET_ERROR__UNSTAKE_DELAY_NOT_MET,
} from "../js/src/generated/errors/opportunityMarket";
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
  // Anchor setup (still needed for buildFinalizeCompDefTx)
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.OpportunityMarket as Program<OpportunityMarket>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const programId = address(program.programId.toBase58());

  before(async () => {
    // Load owner secret key
    const file = fs.readFileSync(`${os.homedir()}/.config/solana/id.json`);
    const secretKey = new Uint8Array(JSON.parse(file.toString()));

    // Initialize all computation definitions
    const rpc = createSolanaRpc(RPC_URL);
    const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    await initializeAllCompDefs(rpc, sendAndConfirmTransaction, secretKey, programId);
  });

  it("passes full opportunity market flow", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const numParticipants = 4;

    // Create an observer keypair that can read stakes.
    const observer = loadObserverKeypair();

    // Initialize TestRunner with all accounts and market
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

    // Initialize ETAs and wrap encrypted tokens for all participants
    const wrapAmount = 100_000_000n;
    const protocolFeeBp = 100n; // 1% fee configured in TestRunner
    const expectedFeePerUser = wrapAmount * protocolFeeBp / 10_000n;
    const expectedNetPerUser = wrapAmount - expectedFeePerUser;

    for (const userId of runner.participants) {
      await runner.initEncryptedTokenAccount(userId);
      await runner.wrapEncryptedTokens(userId, wrapAmount);
    }

    // Verify decrypted ETA balances have fee deducted
    for (const userId of runner.participants) {
      const balance = await runner.decryptEtaBalance(userId);
      expect(balance).to.equal(expectedNetPerUser,
        `ETA balance should be ${expectedNetPerUser} after 1% fee, got ${balance}`);
    }

    // Add two options
    const { optionIndex: optionA } = await runner.addOptionAsCreator("Option A");
    const { optionIndex: optionB } = await runner.addOptionAsCreator("Option B");

    // Wait for market staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Define voting: first half vote Option A (winning), second half vote Option B
    const winningOptionIndex = optionA;
    const buySharesAmounts = [50n, 75n, 100n, 60n];

    // Buy shares for all participants (authorized reader is set at market creation)
    const purchases = runner.participants.map((userId, idx) => ({
      userId,
      amount: buySharesAmounts[idx],
      optionIndex: idx < numParticipants / 2 ? optionA : optionB,
    }));
    const shareAccountIds = await runner.stakeOnOptionBatch(purchases);

    // Verify user can decrypt their own stake
    purchases.forEach((purchase, i) => {
      const decrypted = runner.decryptStakeAmount(purchase.userId, shareAccountIds[i]);
      expect(decrypted.amount).to.equal(purchase.amount);
      expect(decrypted.optionIndex).to.equal(BigInt(purchase.optionIndex));
    });

    // Verify observer can decrypt disclosed stakes
    purchases.forEach((purchase, i) => {
      const disclosed = runner.decryptDisclosedStakeAmount(purchase.userId, shareAccountIds[i], observer);
      expect(disclosed.amount).to.equal(purchase.amount);
      expect(disclosed.optionIndex).to.equal(BigInt(purchase.optionIndex));
    });

    // Market creator selects winning option
    await runner.selectSingleWinningOption(winningOptionIndex);

    // Verify selected option
    const resolvedMarket = await runner.fetchMarket();
    expect(resolvedMarket.data.selectedOptions).to.deep.equal(some([{ optionIndex: winningOptionIndex, rewardPercentage: 100 }]));

    // Get winners (participants who voted for winning option) using stored share account info
    const winners = runner.participants.filter(
      (userId) => runner.getUserShareAccountsForOption(userId, winningOptionIndex).length > 0
    );
    const winnerShareAccounts = winners.map(
      (userId) => runner.getUserShareAccountsForOption(userId, winningOptionIndex)[0]
    );

    // Reveal shares for winners
    await runner.revealSharesBatch(
      winners.map((userId, i) => ({ userId, shareAccountId: winnerShareAccounts[i].id }))
    );

    // Verify revealed shares for winners
    for (let i = 0; i < winners.length; i++) {
      const sa = winnerShareAccounts[i];
      const shareAccount = await runner.fetchShareAccountData(winners[i], sa.id);
      expect(shareAccount.data.revealedAmount).to.deep.equal(some(sa.amount));
      expect(shareAccount.data.revealedOption).to.deep.equal(some(winningOptionIndex));
    }

    // Increment option tally for winners
    await runner.incrementOptionTallyBatch(
      winners.map((userId, i) => ({
        userId,
        optionIndex: winningOptionIndex,
        shareAccountId: winnerShareAccounts[i].id,
      }))
    );

    // Verify option tally
    const totalWinningShares = winnerShareAccounts.reduce((sum, sa) => sum + sa.amount, 0n);
    const optionAccount = await runner.fetchOptionData(winningOptionIndex);
    expect(optionAccount.data.totalShares).to.deep.equal(some(totalWinningShares));

    // Get timestamps for reward calculation
    const updatedMarket = await runner.fetchMarket();
    const marketCloseTimestamp =
      BigInt(
        updatedMarket.data.openTimestamp.__option === "Some"
          ? updatedMarket.data.openTimestamp.value
          : 0n
      ) + updatedMarket.data.timeToStake;

    const winnerTimestamps = await Promise.all(
      winners.map(async (userId, i) => {
        const shareAccount = await runner.fetchShareAccountData(userId, winnerShareAccounts[i].id);
        const ts = shareAccount.data.stakedAtTimestamp;
        if (!isSome(ts)) throw new Error("stakedAtTimestamp is None");
        return ts.value;
      })
    );

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    // Get token balances before closing
    const rpc = runner.getRpc();
    const marketAta = await runner.getMarketAta();

    const balancesBefore = await Promise.all(
      winners.map(async (userId) => ({
        userId,
        balance: (await fetchToken(rpc, runner.getUserTokenAccount(userId))).data.amount,
      }))
    );
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close share accounts for winners
    await runner.closeShareAccountBatch(
      winners.map((userId, i) => ({
        userId,
        optionIndex: winningOptionIndex,
        shareAccountId: winnerShareAccounts[i].id,
      }))
    );

    // Verify share accounts were closed
    for (let i = 0; i < winners.length; i++) {
      const addr = await runner.getShareAccountAddress(winners[i], winnerShareAccounts[i].id);
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

    // Calculate gains
    const gains = winners.map((userId, i) => ({
      userId,
      gain: balancesAfter[i].balance - balancesBefore[i].balance,
      shares: winnerShareAccounts[i].amount,
    }));

    // All winners should have gained funds
    for (const { gain } of gains) {
      expect(gain > 0n).to.be.true;
    }

    // Total market loss should equal the full reward amount (tolerance of 2 for rounding)
    const marketLoss = marketBalanceBefore - marketBalanceAfter;
    expect(marketLoss >= marketFundingAmount - 2n && marketLoss <= marketFundingAmount).to.be.true;

    // Verify proportional reward distribution
    const winnerScores = gains.map(({ gain, shares }, i) => ({
      gain,
      score: shares * (marketCloseTimestamp - winnerTimestamps[i]),
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
    const totalExpectedFees = expectedFeePerUser * BigInt(numParticipants);
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

  it("allows users to vote for multiple options", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const numParticipants = 1;

    // Create an observer keypair that can read stakes
    const observer = loadObserverKeypair();

    // Initialize TestRunner with 1 participant
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

    // Get the single participant
    const user = runner.participants[0];

    // Initialize ETA and wrap encrypted tokens for user
    const wrapAmount = 100_000_000n;
    await runner.initEncryptedTokenAccount(user);
    await runner.wrapEncryptedTokens(user, wrapAmount);

    // Calculate stake amounts: 1/4 of net balance (after protocol fee) for each action
    const netAmount = await runner.decryptEtaBalance(user);
    const quarterAmount = netAmount / 4n;

    // Wait for market staking period to be active
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // User adds 2 options, staking 1/4 of wrapped tokens for each
    // This creates share accounts 0 and 1 (authorized reader is set at market creation)
    const { optionIndex: optionA, shareAccountId: sa0 } = await runner.addMarketOption(user, "Option A", quarterAmount);
    const { optionIndex: optionB, shareAccountId: sa1 } = await runner.addMarketOption(user, "Option B", quarterAmount);

    // User explicitly stakes more shares for both options (1/4 each)
    // This creates share accounts 2 and 3
    const [sa2, sa3] = await runner.stakeOnOptionBatch([
      { userId: user, amount: quarterAmount, optionIndex: optionA },
      { userId: user, amount: quarterAmount, optionIndex: optionB },
    ]);

    // User now has 4 share accounts, with all wrapped tokens staked
    const userShareAccounts = runner.getUserShareAccounts(user);
    expect(userShareAccounts.length).to.equal(4);

    // Verify user can decrypt all share accounts
    const expectedStakes = [
      { id: sa0, amount: quarterAmount, optionIndex: optionA },
      { id: sa1, amount: quarterAmount, optionIndex: optionB },
      { id: sa2, amount: quarterAmount, optionIndex: optionA },
      { id: sa3, amount: quarterAmount, optionIndex: optionB },
    ];
    expectedStakes.forEach(({ id, amount, optionIndex }) => {
      const decrypted = runner.decryptStakeAmount(user, id);
      expect(decrypted.amount).to.equal(amount);
      expect(decrypted.optionIndex).to.equal(BigInt(optionIndex));
    });

    // Verify observer can decrypt all disclosed stakes
    expectedStakes.forEach(({ id, amount, optionIndex }) => {
      const disclosed = runner.decryptDisclosedStakeAmount(user, id, observer);
      expect(disclosed.amount).to.equal(amount);
      expect(disclosed.optionIndex).to.equal(BigInt(optionIndex));
    });

    // Market creator selects winning option (Option A)
    const winningOptionIndex = optionA;
    await runner.selectSingleWinningOption(winningOptionIndex);

    // Reveal ALL share accounts sequentially (one at a time to avoid concurrent MPC issues)
    for (const sa of userShareAccounts) {
      await runner.revealShares(user, sa.id);
    }

    // Verify all shares are revealed
    for (const sa of userShareAccounts) {
      const shareAccount = await runner.fetchShareAccountData(user, sa.id);
      expect(shareAccount.data.revealedAmount).to.deep.equal(some(sa.amount));
      expect(shareAccount.data.revealedOption).to.deep.equal(some(sa.optionIndex));
    }

    // Increment tally for winning option share accounts
    const winningShareAccounts = runner.getUserShareAccountsForOption(user, winningOptionIndex);
    await runner.incrementOptionTallyBatch(
      winningShareAccounts.map((sa) => ({
        userId: user,
        optionIndex: winningOptionIndex,
        shareAccountId: sa.id,
      }))
    );

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    // Get balances before closing
    const rpc = runner.getRpc();
    const userBalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;
    const marketAta = await runner.getMarketAta();
    const marketBalanceBefore = (await fetchToken(rpc, marketAta)).data.amount;

    // Close ALL share accounts (both winning and losing)
    await runner.closeShareAccountBatch(
      userShareAccounts.map((sa) => ({
        userId: user,
        optionIndex: sa.optionIndex,
        shareAccountId: sa.id,
      }))
    );

    // Verify all share accounts were closed
    for (const sa of userShareAccounts) {
      const addr = await runner.getShareAccountAddress(user, sa.id);
      const exists = await runner.accountExists(addr);
      expect(exists).to.be.false;
    }

    // Get balances after closing
    const userBalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user))).data.amount;
    const marketBalanceAfter = (await fetchToken(rpc, marketAta)).data.amount;

    // Calculate gains and losses
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

  it("allows early unstaking with delay", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const unstakeDelaySeconds = 10n;
    const timeToStake = 30n;

    // Create an observer keypair for authorized reading
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

    // Initialize ETAs and wrap tokens
    await runner.initEncryptedTokenAccount(staker);
    await runner.initEncryptedTokenAccount(executor);
    const wrapAmount = 100_000_000n;
    await runner.wrapEncryptedTokens(staker, wrapAmount);

    // Net balance after protocol fee
    const netAmount = await runner.decryptEtaBalance(staker);

    // Add options
    const { optionIndex: optionA } = await runner.addOptionAsCreator("Option A");
    await runner.addOptionAsCreator("Option B");

    // Wait for staking period and stake
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);
    const stakeAmount = 50_000_000n;
    const shareAccountId = await runner.stakeOnOption(staker, stakeAmount, optionA);

    // Verify ETA balance decreased after staking
    const balanceAfterStake = await runner.decryptEtaBalance(staker);
    expect(balanceAfterStake).to.equal(netAmount - stakeAmount);

    // Verify initial state
    let shareAccount = await runner.fetchShareAccountData(staker, shareAccountId);
    expect(isSome(shareAccount.data.unstakeableAtTimestamp)).to.be.false;
    expect(isSome(shareAccount.data.unstakedAtTimestamp)).to.be.false;

    // Initiate early unstake (sets unstakeableAtTimestamp)
    await runner.unstakeEarly(staker, shareAccountId);

    shareAccount = await runner.fetchShareAccountData(staker, shareAccountId);
    expect(isSome(shareAccount.data.unstakeableAtTimestamp)).to.be.true;
    expect(isSome(shareAccount.data.unstakedAtTimestamp)).to.be.false;

    // Execute unstake too early, should throw
    await shouldThrowCustomError(
      () => runner.doUnstakeEarly(executor, staker, shareAccountId),
      OPPORTUNITY_MARKET_ERROR__UNSTAKE_DELAY_NOT_MET
    );

    // Wait for unstake delay to pass
    if (!isSome(shareAccount.data.unstakeableAtTimestamp)) throw new Error()
    const unstakeableAt = shareAccount.data.unstakeableAtTimestamp.value;
    await sleepUntilOnChainTimestamp(Number(unstakeableAt) + 1);

    // Execute unstake (permissionless - different user can call)
    await runner.doUnstakeEarly(executor, staker, shareAccountId);

    shareAccount = await runner.fetchShareAccountData(staker, shareAccountId);
    expect(isSome(shareAccount.data.unstakedAtTimestamp)).to.be.true;

    // Verify ETA balance was refunded
    const balanceAfterUnstake = await runner.decryptEtaBalance(staker);
    expect(balanceAfterUnstake).to.equal(netAmount);

    // Select winner and wait for stake period to end
    await runner.selectSingleWinningOption(optionA);
    const stakeEndTimestamp = Number(openTimestamp) + Number(timeToStake);
    await sleepUntilOnChainTimestamp(stakeEndTimestamp + 1);

    // Reveal shares.
    await runner.revealShares(staker, shareAccountId);
    shareAccount = await runner.fetchShareAccountData(staker, shareAccountId);
    expect(shareAccount.data.revealedAmount).to.deep.equal(some(stakeAmount));
    expect(shareAccount.data.revealedOption).to.deep.equal(some(optionA));
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
        timeToReveal: 30n, // Long window: 6 reveals + 3 tallies need time
        authorizedReaderPubkey: observer.publicKey,
      },
    });

    await runner.fundMarket();
    const openTimestamp = await runner.openMarket();

    const [user1, user2] = runner.participants;

    // Init ETAs and wrap tokens for both users
    for (const userId of [user1, user2]) {
      await runner.initEncryptedTokenAccount(userId);
      await runner.wrapEncryptedTokens(userId, 100_000_000n);
    }

    // Create 7 options: A-G
    const options: number[] = [];
    for (const name of ["A", "B", "C", "D", "E", "F", "G"]) {
      const { optionIndex } = await runner.addOptionAsCreator(`Option ${name}`);
      options.push(optionIndex);
    }
    const [optA, optB, optC, _optD, optE, optF, optG] = options;

    // Wait for staking period
    await sleepUntilOnChainTimestamp(Number(openTimestamp) + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // User 1 stakes to A, B, C
    const u1ShareIds = await runner.stakeOnOptionBatch([
      { userId: user1, amount: stakeAmount, optionIndex: optA },
      { userId: user1, amount: stakeAmount, optionIndex: optB },
      { userId: user1, amount: stakeAmount, optionIndex: optC },
    ]);

    // User 2 stakes to E, F, G
    const u2ShareIds = await runner.stakeOnOptionBatch([
      { userId: user2, amount: stakeAmount, optionIndex: optE },
      { userId: user2, amount: stakeAmount, optionIndex: optF },
      { userId: user2, amount: stakeAmount, optionIndex: optG },
    ]);

    // Creator selects 3 winning options with different percentages: A=50%, B=30%, E=20%
    await runner.selectWinningOptions([
      { optionIndex: optA, rewardPercentage: 50 },
      { optionIndex: optB, rewardPercentage: 30 },
      { optionIndex: optE, rewardPercentage: 20 },
    ]);

    // Verify selected options
    const resolvedMarket = await runner.fetchMarket();
    expect(resolvedMarket.data.selectedOptions).to.deep.equal(some([
      { optionIndex: optA, rewardPercentage: 50 },
      { optionIndex: optB, rewardPercentage: 30 },
      { optionIndex: optE, rewardPercentage: 20 },
    ]));

    // selectWinningOptions with allow_closing_early shortens time_to_stake, so reveal window starts now.
    // Sleep briefly to ensure the on-chain clock has advanced past reveal_start.
    const updatedMarket = await runner.fetchMarket();
    const updatedOpenTs = updatedMarket.data.openTimestamp.__option === "Some"
      ? Number(updatedMarket.data.openTimestamp.value)
      : 0;
    const revealStart = updatedOpenTs + Number(updatedMarket.data.timeToStake);
    await sleepUntilOnChainTimestamp(revealStart + ONCHAIN_TIMESTAMP_BUFFER_SECONDS);

    // Reveal all share accounts (users in parallel, each user's reveals sequential due to ETA locking)
    await Promise.all([
      runner.revealSharesBatch(u1ShareIds.map(sid => ({ userId: user1, shareAccountId: sid }))),
      runner.revealSharesBatch(u2ShareIds.map(sid => ({ userId: user2, shareAccountId: sid }))),
    ]);

    // Increment tally for winning share accounts only (all in parallel)
    // User 1: A (share 0), B (share 1) — C is a loser
    // User 2: E (share 0) — F, G are losers
    await Promise.all([
      runner.incrementOptionTally(user1, optA, u1ShareIds[0]),
      runner.incrementOptionTally(user1, optB, u1ShareIds[1]),
      runner.incrementOptionTally(user2, optE, u2ShareIds[0]),
    ]);

    // Wait for reveal period to end
    const timeToReveal = Number(runner.getTimeToReveal());
    await sleepUntilOnChainTimestamp(new Date().getTime() / 1000 + timeToReveal);

    const rpc = runner.getRpc();

    // Get user1 balance before closing
    const u1BalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user1))).data.amount;

    // Close all user1 share accounts (A, B winning; C losing)
    await runner.closeShareAccountBatch([
      { userId: user1, optionIndex: optA, shareAccountId: u1ShareIds[0] },
      { userId: user1, optionIndex: optB, shareAccountId: u1ShareIds[1] },
      { userId: user1, optionIndex: optC, shareAccountId: u1ShareIds[2] },
    ]);

    const u1BalanceAfter = (await fetchToken(rpc, runner.getUserTokenAccount(user1))).data.amount;
    const u1Gain = u1BalanceAfter - u1BalanceBefore;

    // Get user2 balance before closing
    const u2BalanceBefore = (await fetchToken(rpc, runner.getUserTokenAccount(user2))).data.amount;

    // Close all user2 share accounts (E winning; F, G losing)
    await runner.closeShareAccountBatch([
      { userId: user2, optionIndex: optE, shareAccountId: u2ShareIds[0] },
      { userId: user2, optionIndex: optF, shareAccountId: u2ShareIds[1] },
      { userId: user2, optionIndex: optG, shareAccountId: u2ShareIds[2] },
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

    // All share accounts should be closed
    for (const [userId, shareIds] of [[user1, u1ShareIds], [user2, u2ShareIds]] as const) {
      for (const sid of shareIds) {
        const addr = await runner.getShareAccountAddress(userId, sid);
        expect(await runner.accountExists(addr)).to.be.false;
      }
    }
  });

  it("prevents closing market early when not allowed", async () => {
    const marketFundingAmount = 1_000_000_000n;
    const timeToStake = 10n;

    // Create an observer keypair
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
    const { optionIndex: optionA } = await runner.addOptionAsCreator("Option A");
    await runner.addOptionAsCreator("Option B");

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
    expect(market.data.selectedOptions).to.deep.equal(some([{ optionIndex: optionA, rewardPercentage: 100 }]));
  });

});

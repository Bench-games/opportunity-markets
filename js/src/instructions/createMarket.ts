import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCreateMarketInstructionAsync,
  type CreateMarketInstruction,
} from "../generated";
import { type ByteArray, toNumberArray } from "../utils";
import { type BaseInstructionParams } from "./instructionParams";

export interface CreateMarketParams extends BaseInstructionParams {
  creator: TransactionSigner;
  tokenMint: Address;
  tokenProgram: Address;
  marketIndex: bigint;
  rewardAmount: bigint;
  timeToStake: bigint;
  timeToReveal: bigint;
  marketAuthority: Address | null;
  unstakeDelaySeconds: bigint;
  authorizedReaderPubkey: ByteArray;
  allowClosingEarly: boolean;
  revealPeriodAuthority: Address;
}

export async function createMarket(
  input: CreateMarketParams
): Promise<CreateMarketInstruction<string>> {
  const {
    creator,
    tokenMint,
    tokenProgram,
    marketIndex,
    rewardAmount,
    timeToReveal,
    timeToStake,
    marketAuthority,
    unstakeDelaySeconds,
    authorizedReaderPubkey,
    allowClosingEarly,
    revealPeriodAuthority,
    programAddress,
  } = input;

  return getCreateMarketInstructionAsync(
    {
      creator,
      tokenMint,
      tokenProgram,
      marketIndex,
      rewardAmount,
      timeToStake,
      timeToReveal,
      marketAuthority,
      unstakeDelaySeconds,
      authorizedReaderPubkey: toNumberArray(authorizedReaderPubkey),
      allowClosingEarly,
      revealPeriodAuthority,
    },
    programAddress ? { programAddress } : undefined
  );
}

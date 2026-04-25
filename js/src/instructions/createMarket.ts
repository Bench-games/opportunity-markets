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
  timeToStake: bigint;
  timeToReveal: bigint;
  marketAuthority: Address;
  unstakeDelaySeconds: bigint;
  authorizedReaderPubkey: ByteArray;
  allowClosingEarly: boolean;
  revealPeriodAuthority: Address;
  earlinessCutoffSeconds: bigint;
}

export async function createMarket(
  input: CreateMarketParams
): Promise<CreateMarketInstruction<string>> {
  const {
    creator,
    tokenMint,
    tokenProgram,
    marketIndex,
    timeToReveal,
    timeToStake,
    marketAuthority,
    unstakeDelaySeconds,
    authorizedReaderPubkey,
    allowClosingEarly,
    revealPeriodAuthority,
    earlinessCutoffSeconds,
    programAddress,
  } = input;

  return getCreateMarketInstructionAsync(
    {
      creator,
      tokenMint,
      tokenProgram,
      marketIndex,
      timeToStake,
      timeToReveal,
      marketAuthority,
      unstakeDelaySeconds,
      authorizedReaderPubkey: toNumberArray(authorizedReaderPubkey),
      allowClosingEarly,
      revealPeriodAuthority,
      earlinessCutoffSeconds,
    },
    programAddress ? { programAddress } : undefined
  );
}

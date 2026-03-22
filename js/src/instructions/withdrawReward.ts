import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getWithdrawRewardInstructionAsync,
  type WithdrawRewardInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface WithdrawRewardParams extends BaseInstructionParams {
  authority: TransactionSigner;
  market: Address;
  tokenMint: Address;
  refundTokenAccount: Address;
  tokenProgram: Address;
}

export async function withdrawReward(
  input: WithdrawRewardParams
): Promise<WithdrawRewardInstruction<string>> {
  const { programAddress, ...params } = input;
  return getWithdrawRewardInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

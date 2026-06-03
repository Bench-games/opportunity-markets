import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getAddRewardInstructionAsync,
  type AddRewardInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface AddRewardParams extends BaseInstructionParams {
  sponsor: TransactionSigner;
  market: Address;
  tokenMint: Address;
  sponsorTokenAccount: Address;
  tokenProgram: Address;
  amount: bigint;
}

export async function addReward(
  input: AddRewardParams
): Promise<AddRewardInstruction<string>> {
  const { programAddress, ...params } = input;
  return getAddRewardInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getClaimRewardsInstructionAsync,
  type ClaimRewardsInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface ClaimRewardsParams extends BaseInstructionParams {
  owner: TransactionSigner;
  market: Address;
  vouchAccount: Address;
  option: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
}

export async function claimRewards(
  input: ClaimRewardsParams
): Promise<ClaimRewardsInstruction<string>> {
  const { programAddress, ...params } = input;
  return getClaimRewardsInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

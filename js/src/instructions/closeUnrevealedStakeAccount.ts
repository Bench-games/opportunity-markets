import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseUnrevealedStakeAccountInstructionAsync,
  type CloseUnrevealedStakeAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseUnrevealedStakeAccountParams extends BaseInstructionParams {
  owner: TransactionSigner;
  market: Address;
  stakeAccount: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
}

export async function closeUnrevealedStakeAccount(
  input: CloseUnrevealedStakeAccountParams
): Promise<CloseUnrevealedStakeAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseUnrevealedStakeAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

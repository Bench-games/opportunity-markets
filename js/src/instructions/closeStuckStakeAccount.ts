import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseStuckStakeAccountInstructionAsync,
  type CloseStuckStakeAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseStuckStakeAccountParams extends BaseInstructionParams {
  signer: TransactionSigner;
  market: Address;
  tokenMint: Address;
  signerTokenAccount: Address;
  tokenProgram: Address;
  stakeAccountId: number;
}

export async function closeStuckStakeAccount(
  input: CloseStuckStakeAccountParams
): Promise<CloseStuckStakeAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseStuckStakeAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

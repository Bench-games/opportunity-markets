import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseUnrevealedVouchAccountInstructionAsync,
  type CloseUnrevealedVouchAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseUnrevealedVouchAccountParams extends BaseInstructionParams {
  owner: TransactionSigner;
  market: Address;
  vouchAccount: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
}

export async function closeUnrevealedVouchAccount(
  input: CloseUnrevealedVouchAccountParams
): Promise<CloseUnrevealedVouchAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseUnrevealedVouchAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

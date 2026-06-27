import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseVouchAccountInstructionAsync,
  type CloseVouchAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseVouchAccountParams extends BaseInstructionParams {
  owner: TransactionSigner;
  market: Address;
  vouchAccount: Address;
  option: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
}

export async function closeVouchAccount(
  input: CloseVouchAccountParams
): Promise<CloseVouchAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseVouchAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

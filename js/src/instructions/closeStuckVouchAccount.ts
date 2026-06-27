import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseStuckVouchAccountInstructionAsync,
  type CloseStuckVouchAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseStuckVouchAccountParams extends BaseInstructionParams {
  signer: TransactionSigner;
  rentPayer: Address;
  market: Address;
  tokenMint: Address;
  signerTokenAccount: Address;
  tokenProgram: Address;
  vouchAccountId: number;
}

export async function closeStuckVouchAccount(
  input: CloseStuckVouchAccountParams
): Promise<CloseStuckVouchAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseStuckVouchAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

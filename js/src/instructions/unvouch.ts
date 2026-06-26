import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getUnvouchInstructionAsync,
  type UnvouchInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface UnvouchParams extends BaseInstructionParams {
  signer: TransactionSigner;
  owner: Address;
  market: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
  vouchAccountId: number;
}

export async function unvouch(
  input: UnvouchParams,
): Promise<UnvouchInstruction<string>> {
  const { programAddress, ...params } = input;

  return getUnvouchInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

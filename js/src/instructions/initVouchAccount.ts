import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getInitVouchAccountInstructionAsync,
  type InitVouchAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface InitVouchAccountParams extends BaseInstructionParams {
  payer: TransactionSigner;
  owner: Address;
  market: Address;
  vouchAccountId: number;
}

export async function initVouchAccount(
  input: InitVouchAccountParams
): Promise<InitVouchAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getInitVouchAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

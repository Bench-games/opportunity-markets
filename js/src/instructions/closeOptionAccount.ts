import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCloseOptionAccountInstructionAsync,
  type CloseOptionAccountInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CloseOptionAccountParams extends BaseInstructionParams {
  signer: TransactionSigner;
  market: Address;
  platformConfig: Address;
  optionId: number | bigint;
}

export async function closeOptionAccount(
  input: CloseOptionAccountParams
): Promise<CloseOptionAccountInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCloseOptionAccountInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

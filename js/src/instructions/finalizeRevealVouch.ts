import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getFinalizeRevealVouchInstructionAsync,
  type FinalizeRevealVouchInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface FinalizeRevealVouchParams extends BaseInstructionParams {
  signer: TransactionSigner;
  owner: Address;
  market: Address;
  optionId: number | bigint;
  vouchAccountId: number;
}

export async function finalizeRevealVouch(
  input: FinalizeRevealVouchParams
): Promise<FinalizeRevealVouchInstruction<string>> {
  const { programAddress, ...params } = input;
  return getFinalizeRevealVouchInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner } from "@solana/kit";
import {
  getCancelUpdateAuthorityChangeInstructionAsync,
  type CancelUpdateAuthorityChangeInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CancelUpdateAuthorityChangeParams extends BaseInstructionParams {
  signer: TransactionSigner;
}

export async function cancelUpdateAuthorityChange(
  input: CancelUpdateAuthorityChangeParams
): Promise<CancelUpdateAuthorityChangeInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCancelUpdateAuthorityChangeInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

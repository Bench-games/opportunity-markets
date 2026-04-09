import { type TransactionSigner } from "@solana/kit";
import {
  getFinalizeNewUpdateAuthorityInstructionAsync,
  type FinalizeNewUpdateAuthorityInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface FinalizeNewUpdateAuthorityParams extends BaseInstructionParams {
  updateAuthority: TransactionSigner;
  proposedAuthority: TransactionSigner;
}

export async function finalizeNewUpdateAuthority(
  input: FinalizeNewUpdateAuthorityParams
): Promise<FinalizeNewUpdateAuthorityInstruction<string>> {
  const { programAddress, ...params } = input;
  return getFinalizeNewUpdateAuthorityInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

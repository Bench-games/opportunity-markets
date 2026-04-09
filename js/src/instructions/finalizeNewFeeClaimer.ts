import { type TransactionSigner } from "@solana/kit";
import {
  getFinalizeNewFeeClaimerInstructionAsync,
  type FinalizeNewFeeClaimerInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface FinalizeNewFeeClaimerParams extends BaseInstructionParams {
  updateAuthority: TransactionSigner;
  proposedFeeClaimer: TransactionSigner;
}

export async function finalizeNewFeeClaimer(
  input: FinalizeNewFeeClaimerParams
): Promise<FinalizeNewFeeClaimerInstruction<string>> {
  const { programAddress, ...params } = input;
  return getFinalizeNewFeeClaimerInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

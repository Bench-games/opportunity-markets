import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getProposeNewFeeClaimerInstructionAsync,
  type ProposeNewFeeClaimerInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface ProposeNewFeeClaimerParams extends BaseInstructionParams {
  updateAuthority: TransactionSigner;
  proposedFeeClaimer: Address;
}

export async function proposeNewFeeClaimer(
  input: ProposeNewFeeClaimerParams
): Promise<ProposeNewFeeClaimerInstruction<string>> {
  const { programAddress, ...params } = input;
  return getProposeNewFeeClaimerInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

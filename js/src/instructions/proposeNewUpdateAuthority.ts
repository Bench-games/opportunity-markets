import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getProposeNewUpdateAuthorityInstructionAsync,
  type ProposeNewUpdateAuthorityInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface ProposeNewUpdateAuthorityParams extends BaseInstructionParams {
  updateAuthority: TransactionSigner;
  proposedAuthority: Address;
}

export async function proposeNewUpdateAuthority(
  input: ProposeNewUpdateAuthorityParams
): Promise<ProposeNewUpdateAuthorityInstruction<string>> {
  const { programAddress, ...params } = input;
  return getProposeNewUpdateAuthorityInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

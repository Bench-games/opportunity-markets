import { type TransactionSigner } from "@solana/kit";
import {
  getCancelFeeClaimerChangeInstructionAsync,
  type CancelFeeClaimerChangeInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface CancelFeeClaimerChangeParams extends BaseInstructionParams {
  signer: TransactionSigner;
}

export async function cancelFeeClaimerChange(
  input: CancelFeeClaimerChangeParams
): Promise<CancelFeeClaimerChangeInstruction<string>> {
  const { programAddress, ...params } = input;
  return getCancelFeeClaimerChangeInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getEndRevealPeriodInstruction,
  type EndRevealPeriodInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface EndRevealPeriodParams extends BaseInstructionParams {
  authority: TransactionSigner;
  market: Address;
}

export function endRevealPeriod(
  input: EndRevealPeriodParams
): EndRevealPeriodInstruction<string> {
  const { programAddress, ...params } = input;
  return getEndRevealPeriodInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

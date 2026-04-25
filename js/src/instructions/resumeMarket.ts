import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getResumeMarketInstruction,
  type ResumeMarketInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface ResumeMarketParams extends BaseInstructionParams {
  marketAuthority: TransactionSigner;
  market: Address;
}

export function resumeMarket(
  input: ResumeMarketParams
): ResumeMarketInstruction<string> {
  const { programAddress, ...params } = input;
  return getResumeMarketInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

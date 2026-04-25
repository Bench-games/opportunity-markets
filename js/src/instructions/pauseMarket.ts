import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getPauseMarketInstruction,
  type PauseMarketInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface PauseMarketParams extends BaseInstructionParams {
  marketAuthority: TransactionSigner;
  market: Address;
}

export function pauseMarket(
  input: PauseMarketParams
): PauseMarketInstruction<string> {
  const { programAddress, ...params } = input;
  return getPauseMarketInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

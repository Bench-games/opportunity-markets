import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getOpenMarketInstruction,
  type OpenMarketInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface OpenMarketParams extends BaseInstructionParams {
  marketAuthority: TransactionSigner;
  market: Address;
  platformConfig: Address;
  timeToVouch: bigint;
}

export function openMarket(
  input: OpenMarketParams
): OpenMarketInstruction<string> {
  const { programAddress, ...params } = input;
  return getOpenMarketInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getAddMarketOptionInstructionAsync,
  type AddMarketOptionInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface AddMarketOptionParams extends BaseInstructionParams {
  signer: TransactionSigner;
  platformConfig: Address;
  market: Address;
  optionId: number | bigint;
}

export async function addMarketOption(
  input: AddMarketOptionParams
): Promise<AddMarketOptionInstruction<string>> {
  const { programAddress, ...params } = input;
  return getAddMarketOptionInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

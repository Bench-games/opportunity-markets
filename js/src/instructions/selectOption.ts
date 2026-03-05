import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getSelectOptionInstruction,
  type SelectOptionInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";
import { type WinningOption } from "../generated/types";

export interface SelectOptionParams extends BaseInstructionParams {
  authority: TransactionSigner;
  market: Address;
  selections: Array<WinningOption>;
}

export function selectOption(
  input: SelectOptionParams
): SelectOptionInstruction<string> {
  const { programAddress, ...params } = input;
  return getSelectOptionInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

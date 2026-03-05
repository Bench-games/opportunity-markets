import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getSelectWinningOptionsInstruction,
  type SelectWinningOptionsInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";
import { type WinningOption } from "../generated/types";

export interface SelectWinningOptionsParams extends BaseInstructionParams {
  authority: TransactionSigner;
  market: Address;
  selections: Array<WinningOption>;
}

export function selectWinningOptions(
  input: SelectWinningOptionsParams
): SelectWinningOptionsInstruction<string> {
  const { programAddress, ...params } = input;
  return getSelectWinningOptionsInstruction(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getSelectWinningOptionsInstruction,
  type SelectWinningOptionsInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";
import { type WinningOptionArgs } from "../generated/types";

export interface SelectWinningOptionsParams extends BaseInstructionParams {
  marketAuthority: TransactionSigner;
  market: Address;
  selections: Array<WinningOptionArgs>;
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

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getWithdrawVouchInstructionAsync,
  type WithdrawVouchInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface WithdrawVouchParams extends BaseInstructionParams {
  signer: TransactionSigner;
  owner: Address;
  market: Address;
  tokenMint: Address;
  ownerTokenAccount: Address;
  tokenProgram: Address;
  vouchAccountId: number;
}

export async function withdrawVouch(
  input: WithdrawVouchParams,
): Promise<WithdrawVouchInstruction<string>> {
  const { programAddress, ...params } = input;

  return getWithdrawVouchInstructionAsync(
    params,
    programAddress ? { programAddress } : undefined
  );
}

import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getInitTokenVaultInstructionAsync,
  type InitTokenVaultInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface InitTokenVaultParams extends BaseInstructionParams {
  /** The signer/payer for the transaction */
  payer: TransactionSigner;
  /** The token mint for this vault */
  tokenMint: Address;
  /** Address that can withdraw tokens from the vault */
  fundManager: Address;
}

export async function initTokenVault(
  input: InitTokenVaultParams
): Promise<InitTokenVaultInstruction<string>> {
  const { programAddress, payer, tokenMint, fundManager } = input;

  return getInitTokenVaultInstructionAsync(
    {
      payer,
      tokenMint,
      fundManager,
    },
    programAddress ? { programAddress } : undefined
  );
}

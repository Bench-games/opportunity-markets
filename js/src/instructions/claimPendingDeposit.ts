import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getClaimPendingDepositInstructionAsync,
  type ClaimPendingDepositInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";

export interface ClaimPendingDepositParams extends BaseInstructionParams {
  signer: TransactionSigner;
  tokenMint: Address;
  encryptedTokenAccount: Address;
  /** Signer's token account (destination for claimed tokens) */
  signerTokenAccount: Address;
  tokenProgram: Address;
}

export async function claimPendingDeposit(
  input: ClaimPendingDepositParams
): Promise<ClaimPendingDepositInstruction<string>> {
  const { programAddress, signer, tokenMint, encryptedTokenAccount, signerTokenAccount, tokenProgram } = input;

  return getClaimPendingDepositInstructionAsync(
    {
      signer,
      tokenMint,
      encryptedTokenAccount,
      signerTokenAccount,
      tokenProgram,
    },
    programAddress ? { programAddress } : undefined
  );
}

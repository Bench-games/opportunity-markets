import { type TransactionSigner, type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";
import {
  getRevealVouchInstructionAsync,
  type RevealVouchInstruction,
} from "../generated";
import { type ArciumConfig, getComputeAccounts } from "../arcium/computeAccounts";
import {
  awaitComputationFinalization,
  type AwaitComputationOptions,
} from "../arcium/awaitFinalizeComputation";
import { type BaseInstructionParams } from "./instructionParams";

export interface RevealVouchParams extends BaseInstructionParams {
  signer: TransactionSigner;
  owner: Address;
  market: Address;
  vouchAccountId: number;
}

export async function revealVouch(
  input: RevealVouchParams,
  config: ArciumConfig
): Promise<RevealVouchInstruction<string>> {
  const { programAddress, signer, owner, market, vouchAccountId } = input;

  return getRevealVouchInstructionAsync(
    {
      ...getComputeAccounts("reveal_vouch", config),
      signer,
      owner,
      market,
      vouchAccountId,
    },
    programAddress ? { programAddress } : undefined
  );
}

export async function awaitRevealVouchFinalization(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: Signature,
  config: ArciumConfig,
  options?: AwaitComputationOptions,
): Promise<Signature> {
  const { computationAccount } = getComputeAccounts("reveal_vouch", config);
  return awaitComputationFinalization(rpc, computationAccount, txSignature, options);
}

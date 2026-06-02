import { type TransactionSigner, type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";
import {
  getRevealStakeInstructionAsync,
  type RevealStakeInstruction,
} from "../generated";
import { type ArciumConfig, getComputeAccounts } from "../arcium/computeAccounts";
import {
  awaitComputationFinalization,
  type AwaitComputationOptions,
} from "../arcium/awaitFinalizeComputation";
import { type BaseInstructionParams } from "./instructionParams";

export interface RevealStakeParams extends BaseInstructionParams {
  signer: TransactionSigner;
  owner: Address;
  market: Address;
  stakeAccountId: number;
}

export async function revealStake(
  input: RevealStakeParams,
  config: ArciumConfig
): Promise<RevealStakeInstruction<string>> {
  const { programAddress, signer, owner, market, stakeAccountId } = input;

  return getRevealStakeInstructionAsync(
    {
      ...getComputeAccounts("reveal_stake", config),
      signer,
      owner,
      market,
      stakeAccountId,
    },
    programAddress ? { programAddress } : undefined
  );
}

export async function awaitRevealStakeFinalization(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: Signature,
  config: ArciumConfig,
  options?: AwaitComputationOptions,
): Promise<Signature> {
  const { computationAccount } = getComputeAccounts("reveal_stake", config);
  return awaitComputationFinalization(rpc, computationAccount, txSignature, options);
}

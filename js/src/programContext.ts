import {
  type Address,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "./generated";
import {
  awaitRevealVouchFinalization,
  revealVouch,
  type RevealVouchParams,
} from "./instructions/revealVouch";
import {
  awaitVouchFinalization,
  vouch,
  type VouchParams,
} from "./instructions/vouch";
import {
  withdrawVouch,
  type WithdrawVouchParams,
} from "./instructions/withdrawVouch";
import type { AwaitComputationOptions } from "./arcium/awaitFinalizeComputation";
import { getComputeAccounts } from "./arcium/computeAccounts";
import {
  ARCIUM_DEVNET_CLUSTER_OFFSET,
  ARCIUM_MAINNET_10K_CLUSTER_OFFSET,
  ARCIUM_MAINNET_CLUSTER_OFFSET,
} from "./arcium/constants";

type ContextInput<T extends { programAddress?: Address }> = Omit<
  T,
  "programAddress"
>;

export class ProgramContext {
  constructor(
    readonly clusterOffset: number,
    readonly programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  ) {}

  static devnet(
    programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  ): ProgramContext {
    return new ProgramContext(ARCIUM_DEVNET_CLUSTER_OFFSET, programId);
  }

  static mainnet(
    programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  ): ProgramContext {
    return new ProgramContext(ARCIUM_MAINNET_CLUSTER_OFFSET, programId);
  }

  static mainnet10k(
    programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
  ): ProgramContext {
    return new ProgramContext(ARCIUM_MAINNET_10K_CLUSTER_OFFSET, programId);
  }

  getComputeAccounts(ixName: string, computationOffset: bigint) {
    return getComputeAccounts(ixName, this.config(computationOffset));
  }

  vouch(input: ContextInput<VouchParams>, computationOffset: bigint) {
    return vouch(
      { ...input, programAddress: this.programId },
      this.config(computationOffset)
    );
  }

  revealVouch(
    input: ContextInput<RevealVouchParams>,
    computationOffset: bigint
  ) {
    return revealVouch(
      { ...input, programAddress: this.programId },
      this.config(computationOffset)
    );
  }

  withdrawVouch(input: ContextInput<WithdrawVouchParams>) {
    return withdrawVouch({ ...input, programAddress: this.programId });
  }

  awaitVouchFinalization(
    rpc: Rpc<SolanaRpcApi>,
    txSignature: Signature,
    computationOffset: bigint,
    options?: AwaitComputationOptions
  ): Promise<Signature> {
    return awaitVouchFinalization(
      rpc,
      txSignature,
      this.config(computationOffset),
      options
    );
  }

  awaitRevealVouchFinalization(
    rpc: Rpc<SolanaRpcApi>,
    txSignature: Signature,
    computationOffset: bigint,
    options?: AwaitComputationOptions
  ): Promise<Signature> {
    return awaitRevealVouchFinalization(
      rpc,
      txSignature,
      this.config(computationOffset),
      options
    );
  }

  private config(computationOffset: bigint) {
    return {
      clusterOffset: this.clusterOffset,
      computationOffset,
      programId: this.programId,
    };
  }
}

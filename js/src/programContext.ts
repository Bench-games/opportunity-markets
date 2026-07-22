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
import {
  claimComputationRent,
  type ClaimComputationRentParams,
} from "./arcium/claimComputationRent";

type ContextInput<T extends { programAddress?: Address }> = Omit<
  T,
  "programAddress"
>;

const DEVNET_MXE_X25519_PUBLIC_KEY = Uint8Array.of(
  0x6b, 0x84, 0x48, 0xee, 0xa9, 0x2f, 0x14, 0x19,
  0xec, 0x78, 0x25, 0xc7, 0xaf, 0xb9, 0x5f, 0xdf,
  0x22, 0x9b, 0x73, 0xbe, 0xfc, 0x3a, 0x8b, 0x12,
  0xd6, 0xee, 0xf9, 0x4f, 0x2f, 0xcb, 0xb3, 0x2c
);

const MAINNET_MXE_X25519_PUBLIC_KEY = Uint8Array.of(
  0xaa, 0xa3, 0x9b, 0x62, 0x1e, 0x52, 0x56, 0x3c,
  0xb2, 0xe8, 0x85, 0x67, 0x37, 0x89, 0x6b, 0x15,
  0x43, 0xe4, 0xc9, 0x1b, 0xbf, 0xfc, 0x40, 0x1c,
  0x87, 0xf1, 0x64, 0x92, 0xa2, 0xc1, 0x18, 0x26
);

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

  get mxeX25519PublicKey(): Uint8Array {
    switch (this.clusterOffset) {
      case ARCIUM_DEVNET_CLUSTER_OFFSET:
        return DEVNET_MXE_X25519_PUBLIC_KEY.slice();
      case ARCIUM_MAINNET_CLUSTER_OFFSET:
      case ARCIUM_MAINNET_10K_CLUSTER_OFFSET:
        return MAINNET_MXE_X25519_PUBLIC_KEY.slice();
      default:
        throw new Error(
          `No MXE X25519 public key configured for cluster offset ${this.clusterOffset}`
        );
    }
  }

  getComputeAccounts(ixName: string, computationOffset: bigint) {
    return getComputeAccounts(ixName, this.config(computationOffset));
  }

  claimComputationRent(
    input: Omit<ClaimComputationRentParams, "clusterOffset">
  ) {
    return claimComputationRent({
      ...input,
      clusterOffset: this.clusterOffset,
    });
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

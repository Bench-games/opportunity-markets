import { address, Address } from "@solana/kit";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
} from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "../generated";
import {
  ARCIUM_DEVNET_CLUSTER_OFFSET,
  ARCIUM_MAINNET_10K_CLUSTER_OFFSET,
  ARCIUM_MAINNET_CLUSTER_OFFSET,
} from "./constants";

function toAddress(pubkey: { toBase58(): string }): Address {
  return address(pubkey.toBase58());
}
export interface ArciumConfig {
  clusterOffset: number;
  computationOffset: bigint;
  programId?: Address;
}

export type ArciumNetworkConfig = Omit<ArciumConfig, "clusterOffset">;

export function getComputeAccounts(ixName: string, config: ArciumConfig) {
  const programId = config.programId ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS;
  const programIdLegacy = new PublicKey(programId);
  const { clusterOffset, computationOffset } = config;
  const mxeAccount = toAddress(getMXEAccAddress(programIdLegacy));
  const clusterAccount = toAddress(getClusterAccAddress(clusterOffset));
  const mempoolAccount = toAddress(getMempoolAccAddress(clusterOffset));
  const executingPool = toAddress(getExecutingPoolAccAddress(clusterOffset));

  // Convert bigint to BN correctly - BN doesn't support native bigint directly
  const computationOffsetBN = new BN(computationOffset.toString());

  const computationAccount = toAddress(
    getComputationAccAddress(clusterOffset, computationOffsetBN)
  );
  const compDefAccount = toAddress(
    getCompDefAccAddress(
      programIdLegacy,
      Buffer.from(getCompDefAccOffset(ixName)).readUInt32LE()
    )
  );

  return {
    mxeAccount,
    clusterAccount,
    mempoolAccount,
    executingPool,
    computationAccount,
    compDefAccount,
    computationOffset,
  };
}

export function getComputeAccountsMainnet(
  ixName: string,
  config: ArciumNetworkConfig
) {
  return getComputeAccounts(ixName, {
    ...config,
    clusterOffset: ARCIUM_MAINNET_CLUSTER_OFFSET,
  });
}

export function getComputeAccountsMainnet10k(
  ixName: string,
  config: ArciumNetworkConfig
) {
  return getComputeAccounts(ixName, {
    ...config,
    clusterOffset: ARCIUM_MAINNET_10K_CLUSTER_OFFSET,
  });
}

export function getComputeAccountsDevnet(
  ixName: string,
  config: ArciumNetworkConfig
) {
  return getComputeAccounts(ixName, {
    ...config,
    clusterOffset: ARCIUM_DEVNET_CLUSTER_OFFSET,
  });
}

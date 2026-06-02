import { type TransactionSigner, type Address, type Instruction } from "@solana/kit";
import {
  fetchMaybePlatformConfig,
  getInitPlatformConfigInstructionAsync,
} from "../generated";
import { getPlatformConfigAddress } from "../accounts/platformConfig";
import { type BaseInstructionParams } from "./instructionParams";

export interface CreatePlatformConfigParams extends BaseInstructionParams {
  signer: TransactionSigner;
  name: string;
  platformFeeBp: number;
  rewardPoolFeeBp: number;
  creatorFeeBp: number;
  feeClaimAuthority: Address;
  revealAuthority: Address;
  minTimeToStakeSeconds: bigint;
  revealPeriodSeconds: bigint;
  marketResolutionDeadlineSeconds: bigint;
}

export async function createPlatformConfig(
  rpc: Parameters<typeof fetchMaybePlatformConfig>[0],
  params: CreatePlatformConfigParams,
): Promise<Instruction> {
  const {
    programAddress,
    signer,
    name,
    platformFeeBp,
    rewardPoolFeeBp,
    creatorFeeBp,
    feeClaimAuthority,
    revealAuthority,
    minTimeToStakeSeconds,
    revealPeriodSeconds,
    marketResolutionDeadlineSeconds,
  } = params;

  const [platformConfigAddress] = await getPlatformConfigAddress(
    signer.address,
    name,
    programAddress,
  );
  const existing = await fetchMaybePlatformConfig(rpc, platformConfigAddress);
  if (existing.exists) {
    throw new Error(
      `Platform config already exists for (${signer.address}, "${name}") at ${platformConfigAddress}`,
    );
  }

  return getInitPlatformConfigInstructionAsync(
    {
      payer: signer,
      name,
      platformFeeBp,
      rewardPoolFeeBp,
      creatorFeeBp,
      feeClaimAuthority,
      revealAuthority,
      minTimeToStakeSeconds,
      revealPeriodSeconds,
      marketResolutionDeadlineSeconds,
    },
    programAddress ? { programAddress } : undefined,
  ) as Promise<Instruction>;
}

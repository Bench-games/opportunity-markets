import { type TransactionSigner, type Address, type Instruction } from "@solana/kit";
import {
  fetchMaybePlatformConfig,
  getInitPlatformConfigInstructionAsync,
  getUpdatePlatformConfigInstruction,
} from "../generated";
import { getPlatformConfigAddress } from "../accounts/platformConfig";
import { type BaseInstructionParams } from "./instructionParams";

export interface EnsurePlatformConfigParams extends BaseInstructionParams {
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

export async function ensurePlatformConfig(
  rpc: Parameters<typeof fetchMaybePlatformConfig>[0],
  params: EnsurePlatformConfigParams,
): Promise<Instruction | null> {
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
  const config = programAddress ? { programAddress } : undefined;

  const [platformConfigAddress] = await getPlatformConfigAddress(
    signer.address,
    name,
    programAddress,
  );
  const existing = await fetchMaybePlatformConfig(rpc, platformConfigAddress);

  if (existing.exists) {
    const s = existing.data;
    if (
      s.feeRates.platformFeeBp === platformFeeBp &&
      s.feeRates.rewardPoolFeeBp === rewardPoolFeeBp &&
      s.feeRates.creatorFeeBp === creatorFeeBp &&
      s.minTimeToStakeSeconds === minTimeToStakeSeconds &&
      s.revealPeriodSeconds === revealPeriodSeconds &&
      s.marketResolutionDeadlineSeconds === marketResolutionDeadlineSeconds
    ) {
      return null;
    }

    return getUpdatePlatformConfigInstruction(
      {
        updateAuthority: signer,
        platformConfig: platformConfigAddress,
        platformFeeBp,
        rewardPoolFeeBp,
        creatorFeeBp,
        revealAuthority,
        minTimeToStakeSeconds,
        revealPeriodSeconds,
        marketResolutionDeadlineSeconds,
      },
      config,
    ) as Instruction;
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
    config,
  ) as Promise<Instruction>;
}

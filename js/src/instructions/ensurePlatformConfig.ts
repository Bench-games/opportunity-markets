import { type TransactionSigner, type Address, type Instruction } from "@solana/kit";
import {
  fetchMaybePlatformConfig,
  getInitPlatformConfigInstruction,
  getUpdatePlatformConfigInstruction,
} from "../generated";
import { getPlatformConfigAddress } from "../accounts/platformConfig";
import { type BaseInstructionParams } from "./instructionParams";

export interface EnsurePlatformConfigParams extends BaseInstructionParams {
  signer: TransactionSigner;
  name: string;
  userPlatformFeeBp: number;
  userRewardPoolFeeBp: number;
  userCreatorFeeBp: number;
  sponsorPlatformFeeBp: number;
  feeClaimAuthority: Address;
  revealAuthority: Address;
  minTimeToVouchSeconds: bigint;
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
    userPlatformFeeBp,
    userRewardPoolFeeBp,
    userCreatorFeeBp,
    sponsorPlatformFeeBp,
    feeClaimAuthority,
    revealAuthority,
    minTimeToVouchSeconds,
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
      s.feeRates.userPlatformFeeBp === userPlatformFeeBp &&
      s.feeRates.userRewardPoolFeeBp === userRewardPoolFeeBp &&
      s.feeRates.userCreatorFeeBp === userCreatorFeeBp &&
      s.feeRates.sponsorPlatformFeeBp === sponsorPlatformFeeBp &&
      s.minTimeToVouchSeconds === minTimeToVouchSeconds &&
      s.revealPeriodSeconds === revealPeriodSeconds &&
      s.marketResolutionDeadlineSeconds === marketResolutionDeadlineSeconds
    ) {
      return null;
    }

    return getUpdatePlatformConfigInstruction(
      {
        updateAuthority: signer,
        platformConfig: platformConfigAddress,
        params: {
          userPlatformFeeBp,
          userRewardPoolFeeBp,
          userCreatorFeeBp,
          sponsorPlatformFeeBp,
          revealAuthority,
          minTimeToVouchSeconds,
          revealPeriodSeconds,
          marketResolutionDeadlineSeconds,
        },
      },
      config,
    ) as Instruction;
  }

  return getInitPlatformConfigInstruction(
    {
      payer: signer,
      platformConfig: platformConfigAddress,
      params: {
        name,
        userPlatformFeeBp,
        userRewardPoolFeeBp,
        userCreatorFeeBp,
        sponsorPlatformFeeBp,
        feeClaimAuthority,
        revealAuthority,
        minTimeToVouchSeconds,
        revealPeriodSeconds,
        marketResolutionDeadlineSeconds,
      },
    },
    config,
  ) as Instruction;
}

import { type TransactionSigner, type Address, type Instruction } from "@solana/kit";
import {
  fetchMaybePlatformConfig,
  getInitPlatformConfigInstruction,
} from "../generated";
import { getPlatformConfigAddress } from "../accounts/platformConfig";
import { type BaseInstructionParams } from "./instructionParams";

export interface CreatePlatformConfigParams extends BaseInstructionParams {
  signer: TransactionSigner;
  name: string;
  userPlatformFeeBp: number;
  userRewardPoolFeeBp: number;
  userCreatorFeeBp: number;
  sponsorPlatformFeeBp: number;
  feeClaimAuthority: Address;
  revealAuthority: Address;
  optionCreationAuthority: Address;
  minTimeToVouchSeconds: bigint;
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
    userPlatformFeeBp,
    userRewardPoolFeeBp,
    userCreatorFeeBp,
    sponsorPlatformFeeBp,
    feeClaimAuthority,
    revealAuthority,
    optionCreationAuthority,
    minTimeToVouchSeconds,
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
        optionCreationAuthority,
        minTimeToVouchSeconds,
        revealPeriodSeconds,
        marketResolutionDeadlineSeconds,
      },
    },
    programAddress ? { programAddress } : undefined,
  ) as Instruction;
}

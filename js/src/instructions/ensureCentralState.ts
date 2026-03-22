import { type TransactionSigner, type Address, type Instruction } from "@solana/kit";
import {
  fetchMaybeCentralState,
  getInitCentralStateInstructionAsync,
  getUpdateCentralStateInstructionAsync,
} from "../generated";
import { getCentralStateAddress } from "../accounts/centralState";
import { type BaseInstructionParams } from "./instructionParams";

export interface EnsureCentralStateParams extends BaseInstructionParams {
  signer: TransactionSigner;
  earlinessCutoffSeconds: bigint | number;
  minOptionDeposit: bigint | number;
  protocolFeeBp: number;
  feeRecipient: Address;
  rewardWithdrawStakedLimit: number;
  minimumInitialRevealPeriod: bigint | number;
}

export async function ensureCentralState(
  rpc: Parameters<typeof fetchMaybeCentralState>[0],
  params: EnsureCentralStateParams,
): Promise<Instruction | null> {
  const { programAddress, signer, ...args } = params;
  const config = programAddress ? { programAddress } : undefined;

  const [centralStateAddress] = await getCentralStateAddress(programAddress);
  const existing = await fetchMaybeCentralState(rpc, centralStateAddress);

  if (existing.exists) {
    const s = existing.data;
    if (
      s.earlinessCutoffSeconds === BigInt(args.earlinessCutoffSeconds) &&
      s.minOptionDeposit === BigInt(args.minOptionDeposit) &&
      s.protocolFeeBp === args.protocolFeeBp &&
      s.feeRecipient === args.feeRecipient &&
      s.rewardWithdrawStakedLimit === args.rewardWithdrawStakedLimit &&
      s.minimumInitialRevealPeriod === BigInt(args.minimumInitialRevealPeriod)
    ) {
      return null;
    }

    return getUpdateCentralStateInstructionAsync(
      { authority: signer, ...args },
      config,
    ) as Promise<Instruction>;
  }

  return getInitCentralStateInstructionAsync(
    { payer: signer, ...args },
    config,
  ) as Promise<Instruction>;
}

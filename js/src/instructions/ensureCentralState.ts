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
  protocolFeeBp: number;
  feeClaimer: Address;
}

export async function ensureCentralState(
  rpc: Parameters<typeof fetchMaybeCentralState>[0],
  params: EnsureCentralStateParams,
): Promise<Instruction | null> {
  const { programAddress, signer, protocolFeeBp, feeClaimer } = params;
  const config = programAddress ? { programAddress } : undefined;

  const [centralStateAddress] = await getCentralStateAddress(programAddress);
  const existing = await fetchMaybeCentralState(rpc, centralStateAddress);

  if (existing.exists) {
    const s = existing.data;
    if (s.protocolFeeBp === protocolFeeBp) {
      return null;
    }

    return getUpdateCentralStateInstructionAsync(
      { updateAuthority: signer, protocolFeeBp },
      config,
    ) as Promise<Instruction>;
  }

  return getInitCentralStateInstructionAsync(
    { payer: signer, protocolFeeBp, feeClaimer },
    config,
  ) as Promise<Instruction>;
}

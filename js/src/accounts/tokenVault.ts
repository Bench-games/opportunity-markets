import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "../generated";

export const TOKEN_VAULT_SEED = "token_vault";

export async function getTokenVaultAddress(
  mint: Address,
  programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [TOKEN_VAULT_SEED, getAddressEncoder().encode(mint)],
  });
}

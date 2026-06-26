import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type ProgramDerivedAddress,
} from "@solana/kit";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "../generated";

export const VOUCH_ACCOUNT_SEED = "vouch_account";

export async function getVouchAccountAddress(
  owner: Address,
  market: Address,
  vouchAccountId: number,
  programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
): Promise<ProgramDerivedAddress> {
  const addressEncoder = getAddressEncoder();
  const idBytes = new Uint8Array(4);
  new DataView(idBytes.buffer).setUint32(0, vouchAccountId, true);
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      VOUCH_ACCOUNT_SEED,
      addressEncoder.encode(owner),
      addressEncoder.encode(market),
      idBytes,
    ],
  });
}

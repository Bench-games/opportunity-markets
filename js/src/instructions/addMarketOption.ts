import {
  type TransactionSigner,
  type Address,
  getProgramDerivedAddress,
  getBytesEncoder,
  getAddressEncoder,
  getU64Encoder,
} from "@solana/kit";
import {
  getAddMarketOptionInstruction,
  type AddMarketOptionInstruction,
} from "../generated";
import { type BaseInstructionParams } from "./instructionParams";
import { OPPORTUNITY_MARKET_PROGRAM_ADDRESS } from "../generated/programs";

export interface AddMarketOptionParams extends BaseInstructionParams {
  marketAuthority: TransactionSigner;
  market: Address;
  /** Value of market.total_options BEFORE this call (becomes the new option's id). */
  nextOptionId: number | bigint;
}

export async function addMarketOption(
  input: AddMarketOptionParams
): Promise<AddMarketOptionInstruction<string>> {
  const { programAddress, nextOptionId, ...rest } = input;
  const resolvedProgramAddress = programAddress ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS;

  const [option] = await getProgramDerivedAddress({
    programAddress: resolvedProgramAddress,
    seeds: [
      getBytesEncoder().encode(new Uint8Array([111, 112, 116, 105, 111, 110])),
      getAddressEncoder().encode(rest.market),
      getU64Encoder().encode(BigInt(nextOptionId)),
    ],
  });

  return getAddMarketOptionInstruction(
    { ...rest, option },
    programAddress ? { programAddress } : undefined
  ) as AddMarketOptionInstruction<string>;
}

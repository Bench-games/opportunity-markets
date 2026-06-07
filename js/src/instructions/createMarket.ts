import { type TransactionSigner, type Address } from "@solana/kit";
import {
  getCreateMarketInstructionAsync,
  type CreateMarketInstruction,
  OPPORTUNITY_MARKET_PROGRAM_ADDRESS,
} from "../generated";
import { getOpportunityMarketAddress } from "../accounts/opportunityMarket";
import { type ByteArray, toNumberArray } from "../utils";
import { type BaseInstructionParams } from "./instructionParams";

export interface CreateMarketParams extends BaseInstructionParams {
  creator: TransactionSigner;
  platformConfig: Address;
  tokenMint: Address;
  tokenProgram: Address;
  marketIndex: bigint;
  marketAuthority: Address;
  authorizedReaderPubkey: ByteArray;
  earlinessCutoffSeconds: bigint;
  earlinessMultiplier: number;
  minStakeAmount: bigint;
  creatorFeeClaimer: Address;
}

export async function createMarket(
  input: CreateMarketParams,
): Promise<CreateMarketInstruction<string>> {
  const {
    programAddress,
    creator,
    platformConfig,
    tokenMint,
    tokenProgram,
    marketIndex,
    marketAuthority,
    authorizedReaderPubkey,
    earlinessCutoffSeconds,
    earlinessMultiplier,
    minStakeAmount,
    creatorFeeClaimer,
  } = input;

  const resolvedProgramAddress = programAddress ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS;
  const [market] = await getOpportunityMarketAddress(
    platformConfig,
    creator.address,
    marketIndex,
    resolvedProgramAddress,
  );

  return getCreateMarketInstructionAsync(
    {
      creator,
      platformConfig,
      tokenMint,
      tokenProgram,
      market,
      params: {
        marketIndex,
        marketAuthority,
        authorizedReaderPubkey: toNumberArray(authorizedReaderPubkey),
        earlinessCutoffSeconds,
        earlinessMultiplier,
        minStakeAmount,
        creatorFeeClaimer,
      },
    },
    programAddress ? { programAddress } : undefined,
  );
}

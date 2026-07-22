import {
  AccountRole,
  fixEncoderSize,
  getBytesEncoder,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import { ARCIUM_PROGRAM_ID } from "./constants";

const CLAIM_COMPUTATION_RENT_DISCRIMINATOR = new Uint8Array([
  215, 218, 1, 166, 81, 218, 16, 151,
]);
const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

export interface ClaimComputationRentParams {
  signer: Address;
  computationAccount: Address;
  computationOffset: bigint;
  clusterOffset: number;
}

const instructionDataEncoder = getStructEncoder([
  ["discriminator", fixEncoderSize(getBytesEncoder(), 8)],
  ["computationOffset", getU64Encoder()],
  ["clusterOffset", getU32Encoder()],
]);

export function claimComputationRent(
  input: ClaimComputationRentParams
): Instruction {
  return {
    programAddress: ARCIUM_PROGRAM_ID,
    accounts: [
      { address: input.signer, role: AccountRole.WRITABLE_SIGNER },
      { address: input.computationAccount, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: instructionDataEncoder.encode({
      discriminator: CLAIM_COMPUTATION_RENT_DISCRIMINATOR,
      computationOffset: input.computationOffset,
      clusterOffset: input.clusterOffset,
    }),
  };
}

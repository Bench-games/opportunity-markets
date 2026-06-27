import {
  type TransactionSigner,
  type Address,
  address,
  type Instruction,
  SolanaRpcApi,
  Rpc,
  assertAccountExists,
  fetchEncodedAccount,
} from "@solana/kit";
import {
  getMXEAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
} from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";
import {
  getVouchCompDefInstruction,
  getRevealVouchCompDefInstruction,
  OPPORTUNITY_MARKET_PROGRAM_ADDRESS,
  getMXEAccountDecoder,
} from "../generated";
import { BN } from "bn.js";
import { type BaseInstructionParams } from "./instructionParams";

export type CompDefCircuitName =
  | "vouch"
  | "reveal_vouch";

export const ALL_COMP_DEF_CIRCUITS: CompDefCircuitName[] = [
  "vouch",
  "reveal_vouch",
];


function toAddress(pubkey: { toBase58(): string }): Address {
  return address(pubkey.toBase58());
}

export interface InitCompDefConfig extends BaseInstructionParams {}

export async function getMxeAccount(rpc: Rpc<SolanaRpcApi>, programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS) {
  const programIdLegacy = new PublicKey(programId);
  const mxeAddress = toAddress(getMXEAccAddress(programIdLegacy));
  const encoded = await fetchEncodedAccount(rpc, mxeAddress);
  assertAccountExists(encoded);
  const data = getMXEAccountDecoder().decode(encoded.data.slice(8));
  return { address: mxeAddress, data };
}

export function getCompDefAccount(
  circuitName: CompDefCircuitName,
  programId: Address = OPPORTUNITY_MARKET_PROGRAM_ADDRESS
): Address {
  const programIdLegacy = new PublicKey(programId);
  const offset = getCompDefAccOffset(circuitName);
  return toAddress(
    getCompDefAccAddress(programIdLegacy, Buffer.from(offset).readUInt32LE())
  );
}


export function getCompDefOffsetNumber(circuitName: CompDefCircuitName): number {
  const offset = getCompDefAccOffset(circuitName);
  return Buffer.from(offset).readUInt32LE();
}


export async function getInitCompDefInstruction(
  rpc: Rpc<SolanaRpcApi>,
  payer: TransactionSigner,
  circuitName: CompDefCircuitName,
  config: InitCompDefConfig = {}
): Promise<Instruction> {
  const programId = config.programAddress ?? OPPORTUNITY_MARKET_PROGRAM_ADDRESS;
  const mxeAccount = await getMxeAccount(rpc, programId);
  const compDefAccount = getCompDefAccount(circuitName, programId);
  const lutAddress = getLookupTableAddress(
    new PublicKey(programId.toString()),
    new BN(mxeAccount.data.lutOffsetSlot)
  );

  const baseInput = {
    payer,
    mxeAccount: mxeAccount.address,
    compDefAccount,
    addressLookupTable: toAddress(lutAddress),

  };

  switch (circuitName) {
    case "vouch":
      return getVouchCompDefInstruction(baseInput, { programAddress: programId });

    case "reveal_vouch":
      return getRevealVouchCompDefInstruction(baseInput, { programAddress: programId });

    default:
      throw new Error(`Unknown circuit: ${circuitName}`);
  }
}

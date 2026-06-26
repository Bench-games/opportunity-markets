import { type TransactionSigner, type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";
import {
  getVouchInstructionAsync,
  type VouchInstruction,
} from "../generated";
import { type ArciumConfig, getComputeAccounts } from "../arcium/computeAccounts";
import {
  awaitComputationFinalization,
  type AwaitComputationOptions,
} from "../arcium/awaitFinalizeComputation";
import { type ByteArray, toNumberArray } from "../utils";
import { type BaseInstructionParams } from "./instructionParams";

export interface VouchParams extends BaseInstructionParams {
  signer: TransactionSigner;
  payer: TransactionSigner;
  market: Address;
  /** PDA of the vouch_account being vouched into. Use `getVouchAccountAddress(owner, market, id)`. */
  vouchAccount: Address;
  vouchAccountId: number;
  tokenMint: Address;
  signerTokenAccount: Address;
  tokenProgram: Address;
  /** Gross amount (net + fee). Fee is deducted on-chain and routed to the fee vault ATA. */
  amount: bigint;
  selectedOptionCiphertext: ByteArray;
  inputNonce: bigint;
  authorizedReaderNonce: bigint;
  /** User's x25519 public key (NOT their Solana wallet pubkey). */
  userPubkey: ByteArray;
  /** u128 nonce committed to encrypted-state derivation. */
  stateNonce: bigint;
}

export async function vouch(
  input: VouchParams,
  config: ArciumConfig,
): Promise<VouchInstruction<string>> {
  const {
    programAddress,
    signer,
    payer,
    market,
    vouchAccount,
    vouchAccountId,
    tokenMint,
    signerTokenAccount,
    tokenProgram,
    amount,
    selectedOptionCiphertext,
    inputNonce,
    authorizedReaderNonce,
    userPubkey,
    stateNonce,
  } = input;

  const { computationOffset, ...computeAccounts } = getComputeAccounts("vouch", config);

  return getVouchInstructionAsync(
    {
      ...computeAccounts,
      signer,
      payer,
      market,
      vouchAccount,
      tokenMint,
      signerTokenAccount,
      tokenProgram,
      params: {
        computationOffset,
        vouchAccountId,
        amount,
        selectedOptionCiphertext: toNumberArray(selectedOptionCiphertext),
        inputNonce,
        authorizedReaderNonce,
        userPubkey: toNumberArray(userPubkey),
        stateNonce,
      },
    },
    programAddress ? { programAddress } : undefined,
  );
}

export async function awaitVouchFinalization(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: Signature,
  config: ArciumConfig,
  options?: AwaitComputationOptions,
): Promise<Signature> {
  const { computationAccount } = getComputeAccounts("vouch", config);
  return awaitComputationFinalization(rpc, computationAccount, txSignature, options);
}

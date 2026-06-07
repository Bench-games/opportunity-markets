import { type TransactionSigner, type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";
import {
  getStakeInstructionAsync,
  type StakeInstruction,
} from "../generated";
import { type ArciumConfig, getComputeAccounts } from "../arcium/computeAccounts";
import {
  awaitComputationFinalization,
  type AwaitComputationOptions,
} from "../arcium/awaitFinalizeComputation";
import { type ByteArray, toNumberArray } from "../utils";
import { type BaseInstructionParams } from "./instructionParams";

export interface StakeParams extends BaseInstructionParams {
  signer: TransactionSigner;
  payer: TransactionSigner;
  market: Address;
  /** PDA of the stake_account being staked into. Use `getStakeAccountAddress(owner, market, id)`. */
  stakeAccount: Address;
  stakeAccountId: number;
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

export async function stake(
  input: StakeParams,
  config: ArciumConfig,
): Promise<StakeInstruction<string>> {
  const {
    programAddress,
    signer,
    payer,
    market,
    stakeAccount,
    stakeAccountId,
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

  const { computationOffset, ...computeAccounts } = getComputeAccounts("stake", config);

  return getStakeInstructionAsync(
    {
      ...computeAccounts,
      signer,
      payer,
      market,
      stakeAccount,
      tokenMint,
      signerTokenAccount,
      tokenProgram,
      params: {
        computationOffset,
        stakeAccountId,
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

export async function awaitStakeFinalization(
  rpc: Rpc<SolanaRpcApi>,
  txSignature: Signature,
  config: ArciumConfig,
  options?: AwaitComputationOptions,
): Promise<Signature> {
  const { computationAccount } = getComputeAccounts("stake", config);
  return awaitComputationFinalization(rpc, computationAccount, txSignature, options);
}

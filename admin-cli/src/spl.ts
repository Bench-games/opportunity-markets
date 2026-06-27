import {
  generateKeyPairSigner,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import type { CliContext } from "./context.js";

export { TOKEN_PROGRAM_ADDRESS };

export async function createMintInstructions(ctx: CliContext, decimals = 0) {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const lamports = await ctx.rpc.getMinimumBalanceForRentExemption(space).send();
  const instructions: Instruction[] = [
    getCreateAccountInstruction({
      payer: ctx.payer,
      newAccount: mint,
      lamports,
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMintInstruction({
      mint: mint.address,
      decimals,
      mintAuthority: ctx.payer.address,
    }),
  ];
  return { mint, instructions };
}

export async function getAta(mint: Address, owner: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

export async function createAtaIfMissingInstruction(
  ctx: CliContext,
  mint: Address,
  owner: Address,
): Promise<Instruction | null> {
  const ata = await getAta(mint, owner);
  const info = await ctx.rpc.getAccountInfo(ata, { encoding: "base64", commitment: ctx.commitment }).send();
  if (info.value) return null;
  return getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: ctx.payer,
    mint,
    owner,
  }) as Promise<Instruction>;
}

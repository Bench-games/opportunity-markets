import {
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  fetchMint,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  type Mint,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { CliContext } from "./context.js";

export { TOKEN_PROGRAM_ADDRESS };

export async function fetchTokenMint(ctx: CliContext, mint: Address): Promise<Mint> {
  const account = await fetchMint(ctx.rpc as never, mint, { commitment: ctx.commitment });
  if (account.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error(`Account ${mint} is owned by ${account.programAddress}, not ${TOKEN_PROGRAM_ADDRESS}`);
  }
  if (!account.data.isInitialized) {
    throw new Error(`Mint ${mint} is not initialized`);
  }
  return account.data;
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

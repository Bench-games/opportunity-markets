import { Command } from "commander";
import { createMintInstructions } from "../spl.js";
import { getContext } from "./common.js";
import { confirmTransaction } from "../prompts.js";
import { printHeader, printSummary, printTxResult } from "../render.js";
import { sendInstructions } from "../tx.js";

export function registerMintCommands(program: Command): void {
  const mint = program.command("mint").description("Token mint utilities");

  mint
    .command("create")
    .description("Create a 0-decimal SPL mint")
    .option("--decimals <decimals>", "mint decimals", "0")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const decimals = Number(options.decimals);
      const { mint: mintSigner, instructions } = await createMintInstructions(ctx, decimals);

      printHeader("Create mint");
      printSummary({
        Payer: ctx.payer.address,
        Mint: mintSigner.address,
        Decimals: decimals,
      });
      await confirmTransaction(ctx.yes);
      const sig = await sendInstructions(ctx, instructions, "create mint");
      printTxResult(sig);
      console.log(`Mint: ${mintSigner.address}`);
    });
}

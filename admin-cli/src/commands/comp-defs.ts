import { Command } from "commander";
import {
  ALL_COMP_DEF_CIRCUITS,
  getCompDefAccount,
  getInitCompDefInstruction,
} from "../../../js/src/index.js";
import { getContext } from "./common.js";
import { confirmTransaction } from "../prompts.js";
import { printHeader, printTxResult } from "../render.js";
import { sendInstructions } from "../tx.js";

export function registerCompDefCommands(program: Command): void {
  const compDefs = program.command("comp-defs").description("Manage Arcium computation definitions");

  compDefs
    .command("init")
    .description("Initialize all computation definitions, skipping existing accounts")
    .action(async (_options, command) => {
      const ctx = await getContext(command);
      printHeader("Initialize computation definitions");
      await confirmTransaction(ctx.yes);

      for (const circuitName of ALL_COMP_DEF_CIRCUITS) {
        const compDefAddress = getCompDefAccount(circuitName, ctx.programId);
        const existing = await ctx.rpc
          .getAccountInfo(compDefAddress, { encoding: "base64", commitment: ctx.commitment })
          .send();
        if (existing.value) {
          console.log(`${circuitName}: already initialized at ${compDefAddress}`);
          continue;
        }
        const instruction = await getInitCompDefInstruction(ctx.rpc as never, ctx.payer, circuitName, {
          programAddress: ctx.programId,
        });
        const sig = await sendInstructions(ctx, [instruction], `init ${circuitName} comp def`);
        console.log(`${circuitName}: ${compDefAddress}`);
        printTxResult(sig);
      }
    });
}

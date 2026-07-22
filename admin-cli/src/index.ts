#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { registerArciumCommands } from "./commands/arcium.js";
import { registerCompDefCommands } from "./commands/comp-defs.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerPlatformCommands } from "./commands/platform.js";
import { registerVouchCommands } from "./commands/vouch.js";
import { printProgramContextBadge } from "./render.js";

const program = new Command();

program
  .name("opportunity-admin")
  .description("Admin CLI for Opportunity Markets")
  .option("-y, --yes", "skip interactive transaction confirmation")
  .option("--keypair <path>", "override KEYPAIR_PATH")
  .option("--commitment <level>", "RPC commitment", "confirmed")
  .addHelpText(
    "after",
    `
Environment:
  RPC_URL       Required. Solana RPC endpoint used for all chain reads and transactions.
  PROGRAM_ID    Optional. Overrides the generated JS binding program address.
                Precedence: PROGRAM_ID, then OPPORTUNITY_MARKET_PROGRAM_ADDRESS from js/src/generated.
  PROGRAM_CONTEXT
                Optional. Selects Arcium accounts for devnet (offset 456), mainnet (offset 2026),
                or mainnet10k (offset 10000). Defaults to mainnet.
  KEYPAIR_PATH  Optional. Signer keypair path for transaction commands.
                Precedence: --keypair, then KEYPAIR_PATH, then ~/.config/solana/id.json.

Read-only commands such as "platform list" and "platform allowed-mints" only require RPC_URL.
Transaction commands also require a readable keypair.
`
  );

registerPlatformCommands(program);
registerMarketCommands(program);
registerCompDefCommands(program);
registerArciumCommands(program);
registerVouchCommands(program);

function configureExitOverride(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) configureExitOverride(child);
}

configureExitOverride(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error && error.name === "CommanderError") {
    process.exitCode = Number(
      (error as Error & { exitCode?: number }).exitCode ?? 1
    );
  } else {
    console.error(
      chalk.red("Fatal:"),
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  }
} finally {
  printProgramContextBadge(process.env.PROGRAM_CONTEXT ?? "mainnet");
}

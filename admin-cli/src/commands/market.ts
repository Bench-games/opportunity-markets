import fs from "node:fs";
import { Command } from "commander";
import { address } from "@solana/kit";
import {
  addMarketOption,
  createMarket,
  fetchPlatformConfig,
  getOpportunityMarketAddress,
  openMarket,
} from "../../../js/src/index.js";
import { DEFAULT_MARKET } from "../defaults.js";
import { selectAllowedMint, selectMarket, selectPlatform } from "../discovery.js";
import { getContext } from "./common.js";
import {
  confirmTransaction,
  promptAddress,
  promptBigInt,
  promptExistingFile,
  promptNumber,
} from "../prompts.js";
import { printHeader, printSummary, printTxResult, shortAddress } from "../render.js";
import { TOKEN_PROGRAM_ADDRESS } from "../spl.js";
import { sendInstructions } from "../tx.js";

function readX25519Pubkey(filePath: string): Uint8Array {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { publicKey?: number[] };
  if (!Array.isArray(parsed.publicKey)) throw new Error(`Missing publicKey array in ${filePath}`);
  const publicKey = new Uint8Array(parsed.publicKey);
  if (publicKey.length !== 32) throw new Error(`X25519 public key must be 32 bytes, got ${publicKey.length}`);
  return publicKey;
}

export function registerMarketCommands(program: Command): void {
  const market = program.command("market").description("Manage markets");

  market
    .command("create")
    .description("Create a market")
    .option("--market-index <index>")
    .option("--authorized-reader-keypair <path>")
    .option("--market-authority <address>")
    .option("--creator-fee-claimer <address>")
    .option("--earliness-cutoff-seconds <seconds>")
    .option("--earliness-multiplier <value>")
    .option("--min-vouch-amount <amount>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const platform = await selectPlatform(ctx);
      const mint = await selectAllowedMint(ctx, platform.address);
      const marketIndex = options.marketIndex
        ? BigInt(options.marketIndex)
        : await promptBigInt("Market index", DEFAULT_MARKET.marketIndex);
      const authorizedReaderPath = options.authorizedReaderKeypair
        ?? await promptExistingFile("Authorized reader X25519 keypair path");
      const authorizedReaderPubkey = readX25519Pubkey(authorizedReaderPath);
      const marketAuthority = options.marketAuthority
        ? address(options.marketAuthority)
        : await promptAddress("Market authority", ctx.payer.address);
      const creatorFeeClaimer = options.creatorFeeClaimer
        ? address(options.creatorFeeClaimer)
        : await promptAddress("Creator fee claimer", ctx.payer.address);
      const earlinessCutoffSeconds = options.earlinessCutoffSeconds
        ? BigInt(options.earlinessCutoffSeconds)
        : await promptBigInt("Earliness cutoff seconds", DEFAULT_MARKET.earlinessCutoffSeconds);
      const earlinessMultiplier = options.earlinessMultiplier
        ? Number(options.earlinessMultiplier)
        : await promptNumber("Earliness multiplier", DEFAULT_MARKET.earlinessMultiplier);
      const minVouchAmount = options.minVouchAmount
        ? BigInt(options.minVouchAmount)
        : await promptBigInt("Min vouch amount", DEFAULT_MARKET.minVouchAmount);

      const [marketAddress] = await getOpportunityMarketAddress(platform.address, ctx.payer.address, marketIndex, ctx.programId);
      printHeader("Create market");
      printSummary({
        Platform: `${platform.data.name} ${shortAddress(platform.address)}`,
        Mint: mint.data.mint,
        "Market index": marketIndex,
        "Market address": marketAddress,
        "Market authority": marketAuthority,
        "Creator fee claimer": creatorFeeClaimer,
        "Earliness cutoff": earlinessCutoffSeconds,
        "Earliness multiplier": earlinessMultiplier,
        "Min vouch amount": minVouchAmount,
      });
      await confirmTransaction(ctx.yes);

      const instruction = await createMarket({
        programAddress: ctx.programId,
        creator: ctx.payer,
        platformConfig: platform.address,
        tokenMint: mint.data.mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        marketIndex,
        marketAuthority,
        authorizedReaderPubkey,
        earlinessCutoffSeconds,
        earlinessMultiplier,
        minVouchAmount,
        creatorFeeClaimer,
      });
      const sig = await sendInstructions(ctx, [instruction], "create market");
      printTxResult(sig);
      console.log(`Market: ${marketAddress}`);
    });

  market
    .command("open")
    .description("Open a market for vouching")
    .option("--time-to-vouch <seconds>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const selected = await selectMarket(ctx);
      const platform = await fetchPlatformConfig(ctx.rpc as never, selected.data.platform, {
        commitment: ctx.commitment,
      });
      const timeToVouch = options.timeToVouch
        ? BigInt(options.timeToVouch)
        : await promptBigInt("Time to vouch seconds", platform.data.minTimeToVouchSeconds);
      printSummary({
        Market: selected.address,
        Platform: selected.data.platform,
        "Time to vouch": timeToVouch,
      });
      await confirmTransaction(ctx.yes);
      const sig = await sendInstructions(ctx, [
        openMarket({
          programAddress: ctx.programId,
          marketAuthority: ctx.payer,
          market: selected.address,
          platformConfig: selected.data.platform,
          timeToVouch,
        }),
      ], "open market");
      printTxResult(sig);
    });

  market
    .command("add-option")
    .description("Add an option to a market")
    .option("--option-id <id>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const selected = await selectMarket(ctx);
      const defaultOptionId = Number(selected.data.totalOptions);
      const optionId = options.optionId
        ? Number(options.optionId)
        : await promptNumber("Option ID", defaultOptionId);
      printSummary({
        Market: selected.address,
        "Option ID": optionId,
      });
      await confirmTransaction(ctx.yes);
      const instruction = await addMarketOption({
        programAddress: ctx.programId,
        signer: ctx.payer,
        market: selected.address,
        optionId,
      });
      const sig = await sendInstructions(ctx, [instruction], "add market option");
      printTxResult(sig);
    });
}

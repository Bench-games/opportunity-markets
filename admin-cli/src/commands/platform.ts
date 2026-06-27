import { Command } from "commander";
import { address } from "@solana/kit";
import {
  createPlatformConfig,
  fetchMaybePlatformConfig,
  getPlatformConfigAddress,
  initAllowedMint,
  setFeeClaimAuthority,
  setUpdateAuthority,
  updatePlatformConfig,
} from "../../../js/src/index.js";
import { DEFAULT_PLATFORM } from "../defaults.js";
import { listAllowedMints, listPlatforms, selectPlatform } from "../discovery.js";
import { getContext, getReadContext } from "./common.js";
import {
  confirmTransaction,
  promptAddress,
  promptBigInt,
  promptNumber,
  promptString,
} from "../prompts.js";
import { printHeader, printSummary, printTxResult, shortAddress } from "../render.js";
import { sendInstructions } from "../tx.js";

function printPlatforms(platforms: Awaited<ReturnType<typeof listPlatforms>>): void {
  if (platforms.length === 0) {
    console.log("No platform configs found.");
    return;
  }

  printHeader("Platforms");
  for (const [index, platform] of platforms.entries()) {
    const fees = platform.data.feeRates;
    console.log(
      `${String(index + 1).padStart(2, " ")}  ${platform.data.name.padEnd(20)}  ${platform.address}  ` +
        `fees ${fees.platformFeeBp}/${fees.rewardPoolFeeBp}/${fees.creatorFeeBp}bp  ` +
        `update ${shortAddress(platform.data.updateAuthority)}`,
    );
  }
}

function printAllowedMints(
  platformAddress: string,
  mints: Awaited<ReturnType<typeof listAllowedMints>>,
): void {
  printHeader(`Allowed mints for ${platformAddress}`);
  if (mints.length === 0) {
    console.log("No allowed mints found.");
    return;
  }

  for (const [index, mint] of mints.entries()) {
    console.log(`${String(index + 1).padStart(2, " ")}  ${mint.data.mint}  account ${shortAddress(mint.address)}`);
  }
}

export function registerPlatformCommands(program: Command): void {
  const platform = program.command("platform").description("Manage platform configs");

  platform
    .command("list")
    .description("List all platform configs")
    .action(async (_options, command) => {
      const ctx = getReadContext(command);
      printPlatforms(await listPlatforms(ctx));
    });

  platform
    .command("allowed-mints")
    .description("List allowed mints for a platform")
    .argument("[platform]", "platform config address")
    .action(async (platformAddress: string | undefined, _options, command) => {
      const ctx = getReadContext(command);
      const selectedPlatform = platformAddress
        ? address(platformAddress)
        : (await selectPlatform(ctx, "Select platform to list allowed mints for")).address;
      const mints = await listAllowedMints(ctx, selectedPlatform);
      printAllowedMints(selectedPlatform, mints);
    });

  platform
    .command("ensure")
    .description("Create or update a platform config")
    .option("--name <name>")
    .option("--platform-fee-bp <bp>")
    .option("--reward-pool-fee-bp <bp>")
    .option("--creator-fee-bp <bp>")
    .option("--fee-claim-authority <address>")
    .option("--reveal-authority <address>")
    .option("--min-time-to-vouch-seconds <seconds>")
    .option("--reveal-period-seconds <seconds>")
    .option("--resolution-deadline-seconds <seconds>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const name = options.name ?? await promptString("Platform name", DEFAULT_PLATFORM.name);
      const platformFeeBp = options.platformFeeBp ? Number(options.platformFeeBp) : await promptNumber("Platform fee bp", DEFAULT_PLATFORM.platformFeeBp);
      const rewardPoolFeeBp = options.rewardPoolFeeBp ? Number(options.rewardPoolFeeBp) : await promptNumber("Reward pool fee bp", DEFAULT_PLATFORM.rewardPoolFeeBp);
      const creatorFeeBp = options.creatorFeeBp ? Number(options.creatorFeeBp) : await promptNumber("Creator fee bp", DEFAULT_PLATFORM.creatorFeeBp);
      const feeClaimAuthority = options.feeClaimAuthority
        ? address(options.feeClaimAuthority)
        : await promptAddress("Fee claim authority", ctx.payer.address);
      const revealAuthority = options.revealAuthority
        ? address(options.revealAuthority)
        : await promptAddress("Reveal authority", ctx.payer.address);
      const minTimeToVouchSeconds = options.minTimeToVouchSeconds
        ? BigInt(options.minTimeToVouchSeconds)
        : await promptBigInt("Min time to vouch seconds", DEFAULT_PLATFORM.minTimeToVouchSeconds);
      const revealPeriodSeconds = options.revealPeriodSeconds
        ? BigInt(options.revealPeriodSeconds)
        : await promptBigInt("Reveal period seconds", DEFAULT_PLATFORM.revealPeriodSeconds);
      const marketResolutionDeadlineSeconds = options.resolutionDeadlineSeconds
        ? BigInt(options.resolutionDeadlineSeconds)
        : await promptBigInt("Resolution deadline seconds", DEFAULT_PLATFORM.marketResolutionDeadlineSeconds);

      const [platformConfig] = await getPlatformConfigAddress(ctx.payer.address, name, ctx.programId);
      const existing = await fetchMaybePlatformConfig(ctx.rpc, platformConfig, { commitment: ctx.commitment });
      const mode = existing.exists ? "update" : "create";

      printHeader(`Platform ${mode}`);
      printSummary({
        Program: ctx.programId,
        Payer: ctx.payer.address,
        Name: name,
        "Platform config": platformConfig,
        "Platform fee": `${platformFeeBp} bp`,
        "Reward pool fee": `${rewardPoolFeeBp} bp`,
        "Creator fee": `${creatorFeeBp} bp`,
        "Fee claim authority": existing.exists ? existing.data.feeClaimAuthority : feeClaimAuthority,
        "Reveal authority": revealAuthority,
      });
      await confirmTransaction(ctx.yes);

      const instruction = existing.exists
        ? await updatePlatformConfig(ctx.rpc, {
            programAddress: ctx.programId,
            signer: ctx.payer,
            name,
            platformFeeBp,
            rewardPoolFeeBp,
            creatorFeeBp,
            revealAuthority,
            minTimeToVouchSeconds,
            revealPeriodSeconds,
            marketResolutionDeadlineSeconds,
          })
        : await createPlatformConfig(ctx.rpc, {
            programAddress: ctx.programId,
            signer: ctx.payer,
            name,
            platformFeeBp,
            rewardPoolFeeBp,
            creatorFeeBp,
            feeClaimAuthority,
            revealAuthority,
            minTimeToVouchSeconds,
            revealPeriodSeconds,
            marketResolutionDeadlineSeconds,
          });
      const sig = await sendInstructions(ctx, [instruction], `platform ${mode}`);
      printTxResult(sig);
    });

  platform
    .command("allow-mint")
    .description("Whitelist a mint for a platform")
    .option("--mint <address>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const selected = await selectPlatform(ctx);
      const tokenMint = options.mint ? address(options.mint) : await promptAddress("Mint address");
      printSummary({
        Platform: `${selected.data.name} ${selected.address}`,
        Mint: tokenMint,
      });
      await confirmTransaction(ctx.yes);
      const instruction = await initAllowedMint({
        programAddress: ctx.programId,
        updateAuthority: ctx.payer,
        platformConfig: selected.address,
        tokenMint,
      });
      const sig = await sendInstructions(ctx, [instruction], "allow mint");
      printTxResult(sig);
    });

  platform
    .command("set-fee-claim-authority")
    .description("Set a platform fee claim authority")
    .option("--new-authority <address>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const selected = await selectPlatform(ctx);
      const newFeeClaimAuthority = options.newAuthority
        ? address(options.newAuthority)
        : await promptAddress("New fee claim authority");
      printSummary({
        Platform: `${selected.data.name} ${shortAddress(selected.address)}`,
        "New fee claim authority": newFeeClaimAuthority,
      });
      await confirmTransaction(ctx.yes);
      const sig = await sendInstructions(ctx, [
        setFeeClaimAuthority({
          programAddress: ctx.programId,
          updateAuthority: ctx.payer,
          platformConfig: selected.address,
          newFeeClaimAuthority,
        }),
      ], "set fee claim authority");
      printTxResult(sig);
    });

  platform
    .command("set-update-authority")
    .description("Set a platform update authority")
    .option("--new-authority <address>")
    .action(async (options, command) => {
      const ctx = await getContext(command);
      const selected = await selectPlatform(ctx);
      const newAuthority = options.newAuthority
        ? address(options.newAuthority)
        : await promptAddress("New update authority");
      printSummary({
        Platform: `${selected.data.name} ${shortAddress(selected.address)}`,
        "New update authority": newAuthority,
      });
      await confirmTransaction(ctx.yes);
      const sig = await sendInstructions(ctx, [
        setUpdateAuthority({
          programAddress: ctx.programId,
          updateAuthority: ctx.payer,
          platformConfig: selected.address,
          newAuthority,
        }),
      ], "set update authority");
      printTxResult(sig);
    });
}

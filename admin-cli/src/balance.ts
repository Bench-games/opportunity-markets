import ora from "ora";
import type { CliContext } from "./context.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const LOW_PAYER_BALANCE_LAMPORTS = 10_000_000n; // 0.01 SOL.

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fractional = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${fractional ? `.${fractional}` : ""} SOL`;
}

export async function checkPayerBalance(ctx: CliContext): Promise<void> {
  const balanceSpinner = ora("Checking payer balance").start();
  const { value: lamports } = await ctx.rpc
    .getBalance(ctx.payer.address, { commitment: ctx.commitment })
    .send();

  if (lamports === 0n) {
    balanceSpinner.fail("Payer has no SOL");
    console.warn(`Warning: payer ${ctx.payer.address} has 0 SOL on ${ctx.rpcUrl}`);
    console.warn(`Keypair: ${ctx.keypairPath}`);
    console.warn("Fund this payer or use --keypair/KEYPAIR_PATH/RPC_URL for a funded account.");
    throw new Error("Payer has no SOL; transaction not attempted");
  }

  balanceSpinner.succeed(`Payer balance: ${formatSol(lamports)}`);
  if (lamports < LOW_PAYER_BALANCE_LAMPORTS) {
    console.warn(
      `Warning: payer ${ctx.payer.address} balance is low (${formatSol(lamports)}) on ${ctx.rpcUrl}`,
    );
  }
}

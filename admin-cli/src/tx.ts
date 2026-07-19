import ora from "ora";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Signature,
} from "@solana/kit";
import type { CliContext } from "./context.js";

function stringifyBigint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

export async function sendInstructions(
  ctx: CliContext,
  instructions: Instruction[],
  label: string,
): Promise<Signature> {
  const blockhashSpinner = ora("Fetching latest blockhash").start();
  const { value: latestBlockhash } = await ctx.rpc
    .getLatestBlockhash({ commitment: ctx.commitment })
    .send();
  blockhashSpinner.succeed("Fetched latest blockhash");

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (msg) => setTransactionMessageFeePayer(ctx.payer.address, msg),
    (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
    (msg) => appendTransactionMessageInstructions(instructions, msg),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const encoded = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed);

  const simulateSpinner = ora(`Simulating ${label}`).start();
  const sim = await ctx.rpc
    .simulateTransaction(encoded, { commitment: ctx.commitment, encoding: "base64" })
    .send();
  if (sim.value.err) {
    simulateSpinner.fail("Simulation failed");
    if (sim.value.logs) console.error(sim.value.logs.join("\n"));
    throw new Error(`Simulation failed: ${stringifyBigint(sim.value.err)}`);
  }
  simulateSpinner.succeed("Simulation succeeded");

  const sendSpinner = ora(`Sending ${label}`).start();
  await ctx.rpc.sendTransaction(encoded, { encoding: "base64" }).send();
  sendSpinner.succeed(`Sent ${signature}`);

  const confirmSpinner = ora("Waiting for confirmation").start();
  const start = Date.now();
  const timeout = 60_000;
  while (Date.now() - start < timeout) {
    const { value } = await ctx.rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) {
        confirmSpinner.fail("Transaction failed");
        throw new Error(`Transaction failed: ${stringifyBigint(status.err)}`);
      }
      confirmSpinner.succeed("Transaction confirmed");
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  confirmSpinner.fail("Confirmation timed out");
  throw new Error(`Transaction ${signature} not confirmed within ${timeout / 1000}s`);
}

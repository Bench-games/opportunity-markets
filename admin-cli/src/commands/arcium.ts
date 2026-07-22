import { Command } from "commander";
import {
  getCompDefAccount,
  ALL_COMP_DEF_CIRCUITS,
} from "../../../js/src/index.js";
import { getMxePublicKeyHex, getVouchComputeAddresses } from "../arcium.js";
import { getReadContext } from "./common.js";
import { printHeader, printSummary } from "../render.js";

export function registerArciumCommands(program: Command): void {
  const arcium = program.command("arcium").description("Arcium helpers");

  arcium
    .command("mxe-pubkey")
    .description("Fetch the MXE X25519 public key as hex")
    .action(async (_options, command) => {
      const ctx = getReadContext(command);
      const hex = await getMxePublicKeyHex(ctx);
      console.log(hex);
    });

  arcium
    .command("addresses")
    .description("Print Arcium addresses used by this program")
    .action(async (_options, command) => {
      const ctx = getReadContext(command);
      const addresses = getVouchComputeAddresses(ctx, 0n);
      printHeader("Arcium addresses");
      printSummary({
        Program: ctx.programId,
        "Program context": ctx.programContextName,
        "Cluster offset": ctx.programContext.clusterOffset,
        "MXE account": addresses.mxeAccount,
        "Cluster account": addresses.clusterAccount,
        "Mempool account": addresses.mempoolAccount,
        "Executing pool": addresses.executingPool,
        "Computation account offset 0": addresses.computationAccount,
      });
      for (const circuitName of ALL_COMP_DEF_CIRCUITS) {
        console.log(
          `${circuitName}: ${getCompDefAccount(circuitName, ctx.programId)}`
        );
      }
    });
}
